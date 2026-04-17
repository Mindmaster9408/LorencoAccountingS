// client-assessment.js — Phase 2A
// Public-link BASIS assessment for standalone client portal.
//
// Flow:
//   1. Extract ?token=... from URL
//   2. GET /api/basis/public/:token   — validate token, pre-fill name
//   3. Client fills in info + answers
//   4. PUT /api/basis/public/:token   — submit answers + computed results
//
// No localStorage used. All state server-backed.

import { BASIS_QUESTIONS, SECTION_LABELS, getBASISResults } from './basis-assessment.js';
import { API_BASE_URL } from './api.js';

const $ = (selector) => document.querySelector(selector);

// Module-level state
let submissionId   = null;      // id returned by publicGet
let preferredLang  = 'en';      // from token response
let clientData     = null;      // filled in by start-assessment-btn
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
    const errorSection = $('#error-section');
    if (errorSection) {
        const p = errorSection.querySelector('.error-message p');
        if (p && message) p.textContent = message;
        errorSection.style.display = 'block';
    }
    const clientInfo = $('#client-info-section');
    if (clientInfo) clientInfo.style.display = 'none';
}

// ─── Token validation ─────────────────────────────────────────────────────────

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

        // Pre-fill name field if available
        if (data.respondentName) {
            const parts     = data.respondentName.split(' ');
            const firstEl   = $('#client-firstname');
            const surnameEl = $('#client-surname');
            if (firstEl   && parts.length > 0) firstEl.value   = parts[0];
            if (surnameEl && parts.length > 1) surnameEl.value = parts.slice(1).join(' ');
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


    return true;
}

// ─── Questionnaire render ─────────────────────────────────────────────────────

function renderAssessment() {
    const container = $('#basis-assessment-container');
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
    // Store answers using question.id (1-based) so they match getBASISResults expectations
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

            // Store in flat format: { BALANS_1: 7 }
            basisAnswers[questionId] = value;

            // Update selected state for this question
            document.querySelectorAll(`.scale-btn[data-question-id="${questionId}"]`)
                    .forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');

            updateProgress();
        });
    });

    const submitBtn = $('#submit-basis');
    if (submitBtn) submitBtn.addEventListener('click', submitAssessment);
}

function updateProgress() {
    const totalQuestions = Object.values(BASIS_QUESTIONS).reduce((sum, arr) => sum + arr.length, 0);
    const answeredCount  = Object.keys(basisAnswers).length;
    const percentage     = Math.round((answeredCount / totalQuestions) * 100);

    const fillEl = $('#basis-progress-fill');
    const textEl = $('#basis-progress-text');
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

    // Compute results using the scoring engine (flat format required)
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

        const assessmentSection = $('#assessment-section');
        const successSection    = $('#success-section');
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

    const startBtn = $('#start-assessment-btn');
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            const firstName = ($('#client-firstname').value || '').trim();
            const surname   = ($('#client-surname').value   || '').trim();
            const email     = ($('#client-email').value     || '').trim();
            const phone     = ($('#client-phone').value     || '').trim();
            const langEl    = $('#client-language');
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

            const clientInfoSection = $('#client-info-section');
            const assessmentSection = $('#assessment-section');
            if (clientInfoSection) clientInfoSection.style.display = 'none';
            if (assessmentSection) assessmentSection.style.display  = 'block';

            renderAssessment();
        });
    }
});
