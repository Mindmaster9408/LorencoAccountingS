/**
 * vita-ui.js — VITA Report UI Controller
 *
 * Handles:
 *  - Auth guard (redirect to login if not authenticated)
 *  - Drag-and-drop ranking of 6 VITA dimensions
 *  - POST /api/vita/report API call with JWT auth
 *  - Markdown-to-HTML rendering of the returned report
 *  - PDF export via window.print() with a styled print container
 *  - HTML file download export
 *
 * NOTE: VITA API is at /api/vita (NOT /api/coaching).
 *       Do NOT use apiRequest() from api.js — that prefixes /api/coaching.
 *       Use vitaPost() defined below instead.
 */

import { getAuthToken, isAuthenticated } from './api.js';
import { escapeHtml } from './config.js';

// ─── VITA Dimension Definitions ───────────────────────────────────────────────
// Keys must exactly match backend vita.config.js VITA_DIMENSIONS

const VITA_DIMS = [
  { key: 'STRUKTUUR',  label: 'Struktuur',   icon: '🏗️', sub: 'Orde • Sisteme • Betroubaarheid' },
  { key: 'PRESTASIE',  label: 'Prestasie',   icon: '🏆', sub: 'Resultate • Doelwitte • Standaarde' },
  { key: 'INSIG',      label: 'Insig',       icon: '🔍', sub: 'Begrip • Analise • Diepdenke' },
  { key: 'LIEFDE',     label: 'Liefde',      icon: '❤️', sub: 'Verhoudings • Omgee • Verbinding' },
  { key: 'EMOSIE',     label: 'Emosie',      icon: '🔥', sub: 'Outentisiteit • Gevoel • Uitdrukking' },
  { key: 'INISIATIEF', label: 'Inisiatief',  icon: '🚀', sub: 'Visie • Innovasie • Nuwe Moontlikhede' },
];

// Human labels for each position (index 0–5)
const POSITION_LABELS = ['Primêr', 'Tweede', 'Derde', 'Stres', 'Groei', 'Skadu'];

// ─── Mutable State ────────────────────────────────────────────────────────────

let currentRanking = VITA_DIMS.map(d => d.key);   // ordered by drag result
let currentMarkdown = null;                         // last generated markdown
let clientName = '';                                // optional client name field
let dragSrcKey = null;                              // key of the item being dragged

// ─── Entry Point ──────────────────────────────────────────────────────────────

function init() {
  // Auth guard — must have a valid token
  if (!isAuthenticated()) {
    window.location.href = '/coaching/login.html';
    return;
  }

  renderRankingList();
  bindEvents();
  setState('empty');
}

function bindEvents() {
  document.getElementById('generate-btn').addEventListener('click', onGenerate);
  document.getElementById('reset-btn').addEventListener('click', onReset);
  document.getElementById('export-pdf-btn').addEventListener('click', onExportPdf);
  document.getElementById('export-html-btn').addEventListener('click', onExportHtml);
  document.getElementById('client-name-input').addEventListener('input', e => {
    clientName = e.target.value.trim();
  });
}

// ─── Ranking List Rendering ───────────────────────────────────────────────────

function renderRankingList() {
  const list = document.getElementById('ranking-list');
  list.innerHTML = '';

  currentRanking.forEach((key, idx) => {
    const dim = VITA_DIMS.find(d => d.key === key);
    const item = document.createElement('div');
    item.className = 'rank-item';
    item.draggable = true;
    item.dataset.key = key;
    item.innerHTML = `
      <div class="rank-pos pos-${idx + 1}">${idx + 1}</div>
      <div class="rank-icon">${dim.icon}</div>
      <div class="rank-info">
        <div class="rank-label">${escapeHtml(dim.label)}</div>
        <div class="rank-sub">${escapeHtml(dim.sub)}</div>
      </div>
      <div class="rank-role">${escapeHtml(POSITION_LABELS[idx])}</div>
      <div class="drag-handle" title="Sleep om te herrangskik">⠿</div>
    `;

    item.addEventListener('dragstart', onDragStart);
    item.addEventListener('dragover',  onDragOver);
    item.addEventListener('drop',      onDrop);
    item.addEventListener('dragend',   onDragEnd);

    list.appendChild(item);
  });
}

