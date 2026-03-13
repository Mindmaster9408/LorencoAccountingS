/**
 * ============================================================================
 * Tests — PDF Statement Import Pipeline
 * ============================================================================
 * Tests cover:
 *   A. BaseParser utility methods (parseDate, parseAmount, isPageNoise)
 *   B. FNB parser (detect, parse)
 *   C. ABSA parser (detect, parse)
 *   D. Standard Bank parser (detect, parse)
 *   E. Nedbank parser (detect, parse)
 *   F. Capitec parser (detect, parse)
 *   G. Generic fallback parser
 *   H. Parser registry (selection logic)
 *   I. PdfStatementImportService (scanned PDF detection, pipeline)
 * ============================================================================
 */

const BaseParser = require('../sean/pdf-statement-parsers/base-parser');
const FNBParser = require('../sean/pdf-statement-parsers/fnb-parser');
const ABSAParser = require('../sean/pdf-statement-parsers/absa-parser');
const StandardBankParser = require('../sean/pdf-statement-parsers/standard-bank-parser');
const NedbankParser = require('../sean/pdf-statement-parsers/nedbank-parser');
const CapitecParser = require('../sean/pdf-statement-parsers/capitec-parser');
const GenericParser = require('../sean/pdf-statement-parsers/generic-parser');
const ParserRegistry = require('../sean/pdf-statement-parsers/parser-registry');
const PdfStatementImportService = require('../sean/pdf-statement-import-service');

// ─────────────────────────────────────────────────────────────────────────────
// A. BaseParser utility methods
// ─────────────────────────────────────────────────────────────────────────────

describe('BaseParser.parseDate', () => {
  test('parses DD/MM/YYYY', () => {
    expect(BaseParser.parseDate('01/03/2026')).toBe('2026-03-01');
  });

  test('parses YYYY/MM/DD', () => {
    expect(BaseParser.parseDate('2026/03/01')).toBe('2026-03-01');
  });

  test('parses YYYY-MM-DD', () => {
    expect(BaseParser.parseDate('2026-03-01')).toBe('2026-03-01');
  });

  test('parses DD-MM-YYYY', () => {
    expect(BaseParser.parseDate('01-03-2026')).toBe('2026-03-01');
  });

  test('parses DD Mon YYYY', () => {
    expect(BaseParser.parseDate('15 Jan 2026')).toBe('2026-01-15');
  });

  test('parses DD-Mon-YYYY', () => {
    expect(BaseParser.parseDate('15-Jan-2026')).toBe('2026-01-15');
  });

  test('returns null for garbage', () => {
    expect(BaseParser.parseDate('not a date')).toBeNull();
    expect(BaseParser.parseDate('')).toBeNull();
    expect(BaseParser.parseDate(null)).toBeNull();
  });
});

describe('BaseParser.parseAmount', () => {
  test('parses plain positive amount', () => {
    expect(BaseParser.parseAmount('1500.00')).toBe(1500);
  });

  test('parses comma-separated thousands', () => {
    expect(BaseParser.parseAmount('15,000.00')).toBe(15000);
  });

  test('parses space-separated thousands (ZAR style)', () => {
    expect(BaseParser.parseAmount('15 000.00')).toBe(15000);
  });

  test('parses negative amount', () => {
    expect(BaseParser.parseAmount('-1500.00')).toBe(-1500);
  });

  test('parses DR suffix as negative', () => {
    expect(BaseParser.parseAmount('1500.00 DR')).toBe(-1500);
  });

  test('parses CR suffix as positive', () => {
    expect(BaseParser.parseAmount('1500.00 CR')).toBe(1500);
  });

  test('parses trailing minus', () => {
    expect(BaseParser.parseAmount('1500.00-')).toBe(-1500);
  });

  test('parses R prefix', () => {
    expect(BaseParser.parseAmount('R 1 500.00')).toBe(1500);
  });

  test('forceType debit makes negative', () => {
    expect(BaseParser.parseAmount('500.00', 'debit')).toBe(-500);
  });

  test('forceType credit makes positive', () => {
    expect(BaseParser.parseAmount('500.00', 'credit')).toBe(500);
  });

  test('returns null for empty string', () => {
    expect(BaseParser.parseAmount('')).toBeNull();
    expect(BaseParser.parseAmount(null)).toBeNull();
  });

  test('returns null for non-numeric', () => {
    expect(BaseParser.parseAmount('N/A')).toBeNull();
  });
});

