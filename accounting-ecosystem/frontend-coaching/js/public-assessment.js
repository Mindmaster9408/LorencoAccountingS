// Public BASIS assessment for lead generation
import { BASIS_QUESTIONS, SECTION_LABELS, getBASISResults } from './basis-assessment.js';

const $ = (selector) => document.querySelector(selector);

let leadData = null;
let basisAnswers = {};
let wantsCoachingInfo = false;

// Start assessment button
$('#start-public-assessment-btn')?.addEventListener('click', () => {
    const firstName = $('#reg-firstname').value.trim();
    const surname = $('#reg-surname').value.trim();
    const email = $('#reg-email').value.trim();
    const phone = $('#reg-phone').value.trim();
    const company = $('#reg-company').value.trim();
    const language = $('#reg-language').value;

    if (!firstName || !surname || !email || !phone) {
        alert('Please fill in all required fields (First Name, Surname, Email, Phone).');
        return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert('Please enter a valid email address.');
        return;
    }

    leadData = {
        firstName,
        surname,
        name: `${firstName} ${surname}`,
        email,
        phone,
        company,
        preferred_lang: language,
        source: 'public_assessment',
        registeredAt: new Date().toISOString()
    };

    // Hide registration form, show assessment
    $('#registration-section').style.display = 'none';
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

            <div class="coaching-interest-box">
                <h3>🚀 Interested in Professional Coaching?</h3>
                <div class="checkbox-group">
                    <input type="checkbox" id="wants-coaching" name="wants-coaching">
                    <label for="wants-coaching">
                        <strong>Yes, I'd like to learn more about your coaching services!</strong><br>
                        <span style="font-size: 14px; color: #64748b;">
                            Our coaches can help you leverage your personality insights to achieve your goals. We'll contact you with more information.
                        </span>
                    </label>
                </div>
                <div id="coaching-details" style="display: none; margin-top: 16px;">
                    <div class="form-group">
                        <label>What are your main goals or challenges? (Optional)</label>
                        <textarea id="coaching-goals" rows="3" placeholder="E.g., Career advancement, leadership development, work-life balance..." style="width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 15px;"></textarea>
                    </div>
                </div>
            </div>

            <div class="basis-footer">
                <button id="submit-public-basis" class="btn-primary">Submit Assessment</button>
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

    // Coaching interest checkbox
    $('#wants-coaching')?.addEventListener('change', (e) => {
        wantsCoachingInfo = e.target.checked;
        const detailsSection = $('#coaching-details');
        if (detailsSection) {
            detailsSection.style.display = wantsCoachingInfo ? 'block' : 'none';
        }
    });

    // Submit button
    $('#submit-public-basis')?.addEventListener('click', submitAssessment);
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

    // Add coaching interest data
    if (wantsCoachingInfo) {
        leadData.wantsCoaching = true;
        leadData.coachingGoals = $('#coaching-goals')?.value.trim() || '';
    } else {
        leadData.wantsCoaching = false;
    }

    // Create lead record
    const lead = {
        id: 'lead_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        ...leadData,
        basisAnswers,
        basisResults: results,
        completedAt: new Date().toISOString(),
        status: wantsCoachingInfo ? 'interested' : 'completed',
        contacted: false
    };

    // Save to public leads storage
    const leads = JSON.parse(localStorage.getItem('public_leads') || '[]');
    leads.push(lead);
    localStorage.setItem('public_leads', JSON.stringify(leads));

    // Show success message
    $('#assessment-section').style.display = 'none';
    $('#success-section').style.display = 'block';

    if (wantsCoachingInfo) {
        $('#coaching-follow-up').style.display = 'block';
    }

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
