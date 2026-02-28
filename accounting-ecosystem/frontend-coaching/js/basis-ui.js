// BASIS Assessment UI
import { $, escapeHtml } from './config.js';
import { BASIS_QUESTIONS, SECTION_LABELS, getBASISResults } from './basis-assessment.js';
import { saveClient } from './storage.js';

export function renderBASISAssessment(client, containerId = 'basis-assessment-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Check if client has started or completed assessment
    const hasAnswers = client.basisAnswers && Object.keys(client.basisAnswers).length > 0;
    const hasResults = !!client.basisResults;

    // Show options screen if no answers yet
    if (!hasAnswers && !hasResults) {
        renderBASISOptions(client, container);
    } else {
        renderBASISQuestionnaire(client, container);
    }
}

function renderBASISOptions(client, container) {
    container.innerHTML = `
        <div class="basis-options">
            <h2>BASIS Assessment Options</h2>
            <p style="color: #64748b; margin-bottom: 32px;">Choose how you want to complete the BASIS assessment for ${escapeHtml(client.name)}</p>

            <div class="basis-choice-cards">
                <div class="basis-choice-card">
                    <div class="choice-icon">👨‍💼</div>
                    <h3>Coach-Led Assessment</h3>
                    <p>Complete the assessment together with your client during a coaching session</p>
                    <button id="start-coach-led" class="btn-primary">Start Assessment</button>
                </div>

                <div class="basis-choice-card">
                    <div class="choice-icon">🔗</div>
                    <h3>Client Self-Assessment</h3>
                    <p>Generate a unique link for your client to complete the assessment independently</p>
                    <button id="generate-link" class="btn-primary">Generate Link</button>
                </div>
            </div>

            <div id="assessment-link-section" style="display: none; margin-top: 32px;">
                <div style="background: #f0f9ff; padding: 20px; border-radius: 12px; border: 1px solid #bae6fd;">
                    <h4 style="margin: 0 0 12px 0; color: #0369a1;">Assessment Link Generated</h4>
                    <p style="margin: 0 0 16px 0; color: #64748b; font-size: 14px;">Share this link with your client:</p>
                    <div style="display: flex; gap: 12px; align-items: center;">
                        <input
                            type="text"
                            id="assessment-link-input"
                            readonly
                            style="flex: 1; padding: 12px; border: 2px solid #bae6fd; border-radius: 8px; font-family: monospace; font-size: 14px; background: white;"
                            value=""
                        />
                        <button id="copy-link" class="btn-secondary" style="padding: 12px 24px;">Copy Link</button>
                    </div>
                    <p style="margin: 16px 0 0 0; color: #64748b; font-size: 13px;">
                        📧 You can email this link to your client or send it via WhatsApp/SMS
                    </p>
                </div>
            </div>
        </div>
    `;

    // Attach event listeners
    $('#start-coach-led')?.addEventListener('click', () => {
        renderBASISQuestionnaire(client, container);
    });

    $('#generate-link')?.addEventListener('click', () => {
        generateAssessmentLink(client);
    });

    $('#copy-link')?.addEventListener('click', () => {
        const input = $('#assessment-link-input');
        input.select();
        document.execCommand('copy');
        const btn = $('#copy-link');
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => {
            btn.textContent = originalText;
        }, 2000);
    });
}

function generateAssessmentLink(client) {
    // Generate a unique token for this assessment
    const token = btoa(`${client.id}_${Date.now()}`).replace(/=/g, '');
    const baseUrl = window.location.origin + window.location.pathname.replace('index.html', '');
    const assessmentUrl = `${baseUrl}client-assessment.html?token=${token}`;

    // Store the token mapping
    const tokens = JSON.parse(localStorage.getItem('assessment_tokens') || '{}');
    tokens[token] = {
        clientId: client.id,
        clientName: client.name,
        createdAt: new Date().toISOString(),
        completed: false
    };
    localStorage.setItem('assessment_tokens', JSON.stringify(tokens));

    // Show the link
    const linkSection = $('#assessment-link-section');
    const linkInput = $('#assessment-link-input');
    if (linkSection && linkInput) {
        linkInput.value = assessmentUrl;
        linkSection.style.display = 'block';
    }
}

