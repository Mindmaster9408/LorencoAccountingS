'use strict';

const TeachPaytimeService = require('../sean/teach-paytime-service');

// ─────────────────────────────────────────────────────────────────────────────
// TeachPaytimeService — Unit Tests
//
// GOVERNANCE: These tests verify parse-only behaviour.
// No database writes occur in any test.
// ─────────────────────────────────────────────────────────────────────────────

describe('TeachPaytimeService.parseInput', () => {

  // ── TEST-TP-01: Parse valid CSV input ──────────────────────────────────────
  test('TEST-TP-01: Parses valid CSV and extracts 3 items correctly', () => {
    const text = `Item Name, IRP5 Code
Commission, 3606
Travel Allowance, 3701
Provident Fund, 3801`;

    const result = TeachPaytimeService.parseInput(text);

    expect(result.success).toBe(true);
    expect(result.format).toBe('csv');
    expect(result.items).toHaveLength(3);
    expect(result.items[0].item_name).toBe('Commission');
    expect(result.items[0].irp5_code).toBe('3606');
    expect(result.items[1].item_name).toBe('Travel Allowance');
    expect(result.items[1].irp5_code).toBe('3701');
    expect(result.items[2].item_name).toBe('Provident Fund');
    expect(result.items[2].irp5_code).toBe('3801');
  });

  // ── TEST-TP-02: Parse bullet/text input ───────────────────────────────────
  test('TEST-TP-02: Parses bullet/text input and extracts item name + IRP5 code', () => {
    const text = `- Commission must use IRP5 3606 and is taxable.
- Travel Allowance is code 3701.
- Provident Fund deduction is 3801.`;

    const result = TeachPaytimeService.parseInput(text);

    expect(result.success).toBe(true);
    expect(result.format).toBe('bullet');
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    const commItem = result.items.find(i => i.irp5_code === '3606');
    expect(commItem).toBeTruthy();
  });

  // ── TEST-TP-03: Parse table/pipe-delimited input ──────────────────────────
  test('TEST-TP-03: Parses pipe-delimited table with taxable and UIF columns', () => {
    const text = `Item Name | IRP5 Code | Taxable | UIF
Commission | 3606 | Yes | Yes
Travel Allowance | 3701 | Yes | No`;

    const result = TeachPaytimeService.parseInput(text);

    expect(result.success).toBe(true);
    expect(result.format).toBe('table');
    expect(result.items).toHaveLength(2);
    expect(result.items[0].irp5_code).toBe('3606');
    expect(result.items[0].taxable).toBe(true);
    expect(result.items[0].affects_uif).toBe(true);
    expect(result.items[1].affects_uif).toBe(false);
  });

  // ── TEST-TP-04: Minimum extraction — item_name + irp5_code ────────────────
  test('TEST-TP-04: Minimum valid extraction requires only item_name', () => {
    const text = `Item Name
Commission`;

    const result = TeachPaytimeService.parseInput(text);
    expect(result.success).toBe(true);
    const item = result.items[0];
    expect(item.item_name).toBe('Commission');
    expect(item.irp5_code).toBeNull(); // no code — item still valid
  });

  // ── TEST-TP-05: Missing optional fields are null, not guessed ─────────────
  test('TEST-TP-05: Missing optional fields are null, not guessed values', () => {
    const text = `Item Name, IRP5 Code
Basic Salary, 3601`;

    const result = TeachPaytimeService.parseInput(text);
    const item = result.items[0];

    expect(item.taxable).toBeNull();     // not in CSV — must be null
    expect(item.affects_uif).toBeNull(); // not in CSV — must be null
    expect(item.affects_sdl).toBeNull(); // not in CSV — must be null
  });

  // ── TEST-TP-06: Duplicate detection within batch ──────────────────────────
  test('TEST-TP-06: Duplicate items within the same batch are flagged', () => {
    const text = `Item Name, IRP5 Code
Commission, 3606
Commission, 3606`;

    const result = TeachPaytimeService.parseInput(text);

    expect(result.duplicatesInBatch).toBe(1);
    const dups = result.items.filter(i => i.isDuplicate);
    expect(dups).toHaveLength(1);
    expect(dups[0].item_name).toBe('Commission');
  });

  // ── TEST-TP-07: Empty input returns error ─────────────────────────────────
  test('TEST-TP-07: Empty input returns success=false with clear error', () => {
    const result = TeachPaytimeService.parseInput('');
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  // ── TEST-TP-08: Unparseable text returns error ────────────────────────────
  test('TEST-TP-08: Text with no extractable items returns success=false', () => {
    const result = TeachPaytimeService.parseInput('hello world this has nothing useful');
    expect(result.success).toBe(false);
  });

  // ── TEST-TP-09: IRP5 code validated as 4-digit format ────────────────────
  test('TEST-TP-09: Non-numeric IRP5 code is not extracted (stays null)', () => {
    const text = `Item Name, IRP5 Code
Commission, ABCD`;

    const result = TeachPaytimeService.parseInput(text);
    expect(result.success).toBe(true);
    expect(result.items[0].irp5_code).toBeNull();
  });

  // ── TEST-TP-10: Import batch ID is always a UUID ──────────────────────────
  test('TEST-TP-10: importBatchId is a UUID string', () => {
    const text = 'Commission, 3606';
    const result = TeachPaytimeService.parseInput(text);
    expect(result.success).toBe(true);
    expect(result.importBatchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  // ── TEST-TP-11: Confidence score is in range 0.0–1.0 ─────────────────────
  test('TEST-TP-11: Confidence score is between 0.0 and 1.0 inclusive', () => {
    const text = `Item Name, IRP5 Code
Commission, 3606
Basic Salary, 3601`;

    const result = TeachPaytimeService.parseInput(text);
    result.items.forEach(item => {
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ── TEST-TP-12: CSV with taxable/UIF columns parsed correctly ─────────────
  test('TEST-TP-12: CSV with extra Taxable column correctly maps booleans', () => {
    const text = `Item Name, IRP5 Code, Taxable, UIF
Commission, 3606, Yes, Yes
Housing Allowance, 3713, No, No`;

    const result = TeachPaytimeService.parseInput(text);
    expect(result.items[0].taxable).toBe(true);
    expect(result.items[0].affects_uif).toBe(true);
    expect(result.items[1].taxable).toBe(false);
    expect(result.items[1].affects_uif).toBe(false);
  });

  // ── TEST-TP-13: Bullet text extracts taxable flag ─────────────────────────
  test('TEST-TP-13: Bullet text detects taxable flag from natural language', () => {
    const result = TeachPaytimeService.parseInput('Commission is IRP5 3606 and is taxable.');
    expect(result.success).toBe(true);
    const item = result.items[0];
    expect(item.irp5_code).toBe('3606');
    expect(item.taxable).toBe(true);
  });

  // ── TEST-TP-14: normalizeKey produces clean keys ──────────────────────────
  test('TEST-TP-14: normalizeKey strips special chars and lowercases', () => {
    expect(TeachPaytimeService.normalizeKey('Basic Salary')).toBe('basic_salary');
    expect(TeachPaytimeService.normalizeKey('Travel  Allowance (Fixed)')).toBe('travel_allowance_fixed');
    expect(TeachPaytimeService.normalizeKey('  Commission  ')).toBe('commission');
  });

  // ── TEST-TP-15: Source text preserved per item ────────────────────────────
  test('TEST-TP-15: Each item retains the original source line as source_text', () => {
    const text = `Item Name, IRP5 Code
Commission, 3606`;

    const result = TeachPaytimeService.parseInput(text);
    expect(result.items[0].source_text).toBeTruthy();
    expect(typeof result.items[0].source_text).toBe('string');
  });

  // ── TEST-TP-16: Empty lines in CSV are skipped ────────────────────────────
  test('TEST-TP-16: Empty lines in input do not produce empty items', () => {
    const text = `Item Name, IRP5 Code
Commission, 3606

Travel Allowance, 3701

`;

    const result = TeachPaytimeService.parseInput(text);
    expect(result.success).toBe(true);
    expect(result.items).toHaveLength(2);
    result.items.forEach(i => expect(i.item_name).toBeTruthy());
  });

  // ── TEST-TP-17: Create proposals does NOT approve (governance test) ────────
  // This is a structural assertion — it confirms the parse endpoint never
  // returns an 'approved' or 'synced' status. Approval is a separate action.
  test('TEST-TP-17: Parse result never contains approved/synced status', () => {
    const text = `Commission, 3606`;
    const result = TeachPaytimeService.parseInput(text);
    expect(result.success).toBe(true);
    // Parse result has no status field (it's not a DB record)
    result.items.forEach(item => {
      expect(item).not.toHaveProperty('status');
      expect(item).not.toHaveProperty('approved');
      expect(item).not.toHaveProperty('synced');
    });
  });

  // ── TEST-TP-18: Warnings array is always present ──────────────────────────
  test('TEST-TP-18: warnings array is always present in successful result', () => {
    const text = `Commission, 3606`;
    const result = TeachPaytimeService.parseInput(text);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

});
