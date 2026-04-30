/**
 * spil-client.js — VITA Profile panel embedded in the Client Board
 * Renders a compact VITA Profile summary inside the client's "VITA Profiel" tab.
 * Calls /api/coaching/spil (the coaching module's SPIL routes).
 */

import { apiRequest } from './api.js';
import { escapeHtml } from './config.js';

const DIM_COLORS = {
    STRUKTUUR:  '#0ea5e9',
    PRESTASIE:  '#f59e0b',
    INSIG:      '#8b5cf6',
    LIEFDE:     '#ec4899',
    EMOSIE:     '#10b981',
    INISIATIEF: '#f97316'
};

const DIM_NAMES = {
    STRUKTUUR:  'Struktuur',
    PRESTASIE:  'Prestasie',
    INSIG:      'Insig',
    LIEFDE:     'Liefde',
    EMOSIE:     'Emosie',
    INISIATIEF: 'Inisiatief'
};

export async function renderSpilClientPanel(client, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `
        <div style="padding:20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h3 style="margin:0;font-size:16px;font-weight:600;color:#1e293b">🧭 VITA Profiele</h3>
                <button id="spil-client-open-btn" style="
                    padding:7px 14px;background:#0f172a;color:#e2e8f0;border:none;
                    border-radius:6px;cursor:pointer;font-size:13px;font-weight:600
                ">Open VITA App →</button>
            </div>
            <div id="spil-client-list">
                <div style="color:#64748b;font-size:13px">Profiele laai...</div>
            </div>
        </div>`;

    document.getElementById('spil-client-open-btn')
        .addEventListener('click', () => window.open('/coaching/spil.html', '_blank'));

    const listEl = document.getElementById('spil-client-list');

    if (!client.id) {
        listEl.innerHTML = `<div style="color:#64748b;font-size:13px;padding:12px 0">
            Stoor hierdie kliënt eers voordat jy VITA profiele skep.
        </div>`;
        return;
    }

    let profiles = [];
    try {
        profiles = await apiRequest('/spil');
    } catch (err) {
        listEl.innerHTML = `<div style="color:#dc2626;font-size:13px;padding:8px 0">
            Kon nie profiele laai nie: ${escapeHtml(err.message)}
        </div>`;
        return;
    }

    // Filter to profiles linked to this client or matching email
    const linked = (profiles || []).filter(p =>
        p.linked_client_id !== null &&
        p.linked_client_id !== undefined &&
        Number(p.linked_client_id) === Number(client.id)
    );
    const byEmail = (profiles || []).filter(p =>
        !linked.find(l => l.id === p.id) &&
        client.email && p.respondent_email &&
        p.respondent_email.toLowerCase() === client.email.toLowerCase()
    );
    const all = [...linked, ...byEmail];

    if (all.length === 0) {
        listEl.innerHTML = `
            <div style="color:#64748b;font-size:13px;padding:12px 0;border-top:1px solid #f1f5f9">
                Geen VITA profiele vir hierdie kliënt nie.<br>
                <span style="opacity:0.7">
                    Klik <strong>"Open VITA App"</strong> hierbo en skep 'n nuwe profiel.
                </span>
            </div>`;
        return;
    }

    listEl.innerHTML = all.map(p => {
        const hasResults = p.has_results || p.scores;
        const badge = hasResults
            ? `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:#dcfce7;color:#166534">Voltooi</span>`
            : `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:#fef9c3;color:#713f12">Konsep</span>`;

        const code = p.spil_code
            ? `<span style="font-family:monospace;font-size:12px;font-weight:700;color:#0f172a;background:#f8fafc;padding:2px 8px;border-radius:4px;border:1px solid #e2e8f0;margin-left:8px">${escapeHtml(p.spil_code)}</span>`
            : '';

        const ranking = p.spil_code ? buildMiniRanking(p.spil_code) : '';
        const date = p.created_at
            ? new Date(p.created_at).toLocaleDateString('af-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
            : '';

        return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:8px;background:#fafcff;gap:8px;flex-wrap:wrap">
                <div style="flex:1;min-width:120px">
                    <div style="font-size:13px;font-weight:600;color:#1e293b">${escapeHtml(p.respondent_name)}</div>
                    <div style="display:flex;align-items:center;gap:4px;margin-top:4px;flex-wrap:wrap">${badge}${code}</div>
                    ${ranking}
                </div>
                <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:11px;color:#94a3b8">${escapeHtml(date)}</span>
                    <a href="/coaching/spil.html" target="_blank" style="padding:5px 10px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:600;white-space:nowrap">Bekyk →</a>
                </div>
            </div>`;
    }).join('');
}

function buildMiniRanking(spilCode) {
    if (!spilCode) return '';
    const parts = spilCode.split(' – ').filter(Boolean);
    if (!parts.length) return '';

    const dots = parts.slice(0, 3).map(key => {
        const color = DIM_COLORS[key] || '#94a3b8';
        const name = DIM_NAMES[key] || key;
        return `<span title="${name}" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:3px"></span>`;
    }).join('');

    const label = parts.slice(0, 3).map(k => DIM_NAMES[k] || k).join(' / ');

    return `<div style="margin-top:6px;display:flex;align-items:center;gap:4px">
        ${dots}
        <span style="font-size:11px;color:#64748b">${escapeHtml(label)}</span>
    </div>`;
}