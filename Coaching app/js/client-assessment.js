// client-assessment.js — Phase 2A
// Public-link BASIS assessment for standalone client portal.
//
// Flow:
//   1. Extract ?token=... from URL
//   2. GET /api/basis/public/:token   — validate token, pre-fill client data
//   3a. Coach-generated link (full name on record) → skip info form, start directly
//   3b. Fresh/anonymous link → client fills in info form, clicks Start Assessment
//   4. PUT /api/basis/public/:token   — submit answers + computed results
//
// No localStorage used. All state server-backed.

import { BASIS_QUESTIONS, SECTION_LABELS, getBASISResults } from './basis-assessment.js';
import { API_BASE_URL } from './api.js';

const qs = (selector) => document.querySelector(selector);

// Module-level state
let submissionId   = null;      // id returned by publicGet
let preferredLang  = 'en';      // from token response
let clientData     = null;      // populated by auto-skip or start-btn handler
let basisAnswers   = {};        // flat format: { BALANS_1: 7, AKSIE_3: 4, ... }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTokenFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('token') || '';
}

// Minimal public fetch — no auth header, no login redirect on 401.
async function publicFetch(endpoint, options = {}) {
    const config = {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers }
    };

    const response = await fetch(`${API_BASE_URL}${endpoint}`, config);
    const data     = await response.json();

    if (!response.ok) {
        const err    = new Error(data.error || `Request failed (${response.status})`);
        err.status   = response.status;
        throw err;
    }

    return data;
}

// ─── Error / success display ──────────────────────────────────────────────────

function showError(message) {
    const errorSection = qs('#error-section');
    if (errorSection) {
        const p = errorSection.querySelector('.error-message p');
        if (p && message) p.textContent = message;
        errorSection.style.display = 'block';
    }
    const clientInfo = qs('#client-info-section');
    if (clientInfo) clientInfo.style.display = 'none';
}

// ─── Token validation + pre-fill ─────────────────────────────────────────────

async function validateToken() {
    const token = getTokenFromURL();
    if (!token) {
        showError('No assessment token found. Please use the link provided by your coach.');
        return false;
    }

    try {
        const data = await publicFetch(`/basis/public/${encodeURIComponent(token)}`);

        submissionId  = data.id;
        preferredLang = data.preferredLang || 'en';

        if (data.respondentName) {
            const parts     = data.respondentName.trim().split(/\s+/);
            const firstName = parts[0] || '';
            const surname   = parts.slice(1).join(' ') || '';

            // Pre-fill all form fields from backend data
            const firstEl   = qs('#client-firstname');
            const surnameEl = qs('#client-surname');
            const emailEl   = qs('#client-email');
            const phoneEl   = qs('#client-phone');
            const langEl    = qs('#client-language');

            if (firstEl)                         firstEl.value   = firstName;
            if (surnameEl)                       surnameEl.value = surname;
            if (emailEl && data.respondentEmail) emailEl.value   = data.respondentEmail;
            if (phoneEl && data.respondentPhone) phoneEl.value   = data.respondentPhone;
            if (langEl)                          langEl.value    = preferredLang;

            // Coach-generated link: full name on record → skip info form, start directly
            if (firstName && surname) {
                clientData = {
                    firstName,
                    surname,
                    name:           data.respondentName,
                    email:          data.respondentEmail || null,
                    phone:          data.respondentPhone || null,
                    preferred_lang: preferredLang
                };

                const clientInfoSection = qs('#client-info-section');
                const assessmentSection = qs('#assessment-section');
                if (clientInfoSection) clientInfoSection.style.display = 'none';
                if (assessmentSection) assessmentSection.style.display  = 'block';

                renderAssessment();
            }
        }

        return true;
    } catch (err) {
        if (err.status === 410) {
            showError('This assessment has already been completed.');
        } else if (err.status === 404) {
            showError('Assessment link not found or expired. Please contact your coach.');
        } else {
            showError('Unable to load assessment. Please try again or contact your coach.');
        }
        return false;
    }
}

// ─── Questionnaire render ─────────────────────────────────────────────────────

