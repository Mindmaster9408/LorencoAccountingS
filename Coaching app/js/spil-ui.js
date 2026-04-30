/**
 * spil-ui.js — VITA Profile Frontend Controller
 *
 * State:   In-memory only. API is the single source of truth.
 * Storage: NONE. Zero localStorage / sessionStorage usage.
 * Auth:    Uses existing api.js token helpers (JWT in localStorage — same as
 *          the rest of the Coaching App). That token is authentication state,
 *          not business data.
 */

import { apiRequest, isAuthenticated, clearAuthToken } from './api.js';

// ── Guard: must be logged in ──────────────────────────────────────────────────
if (!isAuthenticated()) {
    window.location.href = 'login.html';
}

// ── Logout ────────────────────────────────────────────────────────────────────
document.getElementById('spil-logout-btn')?.addEventListener('click', () => {
    clearAuthToken();
    window.location.href = 'login.html';
});

// ─────────────────────────────────────────────────────────────────────────────
// QUESTION DEFINITIONS
// Mirrors spil.config.js exactly. Embedded here so the HTML page has no
// separate config fetch. Must remain in sync with backend spil.config.js.
// ─────────────────────────────────────────────────────────────────────────────

const SPIL_DIMS = [
    {
        key: 'STRUKTUUR',
        name: 'Struktuur',
        fullName: 'Struktuur — Sisteme & Orde',
        desc: 'Orde, beplanning, konsekwentheid, betroubaarheid, roetines.',
        color: '#0ea5e9',
        questions: [
            "Ek werk die beste wanneer daar 'n duidelike plan of proses is.",
            "Ek hou daarvan om dinge vooraf te organiseer.",
            "Ek volg roetines en sisteme konsekwent.",
            "Ek raak ongemaklik wanneer dinge chaoties of ongeorganiseerd is.",
            "Ek verkies voorspelbaarheid bo verrassings.",
            "Ek dokumenteer of standaardiseer hoe dinge gedoen moet word.",
            "Ek voltooi take volgens 'n gestruktureerde plan.",
            "Ek vertrou sisteme meer as mense se gevoel.",
            "Ek hou daarvan om beheer te hê oor hoe dinge verloop.",
            "Ek bou eerder stabiliteit as spoed."
        ]
    },
    {
        key: 'PRESTASIE',
        name: 'Prestasie',
        fullName: 'Prestasie — Aksie & Resultate',
        desc: 'Aksie, momentum, resultate, vordering, uitvoering.',
        color: '#f59e0b',
        questions: [
            "Ek neem vinnig besluite en beweeg aan.",
            "Ek hou daarvan om resultate vinnig te sien.",
            "Ek raak gefrustreerd met stadige vordering.",
            "Ek vat eerder aksie as om te lank te dink.",
            "Ek geniet kompetisie en wen.",
            "Ek werk goed onder druk.",
            "Ek soek geleenthede om vorentoe te beweeg.",
            "Ek hou nie van wag nie.",
            "Ek dryf myself om dinge klaar te kry.",
            "Ek kry energie uit momentum."
        ]
    },
    {
        key: 'INSIG',
        name: 'Insig',
        fullName: 'Insig — Logika & Begrip',
        desc: 'Kennis, logika, analise, begrip, leer, groot-prentjie-denke.',
        color: '#8b5cf6',
        questions: [
            "Ek wil eers verstaan voordat ek optree.",
            "Ek analiseer dinge diep voordat ek besluit.",
            "Ek stel belang in hoe en hoekom dinge werk.",
            "Ek geniet dit om te leer en kennis op te bou.",
            "Ek vertrou logika meer as emosie.",
            "Ek vra baie vrae.",
            "Ek hou daarvan om komplekse probleme op te los.",
            "Ek soek akkuraatheid en korrektheid.",
            "Ek verkies feite bo opinies.",
            "Ek dink in terme van die groter prentjie."
        ]
    },
    {
        key: 'LIEFDE',
        name: 'Liefde',
        fullName: 'Liefde — Verbinding & Sorg',
        desc: 'Sorg, verbinding, empatie, verhoudings, opregtheid, ondersteuning.',
        color: '#ec4899',
        questions: [
            "Ek gee om oor mense se gevoelens.",
            "Ek bou maklik diep verhoudings.",
            "Ek wil hê mense moet voel hulle behoort.",
            "Ek help ander selfs al kos dit my iets.",
            "Ek waardeer eerlikheid en opregtheid.",
            "Ek werk goed in spanomgewings.",
            "Ek soek betekenisvolle interaksies.",
            "Ek hou daarvan om mense te ondersteun.",
            "Ek neem ander se emosies in ag.",
            "Ek soek verbinding bo resultate."
        ]
    },
    {
        key: 'EMOSIE',
        name: 'Emosie',
        fullName: 'Emosie — Harmonie & Balans',
        desc: 'Balans, emosionele veiligheid, harmonie, vrede, etiek, stabiliteit.',
        color: '#10b981',
        questions: [
            "Ek vermy konflik waar moontlik.",
            "Ek soek harmonie in my omgewing.",
            "Ek raak ongemaklik met spanning.",
            "Ek probeer vrede hou tussen mense.",
            "Ek verkies stabiliteit bo verandering.",
            "Ek hou van 'n rustige omgewing.",
            "Ek neem besluite wat konflik verminder.",
            "Ek fokus op wat regverdig en eties is.",
            "Ek hou nie van drama nie.",
            "Ek beskerm my emosionele energie."
        ]
    },
    {
        key: 'INISIATIEF',
        name: 'Inisiatief',
        fullName: 'Inisiatief (E+) — Visie & Begin',
        desc: 'Inisiatief, moontlikheidsdenke, bou, risikotoleransie, visie.',
        color: '#f97316',
        questions: [
            "Ek sien geleenthede waar ander probleme sien.",
            "Ek begin dinge al weet ek nie alles nie.",
            "Ek is gemaklik met onsekerheid.",
            "Ek vat risiko's as ek glo dit kan werk.",
            "Ek dink in terme van moontlikhede eerder as beperkings.",
            "Ek raak opgewonde oor nuwe idees.",
            "Ek bou eerder iets nuuts as om iets te volg.",
            "Ek vertrou my instink wanneer ek besluite neem.",
            "Ek sien die groter visie voordat ander dit sien.",
            "Ek sal iets probeer selfs al kan ek misluk."
        ]
    }
];

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY STATE — no localStorage
// ─────────────────────────────────────────────────────────────────────────────

