// BASIS Report UI - Display and download reports

import { generateBASISReport } from './basis-report-generator.js';
import { $ } from './config.js';
import { apiRequest } from './api.js';
import { BASIS_QUESTIONS, SECTION_LABELS } from './basis-assessment.js';

export function renderBASISReportViewer(client, containerId = 'basis-report-viewer') {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!client.basisResults) {
        container.innerHTML = `
            <div class="report-error">
                <h3>No BASIS Assessment Results</h3>
                <p>This client has not completed the BASIS assessment yet.</p>
                <p>Please complete the assessment first to generate a report.</p>
            </div>
        `;
        return;
    }

    const { basisOrder, sectionScores } = client.basisResults;
    const code = basisOrder.join('-');

    container.innerHTML = `
        <div class="basis-report-viewer">
            <div class="report-header">
                <h2>BASIS Report for ${client.name}</h2>
                <div class="report-code">
                    <span class="code-label">BASIS Code:</span>
                    <span class="code-value">${code}</span>
                </div>
            </div>

            <div class="report-actions">
                <button id="preview-report-btn" class="btn-primary">
                    📄 Preview Report
                </button>
                <button id="download-pdf-btn" class="btn-primary">
                    ⬇️ Download PDF
                </button>
                <button id="download-html-btn" class="btn-secondary">
                    📋 Download HTML
                </button>
                <button id="view-answers-btn" class="btn-secondary">
                    🔍 View Submitted Answers
                </button>
            </div>

            <div id="report-preview" class="report-preview" style="display: none;">
                <div class="preview-controls">
                    <button id="close-preview-btn" class="btn-secondary">Close Preview</button>
                    <select id="language-select" class="language-selector">
                        <option value="en">English</option>
                        <option value="af">Afrikaans</option>
                    </select>
                </div>
                <div id="report-content" class="report-content">
                    <!-- Report will be rendered here -->
                </div>
            </div>
        </div>
    `;

    attachReportListeners(client);
}

function attachReportListeners(client) {
    const previewBtn = $('#preview-report-btn');
    const downloadPdfBtn = $('#download-pdf-btn');
    const downloadHtmlBtn = $('#download-html-btn');
    const closePreviewBtn = $('#close-preview-btn');
    const languageSelect = $('#language-select');
    const viewAnswersBtn = $('#view-answers-btn');

    if (previewBtn) {
        previewBtn.addEventListener('click', () => {
            showReportPreview(client, 'en');
        });
    }

    if (downloadPdfBtn) {
        downloadPdfBtn.addEventListener('click', () => {
            downloadReportAsPDF(client);
        });
    }

    if (downloadHtmlBtn) {
        downloadHtmlBtn.addEventListener('click', () => {
            downloadReportAsHTML(client, 'en');
        });
    }

    if (closePreviewBtn) {
        closePreviewBtn.addEventListener('click', () => {
            $('#report-preview').style.display = 'none';
        });
    }

    if (languageSelect) {
        languageSelect.addEventListener('change', (e) => {
            const language = e.target.value;
            showReportPreview(client, language);
        });
    }

    if (viewAnswersBtn) {
        viewAnswersBtn.addEventListener('click', () => {
            showBasisAnswersModal(client);
        });
    }
}

