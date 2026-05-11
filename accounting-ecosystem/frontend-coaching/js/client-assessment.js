// Client-side BASIS assessment for standalone client portal
// All token validation and result storage uses the backend API (no localStorage).
import { BASIS_QUESTIONS, SECTION_LABELS, getBASISResults } from './basis-assessment.js';

console.log('[CA] Module loaded — v20260511-001');

const $ = (selector) => document.querySelector(selector);
const API_BASE = '/api/coaching/assessment-tokens';

let tokenData = null;   // { clientId, clientName } from the server
let clientData = null;  // info the client fills in before starting
let basisAnswers = {};  // flat format: { "SECTION_questionId": value }

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTokenFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
}

function showError(message = null) {
    const errorSection = $('#error-section');
    if (errorSection) errorSection.style.display = 'block';
    const clientInfo = $('#client-info-section');
    if (clientInfo) clientInfo.style.display = 'none';

    if (message) {
        const msgEl = errorSection ? errorSection.querySelector('.error-message p') : null;
        if (msgEl) msgEl.textContent = message;
    }
}

// Public fetch helper — no auth token needed for assessment token endpoints
async function publicFetch(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

// ── Token validation ─────────────────────────────────────────────────────────

async function validateToken() {
    console.log('[CA] validateToken called');
    const token = getTokenFromURL();
    console.log('[CA] Token from URL:', token ? token.slice(0, 12) + '...' : '(none)');
    if (!token) {
        showError();
        return false;
    }

    try {
        const result = await publicFetch(`${API_BASE}/${encodeURIComponent(token)}`);
        tokenData = result.tokenData;   // { clientId, clientName }
        console.log('[CA] validateToken success — clientName:', tokenData ? tokenData.clientName : '(no tokenData)');
        return true;
    } catch (err) {
        if (err.message === 'Assessment already completed') {
            showError('This assessment has already been completed.');
        } else if (err.message === 'Token expired') {
            showError('This assessment link has expired. Please ask your coach for a new link.');
        } else {
            showError();
        }
        return false;
    }
}

// ── Client info form ─────────────────────────────────────────────────────────

function setupStartButton() {
    console.log('[CA] setupStartButton called');
    const btn = $('#start-assessment-btn');
    if (!btn) {
        console.error('[CA] ERROR: #start-assessment-btn not found in DOM');
        return;
    }
    console.log('[CA] Start button found — attaching click handler');

    btn.addEventListener('click', () => {
        console.log('[CA] Start Assessment button clicked');
        const firstName = $('#client-firstname').value.trim();
        const surname   = $('#client-surname').value.trim();
        const email     = ($('#client-email')  || {}).value || '';
        const phone     = ($('#client-phone')  || {}).value || '';
        const language  = ($('#client-language') || { value: 'English' }).value;

        if (!firstName || !surname) {
            alert('Please enter your first name and surname.');
            return;
        }

        clientData = {
            firstName,
            surname,
            name: `${firstName} ${surname}`,
            email:          email.trim(),
            phone:          phone.trim(),
            preferred_lang: language
        };

        $('#client-info-section').style.display = 'none';
        $('#assessment-section').style.display = 'block';

        renderAssessment();
    });
}

// ── Assessment rendering ─────────────────────────────────────────────────────

function renderAssessment() {
    console.log('[CA] renderAssessment called');
    const container = $('#basis-assessment-container');
    if (!container) {
        console.error('[CA] ERROR: #basis-assessment-container not found');
        return;
    }

    container.innerHTML = `
        <div class="basis-assessment">
            <div class="basis-header">
                <h2>BASIS Assessment</h2>
                <p class="basis-instructions">
                    Answer each question on a scale of 1 to 10:<br>
                    <strong>1</strong> = Not true of me at all | <strong>10</strong> = Completely true of me
                </p>
                <div class="basis-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" id="basis-progress-fill" style="width: 0%"></div>
                    </div>
                    <span id="basis-progress-text">0 / 50 questions answered</span>
                </div>
            </div>

            <div class="basis-sections" id="basis-sections">
                ${renderAllSections()}
            </div>

            <div class="basis-footer">
                <button id="submit-basis" class="btn-primary">Submit Assessment</button>
            </div>
        </div>
    `;

    attachEventListeners();
}

function renderAllSections() {
    return Object.keys(SECTION_LABELS).map(sectionKey => {
        const sectionQuestions = BASIS_QUESTIONS[sectionKey];
        return `
            <div class="basis-section">
                <h3 class="section-title">${SECTION_LABELS[sectionKey]}</h3>
                <div class="section-questions">
                    ${sectionQuestions.map((q, idx) => renderQuestion(sectionKey, idx, q)).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function renderQuestion(section, index, question) {
    const globalIndex = getGlobalQuestionIndex(section, index);
    const isReverse   = question.reverse ? ' <span class="reverse-tag">REVERSE</span>' : '';
    // Use the flat key expected by calculateSectionScore: "SECTION_questionId"
    const questionKey = `${section}_${question.id}`;

    return `
        <div class="basis-question">
            <div class="question-header">
                <span class="question-number">${globalIndex + 1}.</span>
                <span class="question-text">${question.text}${isReverse}</span>
            </div>
            <div class="question-scale">
                ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(val => `
                    <button class="scale-btn"
                        data-question-key="${questionKey}"
                        data-value="${val}">${val}</button>
                `).join('')}
            </div>
        </div>
    `;
}

function getGlobalQuestionIndex(section, localIndex) {
    const sections = Object.keys(SECTION_LABELS);
    const sectionIndex = sections.indexOf(section);
    let globalIndex = 0;
    for (let i = 0; i < sectionIndex; i++) {
        globalIndex += BASIS_QUESTIONS[sections[i]].length;
    }
    return globalIndex + localIndex;
}

function attachEventListeners() {
    document.querySelectorAll('.scale-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const questionKey = btn.dataset.questionKey;
            const value       = parseInt(btn.dataset.value);

            // Store answer in flat format — matches calculateSectionScore expectations
            basisAnswers[questionKey] = value;

            // Highlight selected button
            document.querySelectorAll(`.scale-btn[data-question-key="${questionKey}"]`)
                .forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');

            updateProgress();
        });
    });

    const submitBtn = $('#submit-basis');
    if (submitBtn) submitBtn.addEventListener('click', submitAssessment);
}

function updateProgress() {
    const totalQuestions  = Object.values(BASIS_QUESTIONS).reduce((sum, arr) => sum + arr.length, 0);
    const answeredCount   = Object.keys(basisAnswers).length;
    const percentage      = Math.round((answeredCount / totalQuestions) * 100);

    const fillEl = $('#basis-progress-fill');
    const textEl = $('#basis-progress-text');
    if (fillEl) fillEl.style.width = percentage + '%';
    if (textEl) textEl.textContent = `${answeredCount} / ${totalQuestions} questions answered`;
}

// ── Submission ───────────────────────────────────────────────────────────────

async function submitAssessment() {
    const totalQuestions = Object.values(BASIS_QUESTIONS).reduce((sum, arr) => sum + arr.length, 0);
    const answeredCount  = Object.keys(basisAnswers).length;

    if (answeredCount < totalQuestions) {
        alert(`Please answer all questions. You have answered ${answeredCount} out of ${totalQuestions}.`);
        return;
    }

    const results = getBASISResults(basisAnswers);
    const token   = getTokenFromURL();

    const submitBtn = $('#submit-basis');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

    try {
        await publicFetch(`${API_BASE}/${encodeURIComponent(token)}/complete`, {
            method: 'PUT',
            body: JSON.stringify({
                basisAnswers,
                basisResults: results,
                clientInfo: clientData
            })
        });

        $('#assessment-section').style.display = 'none';
        $('#success-section').style.display = 'block';
    } catch (err) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Assessment'; }
        alert('Could not save your assessment: ' + (err.message || 'Server error. Please try again.'));
    }
}

// ── Initialisation ───────────────────────────────────────────────────────────

async function initAssessment() {
    console.log('[CA] DOMContentLoaded fired — starting init');
    try {
        const valid = await validateToken();
        console.log('[CA] validateToken returned:', valid);
        if (!valid) return;

        // If the token already has a clientName (coach-generated link), skip the
        // info form entirely — the client is already known.
        if (tokenData && tokenData.clientName) {
            console.log('[CA] Coach-generated link — skipping info form, rendering assessment');
            const parts = tokenData.clientName.split(' ');
            clientData = {
                firstName:      parts[0] || '',
                surname:        parts.slice(1).join(' ') || '',
                name:           tokenData.clientName,
                email:          '',
                phone:          '',
                preferred_lang: 'English'
            };
            // Jump straight to the assessment — hide info form, show assessment
            const infoSection = $('#client-info-section');
            const assessmentSection = $('#assessment-section');
            if (infoSection) infoSection.style.display = 'none';
            if (assessmentSection) assessmentSection.style.display = 'block';
            renderAssessment();
        } else {
            // Anonymous / leads path — show the info form as normal
            console.log('[CA] Anonymous link — showing info form, setting up start button');
            setupStartButton();
        }
    } catch (err) {
        console.error('[CA] UNCAUGHT ERROR in initAssessment:', err);
        showError();
    }
}

// ES modules are deferred — DOMContentLoaded may already have fired by execution
// time in some edge cases. Guard against both timings.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAssessment);
} else {
    console.log('[CA] DOM already ready — running init immediately');
    initAssessment();
}
