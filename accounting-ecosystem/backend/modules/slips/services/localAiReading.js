/**
 * ============================================================================
 * Slips — layer 3: local AI reader (Ollama on Ruan's computer), merge + checks
 * ============================================================================
 * Ruan 2026-11-10: a vision model on his own computer reads slips that layers
 * 1+2 (supplier memory + Tesseract) could not read with confidence. Nothing is
 * sent to an external AI service. The worker (local-ai-worker/ in the repo root)
 * returns raw fields; THIS file decides what to trust:
 *
 *   - The model's answer is never "high" on its own. A value only becomes high
 *     when something independent agrees: Tesseract read the same number, the
 *     number is printed in the OCR text, or total and VAT agree (15/115).
 *   - A high-confidence Tesseract value is never replaced by a different model
 *     value — the disagreement is shown as a check instead.
 *   - Supplier memory (human-confirmed, layer 1) still wins for the name.
 * The result is a SUGGESTION; the person confirms and saves.
 * ============================================================================
 */

'use strict';

const { buildChecks, needsReview, amountsInLine, DEFAULT_VAT_RATE } = require('./slipParser');
const memory = require('./supplierMemory');

const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol;

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.,-]/g, '').replace(/,(\d{2})$/, '.$1').replace(/,/g, ''));
  return isFinite(n) && n > 0 && n < 10000000 ? Math.round(n * 100) / 100 : null;
}

function isoDate(v, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1) return null;
  const ageDays = (today - d) / 86400000;
  return ageDays >= -2 && ageDays <= 3650 ? { iso: m[0], ageDays } : null;
}

function cleanName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return s.length >= 2 && s.length <= 80 && /[a-z]/i.test(s) ? s : null;
}

/** Normalise the worker's raw JSON (pure). */
function normalise(raw, today) {
  const r = raw || {};
  const vatNo = String(r.supplier_vat_number || '').replace(/\D/g, '');
  const date = isoDate(r.slip_date || r.date, today);
  return {
    supplier_name: cleanName(r.supplier_name || r.supplier),
    slip_date: date,
    amount: money(r.total ?? r.amount),
    vat_amount: money(r.vat_amount ?? r.vat),
    // 10 digits starting with 4; not an obvious placeholder such as 4000000000.
    supplier_vat_number: /^4\d{9}$/.test(vatNo) && !/(\d)\1{6,}/.test(vatNo) ? vatNo : null
  };
}

function textHasAmount(rawText, value) {
  return String(rawText || '').split(/\r?\n/).some(line => amountsInLine(line).some(a => near(a, value)));
}

/**
 * Merge the local model's answer into the Tesseract suggestion (pure).
 * @param prevFields suggestion from layers 1+2 (may be {})
 * @param raw        worker output
 * @param rawText    Tesseract text (may be '')
 * @returns {{ fields, checks, needs_review }}
 */
function mergeAiReading(prevFields, raw, rawText, opts = {}) {
  const vatRate = opts.vatRate ?? DEFAULT_VAT_RATE;
  const ai = normalise(raw, opts.today);
  const fields = Object.assign({}, prevFields || {});
  const extraChecks = [];
  const vatFits = (total, vat) => total && vat && near(vat, total * vatRate / (1 + vatRate), 0.05);

  // Total
  if (ai.amount) {
    const prev = fields.amount;
    if (prev && near(prev.value, ai.amount)) {
      fields.amount = Object.assign({}, prev, { confidence: 'high', source: prev.source + '+ai', reason: 'Tesseract and the AI reader agree' });
    } else if (prev && prev.confidence === 'high') {
      extraChecks.push({ key: 'ai_total_differs', ok: false, message: `AI reader read the total as R${ai.amount.toFixed(2)} — check` });
    } else {
      const corroborated = textHasAmount(rawText, ai.amount) || vatFits(ai.amount, ai.vat_amount);
      fields.amount = { value: ai.amount, confidence: corroborated ? 'high' : 'medium', source: 'ai',
        reason: corroborated ? 'AI reader, confirmed by the slip text / VAT' : 'AI reader — check' };
    }
  }

  // VAT
  if (ai.vat_amount) {
    const prev = fields.vat_amount;
    const total = fields.amount && fields.amount.value;
    if (prev && near(prev.value, ai.vat_amount)) {
      fields.vat_amount = Object.assign({}, prev, { confidence: 'high', source: prev.source + '+ai' });
    } else if (!(prev && prev.confidence === 'high')) {
      fields.vat_amount = { value: ai.vat_amount, confidence: vatFits(total, ai.vat_amount) ? 'high' : 'low', source: 'ai',
        reason: vatFits(total, ai.vat_amount) ? `AI reader, matches ${Math.round(vatRate * 100)}% of the total` : 'AI reader (does not match the total — check)' };
    }
  }

  // Date
  if (ai.slip_date) {
    const prev = fields.slip_date;
    if (prev && prev.value === ai.slip_date.iso) {
      fields.slip_date = Object.assign({}, prev, { confidence: 'high', source: prev.source + '+ai', reason: 'Tesseract and the AI reader agree' });
    } else if (!(prev && prev.confidence === 'high')) {
      fields.slip_date = { value: ai.slip_date.iso, confidence: ai.slip_date.ageDays <= 400 ? 'medium' : 'low', source: 'ai',
        reason: ai.slip_date.ageDays <= 400 ? 'AI reader — check' : 'AI reader: date is far in the past — check' };
    }
  }

  // VAT number
  if (ai.supplier_vat_number && !(fields.supplier_vat_number && fields.supplier_vat_number.confidence === 'high')) {
    const agrees = fields.supplier_vat_number && fields.supplier_vat_number.value === ai.supplier_vat_number;
    fields.supplier_vat_number = { value: ai.supplier_vat_number, confidence: agrees ? 'high' : 'medium', source: agrees ? 'ocr+ai' : 'ai', reason: 'AI reader' };
  }

  // Supplier name (memory is human-confirmed and stays first)
  if (ai.supplier_name && !(fields.supplier_name && fields.supplier_name.source === 'memory')) {
    if (!fields.supplier_name || fields.supplier_name.confidence === 'low') {
      fields.supplier_name = { value: ai.supplier_name, confidence: 'medium', source: 'ai', reason: 'AI reader' };
    }
  }

  const checks = buildChecks(fields, vatRate, null).concat(extraChecks);
  return { fields, checks, needs_review: needsReview(fields) || extraChecks.length > 0 };
}

/** Apply supplier memory using the AI's name / VAT number too (async, DB). */
async function withMemory(companyId, merged, rawText, lookup = memory.lookup) {
  const f = merged.fields;
  const text = [rawText || '', f.supplier_name ? f.supplier_name.value : ''].join('\n');
  const vatNo = f.supplier_vat_number ? f.supplier_vat_number.value : null;
  const match = await lookup(companyId, text, vatNo);
  if (!match) return merged;
  const fields = memory.applyMemory(f, match);
  return Object.assign({}, merged, { fields, needs_review: needsReview(fields) || merged.checks.some(c => c.key === 'ai_total_differs') });
}

module.exports = { mergeAiReading, withMemory, normalise };
