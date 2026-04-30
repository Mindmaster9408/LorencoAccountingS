/**
 * spil-client.js — VITA Profile full in-panel assessment (v3)
 * Flow: options screen -> questionnaire (60 vrae) -> calculate -> report
 * Mirrors the BASIS Assessment pattern.
 */

import { apiRequest } from './api.js';
import { escapeHtml } from './config.js';
import {
    VITA_DIMENSIONS, VITA_QUESTIONS,
    DIM_LABELS, DIM_COLORS, DIM_DESCRIPTIONS, DIM_GROWTH
} from './spil-questions.js';

export async function renderSpilClientPanel(client, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `<div style="padding:20px;color:#64748b;font-size:13px">Laai profiele...</div>`;

    let profiles = [];
    try {
        const all = await apiRequest('/spil');
        profiles = (all || []).filter(p =>
            p.linked_client_id !== null &&
            p.linked_client_id !== undefined &&
            Number(p.linked_client_id) === Number(client.id)
        );
    } catch (err) {
        container.innerHTML = `<div style="padding:20px;color:#dc2626;font-size:13px">Kon nie profiele laai nie: ${escapeHtml(err.message)}</div>`;
        return;
    }

    const completed = profiles.find(p => p.scores && p.spil_code);
    if (completed) {
        renderReport(container, completed, client, containerId);
    } else if (profiles.length > 0) {
        const detail = await apiRequest(`/spil/${profiles[0].id}`).catch(() => profiles[0]);
        renderQuestionnaire(container, client, containerId, detail);
    } else {
        renderOptionsScreen(container, client, containerId);
    }
}

function renderOptionsScreen(container, client, containerId) {
    container.innerHTML = `
        <div style="padding:24px;text-align:center">
            <div style="font-size:52px;margin-bottom:16px">&#x1F9ED;</div>
            <h3 style="margin:0 0 8px 0;font-size:18px;font-weight:700;color:#1e293b">VITA Profiel</h3>
            <p style="color:#64748b;font-size:14px;margin:0 0 32px 0;max-width:400px;margin-left:auto;margin-right:auto;line-height:1.6">
                Ontdek jou dryfkragte, sterkpunte en groei-areas deur 60 insiggewende vrae.
                Elke stelling word beoordeel op 'n skaal van 1 (glad nie) tot 10 (altyd).
            </p>
            <button id="vita-start-btn" style="
                padding:13px 36px;background:#0f172a;color:#e2e8f0;border:none;
                border-radius:8px;cursor:pointer;font-size:15px;font-weight:700;letter-spacing:0.3px
            ">Begin VITA Assessering</button>
        </div>`;
    document.getElementById('vita-start-btn').addEventListener('click', () => {
        renderQuestionnaire(container, client, containerId, null);
    });
}

