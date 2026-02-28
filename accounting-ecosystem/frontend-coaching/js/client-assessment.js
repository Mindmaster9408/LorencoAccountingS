// Client-side BASIS assessment for standalone client portal
import { BASIS_QUESTIONS, SECTION_LABELS, getBASISResults } from './basis-assessment.js';

const $ = (selector) => document.querySelector(selector);

let tokenData = null;
let clientData = null;
let basisAnswers = {};

// Get token from URL
function getTokenFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('token');
}

// Validate token
function validateToken() {
    const token = getTokenFromURL();
    if (!token) {
        showError();
        return false;
    }

    // Get tokens from localStorage
    const tokens = JSON.parse(localStorage.getItem('assessment_tokens') || '{}');
    tokenData = tokens[token];

    if (!tokenData) {
        showError();
        return false;
    }

    if (tokenData.completed) {
        showError('This assessment has already been completed.');
        return false;
    }

    return true;
}

function showError(message = null) {
    $('#error-section').style.display = 'block';
    $('#client-info-section').style.display = 'none';

    if (message) {
        $('#error-section .error-message p').textContent = message;
    }
}

// Start assessment button
$('#start-assessment-btn')?.addEventListener('click', () => {
    const firstName = $('#client-firstname').value.trim();
    const surname = $('#client-surname').value.trim();
    const email = $('#client-email').value.trim();
    const phone = $('#client-phone').value.trim();
    const language = $('#client-language').value;

    if (!firstName || !surname) {
        alert('Please enter your first name and surname.');
        return;
    }

    clientData = {
        firstName,
        surname,
        name: `${firstName} ${surname}`,
        email,
        phone,
        preferred_lang: language
    };

    // Hide info form, show assessment
    $('#client-info-section').style.display = 'none';
    $('#assessment-section').style.display = 'block';

    renderAssessment();
});

function renderAssessment() {
    const container = $('#basis-assessment-container');
    if (!container) return;

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
    const isReverse = question.reverse ? ' <span class="reverse-tag">REVERSE</span>' : '';

    return `
        <div class="basis-question">
            <div class="question-header">
                <span class="question-number">${globalIndex + 1}.</span>
                <span class="question-text">${question.text}${isReverse}</span>
            </div>
            <div class="question-scale">
                ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(val => `
                    <button class="scale-btn" data-section="${section}" data-index="${index}" data-value="${val}">${val}</button>
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
    // Scale button clicks
    document.querySelectorAll('.scale-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const section = btn.dataset.section;
            const index = parseInt(btn.dataset.index);
            const value = parseInt(btn.dataset.value);

            // Store answer
            if (!basisAnswers[section]) basisAnswers[section] = {};
            basisAnswers[section][index] = value;

            // Update button states
            const sectionButtons = document.querySelectorAll(
                `.scale-btn[data-section="${section}"][data-index="${index}"]`
            );
            sectionButtons.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');

            updateProgress();
        });
    });

    // Submit button
    $('#submit-basis')?.addEventListener('click', submitAssessment);
}

function updateProgress() {
    const totalQuestions = Object.values(BASIS_QUESTIONS).reduce((sum, arr) => sum + arr.length, 0);
    const answeredCount = Object.values(basisAnswers).reduce((sum, section) =>
        sum + Object.keys(section).length, 0
    );

    const percentage = Math.round((answeredCount / totalQuestions) * 100);

    const fillEl = $('#basis-progress-fill');
    const textEl = $('#basis-progress-text');

    if (fillEl) fillEl.style.width = percentage + '%';
    if (textEl) textEl.textContent = `${answeredCount} / ${totalQuestions} questions answered`;
}

function submitAssessment() {
    // Check if all questions answered
    const totalQuestions = Object.values(BASIS_QUESTIONS).reduce((sum, arr) => sum + arr.length, 0);
    const answeredCount = Object.values(basisAnswers).reduce((sum, section) =>
        sum + Object.keys(section).length, 0
    );

    if (answeredCount < totalQuestions) {
        alert(`Please answer all questions. You have answered ${answeredCount} out of ${totalQuestions}.`);
        return;
    }

    // Calculate results
    const results = getBASISResults(basisAnswers);

    // Get the current user's store key (admin user)
    const currentUser = localStorage.getItem('current_user');
    if (!currentUser) {
        alert('Error: Could not find coach account. Please contact your coach.');
        return;
    }

    // Load coach's store
    const storeKey = `coaching_store_${currentUser}`;
    const store = JSON.parse(localStorage.getItem(storeKey) || '{"clients":[]}');

    // Find the client by ID from token
    const client = store.clients.find(c => c.id === tokenData.clientId);
    if (!client) {
        alert('Error: Could not find your client record. Please contact your coach.');
        return;
    }

    // Update client with assessment data and client info
    client.firstName = clientData.firstName;
    client.surname = clientData.surname;
    client.name = clientData.name;
    if (clientData.email) client.email = clientData.email;
    if (clientData.phone) client.phone = clientData.phone;
    client.preferred_lang = clientData.preferred_lang;
    client.basisAnswers = basisAnswers;
    client.basisResults = results;
    client.last_session = new Date().toISOString().split('T')[0];

    // Save updated store
    localStorage.setItem(storeKey, JSON.stringify(store));

    // Mark token as completed
    const token = getTokenFromURL();
    const tokens = JSON.parse(localStorage.getItem('assessment_tokens') || '{}');
    tokens[token].completed = true;
    tokens[token].completedAt = new Date().toISOString();
    localStorage.setItem('assessment_tokens', JSON.stringify(tokens));

    // Show success message
    $('#assessment-section').style.display = 'none';
    $('#success-section').style.display = 'block';
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    if (!validateToken()) {
        return;
    }

    // Pre-fill name if available
    if (tokenData.clientName) {
        const parts = tokenData.clientName.split(' ');
        if (parts.length >= 2) {
            $('#client-firstname').value = parts[0];
            $('#client-surname').value = parts.slice(1).join(' ');
        }
    }
});