// ─── Drag and Drop ────────────────────────────────────────────────────────────

function onDragStart(e) {
  dragSrcKey = this.dataset.key;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Required for Firefox
  e.dataTransfer.setData('text/plain', dragSrcKey);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  // Visual feedback: highlight drop target
  document.querySelectorAll('.rank-item').forEach(el => el.classList.remove('drag-over'));
  this.classList.add('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  const dstKey = this.dataset.key;
  if (!dragSrcKey || dragSrcKey === dstKey) return;

  const srcIdx = currentRanking.indexOf(dragSrcKey);
  const dstIdx = currentRanking.indexOf(dstKey);

  // Move src to dst position (insert, not swap)
  currentRanking.splice(srcIdx, 1);
  currentRanking.splice(dstIdx, 0, dragSrcKey);

  renderRankingList();
}

function onDragEnd() {
  dragSrcKey = null;
  document.querySelectorAll('.rank-item').forEach(el => {
    el.classList.remove('dragging', 'drag-over');
  });
}

// ─── Generate Report ──────────────────────────────────────────────────────────

async function onGenerate() {
  const btn = document.getElementById('generate-btn');
  setState('loading');
  btn.disabled = true;
  btn.textContent = 'Genereer…';

  try {
    const data = await vitaPost('/report', { ranking: currentRanking });
    currentMarkdown = data.report.markdown;
    renderReport(data.report.markdown, data.report.generatedAt);
    setState('report');
  } catch (err) {
    setState('error', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Genereer Verslag';
  }
}

function onReset() {
  currentRanking = VITA_DIMS.map(d => d.key);
  currentMarkdown = null;
  renderRankingList();
  setState('empty');
}

// ─── UI State Management ──────────────────────────────────────────────────────

/**
 * @param {'empty'|'loading'|'error'|'report'} state
 * @param {string} [errMsg]
 */
function setState(state, errMsg = '') {
  document.getElementById('output-state-empty').classList.toggle('hidden', state !== 'empty');
  document.getElementById('output-state-loading').classList.toggle('hidden', state !== 'loading');
  document.getElementById('output-state-error').classList.toggle('hidden', state !== 'error');
  document.getElementById('report-view').classList.toggle('hidden', state !== 'report');
  document.getElementById('export-bar').classList.toggle('hidden', state !== 'report');

  if (state === 'error') {
    document.getElementById('error-msg').textContent = errMsg || 'Onbekende fout.';
  }
}

// ─── Report Rendering ─────────────────────────────────────────────────────────

function renderReport(markdown, generatedAt) {
  const html = markdownToHtml(markdown);

  // On-screen view
  document.getElementById('report-view').innerHTML = html;

  // Print area
  document.getElementById('print-content').innerHTML = html;
  document.getElementById('print-client-name').textContent = clientName || '';
  try {
    const d = new Date(generatedAt);
    document.getElementById('print-date').textContent =
      d.toLocaleDateString('af-ZA', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch (_) {
    document.getElementById('print-date').textContent = generatedAt || '';
  }
}

// ─── Markdown to HTML Converter ───────────────────────────────────────────────
// Handles all constructs used in vita.template.js:
//   # H1  ## H2  ### H3  #### H4
//   **bold**  *italic*
//   - list item
//   ---  (hr)
//   blank line (paragraph break)

function markdownToHtml(md) {
  // Safety: escape HTML special characters before processing
  const lines = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n');

  const out = [];
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trimStart();

    if (trimmed.startsWith('# ')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h1>${processInline(trimmed.slice(2))}</h1>`);

    } else if (trimmed.startsWith('## ')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h2>${processInline(trimmed.slice(3))}</h2>`);

    } else if (trimmed.startsWith('### ')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h3>${processInline(trimmed.slice(4))}</h3>`);

    } else if (trimmed.startsWith('#### ')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h4>${processInline(trimmed.slice(5))}</h4>`);

    } else if (trimmed === '---') {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<hr>');

    } else if (trimmed.startsWith('- ')) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${processInline(trimmed.slice(2))}</li>`);

    } else if (trimmed === '') {
      if (inList) { out.push('</ul>'); inList = false; }
      // Blank lines between paragraphs — just skip, adjacent <p> elements create visual spacing

    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p>${processInline(trimmed)}</p>`);
    }
  }

  if (inList) out.push('</ul>');
  return out.join('\n');
}

