/**
 * ============================================================================
 * Tests — Image Statement Import Service
 * ============================================================================
 * Tests cover:
 *   A. isAllowedFile() — MIME and extension validation
 *   B. _makeExternalId() — external ID generation
 *   C. parseImage() with mocked OCR — happy path (FNB-like text)
 *   D. parseImage() — OCR unavailable (503-class error)
 *   E. parseImage() — low word count (unreadable image)
 *   F. parseImage() — OCR throws exception
 *   G. parseImage() — parser returns 0 transactions
 *   H. parseImage() — generic fallback parser selected
 * ============================================================================
 */

'use strict';

// ── Module under test ──────────────────────────────────────────────────────
const ImageStatementImportService = require('../sean/image-statement-import-service');

// ── Dependencies to mock ───────────────────────────────────────────────────
jest.mock('../sean/ocr-service');
jest.mock('../sean/pdf-statement-parsers/parser-registry');

const OcrService = require('../sean/ocr-service');
const ParserRegistry = require('../sean/pdf-statement-parsers/parser-registry');

// ── Minimal FNB-like OCR text fixture ─────────────────────────────────────
const FNB_OCR_TEXT = `
First National Bank
Account Number: 62123456789
Statement Period: 01 Jan 2026 to 31 Jan 2026

Date       Description                        Debit     Credit    Balance
2026/01/05 Opening Balance                                        10000.00
2026/01/06 WOOLWORTHS CAPE TOWN               -500.00             9500.00
2026/01/10 SALARY PAYMENT ACME CO                       15000.00 24500.00
2026/01/15 CAPITEC ATM WITHDRAWAL             -1000.00            23500.00
2026/01/20 STANDARD BANK TRANSFER IN                    2500.00  26000.00
2026/01/28 AIRTIME PURCHASE MTN               -150.00            25850.00
`.trim();

// ── Stub parser that returns predictable results ───────────────────────────
function makeMockParser(bank, transactions = []) {
  return {
    PARSER_ID: bank.toLowerCase().replace(/\s+/g, '-'),
    parse: jest.fn().mockReturnValue({
      bank,
      parserId: bank.toLowerCase().replace(/\s+/g, '-'),
      accountNumber: '62123456789',
      statementPeriod: { from: '2026-01-01', to: '2026-01-31' },
      transactions,
      warnings: [],
      skippedLines: 0,
    }),
  };
}

const SAMPLE_TRANSACTIONS = [
  { date: '2026-01-06', description: 'WOOLWORTHS CAPE TOWN', reference: null, amount: -500, balance: 9500, rawLine: null },
  { date: '2026-01-10', description: 'SALARY PAYMENT ACME CO', reference: null, amount: 15000, balance: 24500, rawLine: null },
  { date: '2026-01-15', description: 'CAPITEC ATM WITHDRAWAL', reference: null, amount: -1000, balance: 23500, rawLine: null },
  { date: '2026-01-20', description: 'STANDARD BANK TRANSFER IN', reference: null, amount: 2500, balance: 26000, rawLine: null },
  { date: '2026-01-28', description: 'AIRTIME PURCHASE MTN', reference: null, amount: -150, balance: 25850, rawLine: null },
];

