'use strict';

/**
 * ============================================================================
 * Slip Capture — layout learning tests (pure functions, no DB, no OCR binary)
 * ============================================================================
 * All slips, suppliers and VAT numbers are FICTIONAL.
 *
 * Invariants:
 *   1. Only layout is learned (label of the total line, date format) — never
 *      amounts or dates themselves.
 *   2. Payment / change / subtotal lines are never learned as the total line.
 *   3. A company needs 2 agreeing slips before its own layout is used.
 *   4. The company's own layout beats a global one; branch beats chain.
 *   5. Name-keyed suppliers (no VAT number) can never become global.
 *   6. A learned layout never overrides a payment on the slip that disagrees.
 *   7. Without a layout the parser behaves exactly as before.
 * ============================================================================
 */

jest.mock('../config/database', () => ({ supabase: {} }));

const { parseSlipText } = require('../modules/slips/services/slipParser');
const L = require('../modules/slips/services/slipLayout');
const S = require('../sean/slip-layout-learning');
const { readSlip } = require('../modules/slips/services/slipReader');

const today = new Date('2026-11-13T10:00:00Z');
const val = (r, k) => r.fields[k] && r.fields[k].value;
const conf = (r, k) => r.fields[k] && r.fields[k].confidence;

// A fictional chain whose till prints the total as "SALE AMT" (no TOTAL word)
// and writes dates month/day/year.
const ODD_SLIP = [
  'KAROO KRUIDENIER', 'STORE NO: 0417', 'VAT No: 4987654321', '11/03/2026 09:14',
  'BREAD 18.99', 'MILK 2L 32.50', 'SALE AMT 51.49', 'VAT INCL 6.72',
].join('\n');

describe('deriveLayout — what is learned from one saved slip', () => {
  test('total on its labelled line + month/day/year date', () => {
    expect(L.deriveLayout(ODD_SLIP, { amount: 51.49, slipDate: '2026-11-03' }))
      .toEqual({ total_line: 'same:sale amt', date_format: 'mdy' });
  });

  test('label alone with the amount on the next line → "next"', () => {
    const t = ['SOMEWHERE CAFE', 'AMOUNT PAYABLE', '75.00', 'CASH 100.00', 'CHANGE 25.00'].join('\n');
    expect(L.deriveLayout(t, { amount: 75 }).total_line).toBe('next:amount payable');
  });

  test('subtotal, card and change lines are never learned as the total line', () => {
    const t = ['DELI', 'SUBTOTAL 90.50', 'TOTAL DUE 90.50', 'CARD 90.50'].join('\n');
    expect(L.deriveLayout(t, { amount: 90.5 }).total_line).toBe('same:total due');
    const onlyPayment = ['DELI', 'ITEMS 90.50', 'CARD 90.50'].join('\n');
    expect(L.deriveLayout(onlyPayment, { amount: 90.5 }).total_line).toBe('same:items');
    const noLabel = ['DELI', 'CARD 12.00'].join('\n');
    expect(L.deriveLayout(noLabel, { amount: 12 }).total_line).toBeUndefined();
  });

  test('ambiguous date (05/05) teaches nothing; day/month is learned as dmy', () => {
    expect(L.deriveLayout('05/05/2026', { slipDate: '2026-05-05' }).date_format).toBeUndefined();
    expect(L.deriveLayout('Date: 03/11/2026', { slipDate: '2026-11-03' }).date_format).toBe('dmy');
    expect(L.deriveLayout('2026-11-03 10:00', { slipDate: '2026-11-03' }).date_format).toBe('ymd');
  });

  test('nothing is learned when the saved amount is not on the slip', () => {
    expect(L.deriveLayout(ODD_SLIP, { amount: 999.99 }).total_line).toBeUndefined();
  });
});

describe('keys and event rows', () => {
  test('VAT number → global-capable chain key; name only → never global', () => {
    expect(L.chainKeyFor('4987654321', 'Karoo')).toBe('vat:4987654321');
    expect(L.chainKeyFor(null, 'Karoo Kruidenier')).toBe('name:karookruidenier');
    expect(L.globalSubject('name:karookruidenier', null, 'total_line')).toBeNull();
  });

  test('branch number is read from the slip', () => {
    expect(L.branchKeyFrom(ODD_SLIP)).toBe('store:0417');
    expect(L.branchKeyFrom('BRANCH: PRETORIA')).toBeNull(); // no digits → not a store number
  });

  test('chain row always, branch row when a store number is printed', () => {
    const rows = L.buildEventRows({
      companyId: 51, slipId: 7, chainKey: 'vat:4987654321', branchKey: 'store:0417',
      supplierName: 'Karoo Kruidenier', layout: { total_line: 'same:sale amt', date_format: 'mdy' },
    });
    expect(rows).toHaveLength(4);
    expect(rows.map(r => r.global_subject)).toEqual([
      'vat:4987654321|*|total_line', 'vat:4987654321|store:0417|total_line',
      'vat:4987654321|*|date_format', 'vat:4987654321|store:0417|date_format',
    ]);
    // No amounts or dates are stored — only layout values.
    expect(rows.every(r => !('amount' in r) && !('slip_date' in r))).toBe(true);
  });
});