const state = {
    profiles:       [],     // list summary from GET /api/spil
    currentProfile: null,   // full profile object from GET /api/spil/:id
    answers:        {}      // { DIM_N: value, ... } while filling questionnaire
};

// ─────────────────────────────────────────────────────────────────────────────
// VIEW SWITCHING
// ─────────────────────────────────────────────────────────────────────────────

const VIEWS = ['spil-view-list', 'spil-view-questionnaire', 'spil-view-results'];

function showView(id) {
    VIEWS.forEach(v => {
        document.getElementById(v).style.display = v === id ? '' : 'none';
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTICE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function setNotice(elId, msg, type = 'info') {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!msg) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="spil-notice spil-notice-${type}">${msg}</div>`;
}

function clearNotice(elId) { setNotice(elId, ''); }

// ─────────────────────────────────────────────────────────────────────────────
// API HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function loadProfiles() {
    return await apiRequest('/spil');
}

async function createProfile(body) {
    return await apiRequest('/spil', { method: 'POST', body: JSON.stringify(body) });
}

async function loadProfile(id) {
    return await apiRequest(`/spil/${id}`);
}

async function submitAnswers(id, body) {
    return await apiRequest(`/spil/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}

// ─────────────────────────────────────────────────────────────────────────────
// LIST VIEW
// ─────────────────────────────────────────────────────────────────────────────

async function renderList() {
    showView('spil-view-list');
    hideCreatePanel();
    clearNotice('spil-list-notice');

    const container = document.getElementById('spil-profiles-list');
    container.innerHTML = '<div class="spil-empty-state"><span class="spil-spinner"></span> Profiele laai...</div>';

    try {
        state.profiles = await loadProfiles();
    } catch (err) {
        container.innerHTML = '';
        setNotice('spil-list-notice', `Kon nie profiele laai nie: ${err.message}`, 'error');
        return;
    }

    if (!state.profiles || state.profiles.length === 0) {
        container.innerHTML = '<div class="spil-empty-state">Geen profiele nie. Klik <strong>+ Nuwe Profiel</strong> om te begin.</div>';
        return;
    }

    const rows = state.profiles.map(p => {
        const hasResults = p.has_results || p.scores;
        const badge = hasResults
            ? '<span class="spil-profile-badge badge-complete">Voltooi</span>'
            : '<span class="spil-profile-badge badge-draft">Konsep</span>';

        const code = p.spil_code
            ? `<div class="spil-profile-code">${escHtml(p.spil_code)}</div>`
            : '';

        const date = p.created_at
            ? new Date(p.created_at).toLocaleDateString('af-ZA', { day: '2-digit', month: 'short', year: 'numeric' })
            : '';

        return `
            <div class="spil-profile-row" data-id="${p.id}">
                <div>
                    <div class="spil-profile-name">${escHtml(p.respondent_name)}</div>
                    ${code}
                </div>
                <div style="display:flex; align-items:center; gap:12px;">
                    ${badge}
                    <span class="spil-profile-meta">${escHtml(date)}</span>
                </div>
            </div>`;
    }).join('');

    container.innerHTML = `<div class="spil-profiles-list">${rows}</div>`;

    container.querySelectorAll('.spil-profile-row').forEach(row => {
        row.addEventListener('click', () => openProfile(parseInt(row.dataset.id, 10)));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE PANEL
// ─────────────────────────────────────────────────────────────────────────────

function showCreatePanel() {
    document.getElementById('spil-create-panel').style.display = '';
    document.getElementById('btn-new-profile').style.display = 'none';
    clearNotice('spil-create-notice');
    document.getElementById('new-name').focus();
}

function hideCreatePanel() {
    document.getElementById('spil-create-panel').style.display = 'none';
    document.getElementById('btn-new-profile').style.display = '';
    ['new-name', 'new-email', 'new-phone'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('new-lang').value = 'af';
}

document.getElementById('btn-new-profile').addEventListener('click', showCreatePanel);
document.getElementById('btn-cancel-create').addEventListener('click', hideCreatePanel);

document.getElementById('btn-save-create').addEventListener('click', async () => {
    const name  = document.getElementById('new-name').value.trim();
    const email = document.getElementById('new-email').value.trim();
    const phone = document.getElementById('new-phone').value.trim();
    const lang  = document.getElementById('new-lang').value;

    if (!name) {
        setNotice('spil-create-notice', 'Naam is verpligtend.', 'warn');
        document.getElementById('new-name').focus();
        return;
    }

    const btn = document.getElementById('btn-save-create');
    btn.disabled = true;
    btn.textContent = 'Besig...';
    clearNotice('spil-create-notice');

    try {
        const profile = await createProfile({
            respondentName:  name,
            respondentEmail: email || undefined,
            respondentPhone: phone || undefined,
            preferredLang:   lang
        });

        hideCreatePanel();
        // Navigate straight to questionnaire for the new profile
        await openProfile(profile.id);
    } catch (err) {
        setNotice('spil-create-notice', `Kon nie profiel skep nie: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Skep Profiel';
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// OPEN PROFILE
// ─────────────────────────────────────────────────────────────────────────────

async function openProfile(id) {
    let profile;
    try {
        profile = await loadProfile(id);
    } catch (err) {
        setNotice('spil-list-notice', `Kon nie profiel laai nie: ${err.message}`, 'error');
        return;
    }

    state.currentProfile = profile;
    state.answers = {};  // fresh in-memory answers

    if (profile.scores) {
        // Already has results — go straight to results
        renderResults(profile);
    } else {
        // No results yet — go to questionnaire
        renderQuestionnaire(profile);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// QUESTIONNAIRE VIEW
// ─────────────────────────────────────────────────────────────────────────────

function renderQuestionnaire(profile) {
    showView('spil-view-questionnaire');
    state.answers = {};

    document.getElementById('q-profile-name').textContent =
        `VITA Profiel Vraelys — ${profile.respondent_name}`;

    clearNotice('q-submit-notice');
    document.getElementById('q-validation-msg').style.display = 'none';

    const sectionsEl = document.getElementById('q-sections');
    sectionsEl.innerHTML = '';

    let globalQ = 0;

    SPIL_DIMS.forEach(dim => {
        const section = document.createElement('div');
        section.className = 'spil-section';
        section.style.borderLeftColor = dim.color;

        const qRows = dim.questions.map((text, qIdx) => {
            globalQ++;
            const key = `${dim.key}_${qIdx + 1}`;
            const scaleButtons = Array.from({ length: 10 }, (_, i) => i + 1).map(n =>
                `<button class="spil-scale-btn" data-key="${key}" data-val="${n}" type="button">${n}</button>`
            ).join('');

            return `
                <div class="spil-question" id="q-row-${key}">
                    <div class="spil-question-header">
                        <span class="spil-question-num">${globalQ}.</span>
                        <span class="spil-question-text">${escHtml(text)}</span>
                    </div>
                    <div class="spil-scale" id="scale-${key}">
                        ${scaleButtons}
                    </div>
                    <div class="spil-scale-labels">
                        <span>Stem glad nie saam nie</span>
                        <span>Stem heeltemal saam</span>
                    </div>
                </div>`;
        }).join('');

        section.innerHTML = `
            <h3 class="spil-section-title">${escHtml(dim.fullName)}</h3>
            <p class="spil-section-desc">${escHtml(dim.desc)}</p>
            <div class="spil-section-questions">${qRows}</div>`;

        sectionsEl.appendChild(section);
    });

    // Delegate click events for scale buttons
    sectionsEl.addEventListener('click', e => {
        const btn = e.target.closest('.spil-scale-btn');
        if (!btn) return;

        const key = btn.dataset.key;
        const val = parseInt(btn.dataset.val, 10);

        state.answers[key] = val;

        // Update selected state in this scale row
        document.querySelectorAll(`.spil-scale-btn[data-key="${key}"]`).forEach(b => {
            b.classList.toggle('selected', parseInt(b.dataset.val, 10) === val);
        });

        updateProgress();
    });

    updateProgress();
}

function updateProgress() {
    const answered = Object.keys(state.answers).length;
    const pct = Math.round((answered / 60) * 100);
    document.getElementById('q-progress-fill').style.width = pct + '%';
    document.getElementById('q-progress-label').textContent = `${answered} / 60 vrae beantwoord`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBMIT ANSWERS
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('btn-submit-answers').addEventListener('click', async () => {
    const answered = Object.keys(state.answers).length;
    const msgEl = document.getElementById('q-validation-msg');

    if (answered < 60) {
        msgEl.style.display = 'block';
        msgEl.textContent = `Beantwoord asseblief alle 60 vrae. (${answered}/60 beantwoord)`;
        // Scroll to first unanswered
        scrollToFirstUnanswered();
        return;
    }

    msgEl.style.display = 'none';

    const btn = document.getElementById('btn-submit-answers');
    btn.disabled = true;
    btn.innerHTML = '<span class="spil-spinner"></span>Besig om te bereken...';
    clearNotice('q-submit-notice');

    try {
        const updated = await submitAnswers(state.currentProfile.id, {
            answers: state.answers
        });

        state.currentProfile = updated;
        state.answers = {};
        renderResults(updated);
    } catch (err) {
        setNotice('q-submit-notice', `Indiening het misluk: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Vraelys Indien';
    }
});

function scrollToFirstUnanswered() {
    for (const dim of SPIL_DIMS) {
        for (let i = 1; i <= 10; i++) {
            const key = `${dim.key}_${i}`;
            if (!state.answers[key]) {
                const row = document.getElementById(`q-row-${key}`);
                if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS VIEW
// ─────────────────────────────────────────────────────────────────────────────

function renderResults(profile) {
    showView('spil-view-results');
    clearNotice('results-notice');

    if (!profile.scores || !profile.ranking) {
        setNotice('results-notice', 'Geen resultate beskikbaar nie. Voltooi die vraelys eers.', 'warn');
        document.getElementById('results-code-display').style.display = 'none';
        document.getElementById('tab-scores').style.display = 'none';
        document.querySelector('.spil-tabs').style.display = 'none';
        return;
    }

    document.getElementById('results-code-display').style.display = '';
    document.querySelector('.spil-tabs').style.display = '';

    // SPIL Code
    document.getElementById('results-spil-code').textContent =
        profile.spil_code ?? '—';

    // Ranking list
    const rankingEl = document.getElementById('results-ranking');
    const ranking = profile.ranking ?? [];
    rankingEl.innerHTML = ranking.map((dimKey, idx) => {
        const dim = SPIL_DIMS.find(d => d.key === dimKey);
        const score = profile.scores?.[dimKey] ?? 0;
        return `<li>
            <span class="spil-rank-pos">#${idx + 1}</span>
            <span class="spil-rank-name" style="color:${dim?.color ?? '#1f2937'}">${dim?.name ?? dimKey}</span>
            <span style="font-size:13px; color:#64748b; margin-left:auto;">${score}/100</span>
        </li>`;
    }).join('');

    // Score bars (ordered by ranking)
    const scoresEl = document.getElementById('results-scores');
    scoresEl.innerHTML = ranking.map(dimKey => {
        const dim = SPIL_DIMS.find(d => d.key === dimKey);
        const score = profile.scores?.[dimKey] ?? 0;
        const pct   = Math.round((score / 100) * 100);
        return `
            <div class="spil-score-row">
                <div class="spil-score-dim" style="color:${dim?.color ?? '#1f2937'}">${dim?.name ?? dimKey}</div>
                <div class="spil-score-bar-track">
                    <div class="spil-score-bar-fill" style="width:${pct}%; background:${dim?.color ?? '#3b82f6'}"></div>
                </div>
                <div class="spil-score-num" style="color:${dim?.color ?? '#2563eb'}">${score}</div>
            </div>`;
    }).join('');

    // Report
    const reportEl = document.getElementById('results-report-content');
    if (profile.report_generated?.markdown) {
        reportEl.innerHTML = renderMarkdown(profile.report_generated.markdown);
    } else {
        reportEl.innerHTML = '<div class="spil-notice spil-notice-warn">Verslag is nog nie gegenereer nie.</div>';
    }

    // Internal notes
    const notesEl = document.getElementById('results-notes-content');
    if (profile.report_internal?.markdown) {
        notesEl.innerHTML = renderMarkdown(profile.report_internal.markdown);
    } else {
        notesEl.innerHTML = '<div class="spil-notice spil-notice-info">Geen afrigternotas beskikbaar nie.</div>';
    }

    // Show scores tab by default
    switchResultsTab('scores');
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS TABS
// ─────────────────────────────────────────────────────────────────────────────

function switchResultsTab(name) {
    ['scores', 'report', 'notes'].forEach(t => {
        const panel = document.getElementById(`tab-${t}`);
        const btn   = document.querySelector(`.spil-tab[data-tab="${t}"]`);
        if (panel) panel.style.display = t === name ? '' : 'none';
        if (btn)   btn.classList.toggle('active', t === name);
    });
}

document.querySelectorAll('.spil-tab').forEach(btn => {
    btn.addEventListener('click', () => switchResultsTab(btn.dataset.tab));
});

// Coach notes toggle
document.getElementById('notes-toggle-bar').addEventListener('click', () => {
    const panel = document.getElementById('notes-panel');
    const hint  = document.getElementById('notes-toggle-hint');
    const bar   = document.getElementById('notes-toggle-bar');
    const open  = panel.classList.toggle('visible');
    hint.textContent  = open ? 'Klik om te verberg' : 'Klik om te wys';
    bar.setAttribute('aria-expanded', String(open));
});

// ─────────────────────────────────────────────────────────────────────────────
// RETAKE
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('btn-retake').addEventListener('click', () => {
    if (!state.currentProfile) return;
    state.answers = {};
    renderQuestionnaire(state.currentProfile);
});

// ─────────────────────────────────────────────────────────────────────────────
// BACK LINKS
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('btn-back-from-q').addEventListener('click', () => {
    state.answers = {};
    renderList();
});

document.getElementById('btn-back-from-results').addEventListener('click', () => {
    state.currentProfile = null;
    renderList();
});

// ─────────────────────────────────────────────────────────────────────────────
// MARKDOWN RENDERER
// Minimal safe renderer — handles the exact Markdown produced by spil.report.js.
// No third-party dependency. XSS-safe: raw HTML in markdown is never trusted.
// ─────────────────────────────────────────────────────────────────────────────

function renderMarkdown(md) {
    if (!md) return '';

    // Escape any HTML that might be in the content
    let s = md
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Headings
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Horizontal rule
    s = s.replace(/^---$/gm, '<hr>');

    // Bold + italic (**bold** and *italic*)
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g,     '<em>$1</em>');

    // Blockquote (> text)
    s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Simple table — detect lines that contain | and have a separator row
    s = renderMarkdownTables(s);

    // Ordered list (1. item)
    s = s.replace(/(^|\n)((\d+\. .+\n?)+)/g, (_, pre, block) => {
        const items = block.trim().split('\n')
            .map(line => `<li>${line.replace(/^\d+\.\s+/, '')}</li>`)
            .join('');
        return `${pre}<ol>${items}</ol>`;
    });

    // Unordered list (* or - item)
    s = s.replace(/(^|\n)(([*\-] .+\n?)+)/g, (_, pre, block) => {
        const items = block.trim().split('\n')
            .map(line => `<li>${line.replace(/^[*\-]\s+/, '')}</li>`)
            .join('');
        return `${pre}<ul>${items}</ul>`;
    });

    // Paragraphs — wrap double-newline separated blocks not already wrapped in a block element
    const blockTags = ['<h1','<h2','<h3','<hr','<blockquote','<ol','<ul','<table'];
    const paragraphs = s.split(/\n\n+/);
    s = paragraphs.map(block => {
        const trimmed = block.trim();
        if (!trimmed) return '';
        const isBlock = blockTags.some(t => trimmed.startsWith(t));
        return isBlock ? trimmed : `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');

    return s;
}

function renderMarkdownTables(s) {
    // Match a table block: header row | separator row | data rows
    return s.replace(/((?:^.+\|.+\n){1}(?:^[-| ]+\n){1}(?:^.+\|.+\n?)+)/gm, (block) => {
        const lines = block.trim().split('\n').filter(Boolean);
        if (lines.length < 3) return block;

        const headerCells = lines[0].split('|').map(c => c.trim()).filter(Boolean);
        const dataLines   = lines.slice(2);

        const thead = '<thead><tr>' +
            headerCells.map(c => `<th>${c}</th>`).join('') +
            '</tr></thead>';

        const tbody = '<tbody>' +
            dataLines.map(line => {
                const cells = line.split('|').map(c => c.trim()).filter(Boolean);
                return '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
            }).join('') +
            '</tbody>';

        return `<table>${thead}${tbody}</table>`;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

renderList();
