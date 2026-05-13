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

// ─── Standard Bank — real DD Mon YY format (3-month statement) ────────────────

const STDBANK_REAL_SAMPLE = `
The Standard Bank of South Africa
Customer Care: 0860 123 000
Account number: 10 23 658 206 0
DRONEDOG STUDIO (PTY) LTD
From: 26 Nov 24
To: 24 Feb 25
3 month statement

Date Description Payments Deposits Balance
STATEMENT OPENING BALANCE 0.00
27 Nov 24 DF CTOTS 1008
AUTOBANK CASH DEPOSIT
200.00 200.00
27 Nov 24 CASH DEPOSIT FEE - AUTOBANK
CASH DEPOSIT FEE - AUTOBANK
-7.20 192.80
30 Nov 24 0000010236582060 00002 R1.00
FEE: MYUPDATES FOR BUSINESS
-1.00 191.80
11 Dec 24 CAPITEC H RUST
CREDIT TRANSFER
500.00 691.80
31 Dec 24 MONTHLY MANAGEMENT FEE
MONTHLY MANAGEMENT FEE
-4.29 687.51
31 Dec 24 0000010236582060 00002 R1.00
FEE: MYUPDATES FOR BUSINESS
-1.00 686.51
04 Jan 25 12H40 2838 4278*6153
FEE-PIN RESET
-15.00 671.51
06 Jan 25 DIAMATRIX CC DRONDOG DOMA
IB PAYMENT TO
-298.00 373.51
06 Jan 25 10236582060
FEE-ELECTRONIC ACCOUNT PAYMENT
-5.80 367.71
06 Jan 25 DIAMATRIX CC
FEE: PAYMENT CONFIRM - EMAIL
-0.80 366.91
14 Jan 25 GOOGLE PHOTOD 4278*6153 12 JAN
CHEQUE CARD PURCHASE
-129.99 236.92
14 Jan 25 #INTERNATIONAL4278193242756153
CHEQUE CARD PURCHASE
-3.57 233.35
15 Jan 25 GOOGLE POWERD 4278*6153 11 JAN
CHEQUE CARD PURCHASE
-139.99 93.36
15 Jan 25 #INTERNATIONAL4278193242756153
CHEQUE CARD PURCHASE
-3.85 89.51

Customer Care: 0860 123 000
Website: www.standardbank.co.za
Pg 2 of 3
Transaction details Available Balance: R9.37
Date Description Payments Deposits Balance

31 Jan 25 INTFIN
MAGTAPE CREDIT
2,210.00 2,299.51
31 Jan 25 MONTHLY MANAGEMENT FEE
MONTHLY MANAGEMENT FEE
-9.00 2,290.51
31 Jan 25 0000010236582060 00002 R1.00
FEE: MYUPDATES FOR BUSINESS
-2.00 2,288.51
01 Feb 25 N MOLEFE
IB PAYMENT TO
-1,800.00 488.51
01 Feb 25 10236582060
FEE-ELECTRONIC ACCOUNT PAYMENT
-5.80 482.71
01 Feb 25 N MOLEFE
FEE: PAYMENT CONFIRM - EMAIL
-0.80 481.91
10 Feb 25 HR PHOTOGRAPHY - JAN
MAGTAPE CREDIT
2,000.00 2,481.91
13 Feb 25 #INTERNATIONAL4278193242756153
CHEQUE CARD PURCHASE
-3.85 2,478.06
13 Feb 25 GOOGLE CYBERL 4278*6153 12 FEB
CHEQUE CARD PURCHASE
-139.99 2,338.07
14 Feb 25 GOOGLE CYBERL 4278*6153 13 FEB
CHEQUE CARD PURCHASE
-129.99 2,208.08
14 Feb 25 #INTERNATIONAL4278193242756153
CHEQUE CARD PURCHASE
-3.57 2,204.51
15 Feb 25 00006497 2025-02-15T11:03:48 4278*6153
AUTOBANK CASH WITHDRAWAL AT
-600.00 1,604.51
15 Feb 25 4278*6153
CASH WITHDRAWAL FEE
-15.30 1,589.21
19 Feb 25 ENGEN MIEDERP 4278*6153 19 FEB
CHEQUE CARD PURCHASE
-200.00 1,389.21
20 Feb 25 ENGEN EMSLIES 4278*6153 20 FEB
CHEQUE CARD PURCHASE
-300.00 1,089.21
20 Feb 25 ALABAMA SUPER 4278*6153 20 FEB
CHEQUE CARD PURCHASE
-89.00 1,000.21
20 Feb 25 ATHLETICS CEN 4278*6153 19 FEB
CHEQUE CARD PURCHASE
-40.00 960.21
20 Feb 25 GOLDEN SUPERM 4278*6153 19 FEB
CHEQUE CARD PURCHASE
-40.00 920.21

Customer Care: 0860 123 000
Website: www.standardbank.co.za
Pg 3 of 3
Transaction details Available Balance: R9.37
Date Description Payments Deposits Balance

21 Feb 25 C*SPAR POTCH 4278*6153 20 FEB
CHEQUE CARD PURCHASE
-246.72 673.49
22 Feb 25 C*TOPS POTCH 4278*6153 21 FEB
CHEQUE CARD PURCHASE
-49.45 624.04
22 Feb 25 C*SPAR POTCH 4278*6153 21 FEB
CHEQUE CARD PURCHASE
-29.98 594.06
22 Feb 25 TOTAL POTCHEF 4278*6153 21 FEB
CHEQUE CARD PURCHASE
-28.00 566.06
22 Feb 25 SNATZI KAF POTCHEFSTROO ZAF 22-02-2025
OUTSTANDING CARD AUTHORISATION
-25.00 541.06
22 Feb 25 SASOL VANS POTCHEFSTROO ZAF 22-02-2025
OUTSTANDING CARD AUTHORISATION
-200.00 341.06
24 Feb 25 YOCO *TIGHT 4278*6153 21 FEB
CHEQUE CARD PURCHASE
-80.00 261.06
24 Feb 25 C*SPAR POTCH 4278*6153 21 FEB
CHEQUE CARD PURCHASE
-206.69 54.37
24 Feb 25 GOLDEN SUPERM 4278*6153 21 FEB
CHEQUE CARD PURCHASE
-45.00 9.37

Statement Summary
Payments -R4,900.63
Deposits R4,910.00
`;