function showReportPreview(client, language = 'en') {
    try {
        const reportMarkdown = generateBASISReport(client, language);
        const reportHTML = convertMarkdownToHTML(reportMarkdown);

        const reportContent = $('#report-content');
        const reportPreview = $('#report-preview');

        if (reportContent) {
            reportContent.innerHTML = reportHTML;
        }

        if (reportPreview) {
            reportPreview.style.display = 'block';
            reportPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    } catch (error) {
        alert('Error generating report: ' + error.message);
    }
}

function convertMarkdownToHTML(markdown) {
    // Basic markdown to HTML conversion
    let html = markdown;

    // Headers
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');

    // Bold
    html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');

    // Lists
    html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    // Line breaks
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Page breaks
    html = html.replace(/<div class="page-break"><\/div>/g, '<div class="page-break-marker">───── Page Break ─────</div>');

    // Horizontal rules
    html = html.replace(/^---$/gim, '<hr>');

    // Tables
    html = html.replace(/\|(.+)\|/g, (match, content) => {
        const cells = content.split('|').map(cell => cell.trim());
        return '<tr>' + cells.map(cell => `<td>${cell}</td>`).join('') + '</tr>';
    });
    html = html.replace(/(<tr>.*<\/tr>)/s, '<table>$1</table>');

    return html;
}

function downloadReportAsHTML(client, language = 'en') {
    try {
        const reportMarkdown = generateBASISReport(client, language);
        const reportHTML = convertMarkdownToHTML(reportMarkdown);

        const fullHTML = `
<!DOCTYPE html>
<html lang="${language}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BASIS Report - ${client.name}</title>
    <style>
        ${getReportCSS()}
    </style>
</head>
<body>
    <div class="report-container">
        ${reportHTML}
    </div>
</body>
</html>
        `;

        const blob = new Blob([fullHTML], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `BASIS_Report_${client.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        alert('Error downloading report: ' + error.message);
    }
}

// ---------------------------------------------------------------------------
// Read-only submitted answers modal
// ---------------------------------------------------------------------------

async function showBasisAnswersModal(client) {
    // Remove any existing modal
    const existing = document.getElementById('basis-answers-modal');
    if (existing) existing.remove();

    // Build loading modal immediately
    const modal = document.createElement('div');
    modal.id = 'basis-answers-modal';
    modal.style.cssText = `
        position: fixed; inset: 0; z-index: 9999;
        display: flex; align-items: flex-start; justify-content: center;
        background: rgba(0,0,0,0.55); padding: 24px 16px; overflow-y: auto;
    `;
    modal.innerHTML = `
        <div style="
            background: white; border-radius: 14px; width: 100%; max-width: 860px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 28px 32px; position: relative;
        ">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 2px solid #7c3aed; padding-bottom: 14px;">
                <div>
                    <h2 style="color: #5b21b6; margin: 0; font-size: 20px;">🔍 Submitted BASIS Answers</h2>
                    <p style="color: #64748b; margin: 4px 0 0; font-size: 13px;">${client.name} — read-only view</p>
                </div>
                <div style="display:flex; gap:8px;">
                    <button id="print-answers-btn" style="
                        background: #7c3aed; border: none; border-radius: 8px; padding: 8px 14px;
                        cursor: pointer; font-size: 13px; color: white; font-weight: 600;
                    ">🖨️ Print</button>
                    <button id="close-answers-modal" style="
                        background: #f1f5f9; border: none; border-radius: 8px; padding: 8px 14px;
                        cursor: pointer; font-size: 13px; color: #475569; font-weight: 600;
                    ">✕ Close</button>
                </div>
            </div>
            <div id="basis-answers-body" style="text-align: center; padding: 40px 0; color: #64748b;">
                ⏳ Loading submitted answers…
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Close button handler
    modal.querySelector('#close-answers-modal').addEventListener('click', () => modal.remove());
    // Backdrop click closes
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    // Print button handler — opens content in a new window and triggers print
    modal.querySelector('#print-answers-btn').addEventListener('click', () => {
        const bodyEl = document.getElementById('basis-answers-body');
        if (!bodyEl || bodyEl.textContent.trim().startsWith('⏳')) return;
        const win = window.open('', '_blank', 'width=900,height=700');
        win.document.write(`
            <!DOCTYPE html><html><head>
            <title>BASIS Answers — ${escapeHtml(client.name)}</title>
            <style>
                body { font-family: Arial, sans-serif; color: #1e293b; margin: 24px 32px; }
                h2 { color: #5b21b6; margin-bottom: 4px; }
                p.sub { color: #64748b; margin-top: 0; font-size: 13px; }
                table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 24px; }
                th { background: #ede9fe; color: #5b21b6; padding: 6px 10px; border: 1px solid #d8b4fe; text-align: left; font-size: 11px; text-transform: uppercase; }
                td { padding: 5px 10px; border: 1px solid #e2e8f0; vertical-align: top; }
                .section-header { background: #ede9fe; padding: 8px 12px; border-radius: 6px; margin: 18px 0 6px;
                    display: flex; justify-content: space-between; }
                .section-title { font-weight: 700; color: #5b21b6; font-size: 14px; }
                .section-score { font-size: 12px; color: #7c3aed; font-weight: 600; }
                .summary-box { border: 2px solid #7c3aed; border-radius: 8px; padding: 14px 18px; margin-bottom: 18px; display: flex; gap: 40px; }
                .summary-label { font-size: 10px; color: #7c3aed; font-weight: 700; text-transform: uppercase; }
                .summary-value { font-weight: 700; color: #1e293b; margin-top: 2px; }
                .code-value { font-size: 16px; color: #4c1d95; letter-spacing: 1px; }
                .readonly-note { background: #fef9c3; border: 1px solid #fde047; border-radius: 6px; padding: 8px 12px;
                    font-size: 11px; color: #713f12; margin-bottom: 16px; }
                .answer-cell { font-weight: 700; font-size: 15px; color: #7c3aed; text-align: center; }
                .adj-cell { font-weight: 700; color: #5b21b6; text-align: center; }
                .num-cell { color: #94a3b8; text-align: center; font-size: 11px; }
                .reversed { font-size: 10px; color: #9333ea; font-style: italic; }
                @media print { body { margin: 12px 18px; } }
            </style>
            </head><body>
            ${document.getElementById('basis-answers-body').innerHTML}
            </body></html>
        `);
        win.document.close();
        win.focus();
        win.print();
    });

    // Fetch fresh from backend
    let data;
    try {
        data = await apiRequest(`/clients/${client.id}/basis-answers`);
    } catch (err) {
        const status = err.status || 0;
        let msg = 'Unable to load submitted answers. Please try again.';
        if (status === 403) msg = 'You do not have permission to view these answers.';
        if (status === 404) msg = 'Client not found.';
        document.getElementById('basis-answers-body').innerHTML = `
            <div style="color: #dc2626; padding: 20px;">❌ ${msg}</div>`;
        return;
    }

    if (!data.hasSubmission) {
        document.getElementById('basis-answers-body').innerHTML = `
            <div style="color: #64748b; padding: 20px;">
                No submitted BASIS answers were found for this client.
            </div>`;
        return;
    }

    const { basisAnswers, basisResults, submittedAt } = data;
    const sectionScores = (basisResults && basisResults.sectionScores) || {};
    const basisOrder    = (basisResults && basisResults.basisOrder) || [];
    const code          = basisOrder.join('-') || '—';

    const SECTION_KEYS = ['BALANS', 'AKSIE', 'SORG', 'INSIG', 'STRUKTUUR'];

    const submittedLabel = submittedAt
        ? new Date(submittedAt).toLocaleString('en-ZA', {
              year: 'numeric', month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit'
          })
        : '—';

    let html = `
        <div style="background:#f5f3ff; border:2px solid #7c3aed; border-radius:10px; padding:16px 20px; margin-bottom:24px;">
            <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px;">
                <div><span style="font-size:11px;color:#7c3aed;font-weight:700;text-transform:uppercase;">Client</span><br>
                    <strong style="color:#1e293b;">${escapeHtml(client.name)}</strong></div>
                <div><span style="font-size:11px;color:#7c3aed;font-weight:700;text-transform:uppercase;">BASIS Code</span><br>
                    <strong style="color:#4c1d95;font-size:17px;letter-spacing:1px;">${escapeHtml(code)}</strong></div>
                <div><span style="font-size:11px;color:#7c3aed;font-weight:700;text-transform:uppercase;">Submitted</span><br>
                    <strong style="color:#1e293b;">${submittedLabel}</strong></div>
            </div>
        </div>

        <div style="background:#fef9c3; border:1px solid #fde047; border-radius:8px; padding:10px 14px; margin-bottom:20px; font-size:12px; color:#713f12;">
            🔒 <strong>Read-only.</strong> These are the client's submitted responses — they cannot be edited here.
        </div>
    `;

    // Section order badge
    if (basisOrder.length > 0) {
        html += `
            <div style="margin-bottom:24px;">
                <span style="font-size:12px; font-weight:700; color:#5b21b6; text-transform:uppercase; letter-spacing:0.05em;">BASIS Order:</span>
                <span style="margin-left:10px; font-size:14px; font-weight:700; color:#4c1d95;">
                    ${basisOrder.map((s, i) => {
                        const score = sectionScores[s] !== undefined ? ` (${sectionScores[s].toFixed(1)})` : '';
                        return `${i + 1}. ${SECTION_LABELS[s] || s}${score}`;
                    }).join(' → ')}
                </span>
            </div>
        `;
    }

    SECTION_KEYS.forEach(section => {
        const questions   = BASIS_QUESTIONS[section] || [];
        const sectionLabel = SECTION_LABELS[section] || section;
        const score       = sectionScores[section] !== undefined ? sectionScores[section].toFixed(1) : '—';
        const rank        = basisOrder.indexOf(section);
        const rankTag     = rank >= 0 ? ` &nbsp;·&nbsp; Rank #${rank + 1}` : '';

        html += `
            <div style="margin-bottom:28px;">
                <div style="background:#ede9fe; padding:10px 14px; border-radius:8px; margin-bottom:8px;
                            display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:700; font-size:15px; color:#5b21b6;">${sectionLabel}</span>
                    <span style="font-size:12px; color:#7c3aed; font-weight:600;">Score: ${score}/10${rankTag}</span>
                </div>
                <table style="width:100%; border-collapse:collapse; font-size:13px;">
                    <thead>
                        <tr style="background:#f5f3ff; color:#5b21b6; font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">
                            <th style="padding:7px 10px; border:1px solid #d8b4fe; width:36px; text-align:center;">#</th>
                            <th style="padding:7px 10px; border:1px solid #d8b4fe; text-align:left;">Question</th>
                            <th style="padding:7px 10px; border:1px solid #d8b4fe; width:70px; text-align:center;">Answer</th>
                            <th style="padding:7px 10px; border:1px solid #d8b4fe; width:80px; text-align:center;">Adjusted</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${questions.map(q => {
                            const key = `${section}_${q.id}`;
                            const raw = basisAnswers[key];
                            const hasAnswer = raw !== undefined && raw !== null;
                            const rawDisplay = hasAnswer ? raw : '—';
                            const adjDisplay = hasAnswer ? (q.reverse ? 11 - raw : raw) : '—';
                            const rowBg = hasAnswer ? '' : 'background:#fef9c3;';
                            const reverseNote = q.reverse
                                ? `<span style="font-size:10px;color:#9333ea;font-style:italic;"> (reversed)</span>`
                                : '';
                            const answerColor = hasAnswer ? '#7c3aed' : '#94a3b8';
                            return `
                                <tr style="${rowBg}">
                                    <td style="padding:6px 10px; border:1px solid #e2e8f0; text-align:center; color:#94a3b8; font-size:12px;">${q.id}</td>
                                    <td style="padding:6px 10px; border:1px solid #e2e8f0; color:#334155;">${escapeHtml(q.text)}${reverseNote}</td>
                                    <td style="padding:6px 10px; border:1px solid #e2e8f0; text-align:center; font-weight:700; font-size:16px; color:${answerColor};">${rawDisplay}</td>
                                    <td style="padding:6px 10px; border:1px solid #e2e8f0; text-align:center; font-weight:700; color:#5b21b6;">${adjDisplay}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
    });

    document.getElementById('basis-answers-body').innerHTML = html;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function downloadReportAsPDF(client) {
    alert('PDF download functionality requires a PDF library. For now, please use "Download HTML" and print to PDF from your browser (Ctrl+P / Cmd+P, then select "Save as PDF").');
}

function getReportCSS() {
    return `
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            background: #f5f5f5;
        }

        .report-container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 60px 80px;
        }

        h1 {
            font-size: 32px;
            color: #1a202c;
            margin: 40px 0 20px 0;
            border-bottom: 3px solid #3b82f6;
            padding-bottom: 12px;
        }

        h2 {
            font-size: 24px;
            color: #2d3748;
            margin: 32px 0 16px 0;
        }

        h3 {
            font-size: 20px;
            color: #4a5568;
            margin: 24px 0 12px 0;
        }

        h4 {
            font-size: 16px;
            color: #718096;
            margin: 16px 0 8px 0;
        }

        p {
            margin: 12px 0;
            line-height: 1.8;
        }

        ul {
            margin: 16px 0 16px 32px;
        }

        li {
            margin: 8px 0;
            line-height: 1.6;
        }

        strong {
            color: #1a202c;
            font-weight: 600;
        }

        em {
            font-style: italic;
            color: #4a5568;
        }

        hr {
            border: none;
            border-top: 1px solid #e2e8f0;
            margin: 32px 0;
        }

        .page-break-marker {
            text-align: center;
            color: #cbd5e1;
            margin: 60px 0;
            font-size: 14px;
            letter-spacing: 2px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin: 24px 0;
        }

        td {
            padding: 12px;
            border: 1px solid #e2e8f0;
        }

        tr:first-child td {
            background: #f7fafc;
            font-weight: 600;
        }

        @media print {
            .report-container {
                padding: 40px;
            }

            .page-break-marker {
                page-break-after: always;
                visibility: hidden;
            }
        }
    `;
}
