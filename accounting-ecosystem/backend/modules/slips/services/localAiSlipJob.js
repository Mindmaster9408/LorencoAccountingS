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

async function payload(job) {
  const slip = await loadSlip(job);
  if (!OCR_IMAGE_TYPES.has(slip.content_type)) throw Object.assign(new Error('Only photos are read by the AI reader'), { permanent: true });
  const buf = await downloadSlipFile(slip.storage_path);
  const sharp = require('sharp');
  const small = await sharp(buf).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  const prev = await latestReading(slip);
  return {
    image_base64: small.toString('base64'),
    image_mime: 'image/jpeg',
    ocr_text: prev && prev.raw_text ? String(prev.raw_text).slice(0, 4000) : ''
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

module.exports = { payload, complete };