describe('StandardBankParser — real statement (DD Mon YY format)', () => {
  let result;
  beforeAll(() => { result = StandardBankParser.parse(STDBANK_REAL_SAMPLE, 'stdbank-real.pdf'); });

  test('1. detects this statement format', () => {
    expect(StandardBankParser.canParse(STDBANK_REAL_SAMPLE).confidence).toBeGreaterThanOrEqual(0.5);
  });

  test('2. extracts 41 transactions', () => {
    expect(result.transactions.length).toBe(41);
  });

  test('3. first transaction is deposit 200.00 with balance 200.00', () => {
    const first = result.transactions[0];
    expect(first.date).toBe('2024-11-27');
    expect(first.amount).toBe(200);
    expect(first.balance).toBe(200);
  });

  test('4. last transaction is payment -45.00 with balance 9.37', () => {
    const last = result.transactions[result.transactions.length - 1];
    expect(last.date).toBe('2025-02-24');
    expect(last.amount).toBe(-45);
    expect(last.balance).toBeCloseTo(9.37, 2);
  });

  test('5. total payments = 4900.63', () => {
    const payments = result.transactions
      .filter(t => t.amount < 0)
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    expect(payments).toBeCloseTo(4900.63, 2);
  });

  test('6. total deposits = 4910.00', () => {
    const deposits = result.transactions
      .filter(t => t.amount > 0)
      .reduce((sum, t) => sum + t.amount, 0);
    expect(deposits).toBeCloseTo(4910.00, 2);
  });

  test('7. multi-line descriptions are merged', () => {
    const deposit = result.transactions.find(t => t.amount === 200 && t.balance === 200);
    expect(deposit.description).toMatch(/AUTOBANK CASH DEPOSIT/i);
    const pinReset = result.transactions.find(t => t.amount === -15 && Math.abs(t.balance - 671.51) < 0.02);
    expect(pinReset.description).toMatch(/FEE-PIN RESET/i);
  });

  test('8. no header/footer rows become transactions', () => {
    const badTxn = result.transactions.find(t =>
      /customer\s+care|website|standard\s+bank\s+of\s+south|we\s+subscribe|statement\s+summary|opening\s+balance/i.test(t.description)
    );
    expect(badTxn).toBeUndefined();
  });

  test('9. all dates are valid YYYY-MM-DD', () => {
    result.transactions.forEach(t => {
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

// ─── Standard Bank — 4-digit year format (actual production PDF format) ───────
// Real PDFs extracted by pdf-parse use DD Mon YYYY (e.g. "27 Nov 2024"),
// not the 2-digit DD Mon YY used in our synthetic test above.

const STDBANK_4DY_SAMPLE = `
The Standard Bank of South Africa
Customer Care: 0860 123 000
Website: www.standardbank.co.za
Account number:10 23 658 206 0
Account holder:DRONEDOG STUDIO (PTY) LTD
From: 26 Nov 2024
To: 24 Feb 2025
3 month statement

Date Description Payments Deposits Balance
STATEMENT OPENING BALANCE 0.00
27 Nov 2024 DF CTOTS 1008
AUTOBANK CASH DEPOSIT
200.00 200.00
27 Nov 2024 CASH DEPOSIT FEE - AUTOBANK
-7.20 192.80
11 Dec 2024 CAPITEC H RUST
CREDIT TRANSFER
500.00 692.80
31 Dec 2024 MONTHLY MANAGEMENT FEE
-4.29 688.51
06 Jan 2025 DIAMATRIX CC
IB PAYMENT TO
-298.00 390.51
14 Jan 2025 GOOGLE PHOTOD 4278*6153 12 JAN
CHEQUE CARD PURCHASE
-129.99 260.52
24 Feb 2025 GOLDEN SUPERM CHEQUE CARD PURCHASE
-45.00 215.52

Statement Summary
Payments -R477.28
Deposits R700.00
`;

describe('StandardBankParser — 4-digit year (DD Mon YYYY, real PDF format)', () => {
  let result;
  beforeAll(() => { result = StandardBankParser.parse(STDBANK_4DY_SAMPLE, 'stdbank-real.pdf'); });

  test('1. detects Standard Bank with 4-digit year dates', () => {
    expect(StandardBankParser.canParse(STDBANK_4DY_SAMPLE).confidence).toBeGreaterThanOrEqual(0.7);
  });

  test('2. extracts 7 transactions', () => {
    expect(result.transactions.length).toBe(7);
  });

  test('3. first transaction has date 2024-11-27', () => {
    expect(result.transactions[0].date).toBe('2024-11-27');
    expect(result.transactions[0].amount).toBe(200);
  });

  test('4. last transaction has date 2025-02-24', () => {
    const last = result.transactions[result.transactions.length - 1];
    expect(last.date).toBe('2025-02-24');
    expect(last.amount).toBe(-45);
  });

  test('5. all dates are valid YYYY-MM-DD', () => {
    result.transactions.forEach(t => {
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

// ─── Standard Bank — production PDF format (date concatenated with description) ─
// Real pdf-parse extraction merges date column and description column with no space.
// "27 Nov 24DF CTOTS 1008 AUTOBANK CASH DEPOSIT200.00200.00" is one extracted line.
// Also tests: generation date (24/02/2025) must NOT start a block; merged column
// header (DateDescriptionPaymentsDepositsBalance) must be filtered.

const STDBANK_CONCAT_SAMPLE = `The Standard Bank of South Africa
Account number:05 1001 234 5
Account holder:ACME (PTY) LTD
From: 27 Nov 2024
To: 24 Feb 2025
3 month statement
24/02/2025
051001 Pg 1 of3
DateDescriptionPaymentsDepositsBalance
27 Nov 24DF CTOTS 1008 AUTOBANK CASH DEPOSIT200.00200.00
27 Nov 24CASH DEPOSIT FEE - AUTOBANK-7.20192.80
11 Dec 24CAPITEC H RUST CREDIT TRANSFER500.00692.80
31 Dec 24MONTHLY MANAGEMENT FEE-4.29688.51
24/02/2025
051001 Pg 2 of3
DateDescriptionPaymentsDepositsBalance
06 Jan 25DIAMATRIX CC IB PAYMENT TO-298.00390.51
14 Jan 25GOOGLE PHOTOD 4278*6153 12 JAN CHEQUE CARD PURCHASE-129.99260.52
20 Feb 25GOLDEN SUPERM 427846153 18 FEB CHEQUE CARD PURCHASE-45.00215.52

Statement Summary
Payments -R477.28
Deposits R700.00
`;

describe('StandardBankParser \u2014 production concat format (date+desc no space)', () => {
  let result;
  beforeAll(() => { result = StandardBankParser.parse(STDBANK_CONCAT_SAMPLE, 'stdbank-prod.pdf'); });

  test('1. detects Standard Bank', () => {
    expect(StandardBankParser.canParse(STDBANK_CONCAT_SAMPLE).confidence).toBeGreaterThanOrEqual(0.7);
  });

  test('2. extracts 7 transactions (not 2 or 3)', () => {
    expect(result.transactions.length).toBe(7);
  });

  test('3. first transaction date is 2024-11-27', () => {
    expect(result.transactions[0].date).toBe('2024-11-27');
  });

  test('4. first transaction amount is +200 (deposit)', () => {
    expect(result.transactions[0].amount).toBe(200);
  });

  test('5. CASH DEPOSIT FEE is -7.20', () => {
    const fee = result.transactions.find(t => t.description.includes('CASH DEPOSIT FEE'));
    expect(fee).toBeDefined();
    expect(fee.amount).toBe(-7.20);
  });

  test('6. generation date 24/02/2025 does NOT appear as a transaction', () => {
    const gen = result.transactions.find(t => t.date === '2025-02-24' && t.description === '');
    expect(gen).toBeUndefined();
  });

  test('7. last transaction date is 2025-02-20', () => {
    const last = result.transactions[result.transactions.length - 1];
    expect(last.date).toBe('2025-02-20');
    expect(last.amount).toBe(-45);
  });
});

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
// E2. Nedbank Parser — real eConfirm statement (Bakmeester, Feb–Mar 2025)
// ─────────────────────────────────────────────────────────────────────────────

const NEDBANK_ECONFIRM_SAMPLE = `
Nedbank
eConfirm 2025-03-14
Reg No 1951/000009/06

Account: 1151848921
Period: 11/02/2025 - 11/03/2025

12/02/2025 Opening balance 8,440.27
000091 12/02/2025 Notification Fee: E-mail 0.50 * 8,439.77
21/02/2025 Pennygrow 30,000.00 38,439.77
25/02/2025 VAT 28/01-24/02 = R12.24 0.00 38,439.77
25/02/2025 SERVICE FEE 28/01 - 24/02 7.80 * 38,431.97
25/02/2025 MAINTENANCE FEE 75.00 * 38,356.97
26/02/2025 Turkstra Bakkery 20,000.00 58,356.97
26/02/2025 Turkstra Bakkery 10,000.00 68,356.97
26/02/2025 Christo Pretorius 19,712.00 48,644.97
26/02/2025 Ellen Moorcroft 19,712.00 28,932.97
26/02/2025 Kitsbetaling fooi 100.00 * 28,832.97
27/02/2025 Anni Mari Pretorius 19,271.00 9,561.97
27/02/2025 Kitsbetaling fooi 50.00 * 9,511.97
28/02/2025 0087999451 7.80 2,418.79 7,093.18
01/03/2025 Notification Fee: E-mail 0.50 * 7,092.68
05/03/2025 Lorenco Accounting 7.80 2,585.31 4,507.37
06/03/2025 Pennygrow 10,000.00 14,507.37
06/03/2025 Notification Fee: SMS 0.50 * 14,506.87
08/03/2025 Turkstra Bakkery 5,000.00 19,506.87
08/03/2025 0088272613 7.80 13,343.44 6,163.43
10/03/2025 Anni Mari Pretorius13tjek 5,000.00 1,163.43
000092 10/03/2025 Notification Fee: E-mail 0.50 * 1,162.93
10/03/2025 Kitsbetaling fooi 50.00 * 1,112.93
Closing balance 1,112.93
`;

describe('NedbankParser.parse — eConfirm real statement', () => {
  let result;
  beforeAll(() => { result = NedbankParser.parse(NEDBANK_ECONFIRM_SAMPLE, 'nedbank-bakmeester.pdf'); });

  test('canParse recognises Nedbank eConfirm statement', () => {
    const r = NedbankParser.canParse(NEDBANK_ECONFIRM_SAMPLE, 'nedbank-bakmeester.pdf');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test('account number extracted correctly', () => {
    expect(result.accountNumber).toBe('1151848921');
  });

  test('credit transaction (Pennygrow Feb) is positive', () => {
    const t = result.transactions.find(t => t.description.includes('Pennygrow') && t.date === '2025-02-21');
    expect(t).toBeDefined();
    expect(t.amount).toBe(30000);
  });

  test('debit transaction (Christo Pretorius) is negative', () => {
    const t = result.transactions.find(t => t.description.includes('Christo Pretorius'));
    expect(t).toBeDefined();
    expect(t.amount).toBe(-19712);
  });

  test('fee-only row (MAINTENANCE FEE) is negative', () => {
    const t = result.transactions.find(t => t.description.includes('MAINTENANCE FEE'));
    expect(t).toBeDefined();
    expect(t.amount).toBe(-75);
  });

  test('fee-only row (SERVICE FEE) is negative', () => {
    const t = result.transactions.find(t => t.description.includes('SERVICE FEE'));
    expect(t).toBeDefined();
    expect(t.amount).toBeCloseTo(-7.80, 1);
  });

  test('fee+debit combined row — Lorenco Accounting uses net debit as amount', () => {
    const t = result.transactions.find(t => t.description.includes('Lorenco Accounting'));
    expect(t).toBeDefined();
    expect(t.amount).toBeCloseTo(-2585.31, 1);
  });

  test('fee+debit combined row — 0087999451', () => {
    const t = result.transactions.find(t => t.description.includes('0087999451'));
    expect(t).toBeDefined();
    expect(t.amount).toBeCloseTo(-2418.79, 1);
  });

  test('fee+debit combined row — 0088272613', () => {
    const t = result.transactions.find(t => t.description.includes('0088272613'));
    expect(t).toBeDefined();
    expect(t.amount).toBeCloseTo(-13343.44, 1);
  });

  test('tran-list-no prefix row (000091) parsed with correct date and amount', () => {
    const t = result.transactions.find(t => t.description.includes('Notification Fee: E-mail') && t.date === '2025-02-12');
    expect(t).toBeDefined();
    expect(t.amount).toBeCloseTo(-0.50, 2);
  });

  test('tran-list-no prefix row (000092) parsed with correct date and amount', () => {
    const t = result.transactions.find(t => t.description.includes('Notification Fee: E-mail') && t.date === '2025-03-10');
    expect(t).toBeDefined();
    expect(t.amount).toBeCloseTo(-0.50, 2);
  });

  test('VAT annotation line (zero debit) is excluded from transactions', () => {
    const vatLines = result.transactions.filter(t => t.description && t.description.toUpperCase().startsWith('VAT'));
    expect(vatLines.length).toBe(0);
  });

  test('two Turkstra Bakkery credits on 26/02 are both parsed as positive', () => {
    const bakkery = result.transactions.filter(t => t.description.includes('Turkstra Bakkery') && t.date === '2025-02-26');
    expect(bakkery.length).toBe(2);
    bakkery.forEach(t => expect(t.amount).toBeGreaterThan(0));
  });

  test('description with embedded digits (Anni Mari Pretorius13tjek) parses correctly', () => {
    const t = result.transactions.find(t => t.description.includes('Pretorius13tjek'));
    expect(t).toBeDefined();
    expect(t.amount).toBeCloseTo(-5000, 0);
  });

  test('all dates are in ISO YYYY-MM-DD format', () => {
    result.transactions.forEach(t => {
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  test('all dates fall within the statement period (Feb–Mar 2025)', () => {
    result.transactions.forEach(t => {
      expect(t.date).toMatch(/^2025-0[23]-/);
    });
  });

  test('total transaction count is 21 (VAT annotation excluded)', () => {
    expect(result.transactions.length).toBe(21);
  });

  test('closing balance cross-check: opening + credits + debits = 1,112.93', () => {
    const net = result.transactions.reduce((s, t) => s + t.amount, 0);
    expect(8440.27 + net).toBeCloseTo(1112.93, 1);
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
