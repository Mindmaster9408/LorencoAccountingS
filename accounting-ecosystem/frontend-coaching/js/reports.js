// Reports Module - View and download client reports

import { $, escapeHtml } from './config.js';
import { readStore } from './storage.js';
import { renderBASISReportViewer } from './basis-report-ui.js';
import { apiRequest } from './api.js';
import { renderVitaReportPanel } from './vita-report-panel.js';

export async function renderReports() {
    const store = await readStore();
    const view = $('#reports');

    if (!view) return;

    view.innerHTML = `
        <div class="reports-container">
            <header class="reports-header">
                <h2>Client Reports</h2>
                <p class="reports-subtitle">Generate and download professional BASIS reports for your clients</p>
            </header>

            <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px;">
                <a href="/coaching/vita.html" style="display:flex;align-items:flex-start;gap:14px;padding:18px 22px;background:white;border:1px solid #e2e8f0;border-radius:12px;text-decoration:none;color:inherit;min-width:240px;max-width:320px;box-shadow:0 1px 4px rgba(0,0,0,0.06);transition:box-shadow 0.15s;"
                   onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.12)'" onmouseout="this.style.boxShadow='0 1px 4px rgba(0,0,0,0.06)'">
                    <span style="font-size:28px;line-height:1;">🧭</span>
                    <div>
                        <div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:4px;">VITA Verslag Genereerder</div>
                        <div style="font-size:12px;color:#64748b;line-height:1.4;">Genereer 'n persoonlike VITA-profiel verslag vanuit 'n dimensie-rangorde. PDF en HTML uitvoer ingesluit.</div>
                    </div>
                </a>
            </div>

            <div class="reports-content">
                <div class="client-selector">
                    <h3>Select a Client</h3>
                    ${renderClientList(store.clients)}
                </div>

                <div id="report-display-area" class="report-display-area">
                    <div class="empty-state">
                        <div class="empty-icon">📊</div>
                        <h3>No Client Selected</h3>
                        <p>Select a client from the list to view and download their BASIS report.</p>
                    </div>
                </div>
            </div>

            <div style="margin-top:32px;">
                <h3 style="font-size:15px;font-weight:700;color:#0f172a;margin:0 0 12px 0;">VITA Verslae</h3>
                <div id="vita-profiles-section"></div>
            </div>
        </div>
    `;

    // Map snake_case DB fields -> camelCase for the reports page
    // (readStore returns the raw list query — camelCase mapping only happens in openClient)
    store.clients.forEach(c => {
        if (c.basis_results && !c.basisResults) c.basisResults = c.basis_results;
        if (c.basis_answers && !c.basisAnswers) c.basisAnswers = c.basis_answers;
    });

    attachReportsListeners(store.clients);

    // Load VITA profiles asynchronously
    loadVitaProfilesList();
}

