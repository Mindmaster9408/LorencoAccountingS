#!/usr/bin/env node
/**
 * ============================================================================
 * Lorenco local AI worker — runs on Ruan's computer, unattended
 * ============================================================================
 * Ruan 2026-11-10: until there is budget for Claude, slips that the server could
 * not read with confidence are read by a vision model on this computer (Ollama).
 * Nothing is sent to an external AI service, and this computer is not opened to
 * the internet: the worker only makes OUTGOING requests to the app.
 *
 * Loop:  ask the app for a job → read the slip with Ollama → post the fields back.
 *        No job → wait. App or Ollama unreachable → wait and try again.
 *        Ollama not running (e.g. after a reboot with nobody logged in) → start it.
 *
 * Config: config.env next to this file (see config.example.env). No npm packages
 * needed — Node 18+ only.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = __dirname;

// ── config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  const file = path.join(DIR, 'config.env');
  const cfg = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) cfg[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const get = (k, d) => process.env[k] || cfg[k] || d;
  return {
    appUrls: get('APP_URLS', '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean),
    token: get('LOCAL_AI_WORKER_TOKEN', ''),
    ollamaUrl: get('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: get('OLLAMA_MODEL', 'qwen2.5vl:3b'),          // slips (vision)
    textModel: get('OLLAMA_TEXT_MODEL', 'qwen2.5:3b'),    // help chatbot answers (text)
    kinds: get('JOB_KINDS', 'slip_read,help_answer').split(',').map(s => s.trim()).filter(Boolean),
    ollamaExe: get('OLLAMA_EXE', 'ollama'),
    idleSeconds: Number(get('IDLE_SECONDS', '20')),
    workerId: get('WORKER_ID', os.hostname()),
    timeoutSeconds: Number(get('OLLAMA_TIMEOUT_SECONDS', '600')),
    // Keep the model in memory (CPU-only: loading it takes ~30 s; Ollama's default unloads after 5 min).
    keepAlive: get('OLLAMA_KEEP_ALIVE', '24h')
  };
}

// ── log (rotates at 1 MB) ────────────────────────────────────────────────────
const LOG = path.join(DIR, 'worker.log');
function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, line + os.EOL);
  } catch (_) { /* logging must never stop the worker */ }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── app API ──────────────────────────────────────────────────────────────────
let appIndex = 0;
async function api(cfg, pathPart, body) {
  let lastErr;
  for (let i = 0; i < cfg.appUrls.length; i++) {
    const url = cfg.appUrls[(appIndex + i) % cfg.appUrls.length];
    try {
      const res = await fetch(url + '/api/local-ai' + pathPart, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-worker-token': cfg.token },
        body: JSON.stringify(Object.assign({ worker_id: cfg.workerId }, body || {})),
        signal: AbortSignal.timeout(60000)
      });
      if (res.status === 404) throw new Error('404 from ' + url + ' — is LOCAL_AI_WORKER_TOKEN the same on the app?');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
      appIndex = (appIndex + i) % cfg.appUrls.length;   // stick to the app that answered
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No APP_URLS configured');
}

// ── Ollama ───────────────────────────────────────────────────────────────────
async function ollamaUp(cfg) {
  try { const r = await fetch(cfg.ollamaUrl + '/api/version', { signal: AbortSignal.timeout(3000) }); return r.ok; }
  catch (_) { return false; }
}

async function ensureOllama(cfg) {
  if (await ollamaUp(cfg)) return true;
  log('Ollama not reachable — starting "ollama serve"');
  try {
    const child = spawn(cfg.ollamaExe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log('Could not start Ollama:', e.message));
    child.unref();
  } catch (e) {
    log('Could not start Ollama:', e.message);
    return false;
  }
  for (let i = 0; i < 20; i++) { await sleep(1500); if (await ollamaUp(cfg)) return true; }
  return false;
}

const PROMPT = [
  'You read South African till slips and tax invoices. Look at the photo and answer ONLY with JSON:',
  '{"supplier_name": string|null, "slip_date": "YYYY-MM-DD"|null, "total": number|null, "vat_amount": number|null, "supplier_vat_number": string|null}',
  '- supplier_name: the business that issued the slip — usually the name in capitals on the first line(s) at the top. Not an address, road or till number.',
  '- total: the final amount paid (incl. VAT), not a subtotal or change.',
  '- vat_amount: the VAT amount printed on the slip (15% VAT is 15/115 of a VAT-inclusive total). null if not printed.',
  '- supplier_vat_number: the seller\'s 10-digit VAT number (starts with 4). null if not printed.',
  '- South African slips write dates day/month/year: 03/09/2026 is 3 September 2026 (2026-09-03), never 9 March.',
  '- Use null for anything you cannot read. Do not guess.'
].join('\n');

const HELP_PROMPT = {
  AF: 'Jy is die hulp-assistent van Lorenco {APP}. Gebruik net die hulpartikels hieronder om die gebruiker se vraag te beantwoord. ' +
      'Skryf in suiwer Suid-Afrikaanse Afrikaans (nie Nederlands nie), kort en duidelik, in hoogstens 6 genommerde stappe, ' +
      'en gebruik die presiese knoppie- en skermname uit die artikels. Moenie iets byvoeg wat nie in die artikels staan nie. ' +
      'Uitsondering: as die artikels glad nie oor die vraag gaan nie, antwoord met net hierdie een woord: NOT_COVERED',
  EN: 'You are the help assistant of Lorenco {APP}. Use only the help articles below to answer the question of the user. ' +
      'Write in English, short and clear, in at most 6 numbered steps, using the exact button and screen names from the articles. ' +
      'Do not add anything that is not in the articles. ' +
      'Exception: if the articles are not about the question at all, answer with just this one word: NOT_COVERED'
};

async function answerHelp(cfg, payload) {
  const started = Date.now();
  const L = payload.language === 'EN' ? 'EN' : 'AF';
  const app = payload.app === 'paytime' ? 'Paytime' : String(payload.app || '');
  const NL = String.fromCharCode(10);
  const articles = (payload.articles || []).map((a, i) => '### Article ' + (i + 1) + ': ' + a.title +
    (a.screen_name ? ' (screen: ' + a.screen_name + ')' : '') + NL + a.body).join(NL + NL);
  const res = await fetch(cfg.ollamaUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.textModel,
      stream: false,
      keep_alive: cfg.keepAlive || '24h',
      options: { temperature: 0.2, num_predict: 400 },
      messages: [
        { role: 'system', content: HELP_PROMPT[L].replace('{APP}', app) + NL + NL + articles },
        { role: 'user', content: String(payload.question || '').slice(0, 1000) }
      ]
    }),
    signal: AbortSignal.timeout(cfg.timeoutSeconds * 1000)
  });
  if (!res.ok) throw new Error('Ollama HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const answer = String(data.message && data.message.content || '').trim();
  if (!answer) throw new Error('Empty answer');
  return { fields: { answer }, duration_ms: Date.now() - started, model: cfg.textModel };
}