/**
 * Process inline markdown: **bold** and *italic*.
 * Must process ** before * to avoid nested conflicts.
 */
function processInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g, '<em>$1</em>');
}

// ─── Export Functions ─────────────────────────────────────────────────────────

function onExportPdf() {
  if (!currentMarkdown) return;
  window.print();
}

function onExportHtml() {
  if (!currentMarkdown) return;

  const reportHtml = markdownToHtml(currentMarkdown);
  const name = escapeHtml(clientName || 'vita-verslag');
  const timestamp = new Date().toLocaleDateString('af-ZA');

  const fullHtml = `<!DOCTYPE html>
<html lang="af">
<head>
  <meta charset="UTF-8">
  <title>VITA Verslag${clientName ? ' — ' + escapeHtml(clientName) : ''}</title>
  <style>
    body {
      font-family: Georgia, 'Times New Roman', serif;
      max-width: 800px;
      margin: 40px auto;
      padding: 0 24px 60px;
      color: #1e293b;
      line-height: 1.7;
      font-size: 15px;
    }
    .report-header {
      border-bottom: 2px solid #0f172a;
      padding-bottom: 16px;
      margin-bottom: 32px;
    }
    .report-badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 3px;
      text-transform: uppercase;
      color: #0f172a;
    }
    .report-client { font-size: 20px; font-weight: 700; color: #0f172a; margin: 6px 0 2px; }
    .report-date   { font-size: 12px; color: #64748b; }
    h1 { font-size: 22px; font-weight: 800; color: #0f172a; margin: 0 0 8px; }
    h2 {
      font-size: 16px;
      font-weight: 700;
      color: #0f172a;
      margin: 32px 0 10px;
      padding-left: 10px;
      border-left: 3px solid #0ea5e9;
    }
    h3 { font-size: 14px; font-weight: 600; color: #334155; margin: 18px 0 8px; }
    h4 { font-size: 13px; font-weight: 600; color: #475569; margin: 12px 0 6px; }
    p  { margin: 0 0 12px; color: #334155; }
    ul { margin: 6px 0 14px; padding-left: 22px; }
    li { margin-bottom: 5px; color: #334155; }
    hr { border: none; border-top: 1px solid #e2e8f0; margin: 24px 0; }
    strong { color: #1e293b; }
    em     { color: #64748b; font-style: italic; }
  </style>
</head>
<body>
  <div class="report-header">
    <div class="report-badge">VITA Profiel Verslag</div>
    ${clientName ? `<div class="report-client">${escapeHtml(clientName)}</div>` : ''}
    <div class="report-date">${timestamp}</div>
  </div>
  ${reportHtml}
</body>
</html>`;

  const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vita-verslag${clientName ? '-' + clientName.replace(/\s+/g, '-').toLowerCase() : ''}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── VITA API Helper ──────────────────────────────────────────────────────────
// NOTE: VITA is at /api/vita — NOT /api/coaching. Do NOT use apiRequest() here.

async function vitaPost(endpoint, body) {
  const token = getAuthToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api/vita${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    // Token expired or invalid — clear and redirect
    localStorage.removeItem('auth_token');
    window.location.href = '/coaching/login.html';
    // Throw to stop execution in the calling function
    throw new Error('Sessie verval. Teken asseblief weer in.');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