function renderQuestionnaire(container, client, containerId, existingProfile) {
    const savedAnswers = (existingProfile && existingProfile.answers) ? existingProfile.answers : {};

    container.innerHTML = `
        <div style="padding:20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <div>
                    <h3 style="margin:0;font-size:16px;font-weight:700;color:#1e293b">&#x1F9ED; VITA Assessering</h3>
                    <p style="margin:4px 0 0 0;color:#64748b;font-size:12px">1 = glad nie &nbsp;|&nbsp; 10 = altyd</p>
                </div>
                <span id="vita-progress-text" style="font-size:13px;color:#64748b;font-weight:700;white-space:nowrap">0 / 60</span>
            </div>
            <div style="height:5px;background:#f1f5f9;border-radius:3px;margin-bottom:24px">
                <div id="vita-progress-bar" style="height:5px;background:#0ea5e9;border-radius:3px;width:0%;transition:width 0.3s"></div>
            </div>
            <div id="vita-questions-form"></div>
            <div style="margin-top:24px;padding-top:16px;border-top:1px solid #f1f5f9;display:flex;justify-content:flex-end;align-items:center;gap:12px">
                <span id="vita-validation-msg" style="color:#dc2626;font-size:13px;display:none">Beantwoord asseblief al 60 vrae.</span>
                <button id="vita-calculate-btn" style="
                    padding:11px 28px;background:#0f172a;color:#e2e8f0;border:none;
                    border-radius:8px;cursor:pointer;font-size:14px;font-weight:700
                ">Bereken Resultate</button>
            </div>
        </div>`;

    const form = document.getElementById('vita-questions-form');

    VITA_DIMENSIONS.forEach(dim => {
        const section = document.createElement('div');
        section.style.marginBottom = '28px';
        const colorDot = DIM_COLORS[dim];
        section.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid ${colorDot}33">
                <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${colorDot};flex-shrink:0"></span>
                <h4 style="margin:0;font-size:14px;font-weight:700;color:#1e293b">${DIM_LABELS[dim]}</h4>
            </div>`;

        VITA_QUESTIONS[dim].forEach((question, qi) => {
            const key = `${dim}_${qi + 1}`;
            const saved = savedAnswers[key] || '';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;padding:10px 12px;border:1px solid #f1f5f9;border-radius:8px;background:#fafcff';
            const opts = [1,2,3,4,5,6,7,8,9,10].map(n =>
                `<option value="${n}"${saved == n ? ' selected' : ''}>${n}</option>`
            ).join('');
            row.innerHTML = `
                <span style="min-width:22px;font-size:12px;color:#94a3b8;padding-top:3px;text-align:right">${qi + 1}.</span>
                <span style="flex:1;font-size:13px;color:#374151;line-height:1.55">${escapeHtml(question)}</span>
                <select data-key="${key}" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;color:#1e293b;background:white;cursor:pointer;min-width:72px;flex-shrink:0">
                    <option value="">—</option>${opts}
                </select>`;
            section.appendChild(row);
        });
        form.appendChild(section);
    });

    function updateProgress() {
        let answered = 0;
        form.querySelectorAll('select[data-key]').forEach(s => { if (s.value) answered++; });
        const pct = Math.round(answered / 60 * 100);
        document.getElementById('vita-progress-bar').style.width = pct + '%';
        document.getElementById('vita-progress-text').textContent = `${answered} / 60`;
    }
    form.addEventListener('change', updateProgress);
    updateProgress();

    document.getElementById('vita-calculate-btn').addEventListener('click', async () => {
        const finalAnswers = {};
        let answered = 0;
        form.querySelectorAll('select[data-key]').forEach(s => {
            if (s.value) { finalAnswers[s.dataset.key] = Number(s.value); answered++; }
        });
        if (answered < 60) {
            document.getElementById('vita-validation-msg').style.display = 'inline';
            return;
        }
        const btn = document.getElementById('vita-calculate-btn');
        btn.textContent = 'Bereken...';
        btn.disabled = true;
        try {
            let profile;
            if (existingProfile && existingProfile.id) {
                profile = await apiRequest(`/spil/${existingProfile.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({ answers: finalAnswers, respondent_name: client.name })
                });
            } else {
                profile = await apiRequest('/spil', {
                    method: 'POST',
                    body: JSON.stringify({
                        respondent_name: client.name,
                        respondent_email: client.email || null,
                        linked_client_id: client.id,
                        answers: finalAnswers
                    })
                });
            }
            renderReport(container, profile, client, containerId);
        } catch (err) {
            btn.textContent = 'Bereken Resultate';
            btn.disabled = false;
            const msg = document.getElementById('vita-validation-msg');
            msg.textContent = 'Kon nie resultate stoor nie: ' + err.message;
            msg.style.display = 'inline';
        }
    });
}