async function loadVitaProfilesList() {
    const section = document.getElementById('vita-profiles-section');
    if (!section) return;

    section.innerHTML = `<div style="padding:12px 0;color:#94a3b8;font-size:13px;">Laai VITA profiele...</div>`;

    let profiles = [];
    try {
        const all = await apiRequest('/spil');
        profiles = (all || []).filter(p => p.has_results);
    } catch (err) {
        section.innerHTML = `<div style="padding:12px;background:#2d1a1a;border-radius:8px;color:#f8a0a0;font-size:13px;">Kon nie VITA profiele laai nie: ${escapeHtml(err.message)}</div>`;
        return;
    }

    if (profiles.length === 0) {
        section.innerHTML = `<div style="padding:14px 16px;background:#f8fafc;border-radius:8px;border:1px solid #f1f5f9;color:#94a3b8;font-size:13px;">Geen voltooide VITA profiele gevind nie.</div>`;
        return;
    }

    const rows = profiles.map(p => {
        const dateStr = p.created_at
            ? new Date(p.created_at).toLocaleDateString('af-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
            : '';
        return `
            <div data-vita-id="${p.id}" style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #f1f5f9;border-radius:8px;background:#fff;margin-bottom:8px;flex-wrap:wrap;">
                <div style="flex:1;min-width:140px;">
                    <div style="font-size:13px;font-weight:600;color:#1e293b;">${escapeHtml(p.respondent_name || '—')}</div>
                    <div style="font-size:11px;color:#94a3b8;margin-top:2px;font-family:monospace;">${escapeHtml(p.spil_code || '')}</div>
                </div>
                <div style="font-size:12px;color:#94a3b8;white-space:nowrap;">${escapeHtml(dateStr)}</div>
                <div style="display:flex;gap:8px;">
                    <button class="vita-preview-btn" data-vita-id="${p.id}" data-name="${escapeHtml(p.respondent_name || '')}" style="padding:6px 14px;background:#7c5cbf;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Preview</button>
                    <button class="vita-download-btn" data-vita-id="${p.id}" data-name="${escapeHtml(p.respondent_name || '')}" style="padding:6px 14px;background:transparent;color:#7c5cbf;border:1px solid #7c5cbf;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Aflaai</button>
                </div>
            </div>`;
    }).join('');

    section.innerHTML = rows + `<div id="vita-inline-report-area" style="margin-top:16px;"></div>`;

    section.querySelectorAll('.vita-preview-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id   = btn.dataset.vitaId;
            const name = btn.dataset.name;
            const area = document.getElementById('vita-inline-report-area');
            area.innerHTML = `<div style="padding:10px;color:#94a3b8;font-size:13px;">Laai profiel...</div>`;
            try {
                const full = await apiRequest(`/spil/${id}`);
                const ranking = full.ranking;
                if (!ranking || ranking.length !== 6) throw new Error('Ongeldige rangorde in profiel.');
                const dlName = (name || 'Klient').replace(/\s+/g, '_');
                renderVitaReportPanel(area, ranking, name, dlName);
                area.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (err) {
                area.innerHTML = `<div style="padding:12px;background:#2d1a1a;border-radius:8px;color:#f8a0a0;font-size:13px;">Fout: ${escapeHtml(err.message)}</div>`;
            }
        });
    });

    section.querySelectorAll('.vita-download-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id   = btn.dataset.vitaId;
            const name = btn.dataset.name;
            const tmpArea = document.createElement('div');
            tmpArea.style.display = 'none';
            document.body.appendChild(tmpArea);
            try {
                const full = await apiRequest(`/spil/${id}`);
                const ranking = full.ranking;
                if (!ranking || ranking.length !== 6) throw new Error('Ongeldige rangorde in profiel.');
                const dlName = (name || 'Klient').replace(/\s+/g, '_');
                // renderVitaReportPanel will trigger download via its own button automatically
                // — instead we use a one-shot approach: render then click the download button
                await renderVitaReportPanel(tmpArea, ranking, name, dlName);
                const dlBtn = tmpArea.querySelector('button:nth-child(2)');
                if (dlBtn) dlBtn.click();
            } catch (err) {
                alert('Kon nie aflaai nie: ' + err.message);
            } finally {
                setTimeout(() => tmpArea.remove(), 2000);
            }
        });
    });
}

function renderClientList(clients) {
    if (clients.length === 0) {
        return `
            <div class="no-clients">
                <p>No clients found. Add clients from the Dashboard.</p>
            </div>
        `;
    }

    return `
        <div class="client-list">
            ${clients.map(client => {
                const hasAssessment = client.basisResults ? '✓' : '○';
                const statusClass = client.basisResults ? 'has-assessment' : 'no-assessment';

                return `
                    <div class="client-list-item ${statusClass}" data-client-id="${client.id}">
                        <span class="client-status">${hasAssessment}</span>
                        <span class="client-name">${escapeHtml(client.name)}</span>
                        ${client.basisResults ?
                            `<span class="client-code">${client.basisResults.basisOrder.join('-')}</span>` :
                            `<span class="client-no-code">No assessment</span>`
                        }
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function attachReportsListeners(clients) {
    const clientItems = document.querySelectorAll('.client-list-item');

    clientItems.forEach(item => {
        item.addEventListener('click', () => {
            // Remove active class from all items
            clientItems.forEach(i => i.classList.remove('active'));

            // Add active class to clicked item
            item.classList.add('active');

            // Get client — dataset values are always strings; c.id from DB is a number
            const clientId = item.dataset.clientId;
            const client = clients.find(c => String(c.id) === clientId);

            if (client) {
                displayClientReport(client);
            }
        });
    });
}

function displayClientReport(client) {
    const displayArea = $('#report-display-area');
    if (!displayArea) return;

    displayArea.innerHTML = '<div id="basis-report-viewer"></div>';
    renderBASISReportViewer(client, 'basis-report-viewer');
}