describe('BaseParser.isPageNoise', () => {
  test('flags page X of Y', () => {
    expect(BaseParser.isPageNoise('Page 1 of 4')).toBe(true);
  });

  test('flags opening balance line', () => {
    expect(BaseParser.isPageNoise('Opening Balance')).toBe(true);
  });

  test('flags closing balance line', () => {
    expect(BaseParser.isPageNoise('Closing Balance')).toBe(true);
  });

  test('flags total line', () => {
    expect(BaseParser.isPageNoise('Total Credits')).toBe(true);
  });

  test('does not flag normal transaction line', () => {
    expect(BaseParser.isPageNoise('01/01/2026 PAYMENT RECEIVED 5000.00 10000.00')).toBe(false);
  });
});

describe('BaseParser.startsWithDate', () => {
  test('recognises DD/MM/YYYY start', () => {
    expect(BaseParser.startsWithDate('01/03/2026 some text')).toBe(true);
  });

  test('recognises YYYY-MM-DD start', () => {
    expect(BaseParser.startsWithDate('2026-03-01 some text')).toBe(true);
  });

  test('recognises YYYY/MM/DD start', () => {
    expect(BaseParser.startsWithDate('2026/03/01 some text')).toBe(true);
  });

  test('returns false for non-date', () => {
    expect(BaseParser.startsWithDate('Total Credits 1500.00')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. FNB Parser
// ─────────────────────────────────────────────────────────────────────────────

const FNB_SAMPLE = `
First National Bank
Statement of Account
Account: 62012345678
Period: 01/01/2026 to 31/01/2026

Date       Description                          Amount      Balance
01/01/2026 OPENING BALANCE                                  5000.00
02/01/2026 PAYMENT RECEIVED JOHN DOE            5000.00     10000.00
05/01/2026 DEBIT ORDER VODACOM                 -235.00       9765.00
10/01/2026 SALARY LORENCO PTY LTD             15000.00      24765.00
15/01/2026 CAPITEC PAYMENT ELECTRICITY         -850.00      23915.00
31/01/2026 CLOSING BALANCE                                  23915.00
`;

describe('FNBParser.canParse', () => {
  test('returns high confidence for FNB text', () => {
    const result = FNBParser.canParse(FNB_SAMPLE);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test('returns low confidence for non-FNB text', () => {
    const result = FNBParser.canParse('Nedbank Account Statement');
    expect(result.confidence).toBeLessThan(0.4);
  });
});

describe('FNBParser.parse', () => {
  let result;
  beforeAll(() => { result = FNBParser.parse(FNB_SAMPLE, 'fnb-statement.pdf'); });

  test('extracts account number', () => {
    expect(result.accountNumber).toBe('62012345678');
  });

  test('extracts statement period', () => {
    expect(result.statementPeriod.from).toBe('2026-01-01');
    expect(result.statementPeriod.to).toBe('2026-01-31');
  });

  test('skips opening and closing balance lines', () => {
    const descs = result.transactions.map(t => t.description.toLowerCase());
    expect(descs.some(d => d.includes('opening balance'))).toBe(false);
    expect(descs.some(d => d.includes('closing balance'))).toBe(false);
  });

  test('extracts correct number of transactions', () => {
    // 4 real transactions (payment, debit, salary, electricity)
    expect(result.transactions.length).toBe(4);
  });

  test('positive amount for money in', () => {
    const payment = result.transactions.find(t => t.description.includes('PAYMENT RECEIVED'));
    expect(payment).toBeDefined();
    expect(payment.amount).toBeGreaterThan(0);
    expect(payment.amount).toBe(5000);
  });

  test('negative amount for debit order', () => {
    const debit = result.transactions.find(t => t.description.includes('VODACOM'));
    expect(debit).toBeDefined();
    expect(debit.amount).toBeLessThan(0);
    expect(debit.amount).toBe(-235);
  });

  test('dates normalised to YYYY-MM-DD', () => {
    result.transactions.forEach(t => {
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  test('balance extracted correctly', () => {
    const salary = result.transactions.find(t => t.description.includes('SALARY'));
    expect(salary.balance).toBe(24765);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. ABSA Parser
// ─────────────────────────────────────────────────────────────────────────────

const ABSA_SAMPLE = `
ABSA Bank
Account Statement
Account Number: 4085123456
Period: 01/01/2026 to 31/01/2026

Date        Description              Debit       Credit      Balance
01/01/2026  Opening Balance                                  8000.00
03/01/2026  SALARY DEPOSIT           -           6000.00     14000.00
07/01/2026  SHOPRITE PAYMENT         550.00      -           13450.00
20/01/2026  RENT PAYMENT             5000.00     -            8450.00
`;

describe('ABSAParser.canParse', () => {
  test('returns high confidence for ABSA text', () => {
    const result = ABSAParser.canParse(ABSA_SAMPLE);
    expect(result.confidence).toBeGreaterThanOrEqual(0.3);
  });
});

describe('ABSAParser.parse', () => {
  let result;
  beforeAll(() => { result = ABSAParser.parse(ABSA_SAMPLE, 'absa-statement.pdf'); });

  test('credit column parsed as positive amount', () => {
    const salary = result.transactions.find(t => t.description.includes('SALARY'));
    expect(salary).toBeDefined();
    expect(salary.amount).toBeGreaterThan(0);
  });

  test('debit column parsed as negative amount', () => {
    const shoprite = result.transactions.find(t => t.description.includes('SHOPRITE'));
    expect(shoprite).toBeDefined();
    expect(shoprite.amount).toBeLessThan(0);
  });

  test('skips opening balance', () => {
    const descs = result.transactions.map(t => t.description.toLowerCase());
    expect(descs.some(d => d.includes('opening'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Standard Bank Parser
// ─────────────────────────────────────────────────────────────────────────────

const STDBANK_SAMPLE = `
Standard Bank
The Standard Bank of South Africa
Account Number: 002 123 456
Period: 2026/01/01 to 2026/01/31

2026/01/01  Opening Balance                                   12000.00
2026/01/05  SALARY PAYMENT RECEIVED              15000.00     27000.00
2026/01/10  PAYMENT TO MUNICIPALITY    1800.00               25200.00
`;

describe('StandardBankParser.canParse', () => {
  test('returns high confidence for Standard Bank text', () => {
    const result = StandardBankParser.canParse(STDBANK_SAMPLE);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe('StandardBankParser.parse', () => {
  let result;
  beforeAll(() => { result = StandardBankParser.parse(STDBANK_SAMPLE, 'stdbank.pdf'); });

  test('extracts account number', () => {
    expect(result.accountNumber).not.toBeNull();
  });

  test('YYYY/MM/DD dates normalised correctly', () => {
    result.transactions.forEach(t => {
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Nedbank Parser
// ─────────────────────────────────────────────────────────────────────────────

const NEDBANK_SAMPLE = `
Nedbank
Account Statement
Account: 1234567890
Period: 01/01/2026 to 31/01/2026

01/01/2026  Opening Balance                                   3000.00
04/01/2026  SALARY RECEIVED                     8000.00      11000.00
12/01/2026  FUEL PAYMENT                1200.00               9800.00
`;

describe('NedbankParser.canParse', () => {
  test('returns high confidence for Nedbank text', () => {
    const result = NedbankParser.canParse(NEDBANK_SAMPLE);
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });
});

describe('NedbankParser.parse', () => {
  let result;
  beforeAll(() => { result = NedbankParser.parse(NEDBANK_SAMPLE, 'nedbank.pdf'); });

  test('salary parsed as positive amount', () => {
    const salary = result.transactions.find(t => t.description.includes('SALARY'));
    expect(salary).toBeDefined();
    expect(salary.amount).toBeGreaterThan(0);
  });

  test('fuel payment parsed as negative amount', () => {
    const fuel = result.transactions.find(t => t.description.includes('FUEL'));
    expect(fuel).toBeDefined();
    expect(fuel.amount).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Capitec Parser
// ─────────────────────────────────────────────────────────────────────────────

const CAPITEC_SAMPLE = `
Capitec Bank
Account Statement
Account: 1234000001
Period: 2026-01-01 to 2026-01-31

2026-01-01  Opening Balance                      6000.00
2026-01-03  SALARY RECEIVED         5000.00      11000.00
2026-01-08  GROCERY SHOPRITE        -750.00      10250.00
`;

describe('CapitecParser.canParse', () => {
  test('returns high confidence for Capitec text', () => {
    const result = CapitecParser.canParse(CAPITEC_SAMPLE);
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });
});

describe('CapitecParser.parse', () => {
  let result;
  beforeAll(() => { result = CapitecParser.parse(CAPITEC_SAMPLE, 'capitec.pdf'); });

  test('positive amount for salary', () => {
    const salary = result.transactions.find(t => t.description.includes('SALARY'));
    expect(salary).toBeDefined();
    expect(salary.amount).toBe(5000);
  });

  test('negative amount for grocery', () => {
    const grocery = result.transactions.find(t => t.description.includes('GROCERY'));
    expect(grocery).toBeDefined();
    expect(grocery.amount).toBe(-750);
  });

  test('ISO dates correct', () => {
    result.transactions.forEach(t => {
      expect(t.date).toMatch(/^2026-01-\d{2}$/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Generic Parser
// ─────────────────────────────────────────────────────────────────────────────

const GENERIC_SAMPLE = `
Some Unknown Bank
Account Statement

Date       Description          Amount    Balance
01/01/2026 Opening Balance                5000.00
02/01/2026 Transfer In          2000.00   7000.00
05/01/2026 Monthly Fee          -150.00   6850.00
`;

describe('GenericParser', () => {
  test('canParse returns low but non-zero confidence for financial text', () => {
    const result = GenericParser.canParse(GENERIC_SAMPLE);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(0.3);
  });

  test('parse returns transactions with warnings', () => {
    const result = GenericParser.parse(GENERIC_SAMPLE, 'unknown.pdf');
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. Parser Registry
// ─────────────────────────────────────────────────────────────────────────────

describe('ParserRegistry', () => {
  test('listParsers returns all registered parsers', () => {
    const list = ParserRegistry.listParsers();
    expect(list.length).toBeGreaterThanOrEqual(6);
    const ids = list.map(p => p.id);
    expect(ids).toContain('fnb-v1');
    expect(ids).toContain('absa-v1');
    expect(ids).toContain('standardbank-v1');
    expect(ids).toContain('nedbank-v1');
    expect(ids).toContain('capitec-v1');
    expect(ids).toContain('generic-v1');
  });

  test('selectParser picks FNB for FNB text', () => {
    const sel = ParserRegistry.selectParser(FNB_SAMPLE);
    expect(sel.parser.PARSER_ID).toBe('fnb-v1');
    expect(sel.isGenericFallback).toBe(false);
  });

  test('selectParser picks ABSA for ABSA text', () => {
    const sel = ParserRegistry.selectParser(ABSA_SAMPLE);
    expect(sel.parser.PARSER_ID).toBe('absa-v1');
  });

  test('selectParser picks Nedbank for Nedbank text', () => {
    const sel = ParserRegistry.selectParser(NEDBANK_SAMPLE);
    expect(sel.parser.PARSER_ID).toBe('nedbank-v1');
  });

  test('selectParser picks Capitec for Capitec text', () => {
    const sel = ParserRegistry.selectParser(CAPITEC_SAMPLE);
    expect(sel.parser.PARSER_ID).toBe('capitec-v1');
  });

  test('selectParser falls back to generic for unknown text', () => {
    const sel = ParserRegistry.selectParser('Some random text with no bank name and a few 1234.00 amounts.');
    expect(sel.isGenericFallback).toBe(true);
  });

  test('getById returns correct parser', () => {
    const P = ParserRegistry.getById('fnb-v1');
    expect(P).toBe(FNBParser);
  });

  test('getById returns null for unknown id', () => {
    expect(ParserRegistry.getById('nonexistent')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. PdfStatementImportService
// ─────────────────────────────────────────────────────────────────────────────

describe('PdfStatementImportService._makeExternalId', () => {
  test('generates stable ID for a transaction', () => {
    const txn = { date: '2026-01-05', amount: -235, description: 'DEBIT ORDER VODACOM' };
    const id1 = PdfStatementImportService._makeExternalId(txn);
    const id2 = PdfStatementImportService._makeExternalId(txn);
    expect(id1).toBe(id2);
    expect(id1).toContain('pdf-2026-01-05');
  });

  test('different amounts produce different IDs', () => {
    const a = PdfStatementImportService._makeExternalId({ date: '2026-01-05', amount: -235, description: 'DEBIT ORDER VODACOM' });
    const b = PdfStatementImportService._makeExternalId({ date: '2026-01-05', amount: -300, description: 'DEBIT ORDER VODACOM' });
    expect(a).not.toBe(b);
  });
});

describe('PdfStatementImportService scanned PDF detection', () => {
  test('returns error for nearly-empty buffer', async () => {
    // pdf-parse will fail to parse a non-PDF buffer — the service should
    // catch this and return a proper error (not throw).
    const fakeBuffer = Buffer.from('not a real pdf');
    const result = await PdfStatementImportService.parsePdf(fakeBuffer, 'fake.pdf');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('PdfStatementImportService._enrichTransactions', () => {
  test('returns review transactions with moneyIn/moneyOut split', async () => {
    const txns = [
      { date: '2026-01-02', description: 'PAYMENT IN', amount: 5000, balance: 10000, reference: null },
      { date: '2026-01-05', description: 'DEBIT ORDER', amount: -235, balance: 9765, reference: null }
    ];

    let capturedCount = 0;
    const enriched = await PdfStatementImportService._enrichTransactions(
      txns, null, null, (c) => { capturedCount = c; }
    );

    expect(enriched.length).toBe(2);
    expect(enriched[0].moneyIn).toBe(5000);
    expect(enriched[0].moneyOut).toBeNull();
    expect(enriched[1].moneyIn).toBeNull();
    expect(enriched[1].moneyOut).toBe(235);
    expect(enriched[0].externalId).toContain('pdf-');
    expect(capturedCount).toBe(0); // no DB, so no duplicates found
  });
});
