'use strict';

const OFXParserService = require('../modules/accounting/services/ofxParserService');

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeOfx1(transactions, extra = '') {
  const txnLines = transactions.map(t => `
<STMTTRN>
<TRNTYPE>${t.type || 'OTHER'}
<DTPOSTED>${t.dtposted}
<TRNAMT>${t.amount}
${t.fitid ? '<FITID>' + t.fitid : ''}
${t.name  ? '<NAME>'  + t.name  : ''}
${t.memo  ? '<MEMO>'  + t.memo  : ''}
</STMTTRN>`).join('\n');

  return Buffer.from(`OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1001
<STMTRS>
<CURDEF>ZAR
<BANKACCTFROM>
<BANKID>632005
<ACCTID>62000000001
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20240501
<DTEND>20240531
${txnLines}
</BANKTRANLIST>
${extra}
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`);
}

function makeOfx2(transactions, extra = '') {
  const txnXml = transactions.map(t => `
        <STMTTRN>
          <TRNTYPE>${t.type || 'OTHER'}</TRNTYPE>
          <DTPOSTED>${t.dtposted}</DTPOSTED>
          <TRNAMT>${t.amount}</TRNAMT>
          ${t.fitid ? '<FITID>' + t.fitid + '</FITID>' : ''}
          ${t.name  ? '<NAME>'  + t.name  + '</NAME>'  : ''}
          ${t.memo  ? '<MEMO>'  + t.memo  + '</MEMO>'  : ''}
        </STMTTRN>`).join('\n');

  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" DATA="OFXSGML" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <BANKTRANLIST>
${txnXml}
        </BANKTRANLIST>
        ${extra}
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OFXParserService', () => {

  // ── TEST 1: Valid OFX 1.x with a deposit and a payment ───────────────────
  test('TEST-OFX-01: Parses valid OFX 1.x file with deposits and payments', () => {
    const buf = makeOfx1([
      { dtposted: '20240510000000', amount: '1500.00', fitid: 'F001', name: 'SALARY' },
      { dtposted: '20240515000000', amount: '-250.00', fitid: 'F002', name: 'WOOLWORTHS', memo: 'PURCHASE' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');

    expect(result.success).toBe(true);
    expect(result.transactions).toHaveLength(2);
  });

  // ── TEST 2: Positive amounts become moneyIn ────────────────────────────────
  test('TEST-OFX-02: Positive amount sets moneyIn, moneyOut is null', () => {
    const buf = makeOfx1([
      { dtposted: '20240510', amount: '3000.00', fitid: 'D001', name: 'DEPOSIT' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    const txn = result.transactions[0];

    expect(txn.amount).toBe(3000.00);
    expect(txn.moneyIn).toBe(3000.00);
    expect(txn.moneyOut).toBeNull();
  });

  // ── TEST 3: Negative amounts become moneyOut ───────────────────────────────
  test('TEST-OFX-03: Negative amount sets moneyOut, moneyIn is null', () => {
    const buf = makeOfx1([
      { dtposted: '20240512', amount: '-125.50', fitid: 'P001', name: 'CHECKERS' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    const txn = result.transactions[0];

    expect(txn.amount).toBe(-125.50);
    expect(txn.moneyOut).toBe(125.50);
    expect(txn.moneyIn).toBeNull();
  });

  // ── TEST 4: FITID becomes externalId ──────────────────────────────────────
  test('TEST-OFX-04: FITID is captured as externalId for deduplication', () => {
    const buf = makeOfx1([
      { dtposted: '20240520', amount: '-50.00', fitid: 'TXN-ABC-9999', name: 'UBER' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    expect(result.transactions[0].externalId).toBe('TXN-ABC-9999');
  });

  // ── TEST 5: OFX date formats → YYYY-MM-DD ────────────────────────────────
  test('TEST-OFX-05: OFX date YYYYMMDDHHMMSS converts to YYYY-MM-DD', () => {
    const buf = makeOfx1([
      { dtposted: '20240531120000', amount: '100.00', fitid: 'D1', name: 'TEST' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    expect(result.transactions[0].date).toBe('2024-05-31');
  });

  // ── TEST 6: Date with timezone suffix ────────────────────────────────────
  test('TEST-OFX-06: OFX date with timezone suffix parses correctly', () => {
    const buf = makeOfx1([
      { dtposted: '20240615000000[-2:SAST]', amount: '-80.00', fitid: 'TZ1', name: 'SHOPRITE' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    expect(result.transactions[0].date).toBe('2024-06-15');
  });

  // ── TEST 7: NAME + MEMO combined when different ────────────────────────────
  test('TEST-OFX-07: NAME and MEMO combined when both present and different', () => {
    const buf = makeOfx1([
      { dtposted: '20240510', amount: '-30.00', fitid: 'D2', name: 'ENGEN', memo: 'FUEL PURCHASE' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    expect(result.transactions[0].description).toBe('ENGEN - FUEL PURCHASE');
  });

  // ── TEST 8: MEMO only when NAME absent ────────────────────────────────────
  test('TEST-OFX-08: Uses MEMO as description when NAME is absent', () => {
    const buf = makeOfx1([
      { dtposted: '20240511', amount: '-15.00', fitid: 'D3', memo: 'PARKING FEE' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    expect(result.transactions[0].description).toBe('PARKING FEE');
  });

  // ── TEST 9: Duplicate NAME+MEMO not repeated ──────────────────────────────
  test('TEST-OFX-09: Uses only one value when NAME and MEMO are identical', () => {
    const buf = makeOfx1([
      { dtposted: '20240512', amount: '-20.00', fitid: 'D4', name: 'DEBIT ORDER', memo: 'DEBIT ORDER' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    expect(result.transactions[0].description).toBe('DEBIT ORDER');
  });

  // ── TEST 10: OFX 2.x XML-style closed tags ───────────────────────────────
  test('TEST-OFX-10: Parses OFX 2.x XML-style file correctly', () => {
    const buf = makeOfx2([
      { dtposted: '20240601', amount: '500.00',  fitid: 'X001', name: 'REFUND' },
      { dtposted: '20240602', amount: '-200.00', fitid: 'X002', name: 'RENT',  memo: 'MONTHLY RENT' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.qfx');
    expect(result.success).toBe(true);
    expect(result.format).toBe('ofx2');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].moneyIn).toBe(500.00);
    expect(result.transactions[1].moneyOut).toBe(200.00);
  });

  // ── TEST 11: Invalid OFX returns clear error ─────────────────────────────
  test('TEST-OFX-11: Invalid / empty OFX returns success=false with error message', () => {
    const buf = Buffer.from('This is not an OFX file at all.');

    const result = OFXParserService.parse(buf, 'bad.ofx');

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  // ── TEST 12: OFX with transactions missing date or amount are skipped ─────
  test('TEST-OFX-12: Transactions missing date or amount are skipped with warning', () => {
    // Manually craft SGML with one valid and one invalid (no amount) txn
    const buf = Buffer.from(`<OFX>
<STMTTRN>
<DTPOSTED>20240601
<TRNAMT>100.00
<FITID>GOOD1
<NAME>VALID
</STMTTRN>
<STMTTRN>
<DTPOSTED>20240602
<FITID>BAD1
<NAME>NO AMOUNT
</STMTTRN>
</OFX>`);

    const result = OFXParserService.parse(buf, 'partial.ofx');

    expect(result.success).toBe(true);
    expect(result.transactions).toHaveLength(1);
    expect(result.skippedLines).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  // ── TEST 13: LEDGERBAL closing balance extracted ──────────────────────────
  test('TEST-OFX-13: Closing balance from LEDGERBAL is returned', () => {
    const balanceLine = `<LEDGERBAL>
<BALAMT>12345.67
<DTASOF>20240531`;

    const buf = makeOfx1([
      { dtposted: '20240510', amount: '100.00', fitid: 'B1', name: 'DEPOSIT' },
    ], balanceLine);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    expect(result.closingBalance).toBe(12345.67);
  });

  // ── TEST 14: computeFileHash returns consistent SHA-256 ───────────────────
  test('TEST-OFX-14: computeFileHash returns a consistent 64-char hex string', () => {
    const buf = Buffer.from('test content');
    const hash1 = OFXParserService.computeFileHash(buf);
    const hash2 = OFXParserService.computeFileHash(buf);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(/^[a-f0-9]{64}$/.test(hash1)).toBe(true);
  });

  // ── TEST 15: isAllowedFile — .ofx and .qfx pass, others rejected ──────────
  test('TEST-OFX-15: isAllowedFile accepts .ofx and .qfx, rejects .csv and .pdf', () => {
    expect(OFXParserService.isAllowedFile('application/octet-stream', 'statement.ofx')).toBe(true);
    expect(OFXParserService.isAllowedFile('application/octet-stream', 'statement.qfx')).toBe(true);
    expect(OFXParserService.isAllowedFile('text/csv',                  'export.csv')).toBe(false);
    expect(OFXParserService.isAllowedFile('application/pdf',           'statement.pdf')).toBe(false);
  });

  // ── TEST 16: Statement period returned when DTSTART/DTEND present ─────────
  test('TEST-OFX-16: Statement period is returned when DTSTART and DTEND are present', () => {
    const buf = makeOfx1([
      { dtposted: '20240510', amount: '100.00', fitid: 'SP1', name: 'DEPOSIT' },
    ]);

    const result = OFXParserService.parse(buf, 'statement.ofx');
    // makeOfx1 includes DTSTART>20240501 and DTEND>20240531
    expect(result.statementPeriod).toBeTruthy();
    expect(result.statementPeriod).toContain('2024-05-01');
    expect(result.statementPeriod).toContain('2024-05-31');
  });

});