// ── Test setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Default: OCR is available and works
  OcrService.isAvailable.mockReturnValue({
    tesseract: true,
    pdftoppm: true,
    imageOcr: true,
    pdfOcr: true,
  });

  OcrService.extractTextFromImage.mockResolvedValue({
    text: FNB_OCR_TEXT,
    confidence: 85,
  });

  const mockParser = makeMockParser('First National Bank', SAMPLE_TRANSACTIONS);

  ParserRegistry.selectParser.mockReturnValue({
    parser: mockParser,
    confidence: 0.92,
    isGenericFallback: false,
    allScores: [
      { bank: 'FNB', confidence: 0.92 },
      { bank: 'ABSA', confidence: 0.12 },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. isAllowedFile()
// ─────────────────────────────────────────────────────────────────────────────

describe('ImageStatementImportService.isAllowedFile', () => {
  test('accepts image/jpeg MIME', () => {
    expect(ImageStatementImportService.isAllowedFile('image/jpeg')).toBe(true);
  });

  test('accepts image/jpg MIME', () => {
    expect(ImageStatementImportService.isAllowedFile('image/jpg')).toBe(true);
  });

  test('accepts image/png MIME', () => {
    expect(ImageStatementImportService.isAllowedFile('image/png')).toBe(true);
  });

  test('accepts image/webp MIME', () => {
    expect(ImageStatementImportService.isAllowedFile('image/webp')).toBe(true);
  });

  test('accepts MIME with charset suffix gracefully', () => {
    expect(ImageStatementImportService.isAllowedFile('image/jpeg; charset=utf-8')).toBe(true);
  });

  test('accepts .jpg extension when MIME is empty', () => {
    expect(ImageStatementImportService.isAllowedFile('', 'statement.jpg')).toBe(true);
  });

  test('accepts .jpeg extension', () => {
    expect(ImageStatementImportService.isAllowedFile('', 'statement.jpeg')).toBe(true);
  });

  test('accepts .png extension', () => {
    expect(ImageStatementImportService.isAllowedFile('', 'statement.png')).toBe(true);
  });

  test('accepts .webp extension', () => {
    expect(ImageStatementImportService.isAllowedFile('', 'statement.webp')).toBe(true);
  });

  test('rejects application/pdf', () => {
    expect(ImageStatementImportService.isAllowedFile('application/pdf', 'statement.pdf')).toBe(false);
  });

  test('rejects text/csv', () => {
    expect(ImageStatementImportService.isAllowedFile('text/csv', 'statement.csv')).toBe(false);
  });

  test('rejects .gif extension', () => {
    expect(ImageStatementImportService.isAllowedFile('', 'statement.gif')).toBe(false);
  });

  test('rejects .tif extension (not in allowed list)', () => {
    expect(ImageStatementImportService.isAllowedFile('image/tiff', 'statement.tif')).toBe(false);
  });

  test('rejects empty MIME and no filename', () => {
    expect(ImageStatementImportService.isAllowedFile('', '')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. _makeExternalId()
// ─────────────────────────────────────────────────────────────────────────────

describe('ImageStatementImportService._makeExternalId', () => {
  test('generates img-prefixed ID', () => {
    const id = ImageStatementImportService._makeExternalId({
      date: '2026-01-06',
      amount: -500,
      description: 'WOOLWORTHS CAPE TOWN',
    });
    expect(id).toMatch(/^img-/);
  });

  test('includes date segment', () => {
    const id = ImageStatementImportService._makeExternalId({
      date: '2026-01-06',
      amount: 100,
      description: 'Test',
    });
    expect(id).toContain('2026-01-06');
  });

  test('includes amount in cents', () => {
    const id = ImageStatementImportService._makeExternalId({
      date: '2026-01-06',
      amount: -500,
      description: 'Test',
    });
    // -500 ZAR = -50000 cents
    expect(id).toContain('-50000');
  });

  test('description is lowercased + alphanumeric only in ID', () => {
    const id = ImageStatementImportService._makeExternalId({
      date: '2026-01-06',
      amount: 100,
      description: 'WOOLWORTHS - CAPE TOWN!',
    });
    expect(id).not.toMatch(/[^a-z0-9\-]/);
  });

  test('handles missing date gracefully', () => {
    const id = ImageStatementImportService._makeExternalId({
      date: null,
      amount: 50,
      description: 'Mystery',
    });
    expect(id).toContain('nodate');
  });

  test('handles missing description gracefully', () => {
    const id = ImageStatementImportService._makeExternalId({
      date: '2026-01-01',
      amount: 100,
      description: null,
    });
    expect(id).toBeDefined();
    expect(id).toMatch(/^img-/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. parseImage() — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('ImageStatementImportService.parseImage — happy path', () => {
  const fakeBuffer = Buffer.from('fake-image-data');
  const filename = 'fnb-january-2026.jpg';

  test('returns success: true', async () => {
    const result = await ImageStatementImportService.parseImage(fakeBuffer, filename);
    expect(result.success).toBe(true);
  });

  test('sets isImageOcr: true', async () => {
    const result = await ImageStatementImportService.parseImage(fakeBuffer, filename);
    expect(result.isImageOcr).toBe(true);
  });

  test('returns the bank name from parser', async () => {
    const result = await ImageStatementImportService.parseImage(fakeBuffer, filename);
    expect(result.bank).toBe('First National Bank');
  });

  test('returns correct transaction count', async () => {
    const result = await ImageStatementImportService.parseImage(fakeBuffer, filename);
    expect(result.transactions).toHaveLength(SAMPLE_TRANSACTIONS.length);
  });

  test('money-out transactions have moneyOut set and moneyIn null', async () => {
    const result = await ImageStatementImportService.parseImage(fakeBuffer, filename);
    const debit = result.transactions.find(t => t.description === 'WOOLWORTHS CAPE TOWN');
    expect(debit).toBeDefined();
    expect(debit.moneyOut).toBe(500);
    expect(debit.moneyIn).toBeNull();
  });

  test('money-in transactions have moneyIn set and moneyOut null', async () => {
    const result = await ImageStatementImportService.parseImage(fakeBuffer, filename);
    const credit = result.transactions.find(t => t.description === 'SALARY PAYMENT ACME CO');
    expect(credit).toBeDefined();
    expect(credit.moneyIn).toBe(15000);
    expect(credit.moneyOut).toBeNull();
  });

  test('each transaction has an externalId prefixed img-', async () => {
    const result = await ImageStatementImportService.parseImage(fakeBuffer, filename);
    result.transactions.forEach(t => {
      expect(t.externalId).toMatch(/^img-/);
    });
  });

  test('includes importedAt ISO timestamp', async () => {
    const result = await ImageStatementImportService.parseImage(fakeBuffer, filename);
    expect(result.importedAt).toBeDefined();
    expect(() => new Date(result.importedAt).toISOString()).not.toThrow();
  });

  test('passes correct extension to OcrService', async () => {
    await ImageStatementImportService.parseImage(fakeBuffer, 'statement.png');
    const callArgs = OcrService.extractTextFromImage.mock.calls[0];
    expect(callArgs[1]).toMatchObject({ ext: '.png' });
  });

  test('does not set rawTextSample when transactions extracted', async () => {
    const result = await ImageStatementImportService.parseImage(fakeBuffer, filename);
    expect(result.rawTextSample).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. parseImage() — OCR unavailable
// ─────────────────────────────────────────────────────────────────────────────

describe('ImageStatementImportService.parseImage — OCR unavailable', () => {
  test('returns success: false with descriptive error', async () => {
    OcrService.isAvailable.mockReturnValue({
      tesseract: false,
      pdftoppm: false,
      imageOcr: false,
      pdfOcr: false,
    });

    const result = await ImageStatementImportService.parseImage(
      Buffer.from('data'), 'statement.jpg'
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OCR/i);
  });

  test('does NOT call extractTextFromImage when OCR unavailable', async () => {
    OcrService.isAvailable.mockReturnValue({ imageOcr: false });

    await ImageStatementImportService.parseImage(Buffer.from('data'), 'statement.jpg');
    expect(OcrService.extractTextFromImage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. parseImage() — low word count (unreadable image)
// ─────────────────────────────────────────────────────────────────────────────

describe('ImageStatementImportService.parseImage — low word count', () => {
  test('returns success: false for near-empty OCR text', async () => {
    OcrService.extractTextFromImage.mockResolvedValue({ text: 'too few words', confidence: 20 });

    const result = await ImageStatementImportService.parseImage(
      Buffer.from('data'), 'blurry.jpg'
    );
    expect(result.success).toBe(false);
    expect(result.isLowQuality).toBe(true);
    expect(result.transactions).toHaveLength(0);
  });

  test('low-quality result still has correct shape', async () => {
    OcrService.extractTextFromImage.mockResolvedValue({ text: 'three words only', confidence: 10 });

    const result = await ImageStatementImportService.parseImage(
      Buffer.from('data'), 'blurry.jpg'
    );
    expect(result).toMatchObject({
      success: false,
      isImageOcr: true,
      isLowQuality: true,
      bank: null,
      transactions: [],
    });
  });

  test('does NOT call ParserRegistry when word count too low', async () => {
    OcrService.extractTextFromImage.mockResolvedValue({ text: 'five words here ok', confidence: 15 });

    await ImageStatementImportService.parseImage(Buffer.from('data'), 'blurry.jpg');
    expect(ParserRegistry.selectParser).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. parseImage() — OCR throws exception
// ─────────────────────────────────────────────────────────────────────────────

describe('ImageStatementImportService.parseImage — OCR throws', () => {
  test('returns success: false with error message', async () => {
    OcrService.extractTextFromImage.mockRejectedValue(new Error('tesseract segfault'));

    const result = await ImageStatementImportService.parseImage(
      Buffer.from('data'), 'statement.jpg'
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/tesseract segfault/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. parseImage() — parser returns 0 transactions
// ─────────────────────────────────────────────────────────────────────────────

describe('ImageStatementImportService.parseImage — 0 transactions', () => {
  test('returns success: true with empty transactions array', async () => {
    const emptyParser = makeMockParser('FNB', []);
    ParserRegistry.selectParser.mockReturnValue({
      parser: emptyParser,
      confidence: 0.7,
      isGenericFallback: false,
      allScores: [],
    });

    const result = await ImageStatementImportService.parseImage(
      Buffer.from('data'), 'statement.jpg'
    );
    expect(result.success).toBe(true);
    expect(result.transactions).toHaveLength(0);
  });

  test('includes rawTextSample when 0 transactions', async () => {
    const emptyParser = makeMockParser('FNB', []);
    ParserRegistry.selectParser.mockReturnValue({
      parser: emptyParser,
      confidence: 0.6,
      isGenericFallback: false,
      allScores: [],
    });

    const result = await ImageStatementImportService.parseImage(
      Buffer.from('data'), 'statement.jpg'
    );
    expect(result.rawTextSample).toBeDefined();
    expect(typeof result.rawTextSample).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. parseImage() — generic fallback parser
// ─────────────────────────────────────────────────────────────────────────────

describe('ImageStatementImportService.parseImage — generic fallback', () => {
  test('sets isGenericFallback: true in result', async () => {
    const genericParser = makeMockParser('Generic', SAMPLE_TRANSACTIONS);
    ParserRegistry.selectParser.mockReturnValue({
      parser: genericParser,
      confidence: 0.1,
      isGenericFallback: true,
      allScores: [
        { bank: 'FNB', confidence: 0.1 },
        { bank: 'ABSA', confidence: 0.08 },
      ],
    });

    const result = await ImageStatementImportService.parseImage(
      Buffer.from('data'), 'unknown-bank.jpg'
    );
    expect(result.isGenericFallback).toBe(true);
  });

  test('adds a warning about unrecognised bank', async () => {
    const genericParser = makeMockParser('Generic', SAMPLE_TRANSACTIONS);
    ParserRegistry.selectParser.mockReturnValue({
      parser: genericParser,
      confidence: 0.1,
      isGenericFallback: true,
      allScores: [{ bank: 'FNB', confidence: 0.1 }],
    });

    const result = await ImageStatementImportService.parseImage(
      Buffer.from('data'), 'unknown-bank.jpg'
    );
    expect(result.warnings.some(w => /bank not identified/i.test(w))).toBe(true);
  });

  test('still extracts transactions via generic parser', async () => {
    const genericParser = makeMockParser('Generic', SAMPLE_TRANSACTIONS);
    ParserRegistry.selectParser.mockReturnValue({
      parser: genericParser,
      confidence: 0.1,
      isGenericFallback: true,
      allScores: [],
    });

    const result = await ImageStatementImportService.parseImage(
      Buffer.from('data'), 'unknown-bank.jpg'
    );
    expect(result.transactions).toHaveLength(SAMPLE_TRANSACTIONS.length);
  });
});