function renderAssessment() {
    const container = qs('#basis-assessment-container');
    if (!container) return;

    container.innerHTML = `
        <div class="basis-assessment">
            <div class="basis-header">
                <h2>BASIS Assessment</h2>
                <p class="basis-instructions">
                    Answer each question on a scale of 1 to 10:<br>
                    <strong>1</strong> = Not true of me at all &nbsp;|&nbsp; <strong>10</strong> = Completely true of me
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
        const questions = BASIS_QUESTIONS[sectionKey];
        return `
            <div class="basis-section">
                <h3 class="section-title">${SECTION_LABELS[sectionKey]}</h3>
                <div class="section-questions">
                    ${questions.map((q, idx) => renderQuestion(sectionKey, idx, q)).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function getGlobalQuestionIndex(sectionKey, localIndex) {
    const sections   = Object.keys(SECTION_LABELS);
    const sectionIdx = sections.indexOf(sectionKey);
    let global = 0;
    for (let i = 0; i < sectionIdx; i++) {
        global += BASIS_QUESTIONS[sections[i]].length;
    }
    return global + localIndex;
}

function renderQuestion(sectionKey, localIndex, question) {
    const globalIndex = getGlobalQuestionIndex(sectionKey, localIndex);
    const questionId  = `${sectionKey}_${question.id}`;

    return `
        <div class="basis-question">
            <div class="question-header">
                <span class="question-number">${globalIndex + 1}.</span>
                <span class="question-text">${question.text}</span>
            </div>
            <div class="question-scale">
                ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(val => `
                    <button class="scale-btn"
                            data-question-id="${questionId}"
                            data-value="${val}">${val}</button>
                `).join('')}
            </div>
        </div>
    `;
}

// ─── Event listeners ──────────────────────────────────────────────────────────

function attachEventListeners() {
    document.querySelectorAll('.scale-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const questionId = btn.dataset.questionId;
            const value      = parseInt(btn.dataset.value, 10);

            basisAnswers[questionId] = value;

            document.querySelectorAll(`.scale-btn[data-question-id="${questionId}"]`)
                    .forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');

            updateProgress();
        });
    });

    const submitBtn = qs('#submit-basis');
    if (submitBtn) submitBtn.addEventListener('click', submitAssessment);
}

function updateProgress() {
    const totalQuestions = Object.values(BASIS_QUESTIONS).reduce((sum, arr) => sum + arr.length, 0);
    const answeredCount  = Object.keys(basisAnswers).length;
    const percentage     = Math.round((answeredCount / totalQuestions) * 100);

    const fillEl = qs('#basis-progress-fill');
    const textEl = qs('#basis-progress-text');
    if (fillEl) fillEl.style.width = `${percentage}%`;
    if (textEl) textEl.textContent = `${answeredCount} / ${totalQuestions} questions answered`;
}

// ─── Submission ───────────────────────────────────────────────────────────────

async function submitAssessment() {
    const totalQuestions = Object.values(BASIS_QUESTIONS).reduce((sum, arr) => sum + arr.length, 0);
    const answeredCount  = Object.keys(basisAnswers).length;

    if (answeredCount < totalQuestions) {
        alert(`Please answer all questions. You have answered ${answeredCount} out of ${totalQuestions}.`);
        return;
    }

    // Client-side scoring kept for compatibility; backend recomputes server-side and
    // ignores the client-provided basisResults value (see basis.routes.js PUT /public/:token).
    const basisResults = getBASISResults(basisAnswers);

    try {
        const token = getTokenFromURL();

        await publicFetch(`/basis/public/${encodeURIComponent(token)}`, {
            method: 'PUT',
            body: JSON.stringify({
                respondentName:  clientData ? clientData.name          : undefined,
                respondentEmail: clientData ? clientData.email         : undefined,
                respondentPhone: clientData ? clientData.phone         : undefined,
                preferredLang:   clientData ? clientData.preferred_lang : preferredLang,
                basisAnswers,
                basisResults
            })
        });

        const assessmentSection = qs('#assessment-section');
        const successSection    = qs('#success-section');
        if (assessmentSection) assessmentSection.style.display = 'none';
        if (successSection)    successSection.style.display    = 'block';

    } catch (err) {
        if (err.status === 410) {
            alert('This assessment has already been submitted. Please contact your coach if you need to re-do it.');
        } else {
            alert('Failed to submit. Please check your connection and try again.');
            console.error('Submission error:', err);
        }
    }
}

// ─── Initialise ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    const valid = await validateToken();
    if (!valid) return;

    // Manual start button — fallback for anonymous links or incomplete pre-fill.
    // For coach-generated links with a full name, validateToken() already auto-skips
    // the form, so this handler will be attached but never triggered.
    const startBtn = qs('#start-assessment-btn');
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            const firstName = (qs('#client-firstname').value || '').trim();
            const surname   = (qs('#client-surname').value   || '').trim();
            const email     = (qs('#client-email').value     || '').trim();
            const phone     = (qs('#client-phone').value     || '').trim();
            const langEl    = qs('#client-language');
            const language  = langEl ? langEl.value : 'en';

            if (!firstName || !surname) {
                alert('Please enter your first name and surname.');
                return;
            }

            clientData = {
                firstName,
                surname,
                name:           `${firstName} ${surname}`,
                email:          email || null,
                phone:          phone || null,
                preferred_lang: language || 'en'
            };

            const clientInfoSection = qs('#client-info-section');
            const assessmentSection = qs('#assessment-section');
            if (clientInfoSection) clientInfoSection.style.display = 'none';
            if (assessmentSection) assessmentSection.style.display  = 'block';

            renderAssessment();
        });
    }
});