async function readSlip(cfg, payload) {
  const started = Date.now();
  const res = await fetch(cfg.ollamaUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      format: 'json',
      keep_alive: cfg.keepAlive || '24h',
      options: { temperature: 0 },
      messages: [{
        role: 'user',
        content: PROMPT + (payload.ocr_text ? '\n\nText another reader found on this slip (may contain errors):\n' + payload.ocr_text.slice(0, 2500) : ''),
        images: [payload.image_base64]
      }]
    }),
    signal: AbortSignal.timeout(cfg.timeoutSeconds * 1000)
  });
  if (!res.ok) throw new Error('Ollama HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  let fields;
  try { fields = JSON.parse(data.message && data.message.content || '{}'); }
  catch (_) { throw new Error('Model did not answer with JSON'); }
  return { fields, duration_ms: Date.now() - started };
}

// ── main loop ────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  if (!cfg.token || cfg.token.length < 24 || !cfg.appUrls.length) {
    log('Missing config: set APP_URLS and LOCAL_AI_WORKER_TOKEN (24+ characters) in config.env');
    process.exit(1);
  }
  log(`Worker ${cfg.workerId} started — model ${cfg.model}, apps ${cfg.appUrls.join(', ')}`);
  let lastHeartbeat = 0;

  for (;;) {
    try {
      if (!(await ensureOllama(cfg))) { log('Ollama still not reachable — retry in 60 s'); await sleep(60000); continue; }
      const claim = await api(cfg, '/claim', { kinds: cfg.kinds, info: { model: cfg.model, textModel: cfg.textModel, host: os.hostname() } });
      lastHeartbeat = Date.now();
      if (!claim.job) { await sleep(cfg.idleSeconds * 1000); continue; }

      const job = claim.job;
      log(`Job ${job.id} (${job.kind}, attempt ${job.attempt}) — reading…`);
      try {
        const out = job.kind === 'help_answer' ? await answerHelp(cfg, claim.payload) : await readSlip(cfg, claim.payload);
        const res = await api(cfg, `/jobs/${job.id}/result`, { model: out.model || cfg.model, duration_ms: out.duration_ms, fields: out.fields });
        log(`Job ${job.id} done in ${Math.round(out.duration_ms / 1000)} s — needs review: ${res.needs_review}`);
      } catch (err) {
        log(`Job ${job.id} failed:`, err.message);
        await api(cfg, `/jobs/${job.id}/fail`, { error: err.message }).catch(e => log('Could not report failure:', e.message));
      }
    } catch (err) {
      log('App not reachable:', err.message, '— retry in 60 s');
      await sleep(60000);
    }
    if (Date.now() - lastHeartbeat > 60000) {
      await api(cfg, '/heartbeat', { info: { model: cfg.model } }).then(() => { lastHeartbeat = Date.now(); }).catch(() => {});
    }
  }
}

if (require.main === module) main();
module.exports = { loadConfig, readSlip, answerHelp, PROMPT, HELP_PROMPT };