function renderBASISQuestionnaire(client, container) {
    // Initialize answers if not present
    if (!client.basisAnswers) {
        client.basisAnswers = {};
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
                ${renderAllSections(client)}
            </div>

            <div class="basis-footer">
                <button id="save-basis" class="btn-primary">Save Progress</button>
                <button id="calculate-basis" class="btn-primary">Calculate Results</button>
            </div>

            <div id="basis-results" class="basis-results" style="display: none;">
                <!-- Results will be shown here -->
            </div>
        </div>
    `;

    // Attach event listeners
    attachBASISListeners(client);
    updateProgress(client);
}

function renderAllSections(client) {
    const sectionOrder = ['BALANS', 'AKSIE', 'SORG', 'INSIG', 'STRUKTUUR'];

    return sectionOrder.map(sectionKey => {
        return `
            <div class="basis-section">
                <h3 class="section-title">${SECTION_LABELS[sectionKey]}</h3>
                <div class="section-questions">
                    ${renderSectionQuestions(sectionKey, client)}
                </div>
            </div>
        `;
    }).join('');
}

function renderSectionQuestions(sectionKey, client) {
    const questions = BASIS_QUESTIONS[sectionKey];

    return questions.map((question, index) => {
        const questionId = `${sectionKey}_${question.id}`;
        const currentAnswer = client.basisAnswers?.[questionId] || null;

        return `
            <div class="basis-question">
                <div class="question-header">
                    <span class="question-number">${index + 1}.</span>
                    <span class="question-text">${escapeHtml(question.text)}${question.reverse ? ' <span class="reverse-tag">[R]</span>' : ''}</span>
                </div>
                <div class="question-scale">
                    ${renderScaleButtons(questionId, currentAnswer)}
                </div>
            </div>
        `;
    }).join('');
}

function renderScaleButtons(questionId, currentAnswer) {
    const buttons = [];

    for (let i = 1; i <= 10; i++) {
        const isSelected = currentAnswer === i;
        buttons.push(`
            <button
                class="scale-btn ${isSelected ? 'selected' : ''}"
                data-question="${questionId}"
                data-value="${i}"
            >
                ${i}
            </button>
        `);
    }

    return buttons.join('');
}

function attachBASISListeners(client) {
    // Scale button clicks
    const scaleButtons = document.querySelectorAll('.scale-btn');
    scaleButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const questionId = e.target.dataset.question;
            const value = parseInt(e.target.dataset.value);

            // Update client answers
            if (!client.basisAnswers) {
                client.basisAnswers = {};
            }
            client.basisAnswers[questionId] = value;

            // Update UI - remove selected from siblings
            const parent = e.target.parentElement;
            parent.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('selected'));
            e.target.classList.add('selected');

            // Update progress
            updateProgress(client);
        });
    });

    // Save progress button
    const saveBtn = $('#save-basis');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            await saveClient(client);
            alert('Assessment progress saved!');
        });
    }

    // Calculate results button
    const calculateBtn = $('#calculate-basis');
    if (calculateBtn) {
        calculateBtn.addEventListener('click', () => {
            calculateAndShowResults(client);
        });
    }
}

function updateProgress(client) {
    const totalQuestions = 50;
    const answeredCount = Object.keys(client.basisAnswers || {}).length;
    const percentage = Math.round((answeredCount / totalQuestions) * 100);

    const progressFill = $('#basis-progress-fill');
    const progressText = $('#basis-progress-text');

    if (progressFill) {
        progressFill.style.width = `${percentage}%`;
    }

    if (progressText) {
        progressText.textContent = `${answeredCount} / ${totalQuestions} questions answered`;
    }
}

function calculateAndShowResults(client) {
    const totalQuestions = 50;
    const answeredCount = Object.keys(client.basisAnswers || {}).length;

    if (answeredCount < totalQuestions) {
        alert(`Please answer all questions before calculating results. (${answeredCount}/${totalQuestions} answered)`);
        return;
    }

    // Calculate results
    const results = getBASISResults(client.basisAnswers);

    // Store results in client
    client.basisResults = results;

    // Save to storage
    saveClient(client);

    // Show results
    displayResults(results);
}

function displayResults(results) {
    const resultsContainer = $('#basis-results');
    if (!resultsContainer) return;

    const { sectionScores, basisOrder } = results;

    resultsContainer.innerHTML = `
        <div class="results-card">
            <h3>BASIS Assessment Results</h3>

            <div class="results-order">
                <h4>Your BASIS Order (Highest to Lowest):</h4>
                <ol class="basis-order-list">
                    ${basisOrder.map((section, index) => `
                        <li>
                            <strong>${index + 1}. ${SECTION_LABELS[section]}</strong>
                            <span class="score">${sectionScores[section]} / 100</span>
                        </li>
                    `).join('')}
                </ol>
            </div>

            <div class="results-scores">
                <h4>Section Scores:</h4>
                <div class="score-bars">
                    ${Object.entries(sectionScores).map(([section, score]) => `
                        <div class="score-bar-item">
                            <div class="score-bar-label">${SECTION_LABELS[section]}</div>
                            <div class="score-bar-container">
                                <div class="score-bar-fill" style="width: ${score}%"></div>
                            </div>
                            <div class="score-bar-value">${score}</div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="results-interpretation">
                <h4>What This Means:</h4>
                <p>Your BASIS order shows your dominant behavioral preferences in order of strength.</p>
                <ul>
                    <li><strong>${SECTION_LABELS[basisOrder[0]]}</strong> is your strongest preference</li>
                    <li><strong>${SECTION_LABELS[basisOrder[4]]}</strong> is your least dominant preference</li>
                </ul>
                <p>This profile will help guide your coaching journey and inform personalized strategies.</p>
            </div>
        </div>
    `;

    resultsContainer.style.display = 'block';

    // Scroll to results
    resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