describe('parser with a learned layout', () => {
  test('unusual total label: generic parser misses it, learned layout reads it with confidence', () => {
    const generic = parseSlipText(ODD_SLIP, { today });
    expect(conf(generic, 'amount')).not.toBe('high');
    const learned = parseSlipText(ODD_SLIP, { today, layout: { total_line: 'same:sale amt', date_format: 'mdy' } });
    expect(val(learned, 'amount')).toBe(51.49);
    expect(conf(learned, 'amount')).toBe('high');
  });

  test('month/day/year supplier: learned format reads 11/03 as 3 November', () => {
    expect(val(parseSlipText(ODD_SLIP, { today }), 'slip_date')).toBe('2026-03-11'); // SA default
    const r = parseSlipText(ODD_SLIP, { today, layout: { date_format: 'mdy' } });
    expect(val(r, 'slip_date')).toBe('2026-11-03');
    expect(conf(r, 'slip_date')).toBe('high');
  });

  test('a payment on the slip that disagrees keeps the learned total at medium', () => {
    const t = ['KAROO KRUIDENIER', 'SALE AMT 51.49', 'CARD 60.00'].join('\n');
    const r = parseSlipText(t, { today, layout: { total_line: 'same:sale amt' } });
    expect(conf(r, 'amount')).toBe('medium');
  });

  test('two different values on the learned label → layout ignored, generic parser used', () => {
    const t = ['X', 'SALE AMT 10.00', 'SALE AMT 20.00', 'TOTAL 20.00', 'CARD 20.00'].join('\n');
    const r = parseSlipText(t, { today, layout: { total_line: 'same:sale amt' } });
    expect(val(r, 'amount')).toBe(20);
    expect(r.fields.amount.reason).not.toMatch(/learned/);
  });
});

describe('resolveLayout — which layout wins', () => {
  const ev = (value, branch = null, facet = 'total_line') => ({ facet, value, branch_key: branch });
  const pat = (value, branch = null, facet = 'total_line') => ({ facet, layout_value: value, branch_key: branch });

  test('one company confirmation is not enough; two agreeing are', () => {
    expect(L.resolveLayout({ events: [ev('same:sale amt')] })).toBeNull();
    const r = L.resolveLayout({ events: [ev('same:sale amt'), ev('same:sale amt')] });
    expect(r.total_line).toBe('same:sale amt');
    expect(r.sources.total_line).toBe('company:chain');
  });

  test('company beats global; branch beats chain', () => {
    const r = L.resolveLayout({
      events: [ev('same:mine'), ev('same:mine')],
      patterns: [pat('same:global')], branchKey: null,
    });
    expect(r.total_line).toBe('same:mine');

    const g = L.resolveLayout({
      patterns: [pat('same:chain'), pat('same:potch', 'store:0417')], branchKey: 'store:0417',
    });
    expect(g.total_line).toBe('same:potch');
    expect(g.sources.total_line).toBe('global:branch');

    const other = L.resolveLayout({
      patterns: [pat('same:chain'), pat('same:potch', 'store:0417')], branchKey: 'store:9999',
    });
    expect(other.total_line).toBe('same:chain');
  });

  test('no majority in the company → falls through to global', () => {
    const r = L.resolveLayout({
      events: [ev('same:a'), ev('same:a'), ev('same:b'), ev('same:b')],
      patterns: [pat('same:global')],
    });
    expect(r.total_line).toBe('same:global');
  });
});

describe('Sean proposal rules', () => {
  test('two companies fully agreeing reach the proposal threshold; a split does not', () => {
    expect(S.calculateConfidence(2, 2, 2)).toBeGreaterThanOrEqual(70);
    expect(S.calculateConfidence(3, 2, 5)).toBeLessThan(70);
    expect(S.calculateConfidence(5, 1, 5)).toBeLessThan(100);
  });

  test('subject parsing', () => {
    expect(S.parseSubject('vat:4987654321|store:0417|total_line'))
      .toEqual({ chainKey: 'vat:4987654321', branchKey: 'store:0417', facet: 'total_line' });
    expect(S.parseSubject('vat:4987654321|*|date_format').branchKey).toBeNull();
  });

  test('a branch proposal that matches its chain is redundant (hidden)', () => {
    const branch = { chain_key: 'vat:4987654321', branch_key: 'store:0417', facet: 'total_line', layout_value: 'same:sale amt' };
    const chain = { chain_key: 'vat:4987654321', branch_key: null, facet: 'total_line', layout_value: 'same:sale amt', status: 'proposed' };
    expect(S.isRedundantBranchProposal(branch, [chain])).toBe(true);
    expect(S.isRedundantBranchProposal({ ...branch, layout_value: 'next:total' }, [chain])).toBe(false);
    expect(S.isRedundantBranchProposal(branch, [{ ...chain, status: 'rejected' }])).toBe(false);
  });
});

describe('readSlip uses the learned layout', () => {
  const deps = (layoutLookup) => ({
    ocrAvailable: () => ({ imageOcr: true, pdfOcr: true }),
    ocrImage: async () => ({ text: ODD_SLIP, confidence: 80 }),
    ocrScannedPdf: async () => ({ text: '' }),
    prepareForOcr: async (b) => ({ clean: b, plain: b, cropped: false }),
    pdfText: async () => '',
    memoryLookup: async () => null,
    layoutLookup,
  });

  test('VAT number read → layout looked up → total high, noted in engine detail', async () => {
    const calls = [];
    const r = await readSlip({ buffer: Buffer.from('x'), contentType: 'image/png', companyId: 51 },
      deps(async (companyId, q) => { calls.push(q.vatNumber); return { total_line: 'same:sale amt', sources: { total_line: 'global:chain' } }; }));
    expect(calls[0]).toBe('4987654321');
    expect(r.suggestion.amount.value).toBe(51.49);
    expect(r.suggestion.amount.confidence).toBe('high');
    expect(r.engine_detail).toMatch(/layout\(global:chain\)/);
  });

  test('no layout known → reads exactly as before', async () => {
    const r = await readSlip({ buffer: Buffer.from('x'), contentType: 'image/png', companyId: 51 }, deps(async () => null));
    expect(r.engine_detail).not.toMatch(/layout/);
    expect(r.suggestion.amount && r.suggestion.amount.confidence).not.toBe('high');
  });
});