function renderReport(container, profile, client, containerId) {
    const scores  = profile.scores  || {};
    const ranking = profile.ranking || VITA_DIMENSIONS.slice().sort((a, b) => (scores[b]||0) - (scores[a]||0));
    const code    = profile.spil_code || ranking.join(' - ');
    const date    = profile.created_at
        ? new Date(profile.created_at).toLocaleDateString('af-ZA', { day: '2-digit', month: 'long', year: 'numeric' })
        : '';

    const primary    = ranking[0];
    const supporting = ranking[1];
    const lowest     = ranking[ranking.length - 1];
    const hasInisiatief = ranking.slice(0, 3).includes('INISIATIEF');

    const lifePattern = `Jy dink in terme van ${DIM_LABELS[primary].toLowerCase()} en ${DIM_LABELS[supporting].toLowerCase()}, maar mag sukkel om vordering te stabiliseer waar ${DIM_LABELS[lowest].toLowerCase()} swakker is.`;

    const dimBars = ranking.map((dim, i) => {
        const score = scores[dim] || 0;
        const medal = i === 0 ? '&#x1F947;' : i === 1 ? '&#x1F948;' : i === 2 ? '&#x1F949;' : `${i+1}.`;
        return `
            <div style="margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
                    <span style="font-size:13px;font-weight:600;color:#1e293b">${medal} ${DIM_LABELS[dim]}</span>
                    <span style="font-size:13px;font-weight:700;color:#1e293b">${score}<span style="font-weight:400;color:#94a3b8">/100</span></span>
                </div>
                <div style="height:8px;background:#f1f5f9;border-radius:4px">
                    <div style="height:8px;background:${DIM_COLORS[dim]};border-radius:4px;width:${score}%"></div>
                </div>
            </div>`;
    }).join('');

    container.innerHTML = `
        <div style="padding:20px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px">
                <div>
                    <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px">VITA PROFIEL</div>
                    <h3 style="margin:0 0 2px 0;font-size:17px;font-weight:700;color:#1e293b">${escapeHtml(client.name)}</h3>
                    <div style="font-size:12px;color:#94a3b8">${escapeHtml(date)}</div>
                </div>
                <button id="vita-retake-btn" style="padding:7px 14px;background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">&#x21BA; Herhaal</button>
            </div>
            <div style="background:#0f172a;border-radius:10px;padding:16px 20px;margin-bottom:16px">
                <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px">Jou VITA Kode</div>
                <div style="font-size:13px;font-weight:700;color:#e2e8f0;letter-spacing:0.5px;font-family:monospace">${escapeHtml(code)}</div>
            </div>
            <div style="background:#f8fafc;border-radius:10px;padding:16px 20px;margin-bottom:16px">
                <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:14px">Dimensie Tellings</div>
                ${dimBars}
            </div>
            ${vitaSection('Primere Dryfkrag', `
                <p style="margin:0 0 6px 0;font-size:14px">Jou primere dryfkrag is <strong>${DIM_LABELS[primary]}</strong>.</p>
                <p style="margin:0;color:#64748b;font-size:13px;line-height:1.55">${DIM_DESCRIPTIONS[primary]}</p>
            `)}
            ${vitaSection('Ondersteunende Krag', `
                <p style="margin:0 0 6px 0;font-size:14px">Jou ondersteunende krag is <strong>${DIM_LABELS[supporting]}</strong>.</p>
                <p style="margin:0;color:#64748b;font-size:13px;line-height:1.55">${DIM_DESCRIPTIONS[supporting]}</p>
            `)}
            ${vitaSection('Visie', hasInisiatief
                ? `<p style="margin:0;color:#64748b;font-size:13px;line-height:1.55">Jy toon sterk tekens van geleenthede sien, verby die hede te dink en iets betekenisvolles te wil bou of skep.</p>`
                : `<p style="margin:0;color:#64748b;font-size:13px;line-height:1.55">Jy verkies moontlik stabiliteit bo onsekerheid en benader groei meer versigtig.</p>`
            )}
            ${vitaSection('Groei-area', `
                <p style="margin:0 0 6px 0;font-size:14px">Jou groei-area is <strong>${DIM_LABELS[lowest]}</strong>.</p>
                <p style="margin:0;color:#64748b;font-size:13px;line-height:1.55">${DIM_GROWTH[lowest]}</p>
            `)}
            ${vitaSection('Lewenspatroon', `
                <p style="margin:0;color:#64748b;font-size:13px;line-height:1.55">${escapeHtml(lifePattern)}</p>
            `)}
            ${vitaSection('Werk-insig', `
                <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">
                    Jy presteer die beste in omgewings waar <strong>${DIM_LABELS[primary]}</strong> en <strong>${DIM_LABELS[supporting]}</strong> aktief gebruik word.<br><br>
                    Jy mag sukkel in omgewings wat hoofsaaklik deur <strong>${DIM_LABELS[lowest]}</strong> gedryf word.
                </p>
            `)}
            ${vitaSection('Refleksie', `
                <ol style="margin:0;padding-left:20px;color:#64748b;font-size:13px;line-height:2">
                    <li>Waar gebruik jy jou sterkpunte tans?</li>
                    <li>Waar is jy vas?</li>
                    <li>Wat kan jy hierdie week aanpas?</li>
                </ol>
            `)}
            <div style="margin-top:12px;padding:12px 16px;background:#f0fdf4;border-radius:8px;border-left:3px solid #22c55e">
                <p style="margin:0;font-size:12px;color:#166534;line-height:1.55;font-style:italic">
                    Dit is slegs die beginpunt. Hierdie profiel lei bewustheid - dit definieer nie identiteit nie.
                </p>
            </div>
        </div>`;

    document.getElementById('vita-retake-btn').addEventListener('click', () => {
        renderQuestionnaire(container, client, containerId, profile);
    });
}

function vitaSection(title, html) {
    return `
        <div style="margin-bottom:10px;padding:14px 16px;border:1px solid #f1f5f9;border-radius:8px;background:#fff">
            <div style="font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px">${escapeHtml(title)}</div>
            ${html}
        </div>`;
}
