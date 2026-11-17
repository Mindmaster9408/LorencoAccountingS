'use strict';

/**
 * ============================================================================
 * Slip Capture — examples for the local AI reader (opsie A, 2026-11-13)
 * ============================================================================
 * All slips and VAT numbers are FICTIONAL.
 *
 * Invariants:
 *   1. At most 2 examples, each trimmed — keeps the CPU cost bounded.
 *   2. An example is only used when its saved total is printed in its own
 *      OCR text (otherwise it would teach the model the wrong line).
 *   3. The worker prompt tells the model never to copy example values, and
 *      sends nothing extra when there are no examples (old behaviour).
 * Company scoping (same company only) is enforced by the query in
 * localAiSlipJob.findExamples (company_id filter) — covered by the E2E run.
 * ============================================================================
 */

jest.mock('../config/database', () => ({ supabase: {} }));

const { buildExamples } = require('../modules/slips/services/localAiSlipJob');
const { slipPrompt, examplesText, PROMPT } = require('../../../local-ai-worker/worker');

const slip = (amount, text, extra = {}) => ({
  amount, slip_date: '2026-10-28', supplier_name: 'Karoo Kruidenier',
  supplier_vat_number: '4987654321', vat_amount: 3.26, raw_text: text, ...extra,
});

describe('buildExamples', () => {
  test('keeps at most 2 examples, with the saved values as the answer', () => {
    const t = 'KAROO KRUIDENIER\nSALE AMT 24.99';
    const ex = buildExamples([slip(24.99, t), slip(24.99, t), slip(24.99, t)]);
    expect(ex).toHaveLength(2);
    expect(ex[0].answer).toEqual({
      supplier_name: 'Karoo Kruidenier', slip_date: '2026-10-28', total: 24.99,
      vat_amount: 3.26, supplier_vat_number: '4987654321',
    });
  });

  test('skips slips whose saved total is not in their OCR text, or that have no text/date', () => {
    expect(buildExamples([slip(24.99, 'KAROO\nSALE AMT 99.99')])).toHaveLength(0);
    expect(buildExamples([slip(24.99, '')])).toHaveLength(0);
    expect(buildExamples([slip(24.99, 'SALE AMT 24.99', { slip_date: null })])).toHaveLength(0);
  });

  test('long OCR text is trimmed', () => {
    const t = 'SALE AMT 24.99\n' + 'x'.repeat(5000);
    expect(buildExamples([slip(24.99, t)])[0].ocr_text.length).toBe(1200);
  });
});

describe('worker prompt', () => {
  test('no examples → prompt exactly as before', () => {
    expect(examplesText(undefined)).toBe('');
    expect(slipPrompt({ ocr_text: '' })).toBe(PROMPT);
  });

  test('examples are added with the answer and a do-not-copy instruction, before this slip\'s text', () => {
    const p = slipPrompt({
      ocr_text: 'THIS SLIP TEXT',
      examples: [{ ocr_text: 'SALE AMT 24.99', answer: { total: 24.99 } }],
    });
    expect(p).toMatch(/never copy their amounts or dates/);
    expect(p).toMatch(/Example 1 correct answer: \{"total":24.99\}/);
    expect(p.indexOf('Example 1')).toBeLessThan(p.indexOf('THIS SLIP TEXT'));
  });
});
