/**
 * ============================================================================
 * Slips — reading service (run, store and fetch slip readings)
 * ============================================================================
 * - Reads run in the background right after upload, so the phone doesn't
 *   wait; the detail sheet then asks for the result (and waits for an
 *   in-flight read instead of starting a second one).
 * - At most MAX_CONCURRENT OCR jobs at a time: Tesseract is CPU-heavy and
 *   shares the server with every other app.
 * - Every reading is stored in slip_readings (append-only): exactly what the
 *   machine proposed, kept next to what the person later saved.
 * ============================================================================
 */

'use strict';

const { supabase } = require('../../../config/database');
const { readSlip, OCR_IMAGE_TYPES } = require('./slipReader');
const { downloadSlipFile } = require('./storageService');
const localAi = require('../../../shared/services/localAiQueue');

const MAX_CONCURRENT = 2;
let running = 0;
const waiting = [];
const inflight = new Map(); // slipId -> Promise<reading>

function acquire() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

function isReadable(contentType) {
  return OCR_IMAGE_TYPES.has(contentType) || contentType === 'application/pdf';
}

async function setStatus(slip, status) {
  const { error } = await supabase.from('slips')
    .update({ reading_status: status })
    .eq('id', slip.id).eq('company_id', slip.company_id);
  if (error) console.error('[slips] reading_status update failed:', error.message);
}

async function runRead(slip, buffer) {
  await acquire();
  try {
    const buf = buffer || await downloadSlipFile(slip.storage_path);
    const r = await readSlip({ buffer: buf, contentType: slip.content_type, companyId: slip.company_id });
    const { data, error } = await supabase.from('slip_readings').insert({
      company_id: slip.company_id,
      slip_id: slip.id,
      engine: r.engine,
      engine_detail: r.engine_detail,
      status: r.status,
      raw_text: r.raw_text,
      ocr_confidence: r.ocr_confidence,
      suggestion: r.suggestion,
      checks: r.checks,
      needs_review: r.needs_review,
      error: r.error,
      duration_ms: r.duration_ms,
    }).select().single();
    if (error) throw new Error('Could not store reading: ' + error.message);
    await setStatus(slip, r.status);
    if (r.status === 'failed') console.error(`[slips] reading slip ${slip.id} failed:`, r.error);
    // Layer 3 (2026-11-10): a photo that layers 1+2 could not read with confidence goes
    // to the local AI worker on Ruan's computer (only when LOCAL_AI_WORKER_TOKEN is set).
    if (r.status === 'done' && r.needs_review && OCR_IMAGE_TYPES.has(slip.content_type)) {
      await localAi.enqueue('slip_read', slip.company_id, slip.id);
    }
    return data;
  } catch (err) {
    console.error(`[slips] reading slip ${slip.id} crashed:`, err.message);
    await setStatus(slip, 'failed');
    throw err;
  } finally {
    release();
  }
}

/** Start (or join) a read of this slip. Resolves with the stored reading row. */
function scheduleRead(slip, buffer) {
  if (inflight.has(slip.id)) return inflight.get(slip.id);
  const p = runRead(slip, buffer).finally(() => inflight.delete(slip.id));
  inflight.set(slip.id, p);
  return p;
}

async function latestReading(companyId, slipId) {
  const { data } = await supabase.from('slip_readings').select('*')
    .eq('company_id', companyId).eq('slip_id', slipId)
    .order('id', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}

/** Latest reading per slip for a page of slips (list view). */
async function latestReadingsFor(companyId, slipIds) {
  if (!slipIds.length) return new Map();
  const { data } = await supabase.from('slip_readings')
    .select('id, slip_id, status, suggestion, needs_review')
    .eq('company_id', companyId).in('slip_id', slipIds)
    .order('id', { ascending: false });
  const map = new Map();
  for (const r of data || []) if (!map.has(r.slip_id)) map.set(r.slip_id, r);
  return map;
}

module.exports = { scheduleRead, latestReading, latestReadingsFor, isReadable, isInflight: id => inflight.has(id) };
