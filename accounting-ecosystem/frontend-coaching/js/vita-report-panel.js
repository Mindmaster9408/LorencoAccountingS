/**
 * vita-report-panel.js — Reusable VITA Report Panel
 *
 * Renders a full VITA report embedded inside any container element.
 * Used by: spil-client.js (client profile view) and reports.js (reports page).
 *
 * Usage:
 *   import { renderVitaReportPanel } from './vita-report-panel.js';
 *   await renderVitaReportPanel(containerEl, ranking, clientName, downloadName);
 *
 * Parameters:
 *   container    {HTMLElement}  — DOM element to render into
 *   ranking      {string[]}     — 6-element VITA ranking array
 *   clientName   {string}       — display name for the report header (optional)
 *   downloadName {string}       — used in the download filename (optional)
 */

import { getAuthToken } from './api.js';
import { escapeHtml } from './config.js';

// ─── Markdown → HTML ──────────────────────────────────────────────────────────

function processInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code>$1</code>');
}

function markdownToHtml(md) {
  const lines  = md.split('\n');
  const output = [];
  let inList   = false;

  const closeList = () => {
    if (inList) { output.push('</ul>'); inList = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^### (.+)/.test(line)) {
      closeList();
      output.push(`<h3>${processInline(line.replace(/^### /, ''))}</h3>`);
    } else if (/^## (.+)/.test(line)) {
      closeList();
      output.push(`<h2>${processInline(line.replace(/^## /, ''))}</h2>`);
    } else if (/^# (.+)/.test(line)) {
      closeList();
      output.push(`<h1>${processInline(line.replace(/^# /, ''))}</h1>`);
    } else if (/^---/.test(line)) {
      closeList();
      output.push('<hr>');
    } else if (/^- (.+)/.test(line)) {
      if (!inList) { output.push('<ul>'); inList = true; }
      output.push(`<li>${processInline(line.replace(/^- /, ''))}</li>`);
    } else if (line.trim() === '') {
      closeList();
      output.push('');
    } else {
      closeList();
      output.push(`<p>${processInline(line)}</p>`);
    }
  }

  closeList();
  return output.join('\n');
}

// ─── Standalone HTML builder (for print / download) ──────────────────────────

function buildStandaloneHtml(markdown, clientName) {
  const bodyHtml = markdownToHtml(markdown);
  const title    = clientName ? `VITA Verslag — ${escapeHtml(clientName)}` : 'VITA Verslag';
  return `<!DOCTYPE html>
<html lang="af">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 14px; line-height: 1.7;
           color: #1a1a2e; background: #fff; padding: 40px; max-width: 860px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #0f0f23; border-bottom: 2px solid #7c5cbf; padding-bottom: 8px; }
    h2 { font-size: 18px; margin-top: 28px; margin-bottom: 6px; color: #4a2c8a; }
    h3 { font-size: 15px; margin-top: 16px; margin-bottom: 4px; color: #333; }
    p  { margin: 8px 0; }
    ul { margin: 8px 0 8px 20px; }
    li { margin: 4px 0; }
    hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
    code { background: #f4f0fa; padding: 1px 4px; border-radius: 3px; font-size: 13px; }
    strong { color: #2d1a66; }
    @media print {
      body { padding: 20px; font-size: 12px; }
      h1 { font-size: 20px; }
      h2 { font-size: 15px; margin-top: 18px; }
    }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// ─── renderVitaReportPanel ────────────────────────────────────────────────────

/**
 * Renders a full VITA report embedded in the given container.
 *
 * @param {HTMLElement} container
 * @param {string[]}    ranking       — 6-element VITA ranking array
 * @param {string}      [clientName]  — display name used in report header
 * @param {string}      [downloadName] — used in download filename
 */
export async function renderVitaReportPanel(container, ranking, clientName = '', downloadName = '') {
  container.innerHTML = `
    <div style="padding:20px;text-align:center;color:#888;">
      <div style="display:inline-block;width:32px;height:32px;border:3px solid #7c5cbf;
                  border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
      <p style="margin-top:12px;font-size:14px;">Verslag word gegenereer…</p>
    </div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;

  let markdown;
  try {
    const token = getAuthToken();
    const res   = await fetch('/api/vita/report', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ ranking, clientName }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    markdown   = data.report.markdown;
  } catch (err) {
    container.innerHTML = `
      <div style="padding:16px;background:#2d1a1a;border-radius:8px;color:#f8a0a0;font-size:14px;">
        Kon nie verslag genereer nie: ${escapeHtml(err.message)}
      </div>`;
    return;
  }

  // ── Build action buttons ───────────────────────────────────────────────────
  const safeDownloadName  = (downloadName || clientName || 'Verslag').replace(/\s+/g, '_');
  const today             = new Date().toISOString().slice(0, 10);
  const filename          = `VITA_Verslag_${safeDownloadName}_${today}.html`;

  const btnPrint = document.createElement('button');
  btnPrint.textContent  = '🖨 Druk / PDF';
  btnPrint.style.cssText = 'padding:8px 16px;margin-right:8px;border-radius:6px;border:1px solid #7c5cbf;' +
    'background:#7c5cbf;color:#fff;cursor:pointer;font-size:13px;';

  const btnDownload = document.createElement('button');
  btnDownload.textContent  = '⬇ Aflaai HTML';
  btnDownload.style.cssText = 'padding:8px 16px;border-radius:6px;border:1px solid #7c5cbf;' +
    'background:transparent;color:#7c5cbf;cursor:pointer;font-size:13px;';

  const standaloneHtml = buildStandaloneHtml(markdown, clientName);

  btnPrint.addEventListener('click', () => {
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(standaloneHtml);
    win.document.close();
    win.focus();
    win.print();
  });

  btnDownload.addEventListener('click', () => {
    const blob  = new Blob([standaloneHtml], { type: 'text/html;charset=utf-8' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href      = url;
    a.download  = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  });

  // ── Render ─────────────────────────────────────────────────────────────────
  const reportHtml = markdownToHtml(markdown);

  container.innerHTML = '';

  const actionsBar = document.createElement('div');
  actionsBar.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:16px;';
  actionsBar.appendChild(btnPrint);
  actionsBar.appendChild(btnDownload);

  const reportBody = document.createElement('div');
  reportBody.style.cssText = 'font-family:"Segoe UI",Arial,sans-serif;font-size:14px;line-height:1.7;' +
    'color:#e0d6f5;background:#1a1a2e;border-radius:10px;padding:28px 32px;';
  reportBody.innerHTML = `
    <style>
      .vita-report-body h1{font-size:22px;color:#c4a0f0;margin-bottom:8px;border-bottom:1px solid #3a2a5e;padding-bottom:8px;}
      .vita-report-body h2{font-size:16px;color:#a07ee0;margin-top:24px;margin-bottom:6px;}
      .vita-report-body h3{font-size:14px;color:#c0b0e8;margin-top:14px;margin-bottom:4px;}
      .vita-report-body p {margin:6px 0;}
      .vita-report-body ul{margin:6px 0 6px 20px;}
      .vita-report-body li{margin:3px 0;}
      .vita-report-body hr{border:none;border-top:1px solid #3a2a5e;margin:16px 0;}
      .vita-report-body strong{color:#d4b0f8;}
      .vita-report-body code{background:#2e2050;padding:1px 4px;border-radius:3px;font-size:12px;}
    </style>
    <div class="vita-report-body">${reportHtml}</div>
  `;

  container.appendChild(actionsBar);
  container.appendChild(reportBody);
}
