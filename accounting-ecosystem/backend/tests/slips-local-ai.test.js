'use strict';

/**
 * Tests — Slip Capture layer 3: local AI reader (Ollama on Ruan's computer).
 * Fictional data only.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const express = require('express');
const mockDb = {};
let mockCalls = [];
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));
jest.mock('../modules/slips/services/localAiSlipJob', () => ({
  payload: async (job) => ({ image_base64: 'AAAA', image_mime: 'image/jpeg', ocr_text: 'job ' + job.ref_id }),
  complete: async (job, out) => { mockCalls.push(out); return { reading_id: 1, needs_review: false }; }
}));
const { mergeAiReading, normalise } = require('../modules/slips/services/localAiReading');

const TODAY = new Date('2026-11-10T10:00:00Z');
const OCR = 'VOORBEELD HARDWARE\nTOTAL R 500.00\nVAT 15% R 65.22';

describe('mergeAiReading — what to trust', () => {
  test('agreement with Tesseract makes a value high', () => {
    const prev = { amount: { value: 500, confidence: 'medium', source: 'ocr', reason: 'x' } };
    const m = mergeAiReading(prev, { total: 500, slip_date: '2026-10-14', supplier_name: 'Voorbeeld Hardware' }, OCR, { today: TODAY });
    expect(m.fields.amount).toMatchObject({ value: 500, confidence: 'high', source: 'ocr+ai' });
    expect(m.fields.slip_date).toMatchObject({ value: '2026-10-14', confidence: 'medium', source: 'ai' });
    expect(m.fields.supplier_name).toMatchObject({ value: 'Voorbeeld Hardware', source: 'ai' });
  });

  test('the model alone is never high; printed in the OCR text or VAT 15/115 confirms it', () => {
    expect(mergeAiReading({}, { total: 812.4 }, '', { today: TODAY }).fields.amount.confidence).toBe('medium');
    expect(mergeAiReading({}, { total: 500 }, OCR, { today: TODAY }).fields.amount.confidence).toBe('high');
    const m = mergeAiReading({}, { total: 230, vat_amount: 30 }, '', { today: TODAY });
    expect(m.fields.amount.confidence).toBe('high');
    expect(m.fields.vat_amount.confidence).toBe('high');
  });

  test('a high Tesseract total is never replaced; the disagreement is shown and needs review', () => {
    const prev = { amount: { value: 500, confidence: 'high', source: 'ocr', reason: 'x' } };
    const m = mergeAiReading(prev, { total: 50 }, OCR, { today: TODAY });
    expect(m.fields.amount.value).toBe(500);
    expect(m.checks.find(c => c.key === 'ai_total_differs')).toBeTruthy();
    expect(m.needs_review).toBe(true);
  });

  test('supplier memory (human-confirmed) keeps the name', () => {
    const prev = { supplier_name: { value: 'Known Shop', confidence: 'high', source: 'memory', reason: 'x' } };
    expect(mergeAiReading(prev, { supplier_name: 'Other' }, '', { today: TODAY }).fields.supplier_name.value).toBe('Known Shop');
  });

  test('normalise: bad dates, numbers and VAT numbers are dropped', () => {
    expect(normalise({ slip_date: '2026-02-30', total: 'abc', supplier_vat_number: '123', supplier_name: '1' }, TODAY))
      .toEqual({ supplier_name: null, slip_date: null, amount: null, vat_amount: null, supplier_vat_number: null });
    expect(normalise({ total: 'R 1 234,50', supplier_vat_number: '4123 456 789' }, TODAY))
      .toMatchObject({ amount: 1234.5, supplier_vat_number: '4123456789' });
  });
});

describe('/api/local-ai worker API', () => {
  const TOKEN = 'x'.repeat(32);
  let server, base;

  beforeAll(async () => {
    process.env.LOCAL_AI_WORKER_TOKEN = TOKEN;
    const app = express(); app.use(express.json());
    app.use('/api/local-ai', require('../shared/routes/localAiWorker'));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(() => { delete process.env.LOCAL_AI_WORKER_TOKEN; return new Promise(r => server.close(r)); });
  beforeEach(() => {
    mockCalls = [];
    Object.keys(mockDb).forEach(k => delete mockDb[k]);
    Object.assign(mockDb, {
      local_ai_workers: [],
      local_ai_jobs: [{ id: 5, kind: 'slip_read', ref_id: 77, company_id: 51, status: 'queued', attempts: 0, max_attempts: 3 }],
      __rpc: {
        local_ai_claim: (a, db) => {
          const j = db.local_ai_jobs.find(x => x.status === 'queued');
          if (!j) return [];
          Object.assign(j, { status: 'claimed', claimed_by: a.p_worker, attempts: j.attempts + 1 });
          return [j];
        }
      }
    });
  });
  const post = async (p, body, token = TOKEN) => {
    const r = await fetch(base + '/api/local-ai' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-worker-token': token }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json() };
  };

  test('wrong token → 404 (route looks absent)', async () => {
    expect((await post('/claim', { worker_id: 'pc' }, 'y'.repeat(32))).status).toBe(404);
  });

  test('claim → payload; result → stored; job done; heartbeat recorded', async () => {
    const c = await post('/claim', { worker_id: 'pc' });
    expect(c.body.job).toMatchObject({ id: 5, kind: 'slip_read' });
    expect(c.body.payload.ocr_text).toBe('job 77');
    expect(mockDb.local_ai_workers[0].worker_id).toBe('pc');
    const r = await post('/jobs/5/result', { worker_id: 'pc', model: 'qwen2.5vl:3b', duration_ms: 42000, fields: { total: 500 } });
    expect(r.status).toBe(200);
    expect(mockCalls[0]).toMatchObject({ model: 'qwen2.5vl:3b', fields: { total: 500 } });
    expect(mockDb.local_ai_jobs[0].status).toBe('done');
  });

  test('another worker cannot post the result; no job → job null; failure re-queues', async () => {
    await post('/claim', { worker_id: 'pc' });
    expect((await post('/jobs/5/result', { worker_id: 'other', fields: {} })).status).toBe(409);
    expect((await post('/jobs/5/fail', { worker_id: 'pc', error: 'timeout' })).body.status).toBe('queued');
    expect(mockDb.local_ai_jobs[0]).toMatchObject({ status: 'queued', claimed_by: null });
    mockDb.local_ai_jobs[0].status = 'done';
    expect((await post('/claim', { worker_id: 'pc' })).body.job).toBeNull();
  });
});
