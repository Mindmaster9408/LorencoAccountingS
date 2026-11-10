'use strict';

/**
 * ============================================================================
 * Slip Capture — reading layer tests (pure functions, no DB, no OCR binary)
 * ============================================================================
 * All slip texts are FICTIONAL. They mimic what Tesseract returns for till
 * slips, including typical OCR damage (O for 0, a smudged VAT amount).
 *
 * Invariants:
 *   1. The total is only "high" confidence when the slip's own payment agrees.
 *   2. A smudged VAT amount is accepted only if it differs from the expected
 *      15% by one character, and then only as "medium" (person must check).
 *   3. Supplier memory: VAT-number match beats name match; memory never
 *      overrides amounts/dates read from the slip.
 *   4. OCR noise at the photo edge is never taken as the supplier name.
 * ============================================================================
 */

const { parseSlipText, amountsInLine, ocrGoodEnough } = require('../modules/slips/services/slipParser');
const { matchMemory, applyMemory, nameKey } = require('../modules/slips/services/supplierMemory');

const today = new Date('2026-11-05T10:00:00Z');
const val = (r, k) => r.fields[k] && r.fields[k].value;
const conf = (r, k) => r.fields[k] && r.fields[k].confidence;

describe('slipParser — totals', () => {
  test('card slip: TOTAL confirmed by CARD line is high confidence, OCR O→0 repaired', () => {
    const r = parseSlipText(['SOUTHWAY FUEL STOP', 'VAT No: 4123456789', 'Date: 03/11/2026 14:22',
      'UNLEADED 95 40.12L 900.00', 'TOTAL R 9OO.OO', 'VAT 15% 117.39', 'CARD 900.00'].join('\n'), { today });
    expect(val(r, 'amount')).toBe(900);
    expect(conf(r, 'amount')).toBe('high');
    expect(val(r, 'vat_amount')).toBe(117.39);
    expect(val(r, 'supplier_vat_number')).toBe('4123456789');
    expect(val(r, 'slip_date')).toBe('2026-11-03');
    expect(ocrGoodEnough(r.fields)).toBe(true);
  });

  test('cash slip: tendered minus change confirms the total; SUBTOTAL is ignored', () => {
    const r = parseSlipText(['Corner Deli', '2026-10-30', 'Coffee x2 58.00', 'SUBTOTAL 90.50',
      'TOTAL DUE 90.50', 'CASH 100.00', 'CHANGE 9.50'].join('\n'), { today });
    expect(val(r, 'amount')).toBe(90.5);
    expect(conf(r, 'amount')).toBe('high');
    expect(r.checks.find(c => c.key === 'payment_matches_total').ok).toBe(true);
  });

  test('unconfirmed TOTAL is not high; card "available balance" is never the total', () => {
    const r = parseSlipText(['GREEN GROCER', 'TOTAL 120.00', 'AVAILABLE BALANCE 5 000.00'].join('\n'), { today });
    expect(val(r, 'amount')).toBe(120);
    expect(conf(r, 'amount')).not.toBe('high');
  });

  test('amount formats: thousands with space or comma, decimal comma', () => {
    expect(amountsInLine('TOTAL R 1 234.50')).toEqual([1234.5]);
    expect(amountsInLine('TOTAL 1,234.50')).toEqual([1234.5]);
    expect(amountsInLine('TOTAAL 1234,50')).toEqual([1234.5]);
  });
});

describe('slipParser — VAT', () => {
  test('VAT derived from an "excl. VAT / vatable" line when it matches 15%', () => {
    const r = parseSlipText(['SHOP', 'VATABLE 1 116.97', 'TOTAL INCL VAT 1 284.48'].join('\n'), { today });
    expect(val(r, 'vat_amount')).toBe(167.51);
  });

  test('smudged VAT ("T1039" for 117.39) accepted only as medium', () => {
    const r = parseSlipText(['FUEL', 'TOTAL R 900.00', 'VAT 15% T1039', 'CARD 900.00'].join('\n'), { today });
    expect(val(r, 'vat_amount')).toBe(117.39);
    expect(conf(r, 'vat_amount')).toBe('medium');
  });

  test('unrelated garbage on the VAT line is not turned into a VAT amount', () => {
    const r = parseSlipText(['FUEL', 'TOTAL R 900.00', 'VAT 15% 3D', 'CARD 900.00'].join('\n'), { today });
    expect(r.fields.vat_amount).toBeUndefined();
  });
});

describe('slipParser — dates and supplier', () => {
  test('day/month order (South African) and month names incl. Afrikaans', () => {
    expect(val(parseSlipText('Date: 03/11/2026', { today }), 'slip_date')).toBe('2026-11-03');
    expect(val(parseSlipText('28 Okt 2026', { today }), 'slip_date')).toBe('2026-10-28');
    expect(val(parseSlipText('Nov 1, 2026', { today }), 'slip_date')).toBe('2026-11-01');
  });

  test('future dates are rejected; old dates are low confidence', () => {
    expect(parseSlipText('Date: 01/01/2027', { today }).fields.slip_date).toBeUndefined();
    expect(conf(parseSlipText('Date: 01/01/2024', { today }), 'slip_date')).toBe('low');
  });

  test('photo-edge OCR noise is skipped for the supplier name', () => {
    const r = parseSlipText(['BN Eee mmesSTEET', 'CORNER DELI & BAKERY', 'TOTAL 10.00'].join('\n'), { today });
    expect(val(r, 'supplier_name')).toBe('CORNER DELI & BAKERY');
  });
});

describe('supplierMemory', () => {
  const rows = [
    { name_key: 'southwayfuel', supplier_name: 'Southway Fuel', supplier_vat_number: '4123456789', category: 'Fuel', times_confirmed: 3 },
    { name_key: 'cornerdeli', supplier_name: 'Corner Deli', supplier_vat_number: null, category: 'Meals', times_confirmed: 1 },
  ];

  test('VAT number match is high confidence and fills supplier + category', () => {
    const m = matchMemory(rows, 'SOMETHING\nUNREADABLE', '4123456789');
    expect(m.how).toBe('vat_number');
    const f = applyMemory({ amount: { value: 900, confidence: 'high', source: 'ocr' } }, m);
    expect(f.supplier_name).toMatchObject({ value: 'Southway Fuel', confidence: 'high', source: 'memory' });
    expect(f.category.value).toBe('Fuel');
    expect(f.amount.value).toBe(900); // memory never touches amounts
  });

  test('name match tolerates OCR spacing and is medium confidence', () => {
    const m = matchMemory(rows, 'CORNER  DELI & BAKERY\n2026-10-30', null);
    expect(m.how).toBe('name');
    expect(applyMemory({}, m).supplier_name.confidence).toBe('medium');
  });

  test('no match → fields unchanged', () => {
    expect(matchMemory(rows, 'UNKNOWN SHOP', null)).toBeNull();
    expect(nameKey('Engen  Lynnwood!')).toBe('engenlynnwood');
  });
});
