/**
 * ============================================================================
 * Slips — the 'slip_read' job for the local AI worker (layer 3)
 * ============================================================================
 *   payload(job)       → what the worker needs: a downsized photo + the OCR text
 *   complete(job, out) → merge + check the answer (localAiReading.js) and store it
 *                        as a new, append-only slip_readings row (engine 'local-ai')
 * Only photos are sent (PDFs are read by layer 2 from their text layer).
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../../config/database');
const { downloadSlipFile } = require('./storageService');
const { mergeAiReading, withMemory } = require('./localAiReading');
const { OCR_IMAGE_TYPES } = require('./slipReader');
const { amountsInLine } = require('./slipParser');

// Longest side of the photo sent to the local model. On a CPU-only computer the time
// grows steeply with image size (measured 2026-11-10: 1280 px ≈ 110–180 s per slip).
const MAX_SIDE = Number(process.env.LOCAL_AI_IMAGE_MAX_SIDE) || 640;

async function loadSlip(job) {
  const { data: slip, error } = await supabase.from('slips')
    .select('id, company_id, storage_path, content_type')
    .eq('id', job.ref_id).eq('company_id', job.company_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!slip) throw Object.assign(new Error('Slip not found'), { permanent: true });
  return slip;
}

async function latestReading(slip) {
  const { data } = await supabase.from('slip_readings').select('id, engine, raw_text, suggestion')
    .eq('company_id', slip.company_id).eq('slip_id', slip.id).order('id', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}

// ── Examples (opsie A, 2026-11-13) ──────────────────────────────────────────
// Up to 2 earlier slips from the SAME supplier in the SAME company, with the
// values a person saved, so the model sees how this supplier prints its slips.
// Never from another company: a slip is that client's data (Ruan 2026-11-13).
// Text only (no example photos) — photos dominate CPU time on Ruan's computer.
const MAX_EXAMPLES = 2;
const EXAMPLE_TEXT_CHARS = 1200;

/**
 * Pure: turn candidate slips (+ their OCR text) into prompt examples.
 * Only slips whose saved total is actually printed in their OCR text are
 * used — an example whose text does not show the answer would mislead.
 */
function buildExamples(candidates) {
  const out = [];
  for (const c of candidates || []) {
    if (out.length >= MAX_EXAMPLES) break;
    const amount = Number(c.amount);
    const text = String(c.raw_text || '');
    if (!(amount > 0) || !c.slip_date || !text.trim()) continue;
    const printed = text.split(/\r?\n/).some(l => amountsInLine(l).some(a => Math.abs(a - amount) <= 0.01));
    if (!printed) continue;
    out.push({
      ocr_text: text.slice(0, EXAMPLE_TEXT_CHARS),
      answer: {
        supplier_name: c.supplier_name || null,
        slip_date: String(c.slip_date).slice(0, 10),
        total: amount,
        vat_amount: c.vat_amount === null || c.vat_amount === undefined ? null : Number(c.vat_amount),
        supplier_vat_number: c.supplier_vat_number || null,
      },
    });
  }
  return out;
}

async function findExamples(slip, prev) {
  const s = (prev && prev.suggestion) || {};
  const vat = s.supplier_vat_number && /^4\d{9}$/.test(String(s.supplier_vat_number.value)) ? s.supplier_vat_number.value : null;
  // A name only counts when supplier memory (human-confirmed) recognised it.
  const name = !vat && s.supplier_name && s.supplier_name.source === 'memory' ? s.supplier_name.value : null;
  if (!vat && !name) return [];

  let q = supabase.from('slips')
    .select('id, supplier_name, supplier_vat_number, slip_date, amount, vat_amount')
    .eq('company_id', slip.company_id).eq('status', 'active').neq('id', slip.id)
    .not('amount', 'is', null).not('slip_date', 'is', null);
  q = vat ? q.eq('supplier_vat_number', vat) : q.eq('supplier_name', name);
  const { data: slips, error } = await q.order('updated_at', { ascending: false }).limit(6);
  if (error || !slips || !slips.length) return [];

  const { data: reads } = await supabase.from('slip_readings')
    .select('slip_id, raw_text').eq('company_id', slip.company_id)
    .in('slip_id', slips.map(x => x.id)).not('raw_text', 'is', null)
    .order('id', { ascending: false });
  const textBySlip = new Map();
  for (const r of reads || []) if (!textBySlip.has(r.slip_id)) textBySlip.set(r.slip_id, r.raw_text);
  return buildExamples(slips.map(x => ({ ...x, raw_text: textBySlip.get(x.id) })));
}

async function payload(job) {
  const slip = await loadSlip(job);
  if (!OCR_IMAGE_TYPES.has(slip.content_type)) throw Object.assign(new Error('Only photos are read by the AI reader'), { permanent: true });
  const buf = await downloadSlipFile(slip.storage_path);
  const sharp = require('sharp');
  const small = await sharp(buf).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  const prev = await latestReading(slip);
  const examples = await findExamples(slip, prev).catch(err => {
    console.error('[slips] AI examples lookup failed:', err.message);
    return [];
  });
  return {
    image_base64: small.toString('base64'),
    image_mime: 'image/jpeg',
    ocr_text: prev && prev.raw_text ? String(prev.raw_text).slice(0, 4000) : '',
    // Older workers ignore this field; newer ones put it in the prompt.
    examples
  };
}

async function complete(job, output) {
  const slip = await loadSlip(job);
  const prev = await latestReading(slip);
  const rawText = prev && prev.raw_text ? prev.raw_text : '';
  let merged = mergeAiReading(prev ? prev.suggestion : {}, output.fields || {}, rawText);
  merged = await withMemory(slip.company_id, merged, rawText);

  const { data, error } = await supabase.from('slip_readings').insert({
    company_id: slip.company_id,
    slip_id: slip.id,
    engine: 'local-ai',
    engine_detail: String(output.model || 'ollama').slice(0, 80) + (prev ? ` + ${prev.engine}` : ''),
    status: 'done',
    raw_text: rawText ? String(rawText).slice(0, 20000) : null,
    ocr_confidence: null,
    suggestion: merged.fields,
    checks: merged.checks,
    needs_review: merged.needs_review,
    error: null,
    duration_ms: Number.isFinite(Number(output.duration_ms)) ? Math.round(Number(output.duration_ms)) : null
  }).select('id').single();
  if (error) throw new Error('Could not store the AI reading: ' + error.message);
  await supabase.from('slips').update({ reading_status: 'done' }).eq('id', slip.id).eq('company_id', slip.company_id);
  return { reading_id: data.id, needs_review: merged.needs_review };
}

module.exports = { payload, complete, buildExamples, findExamples };
