// BASIS Report UI - Display and download reports

import { generateBASISReport } from './basis-report-generator.js';
import { $ } from './config.js';
import { api } from './api.js';

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

// ─── Phase 2A: Submission-based report viewer ────────────────────────────────
//
// renderBASISSubmissionReport(submission, containerId)
//   Shows the report preview for a basis_submissions row.
//   The submission object must have: basis_results, respondent_name.
//
// renderBASISReportEditorPanel(submissionId, reportEditable, containerId)
//   Shows the coach-editable sections panel with save button.
//   reportEditable is the current report_editable JSONB from the submission.

/**
 * Render report preview from a basis_submissions row.
 * Builds a client-like object from submission data so generateBASISReport works unchanged.
 */
export function renderBASISSubmissionReport(submission, containerId = 'basis-report-viewer') {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!submission || !submission.basis_results) {
        container.innerHTML = `
            <div class="report-error">
                <h3>No Assessment Results</h3>
                <p>This submission has not been completed yet.</p>
            </div>
        `;
        return;
    }

    const { basisOrder, sectionScores } = submission.basis_results;
    const code = basisOrder.join('-');

    // Build a client-like object for generateBASISReport
    const clientObj = {
        name:         submission.respondent_name || 'Client',
        basisResults: submission.basis_results
    };

    container.innerHTML = `
        <div class="basis-report-viewer">
            <div class="report-header">
                <h2>BASIS Report — ${clientObj.name}</h2>
                <div class="report-code">
                    <span class="code-label">BASIS Code:</span>
                    <span class="code-value">${code}</span>
                </div>
            </div>

            <div class="report-actions">
                <button id="preview-report-btn" class="btn-primary">📄 Preview Report</button>
                <button id="download-html-btn" class="btn-secondary">📋 Download HTML</button>
            </div>

            <div id="report-preview" class="report-preview" style="display: none;">
                <div class="preview-controls">
                    <button id="close-preview-btn" class="btn-secondary">Close Preview</button>
                    <select id="language-select" class="language-selector">
                        <option value="en">English</option>
                        <option value="af">Afrikaans</option>
                    </select>
                </div>
                <div id="report-content" class="report-content"></div>
            </div>
        </div>
    `;

    // Reuse existing listeners with the composed client object
    attachReportListeners(clientObj);
}

/**
 * Render the coach-editable sections panel for a basis_submissions row.
 *
 * Editable fields:
 *   coachNotes      — Personal notes / observations about the client
 *   productsPage    — Custom products & services copy for this client
 *   invitationText  — Personalised invitation / call to action
 *   quotationText   — Quote or pricing section override
 *
 * Changes are persisted via PUT /api/basis/:id/report-editable.
 * The panel does NOT regenerate the system report — only the coach sections are updated.
 */
export function renderBASISReportEditorPanel(submissionId, reportEditable = {}, containerId = 'basis-report-editor') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const e = (val) => (val || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    container.innerHTML = `
        <div class="report-editor-panel">
            <div class="editor-header">
                <h3>Coach-Editable Report Sections</h3>
                <p style="color:#64748b;font-size:14px;margin-top:6px;">
                    These sections are merged into the report when it is downloaded or previewed.
                    They do not overwrite the system-generated analysis.
                </p>
            </div>

            <div class="editor-fields">
                <div class="editor-field">
                    <label for="edit-coachNotes">Coach Notes</label>
                    <p class="field-hint">Personal observations, session notes, coaching focus areas.</p>
                    <textarea id="edit-coachNotes" rows="5" class="editor-textarea"
                              placeholder="Your private notes about this client…">${e(reportEditable.coachNotes)}</textarea>
                </div>

                <div class="editor-field">
                    <label for="edit-invitationText">Invitation / Call to Action</label>
                    <p class="field-hint">Personalised invite to take the next coaching step.</p>
                    <textarea id="edit-invitationText" rows="4" class="editor-textarea"
                              placeholder="Dear [Name], based on your BASIS profile…">${e(reportEditable.invitationText)}</textarea>
                </div>

                <div class="editor-field">
                    <label for="edit-productsPage">Products &amp; Services</label>
                    <p class="field-hint">Custom products or services copy tailored to this client.</p>
                    <textarea id="edit-productsPage" rows="5" class="editor-textarea"
                              placeholder="Recommended packages for your profile…">${e(reportEditable.productsPage)}</textarea>
                </div>

                <div class="editor-field">
                    <label for="edit-quotationText">Quotation / Pricing</label>
                    <p class="field-hint">Rate card or quoted investment for this client.</p>
                    <textarea id="edit-quotationText" rows="4" class="editor-textarea"
                              placeholder="Your investment for the programme…">${e(reportEditable.quotationText)}</textarea>
                </div>
            </div>

            <div class="editor-actions">
                <button id="save-report-editable" class="btn-primary">💾 Save Coach Sections</button>
                <span id="editor-save-status" style="margin-left:16px;font-size:13px;color:#64748b;"></span>
            </div>
        </div>
    `;

    const saveBtn    = container.querySelector('#save-report-editable');
    const statusSpan = container.querySelector('#editor-save-status');

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled     = true;
            saveBtn.textContent  = 'Saving…';
            statusSpan.textContent = '';

            const reportEditable = {
                coachNotes:      (container.querySelector('#edit-coachNotes')?.value     || '').trim(),
                invitationText:  (container.querySelector('#edit-invitationText')?.value || '').trim(),
                productsPage:    (container.querySelector('#edit-productsPage')?.value   || '').trim(),
                quotationText:   (container.querySelector('#edit-quotationText')?.value  || '').trim()
            };

            try {
                await api.basis.updateReportEditable(submissionId, reportEditable);
                statusSpan.textContent = '✓ Saved';
                statusSpan.style.color = '#16a34a';
            } catch (err) {
                console.error('Failed to save editable sections:', err);
                statusSpan.textContent = '✗ Save failed — please try again';
                statusSpan.style.color = '#dc2626';
            } finally {
                saveBtn.disabled    = false;
                saveBtn.textContent = '💾 Save Coach Sections';
                setTimeout(() => { statusSpan.textContent = ''; }, 4000);
            }
        });
    }
}
