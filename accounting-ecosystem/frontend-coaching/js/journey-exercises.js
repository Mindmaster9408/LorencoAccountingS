// Journey Exercise Pages - Interactive exercises for each step
import { $, escapeHtml } from './config.js';
import { saveClient } from './storage.js';
import { JOURNEY_STEPS } from './journey-data.js';
import { renderAIChat } from './journey-helpers.js';

// Render specific exercise based on step number
export function renderExercise(client, stepNumber, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Route to specific exercise renderer
    switch(stepNumber) {
        case 1:
            render4QuadrantExercise(client, container);
            break;
        case 2:
            renderPresentGapFuture(client, container);
            break;
        case 3:
            renderFlightPlan(client, container);
            break;
        case 4:
            renderDeepDive(client, container);
            break;
        case 5:
            renderEcochart(client, container);
            break;
        case 6:
            renderAssessments(client, container);
            break;
        case 7:
            renderCockpitReview(client, container);
            break;
        case 8:
            renderPDD(client, container);
            break;
        case 9:
            renderPsychoeducation(client, container);
            break;
        case 10:
            renderMLNP(client, container);
            break;
        case 11:
            renderReassess(client, container);
            break;
        case 12:
            renderRevisit(client, container);
            break;
        case 13:
            renderDreamSpot(client, container);
            break;
        case 14:
            renderValuesBeliefs(client, container);
            break;
        case 15:
            renderSuccessTraits(client, container);
            break;
        case 16:
            renderCuriosityPassionPurpose(client, container);
            break;
        case 17:
            renderCreativityFlow(client, container);
            break;
        default:
            container.innerHTML = '<p>Exercise not yet implemented</p>';
    }
}

// Step 1: 4 Quadrant Exercise
function render4QuadrantExercise(client, container) {
    // Initialize exercise data if not exists
    if (!client.exerciseData) client.exerciseData = {};
    if (!client.exerciseData.fourQuadrant) {
        client.exerciseData.fourQuadrant = {
            painsAndFrustrations: '',
            goalsAndDesires: '',
            fearsAndImplications: '',
            dreamsAndAspirations: '',
            dreamSummary: '',
            our1Percent: '',
            evaluations: {
                experience: '',
                insights: '',
                stoodOut: '',
                future23Years: '',
                next24Hours: ''
            },
            sessionNotes: '',
            aiCoachNotes: ''
        };
    }

    const data = client.exerciseData.fourQuadrant;
    const sessionDate = new Date().toLocaleDateString('en-ZA', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    container.innerHTML = `
        <div class="exercise-page four-quadrant-page">
            <!-- Back Button -->
            <div style="margin-bottom: 16px;">
                <button class="btn-back" onclick="closeExercise()">← Back to Journey</button>
            </div>

            <!-- Header with Logo -->
            <div class="infinite-legacy-header">
                <img src="images/infinite-legacy-logo.png" alt="The Infinite Legacy" class="legacy-logo" onerror="this.style.display='none'">
                <h1 class="legacy-title">THE INFINITE LEGACY</h1>
                <h2 class="model-title">4 QUADRANT MODEL</h2>
                <div class="session-info">
                    <div class="info-field">
                        <strong>Name:</strong> ${escapeHtml(client.name)}
                    </div>
                    <div class="info-field">
                        <strong>Date:</strong> ${sessionDate}
                    </div>
                </div>
            </div>

            <!-- 4 Quadrants Grid -->
            <div class="four-quadrants-grid">
                <div class="quadrant top-left">
                    <h3>Pains & Frustrations</h3>
                    <textarea
                        id="q-pains"
                        placeholder="What pains and frustrations is the client experiencing?"
                        rows="8"
                    >${escapeHtml(data.painsAndFrustrations)}</textarea>
                </div>

                <div class="quadrant top-right">
                    <h3>Goals & Desires</h3>
                    <textarea
                        id="q-goals"
                        placeholder="What are the client's goals and desires?"
                        rows="8"
                    >${escapeHtml(data.goalsAndDesires)}</textarea>
                </div>

                <div class="quadrant bottom-left">
                    <h3>Fears & Implications</h3>
                    <textarea
                        id="q-fears"
                        placeholder="What fears and implications are holding them back?"
                        rows="8"
                    >${escapeHtml(data.fearsAndImplications)}</textarea>
                </div>

                <div class="quadrant bottom-right">
                    <h3>Dreams & Aspirations</h3>
                    <textarea
                        id="q-dreams"
                        placeholder="What are their dreams and aspirations?"
                        rows="8"
                    >${escapeHtml(data.dreamsAndAspirations)}</textarea>
                </div>
            </div>

            <!-- Dream Summary -->
            <div class="dream-summary-section">
                <h3>Dream Summary:</h3>
                <textarea
                    id="dream-summary"
                    placeholder="Summarize the client's dream (this will update their main dream field and move to next step)"
                    rows="3"
                >${escapeHtml(data.dreamSummary)}</textarea>
            </div>

            <!-- Our 1% -->
            <div class="our-one-percent-section">
                <h3>Our 1% — What will the client do before the next session?</h3>
                <p class="one-percent-subtitle"><em>The 1% Rule: What is the smallest step you can take before our next session to move closer to your dream?</em></p>
                <textarea
                    id="our-1-percent"
                    placeholder="Enter the 1% action item for next session..."
                    rows="3"
                >${escapeHtml(data.our1Percent)}</textarea>
            </div>

            <!-- Evaluation Questions -->
            <div class="evaluation-section">
                <h3>Evaluation of 4 Quadrant Exercise:</h3>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>What was your experience of this session?</label>
                        <p class="eval-hint">Dit was moeilik om te dink aan die goed wat gevra word</p>
                        <textarea
                            id="eval-experience"
                            rows="2"
                        >${escapeHtml(data.evaluations.experience)}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">❓</div>
                    <div class="eval-content">
                        <label>What insights did you get, what did you learn from this interview?</label>
                        <p class="eval-hint">Ek moet meer aandag gee aan wat ek in toekoms wil bereik</p>
                        <textarea
                            id="eval-insights"
                            rows="2"
                        >${escapeHtml(data.evaluations.insights)}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🤝</div>
                    <div class="eval-content">
                        <label>What stood out?</label>
                        <p class="eval-hint">Die vraag wat staan in die middle van my drome</p>
                        <textarea
                            id="eval-stood-out"
                            rows="2"
                        >${escapeHtml(data.evaluations.stoodOut)}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🏛️</div>
                    <div class="eval-content">
                        <label>If we had the same discussion 2/3 years from now what should be different both professional and personal</label>
                        <p class="eval-hint">Tradin R 250 000 vir 3 maande, meer standvastigheid in die lewe</p>
                        <textarea
                            id="eval-future"
                            rows="2"
                        >${escapeHtml(data.evaluations.future23Years)}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>One thing you can do within the next 24hours that will increase your chances to reach your goal?</label>
                        <p class="eval-hint">Met pa gaan praat en hoor wat verwag hy</p>
                        <textarea
                            id="eval-24hours"
                            rows="2"
                        >${escapeHtml(data.evaluations.next24Hours)}</textarea>
                    </div>
                </div>
            </div>

            <!-- Session Notes -->
            <div class="session-notes-section">
                <h3>📝 Session Notes</h3>
                <textarea
                    id="session-notes"
                    placeholder="Your personal notes about this session..."
                    rows="6"
                >${escapeHtml(data.sessionNotes)}</textarea>
            </div>

            <!-- AI Coach Assistant -->
            <div class="ai-coach-section">
                <h3>🤖 AI Coach Assistant</h3>
                <p class="ai-intro">Discuss this session and the client. The AI has access to all client information.</p>
                <div class="ai-chat-container" id="ai-chat">
                    <!-- AI chat will be rendered here -->
                </div>
                <div class="ai-input-section">
                    <textarea
                        id="ai-input"
                        placeholder="Ask the AI coach about this client or session..."
                        rows="3"
                    ></textarea>
                    <button class="btn-ai-send" onclick="sendAIMessage()">Send to AI Coach</button>
                </div>
            </div>

            <!-- Footer Actions -->
            <div class="exercise-footer">
                <button class="btn-download" onclick="downloadQuadrantPDF()">📥 Download PDF</button>
                <button class="btn-save" onclick="save4QuadrantExercise()">💾 Save Progress</button>
                <button class="btn-complete" onclick="complete4Quadrant()">✓ Complete & Move to Next Step</button>
            </div>
        </div>
    `;

    // Render AI chat if exists
    if (data.aiCoachNotes) {
        renderAIChat(data.aiCoachNotes);
    }
}

// Step 2: Present-Gap-Future
function renderPresentGapFuture(client, container) {
    // Initialize exercise data if not exists
    if (!client.exerciseData) client.exerciseData = {};
    if (!client.exerciseData.presentGapFuture) {
        client.exerciseData.presentGapFuture = {
            present: Array(10).fill(''),
            gap: Array(9).fill(''),
            future: Array(11).fill(''),
            gapFillIn: Array(4).fill(''),
            evaluations: {
                experience: '',
                insights: '',
                stoodOut: '',
                future23Years: '',
                next24Hours: ''
            },
            sessionNotes: '',
            aiCoachNotes: []
        };
    }

    const data = client.exerciseData.presentGapFuture;

    // Get dream from Step 1 (4 Quadrant)
    const dreamFromStep1 = client.exerciseData?.fourQuadrant?.dreamSummary || client.dream || '';

    const presentQuestions = [
        "What are you proud of that you created in your life the past 3 months?",
        "How did you do that?",
        "What is good about your current situation, even the frustrations?",
        "How is that keeping you stuck?",
        "What is your greatest gift, what are you good at?",
        "Make it real/practical to me",
        "What does that mean?",
        "How do you currently serve people with your gift, or what do you use it for?",
        "What are your underlying fears or anxieties you do not talk about?",
        "If I could help you right now, what would you need from me?"
    ];

    const gapQuestions = [
        "What is the flipside/ negative side of your gift?",
        "What about your dream makes you feel guilty or uneasy?",
        "What might you have to give up or stop doing to achieve your dream/goal?",
        "What is your biggest challenge right now?",
        "How are you holding yourself back?",
        "If I could remove any block right now that is keeping you from reaching your dream what would that be?",
        "On scale of 1-10 how happy are you right now?",
        "So, what makes the missing amount up?",
        "Make it real to me, help me understand better"
    ];

    const futureQuestions = [
        "What is your dream?",
        "Why this dream?",
        "Why is this important to you?",
        "Why now?",
        "If no money...same dream?",
        "How would you know you have reached your goal?",
        "How is this going to impact your life?",
        "When your dream realised what would your life look like?",
        "What would chose around you be able to see, experience and feel?",
        "How is that person (the new you) different from you today?",
        "Do you still agree with your dream?"
    ];

    const gapFillInQuestions = [
        "I will definitely reach my dream, if only...",
        "If I had more confidence, then I will......",
        "If I had more clarity, I will...",
        "If I had no fear, then I would......"
    ];

    container.innerHTML = `
        <div class="exercise-page pgf-page">
            <!-- Back Button -->
            <div style="margin-bottom: 16px;">
                <button class="btn-back" onclick="closeExercise()">← Back to Journey</button>
            </div>

            <div class="exercise-header">
                <h1>🌉 Step 2: Present-Gap-Future</h1>
                <p class="exercise-subtitle">Bridge the gap between where you are and where you want to be</p>
            </div>

            <!-- Dream from Step 1 -->
            ${dreamFromStep1 ? `
                <div class="dream-display-section">
                    <h3>💭 Your Dream (from Step 1):</h3>
                    <div class="dream-display-text">${escapeHtml(dreamFromStep1)}</div>
                </div>
            ` : ''}

            <!-- Three Column Grid -->
            <div class="pgf-grid">
                <!-- Present Column -->
                <div class="pgf-column present-column">
                    <h3>Present Questions</h3>
                    ${presentQuestions.map((q, i) => `
                        <div class="pgf-question-item">
                            <div class="pgf-question-number">${i + 1}</div>
                            <div class="pgf-question-content">
                                <label>${q}</label>
                                <textarea
                                    id="present-${i}"
                                    rows="2"
                                    placeholder="Answer here..."
                                >${escapeHtml(data.present[i] || '')}</textarea>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <!-- Gap Column -->
                <div class="pgf-column gap-column">
                    <h3>GAP Questions</h3>
                    ${gapQuestions.map((q, i) => `
                        <div class="pgf-question-item">
                            <div class="pgf-question-number">${i + 1}</div>
                            <div class="pgf-question-content">
                                <label>${q}</label>
                                <textarea
                                    id="gap-${i}"
                                    rows="2"
                                    placeholder="Answer here..."
                                >${escapeHtml(data.gap[i] || '')}</textarea>
                            </div>
                        </div>
                    `).join('')}

                    <h4 style="margin-top: 24px; color: #059669;">Fill in the blanks:</h4>
                    ${gapFillInQuestions.map((q, i) => `
                        <div class="pgf-question-item">
                            <div class="pgf-question-number">${i + 1}</div>
                            <div class="pgf-question-content">
                                <label>${q}</label>
                                <textarea
                                    id="gap-fill-${i}"
                                    rows="2"
                                    placeholder="Complete the sentence..."
                                >${escapeHtml(data.gapFillIn[i] || '')}</textarea>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <!-- Future Column -->
                <div class="pgf-column future-column">
                    <h3>Future Questions</h3>
                    ${futureQuestions.map((q, i) => `
                        <div class="pgf-question-item">
                            <div class="pgf-question-number">${i + 1}</div>
                            <div class="pgf-question-content">
                                <label>${q}</label>
                                <textarea
                                    id="future-${i}"
                                    rows="2"
                                    placeholder="Answer here..."
                                >${escapeHtml(data.future[i] || '')}</textarea>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- Evaluation Questions -->
            <div class="evaluation-section">
                <h3>Evaluation of Present-Gap-Future Exercise:</h3>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>What was your experience of this session?</label>
                        <textarea
                            id="pgf-eval-experience"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.experience || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">❓</div>
                    <div class="eval-content">
                        <label>What insights did you get, what did you learn from this interview?</label>
                        <textarea
                            id="pgf-eval-insights"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.insights || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🤝</div>
                    <div class="eval-content">
                        <label>What stood out?</label>
                        <textarea
                            id="pgf-eval-stood-out"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.stoodOut || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🏛️</div>
                    <div class="eval-content">
                        <label>If we had the same discussion 2/3 years from now what should be different both professional and personal</label>
                        <textarea
                            id="pgf-eval-future"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.future23Years || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>One thing you can do within the next 24hours that will increase your chances to reach your goal?</label>
                        <textarea
                            id="pgf-eval-24hours"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.next24Hours || '')}</textarea>
                    </div>
                </div>
            </div>

            <!-- Session Notes -->
            <div class="session-notes-section">
                <h3>📝 Session Notes</h3>
                <textarea
                    id="pgf-session-notes"
                    placeholder="Your personal notes about this session..."
                    rows="6"
                >${escapeHtml(data.sessionNotes)}</textarea>
            </div>

            <!-- AI Coach Assistant -->
            <div class="ai-coach-section">
                <h3>🤖 AI Coach Assistant</h3>
                <p class="ai-intro">Discuss this session and the client. The AI has access to all client information.</p>
                <div class="ai-chat-container" id="ai-chat-pgf">
                    <!-- AI chat will be rendered here -->
                </div>
                <div class="ai-input-section">
                    <textarea
                        id="ai-input-pgf"
                        placeholder="Ask the AI coach about this client or session..."
                        rows="3"
                    ></textarea>
                    <button class="btn-ai-send" onclick="sendAIMessagePGF()">Send to AI Coach</button>
                </div>
            </div>

            <div class="exercise-footer">
                <button class="btn-save" onclick="savePresentGapFuture()">💾 Save Progress</button>
                <button class="btn-complete" onclick="completePresentGapFuture()">✓ Complete & Move to Next Step</button>
            </div>
        </div>
    `;

    // Render AI chat if exists
    if (data.aiCoachNotes && data.aiCoachNotes.length > 0) {
        setTimeout(() => {
            const container = document.getElementById('ai-chat-pgf');
            if (container) {
                container.innerHTML = data.aiCoachNotes.map(msg => `
                    <div class="ai-message ${msg.role}">
                        <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                        <div class="message-content">
                            <div class="message-text">${escapeHtml(msg.content)}</div>
                            <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                    </div>
                `).join('');
            }
        }, 100);
    }
}

// Step 3: Flight Plan
function renderFlightPlan(client, container) {
    // Initialize exercise data if not exists
    if (!client.exerciseData) client.exerciseData = {};
    if (!client.exerciseData.flightPlan) {
        client.exerciseData.flightPlan = {
            timelineNumber: '',
            timelineUnit: 'years',
            totalDays: 0,
            onePercentDays: 0,
            flightPlanItems: Array(5).fill(''),
            evaluations: {
                experience: '',
                insights: '',
                stoodOut: '',
                future23Years: '',
                next24Hours: ''
            },
            sessionNotes: '',
            aiCoachNotes: []
        };
    }

    const data = client.exerciseData.flightPlan;

    container.innerHTML = `
        <div class="exercise-page flight-plan-page">
            <!-- Back Button -->
            <div style="margin-bottom: 16px;">
                <button class="btn-back" onclick="closeExercise()">← Back to Journey</button>
            </div>

            <div class="exercise-header">
                <h1>✈️ Step 3: Flight Plan</h1>
                <p class="exercise-subtitle">Create your personalized transformation roadmap</p>
            </div>

            <!-- Flight Plan Section -->
            <div class="flight-plan-section">
                <h3>FLIGHTPLAN</h3>

                <!-- Flight Plan Visual: Runway → Mountain → Dream -->
                <div class="flight-plan-visual-new">
                    <!-- Runway Start -->
                    <div class="runway-start">
                        <div class="runway-label">🛫<br><strong>NOW</strong><br>Goal / Desire</div>
                    </div>

                    <!-- Mountain Path with GAP Steps -->
                    <div class="mountain-container">
                        <svg viewBox="0 0 1000 400" style="width: 100%; height: 400px;">
                            <!-- Runway at bottom -->
                            <rect x="0" y="350" width="150" height="50" fill="#64748b" />
                            <line x1="0" y1="375" x2="150" y2="375" stroke="white" stroke-width="2" stroke-dasharray="10,10"/>

                            <!-- Mountain path -->
                            <path d="M 150 350 L 250 280 L 350 220 L 450 140 L 550 100 L 650 120 L 750 180 L 850 100"
                                  stroke="#94a3b8"
                                  stroke-width="4"
                                  fill="none"
                                  stroke-dasharray="8,4"/>

                            <!-- Mountain silhouette -->
                            <path d="M 150 350 L 250 280 L 350 220 L 450 140 L 550 100 L 650 120 L 750 180 L 850 100 L 850 350 Z"
                                  fill="#e2e8f0"
                                  opacity="0.3"/>

                            <!-- Runway at top (same height as peak) -->
                            <rect x="850" y="50" width="150" height="50" fill="#10b981" />
                            <line x1="850" y1="75" x2="1000" y2="75" stroke="white" stroke-width="2" stroke-dasharray="10,10"/>
                        </svg>

                        <!-- GAP Steps positioned on mountain -->
                        <div class="gap-steps-on-mountain">
                            <h4>Steps to reach your dream (from GAP answers):</h4>
                            ${[1,2,3,4,5].map(i => `
                                <div class="flight-item">
                                    <span class="flight-item-number">${i}.</span>
                                    <textarea
                                        id="flight-item-${i-1}"
                                        rows="1"
                                        placeholder="Add step from GAP answers..."
                                    >${escapeHtml(data.flightPlanItems[i-1] || '')}</textarea>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- Dream Destination -->
                    <div class="runway-end">
                        <div class="runway-label">🏆<br><strong>DREAM</strong><br>Aspiration</div>
                    </div>
                </div>

                <!-- Timeline Calculator (after the visual) -->
                <div class="timeline-calculator">
                    <label style="display: block; margin-bottom: 12px; color: #166534; font-weight: 600; font-size: 18px;">How long to reach your dream?</label>
                    <div style="display: flex; gap: 12px; align-items: center; justify-content: center; margin-bottom: 20px;">
                        <input
                            type="number"
                            id="timeline-number"
                            value="${data.timelineNumber}"
                            placeholder="15"
                            min="1"
                            style="width: 100px; padding: 12px; border: 2px solid #86efac; border-radius: 8px; font-size: 18px; font-weight: 600; text-align: center;"
                            onchange="calculateOnePercent()"
                        />
                        <select
                            id="timeline-unit"
                            style="padding: 12px; border: 2px solid #86efac; border-radius: 8px; font-size: 18px; font-weight: 600;"
                            onchange="calculateOnePercent()"
                        >
                            <option value="months" ${data.timelineUnit === 'months' ? 'selected' : ''}>Months</option>
                            <option value="years" ${data.timelineUnit === 'years' ? 'selected' : ''}>Years</option>
                        </select>
                    </div>

                    <div id="calculation-result" style="background: white; border: 2px solid #86efac; border-radius: 12px; padding: 20px; margin-bottom: 24px; text-align: center;">
                        <div style="color: #166534; font-size: 16px; margin-bottom: 8px;">
                            <strong>Total Days:</strong> <span id="total-days" style="font-size: 24px; font-weight: 700;">${data.totalDays || 0}</span> days
                        </div>
                        <div style="color: #15803d; font-size: 16px; margin-bottom: 8px;">
                            <strong>1% of Total:</strong> <span id="one-percent-days" style="font-size: 24px; font-weight: 700; color: #10b981;">${data.onePercentDays || 0}</span> days
                        </div>
                        <div style="color: #64748b; font-size: 14px; font-style: italic; margin-top: 12px;">
                            Every ${data.onePercentDays || 0} days, implement a small step towards your dream
                        </div>
                    </div>
                </div>
            </div>

            <!-- Evaluation Questions -->
            <div class="evaluation-section">
                <h3>Evaluation of Flight Plan Exercise:</h3>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>What was your experience of this session?</label>
                        <textarea
                            id="fp-eval-experience"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.experience || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">❓</div>
                    <div class="eval-content">
                        <label>What insights did you get, what did you learn from this interview?</label>
                        <textarea
                            id="fp-eval-insights"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.insights || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🤝</div>
                    <div class="eval-content">
                        <label>What stood out?</label>
                        <textarea
                            id="fp-eval-stood-out"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.stoodOut || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🏛️</div>
                    <div class="eval-content">
                        <label>If we had the same discussion 2/3 years from now what should be different both professional and personal</label>
                        <textarea
                            id="fp-eval-future"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.future23Years || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>One thing you can do within the next 24hours that will increase your chances to reach your goal?</label>
                        <textarea
                            id="fp-eval-24hours"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.next24Hours || '')}</textarea>
                    </div>
                </div>
            </div>

            <!-- Session Notes -->
            <div class="session-notes-section">
                <h3>📝 Session Notes</h3>
                <textarea
                    id="fp-session-notes"
                    placeholder="Your personal notes about this session..."
                    rows="6"
                >${escapeHtml(data.sessionNotes)}</textarea>
            </div>

            <!-- AI Coach Assistant -->
            <div class="ai-coach-section">
                <h3>🤖 AI Coach Assistant</h3>
                <p class="ai-intro">Discuss this session and the client. The AI has access to all client information.</p>
                <div class="ai-chat-container" id="ai-chat-fp">
                    <!-- AI chat will be rendered here -->
                </div>
                <div class="ai-input-section">
                    <textarea
                        id="ai-input-fp"
                        placeholder="Ask the AI coach about this client or session..."
                        rows="3"
                    ></textarea>
                    <button class="btn-ai-send" onclick="sendAIMessageFP()">Send to AI Coach</button>
                </div>
            </div>

            <div class="exercise-footer">
                <button class="btn-save" onclick="saveFlightPlan()">💾 Save Progress</button>
                <button class="btn-complete" onclick="completeFlightPlan()">✓ Complete & Move to Next Step</button>
            </div>
        </div>
    `;

    // Initialize calculator on load
    setTimeout(() => {
        if (window.calculateOnePercent) {
            window.calculateOnePercent();
        }
    }, 100);

    // Render AI chat if exists
    if (data.aiCoachNotes && data.aiCoachNotes.length > 0) {
        setTimeout(() => {
            const container = document.getElementById('ai-chat-fp');
            if (container) {
                container.innerHTML = data.aiCoachNotes.map(msg => `
                    <div class="ai-message ${msg.role}">
                        <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                        <div class="message-content">
                            <div class="message-text">${escapeHtml(msg.content)}</div>
                            <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                    </div>
                `).join('');
            }
        }, 100);
    }
}

// Step 4: Deep Dive
function renderDeepDive(client, container) {
    // Initialize exercise data if not exists
    if (!client.exerciseData) client.exerciseData = {};
    if (!client.exerciseData.deepDive) {
        client.exerciseData.deepDive = {
            deepDiveItems: [
                { question: '', answer: '' },
                { question: '', answer: '' },
                { question: '', answer: '' },
                { question: '', answer: '' },
                { question: '', answer: '' },
                { question: '', answer: '' },
                { question: '', answer: '' }
            ],
            evaluations: {
                experience: '',
                insights: '',
                stoodOut: '',
                future23Years: '',
                next24Hours: ''
            },
            sessionNotes: '',
            aiCoachNotes: []
        };
    }

    const data = client.exerciseData.deepDive;

    // Get dream from Step 2
    const dreamFromStep2 = client.dream || client.exerciseData?.fourQuadrant?.dreamSummary || '';

    container.innerHTML = `
        <div class="exercise-page deep-dive-page">
            <!-- Back Button -->
            <div style="margin-bottom: 16px;">
                <button class="btn-back" onclick="closeExercise()">← Back to Journey</button>
            </div>

            <div class="exercise-header">
                <h1>🤿 Step 4: Deep Dive</h1>
                <p class="exercise-subtitle">Explore the most important aspects of your dream</p>
            </div>

            <!-- Dream from Step 2 -->
            ${dreamFromStep2 ? `
                <div class="dream-display-section">
                    <h3>💭 Your Dream:</h3>
                    <div class="dream-display-text">${escapeHtml(dreamFromStep2)}</div>
                </div>
            ` : ''}

            <!-- Deep Dive 2-Column Section -->
            <div class="deep-dive-section">
                <h3>What is most important about this dream?</h3>
                <p class="deep-dive-subtitle">Explore the deeper layers by asking "What is most important?" repeatedly</p>

                <div id="deep-dive-items">
                    ${data.deepDiveItems.map((item, i) => `
                        <div class="deep-dive-row" data-index="${i}">
                            <div class="deep-dive-column">
                                <label>What is most important?</label>
                                <textarea
                                    id="dd-question-${i}"
                                    rows="2"
                                    placeholder="Ask: What is most important about..."
                                    readonly
                                >What is most important${i > 0 ? ' about that' : ''}?</textarea>
                            </div>
                            <div class="deep-dive-column">
                                <label>Client's Answer</label>
                                <textarea
                                    id="dd-answer-${i}"
                                    rows="2"
                                    placeholder="Client's response..."
                                >${escapeHtml(item.answer || '')}</textarea>
                            </div>
                            ${i >= 7 ? `
                                <button class="btn-remove-row" onclick="removeDeepDiveRow(${i})">✕</button>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>

                <button class="btn-add-row" onclick="addDeepDiveRow()">
                    ➕ Add Another Layer
                </button>
            </div>

            <!-- Evaluation Questions -->
            <div class="evaluation-section">
                <h3>Evaluation of Deep Dive Exercise:</h3>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>What was your experience of this session?</label>
                        <textarea
                            id="dd-eval-experience"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.experience || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">❓</div>
                    <div class="eval-content">
                        <label>What insights did you get, what did you learn from this interview?</label>
                        <textarea
                            id="dd-eval-insights"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.insights || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🤝</div>
                    <div class="eval-content">
                        <label>What stood out?</label>
                        <textarea
                            id="dd-eval-stood-out"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.stoodOut || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🏛️</div>
                    <div class="eval-content">
                        <label>If we had the same discussion 2/3 years from now what should be different both professional and personal</label>
                        <textarea
                            id="dd-eval-future"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.future23Years || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>One thing you can do within the next 24hours that will increase your chances to reach your goal?</label>
                        <textarea
                            id="dd-eval-24hours"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.next24Hours || '')}</textarea>
                    </div>
                </div>
            </div>

            <!-- Session Notes -->
            <div class="session-notes-section">
                <h3>📝 Session Notes</h3>
                <textarea
                    id="dd-session-notes"
                    placeholder="Your personal notes about this session..."
                    rows="6"
                >${escapeHtml(data.sessionNotes)}</textarea>
            </div>

            <!-- AI Coach Assistant -->
            <div class="ai-coach-section">
                <h3>🤖 AI Coach Assistant</h3>
                <p class="ai-intro">Discuss this session and the client. The AI has access to all client information.</p>
                <div class="ai-chat-container" id="ai-chat-dd">
                    <!-- AI chat will be rendered here -->
                </div>
                <div class="ai-input-section">
                    <textarea
                        id="ai-input-dd"
                        placeholder="Ask the AI coach about this client or session..."
                        rows="3"
                    ></textarea>
                    <button class="btn-ai-send" onclick="sendAIMessageDD()">Send to AI Coach</button>
                </div>
            </div>

            <div class="exercise-footer">
                <button class="btn-save" onclick="saveDeepDive()">💾 Save Progress</button>
                <button class="btn-complete" onclick="completeDeepDive()">✓ Complete & Move to Next Step</button>
            </div>
        </div>
    `;

    // Render AI chat if exists
    if (data.aiCoachNotes && data.aiCoachNotes.length > 0) {
        setTimeout(() => {
            const chatContainer = document.getElementById('ai-chat-dd');
            if (chatContainer) {
                chatContainer.innerHTML = data.aiCoachNotes.map(msg => `
                    <div class="ai-message ${msg.role}">
                        <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                        <div class="message-content">
                            <div class="message-text">${escapeHtml(msg.content)}</div>
                            <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                    </div>
                `).join('');
            }
        }, 100);
    }
}

function renderEcochart(client, container) {
    // Initialize exercise data if not exists
    if (!client.exerciseData) client.exerciseData = {};
    if (!client.exerciseData.ecochart) {
        client.exerciseData.ecochart = {
            blocks: [
                { name: '', give: 0, take: 0 },
                { name: '', give: 0, take: 0 },
                { name: '', give: 0, take: 0 },
                { name: '', give: 0, take: 0 }
            ],
            evaluations: {
                experience: '',
                insights: '',
                stoodOut: '',
                future23Years: '',
                next24Hours: ''
            },
            sessionNotes: '',
            aiCoachNotes: []
        };
    }

    const data = client.exerciseData.ecochart;

    // Calculate totals
    const totalGive = data.blocks.reduce((sum, block) => sum + (parseFloat(block.give) || 0), 0);
    const totalTake = data.blocks.reduce((sum, block) => sum + (parseFloat(block.take) || 0), 0);
    const grandTotal = totalGive + totalTake;

    // Calculate percentages out of 100
    let givePercent = 0;
    let takePercent = 0;
    if (grandTotal > 0) {
        givePercent = Math.round((totalGive / grandTotal) * 100);
        takePercent = Math.round((totalTake / grandTotal) * 100);
    }

    container.innerHTML = `
        <div class="exercise-page ecochart-page">
            <!-- Back Button -->
            <div style="margin-bottom: 16px;">
                <button class="btn-back" onclick="closeExercise()">← Back to Journey</button>
            </div>

            <div class="exercise-header">
                <h1>🌐 Step 5: Ecochart</h1>
                <p class="exercise-subtitle">Map your ecosystem of relationships - what you give and what you take</p>
            </div>

            <!-- Ecochart Grid -->
            <div class="ecochart-grid-container">
                <div class="ecochart-grid" id="ecochart-blocks">
                    ${data.blocks.map((block, i) => `
                        <div class="ecochart-block" data-index="${i}">
                            <div class="block-name-section">
                                <input
                                    type="text"
                                    id="block-name-${i}"
                                    class="block-name-input"
                                    placeholder="Name (e.g., Family, Work, etc.)"
                                    value="${escapeHtml(block.name || '')}"
                                />
                            </div>
                            <div class="block-amounts-section">
                                <div class="block-give">
                                    <label>Give</label>
                                    <input
                                        type="number"
                                        id="block-give-${i}"
                                        class="block-amount-input"
                                        placeholder="0"
                                        min="0"
                                        max="10"
                                        step="1"
                                        value="${block.give || 0}"
                                    />
                                </div>
                                <div class="block-take">
                                    <label>Take</label>
                                    <input
                                        type="number"
                                        id="block-take-${i}"
                                        class="block-amount-input"
                                        placeholder="0"
                                        min="0"
                                        max="10"
                                        step="1"
                                        value="${block.take || 0}"
                                    />
                                </div>
                            </div>
                            ${i >= 4 ? `
                                <button class="btn-remove-block" onclick="removeEcochartBlock(${i})">✕</button>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>

                <button class="btn-add-block" onclick="addEcochartBlock()">
                    ➕ Add Another Block
                </button>
            </div>

            <!-- Center Summary -->
            <div class="ecochart-summary">
                <h3>📊 Summary</h3>
                <div class="summary-grid">
                    <div class="summary-card give-summary">
                        <div class="summary-label">Total Give</div>
                        <div class="summary-value" id="total-give">${totalGive}</div>
                    </div>
                    <div class="summary-card take-summary">
                        <div class="summary-label">Total Take</div>
                        <div class="summary-value" id="total-take">${totalTake}</div>
                    </div>
                </div>
            </div>

            <!-- Dashboard -->
            <div class="ecochart-dashboard">
                <h3>🎛️ Balance Dashboard (out of 100)</h3>
                <div class="dashboard-bars">
                    <div class="dashboard-bar-container">
                        <div class="dashboard-label">
                            <span>Give</span>
                            <span class="dashboard-percent">${givePercent}%</span>
                        </div>
                        <div class="dashboard-bar-track">
                            <div class="dashboard-bar-fill give-bar" style="width: ${givePercent}%"></div>
                        </div>
                    </div>
                    <div class="dashboard-bar-container">
                        <div class="dashboard-label">
                            <span>Take</span>
                            <span class="dashboard-percent">${takePercent}%</span>
                        </div>
                        <div class="dashboard-bar-track">
                            <div class="dashboard-bar-fill take-bar" style="width: ${takePercent}%"></div>
                        </div>
                    </div>
                </div>
                <div class="dashboard-insight">
                    ${givePercent > 60 ? '💚 You are giving more than you take - ensure you\'re not depleting yourself' :
                      takePercent > 60 ? '❤️ You are taking more than you give - consider how you can contribute more' :
                      '⚖️ You have a balanced ecosystem - well done!'}
                </div>
            </div>

            <!-- Evaluation Questions -->
            <div class="evaluation-section">
                <h3>Evaluation of Ecochart Exercise:</h3>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>What was your experience of this session?</label>
                        <textarea
                            id="eco-eval-experience"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.experience || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">❓</div>
                    <div class="eval-content">
                        <label>What insights did you get, what did you learn from this interview?</label>
                        <textarea
                            id="eco-eval-insights"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.insights || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🤝</div>
                    <div class="eval-content">
                        <label>What stood out?</label>
                        <textarea
                            id="eco-eval-stood-out"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.stoodOut || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🏛️</div>
                    <div class="eval-content">
                        <label>If we had the same discussion 2/3 years from now what should be different both professional and personal</label>
                        <textarea
                            id="eco-eval-future"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.future23Years || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>One thing you can do within the next 24hours that will increase your chances to reach your goal?</label>
                        <textarea
                            id="eco-eval-24hours"
                            rows="2"
                            placeholder="Your answer..."
                        >${escapeHtml(data.evaluations?.next24Hours || '')}</textarea>
                    </div>
                </div>
            </div>

            <!-- Session Notes -->
            <div class="session-notes-section">
                <h3>📝 Session Notes</h3>
                <textarea
                    id="eco-session-notes"
                    placeholder="Your personal notes about this session..."
                    rows="6"
                >${escapeHtml(data.sessionNotes)}</textarea>
            </div>

            <!-- AI Coach Assistant -->
            <div class="ai-coach-section">
                <h3>🤖 AI Coach Assistant</h3>
                <p class="ai-intro">Discuss this session and the client. The AI has access to all client information.</p>
                <div class="ai-chat-container" id="ai-chat-eco">
                    <!-- AI chat will be rendered here -->
                </div>
                <div class="ai-input-section">
                    <textarea
                        id="ai-input-eco"
                        placeholder="Ask the AI coach about this client or session..."
                        rows="3"
                    ></textarea>
                    <button class="btn-ai-send" onclick="sendAIMessageEco()">Send to AI Coach</button>
                </div>
            </div>

            <div class="exercise-footer">
                <button class="btn-save" onclick="saveEcochart()">💾 Save Progress</button>
                <button class="btn-complete" onclick="completeEcochart()">✓ Complete & Move to Next Step</button>
            </div>
        </div>
    `;

    // Render AI chat if exists
    if (data.aiCoachNotes && data.aiCoachNotes.length > 0) {
        setTimeout(() => {
            const chatContainer = document.getElementById('ai-chat-eco');
            if (chatContainer) {
                chatContainer.innerHTML = data.aiCoachNotes.map(msg => `
                    <div class="ai-message ${msg.role}">
                        <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                        <div class="message-content">
                            <div class="message-text">${escapeHtml(msg.content)}</div>
                            <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                    </div>
                `).join('');
            }
        }, 100);
    }

    // Add live update listeners for amounts
    setTimeout(() => {
        data.blocks.forEach((_, i) => {
            const giveInput = document.getElementById(`block-give-${i}`);
            const takeInput = document.getElementById(`block-take-${i}`);

            if (giveInput) {
                giveInput.addEventListener('input', updateEcochartTotals);
            }
            if (takeInput) {
                takeInput.addEventListener('input', updateEcochartTotals);
            }
        });
    }, 100);
}

function renderAssessments(client, container) {
    // Initialize exercise data if not exists
    if (!client.exerciseData) client.exerciseData = {};
    if (!client.exerciseData.assessments) {
        client.exerciseData.assessments = {
            positivePsychoSocial: {
                expectation: 0,
                achievement: 0,
                satisfaction: 0
            },
            negativePsychoSocial: {
                frustration: 0,
                helplessness: 0,
                stress: 0
            },
            selfPerception: {
                innerInsecurity: 0,
                guiltFeelings: 0,
                lackOfSelfWorth: 0
            },
            emotionalFunctioning: {
                disturbingThoughts: 0,
                paranoia: 0,
                anxiety: 0,
                dependency: 0,
                senselessnessOfExistence: 0,
                memoryLoss: 0,
                suicidalThoughts: 0
            },
            flowStateQualities: {
                perseverance: 0,
                passion: 0,
                focus: 0,
                mastery: 0
            },
            evaluations: {
                experience: '',
                insights: '',
                stoodOut: '',
                future23Years: '',
                next24Hours: ''
            },
            sessionNotes: '',
            aiCoachNotes: []
        };
    }

    const data = client.exerciseData.assessments;

    // Calculate overall scores
    const posTotal = data.positivePsychoSocial.expectation + data.positivePsychoSocial.achievement + data.positivePsychoSocial.satisfaction;
    const negTotal = data.negativePsychoSocial.frustration + data.negativePsychoSocial.helplessness + data.negativePsychoSocial.stress;
    const selfTotal = data.selfPerception.innerInsecurity + data.selfPerception.guiltFeelings + data.selfPerception.lackOfSelfWorth;
    const emoTotal = data.emotionalFunctioning.disturbingThoughts + data.emotionalFunctioning.paranoia +
                     data.emotionalFunctioning.anxiety + data.emotionalFunctioning.dependency +
                     data.emotionalFunctioning.senselessnessOfExistence + data.emotionalFunctioning.memoryLoss +
                     data.emotionalFunctioning.suicidalThoughts;
    const flowTotal = data.flowStateQualities.perseverance + data.flowStateQualities.passion +
                      data.flowStateQualities.focus + data.flowStateQualities.mastery;

    container.innerHTML = `
        <div class="exercise-page assessments-page">
            <!-- Back Button -->
            <div style="margin-bottom: 16px;">
                <button class="btn-back" onclick="closeExercise()">← Back to Journey</button>
            </div>

            <div class="exercise-header">
                <h1>📊 Step 6: Assessments</h1>
                <p class="exercise-subtitle">Complete comprehensive psychological assessments and baseline evaluations</p>
            </div>

            <div class="assessment-intro">
                <p>Enter assessment scores manually (0-100) or import from questionnaire results. Bars update automatically as you type.</p>
            </div>

            <!-- Assessment Input Sections -->
            <div class="assessment-sections">

                <!-- Positive Psycho-social Functioning -->
                <div class="assessment-category">
                    <h3>Positive Psycho-social Functioning <span class="total-score">${posTotal}</span></h3>

                    <div class="assessment-item">
                        <label>Expectation - IIS</label>
                        <input type="number" id="pos-expectation" class="assessment-input" min="0" max="100" value="${data.positivePsychoSocial.expectation}" />
                        <div class="bar-chart">
                            <div class="bar-fill positive-bar" style="width: ${data.positivePsychoSocial.expectation}%"></div>
                            <span class="bar-value">${data.positivePsychoSocial.expectation}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Achievement - IIS</label>
                        <input type="number" id="pos-achievement" class="assessment-input" min="0" max="100" value="${data.positivePsychoSocial.achievement}" />
                        <div class="bar-chart">
                            <div class="bar-fill positive-bar" style="width: ${data.positivePsychoSocial.achievement}%"></div>
                            <span class="bar-value">${data.positivePsychoSocial.achievement}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Satisfaction - IIS</label>
                        <input type="number" id="pos-satisfaction" class="assessment-input" min="0" max="100" value="${data.positivePsychoSocial.satisfaction}" />
                        <div class="bar-chart">
                            <div class="bar-fill positive-bar" style="width: ${data.positivePsychoSocial.satisfaction}%"></div>
                            <span class="bar-value">${data.positivePsychoSocial.satisfaction}%</span>
                        </div>
                    </div>

                    <div class="interpretation-guide positive-guide">
                        <strong>Positive Psycho-social Functioning:</strong><br>
                        0% - 30%: Under activated, unable to rationalize.<br>
                        31% - 72%: Under activated, needs attention.<br>
                        73% - 79%: Warning area.<br>
                        80% - 95%: Optimally activated.<br>
                        95% - 100%: Over activated, out of touch with reality.
                    </div>
                </div>

                <!-- Negative Psycho-social Functioning -->
                <div class="assessment-category">
                    <h3>Negative Psycho-social Functioning <span class="total-score">${negTotal}</span></h3>

                    <div class="assessment-item">
                        <label>Frustration - IIS</label>
                        <input type="number" id="neg-frustration" class="assessment-input" min="0" max="100" value="${data.negativePsychoSocial.frustration}" />
                        <div class="bar-chart">
                            <div class="bar-fill negative-bar" style="width: ${data.negativePsychoSocial.frustration}%"></div>
                            <span class="bar-value">${data.negativePsychoSocial.frustration}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Helplessness - IIS</label>
                        <input type="number" id="neg-helplessness" class="assessment-input" min="0" max="100" value="${data.negativePsychoSocial.helplessness}" />
                        <div class="bar-chart">
                            <div class="bar-fill negative-bar" style="width: ${data.negativePsychoSocial.helplessness}%"></div>
                            <span class="bar-value">${data.negativePsychoSocial.helplessness}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Stress - IIS</label>
                        <input type="number" id="neg-stress" class="assessment-input" min="0" max="100" value="${data.negativePsychoSocial.stress}" />
                        <div class="bar-chart">
                            <div class="bar-fill negative-bar" style="width: ${data.negativePsychoSocial.stress}%"></div>
                            <span class="bar-value">${data.negativePsychoSocial.stress}%</span>
                        </div>
                    </div>

                    <div class="interpretation-guide negative-guide">
                        <strong>Negative Psycho-social Functioning:</strong><br>
                        0% - 5%: Under activated, out of touch with reality.<br>
                        6% - 21%: Optimally activated.<br>
                        22% - 28%: Warning area.<br>
                        29% - 70%: Over activated, needs attention.<br>
                        71% - 100%: Over activated, unable to rationalize.
                    </div>
                </div>

                <!-- Self-perception -->
                <div class="assessment-category">
                    <h3>Self-perception <span class="total-score">${selfTotal}</span></h3>

                    <div class="assessment-item">
                        <label>Inner Insecurity</label>
                        <input type="number" id="self-insecurity" class="assessment-input" min="0" max="100" value="${data.selfPerception.innerInsecurity}" />
                        <div class="bar-chart">
                            <div class="bar-fill self-bar" style="width: ${data.selfPerception.innerInsecurity}%"></div>
                            <span class="bar-value">${data.selfPerception.innerInsecurity}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Guilt Feelings</label>
                        <input type="number" id="self-guilt" class="assessment-input" min="0" max="100" value="${data.selfPerception.guiltFeelings}" />
                        <div class="bar-chart">
                            <div class="bar-fill self-bar" style="width: ${data.selfPerception.guiltFeelings}%"></div>
                            <span class="bar-value">${data.selfPerception.guiltFeelings}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Lack of Self Worth</label>
                        <input type="number" id="self-worth" class="assessment-input" min="0" max="100" value="${data.selfPerception.lackOfSelfWorth}" />
                        <div class="bar-chart">
                            <div class="bar-fill self-bar" style="width: ${data.selfPerception.lackOfSelfWorth}%"></div>
                            <span class="bar-value">${data.selfPerception.lackOfSelfWorth}%</span>
                        </div>
                    </div>

                    <div class="interpretation-guide self-guide">
                        <strong>Self-Perception:</strong><br>
                        0% - 20%: Optimally activated.<br>
                        21% - 25%: Warning area.<br>
                        26% - 70%: Over activated, needs attention.<br>
                        71% - 100%: Over activated, unable to rationalize.
                    </div>
                </div>

                <!-- Emotional Functioning -->
                <div class="assessment-category">
                    <h3>Emotional Functioning <span class="total-score">${emoTotal}</span></h3>

                    <div class="assessment-item">
                        <label>Disturbing Thoughts</label>
                        <input type="number" id="emo-thoughts" class="assessment-input" min="0" max="100" value="${data.emotionalFunctioning.disturbingThoughts}" />
                        <div class="bar-chart">
                            <div class="bar-fill emotional-bar" style="width: ${data.emotionalFunctioning.disturbingThoughts}%"></div>
                            <span class="bar-value">${data.emotionalFunctioning.disturbingThoughts}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Paranoia</label>
                        <input type="number" id="emo-paranoia" class="assessment-input" min="0" max="100" value="${data.emotionalFunctioning.paranoia}" />
                        <div class="bar-chart">
                            <div class="bar-fill emotional-bar" style="width: ${data.emotionalFunctioning.paranoia}%"></div>
                            <span class="bar-value">${data.emotionalFunctioning.paranoia}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Anxiety</label>
                        <input type="number" id="emo-anxiety" class="assessment-input" min="0" max="100" value="${data.emotionalFunctioning.anxiety}" />
                        <div class="bar-chart">
                            <div class="bar-fill emotional-bar" style="width: ${data.emotionalFunctioning.anxiety}%"></div>
                            <span class="bar-value">${data.emotionalFunctioning.anxiety}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Dependency</label>
                        <input type="number" id="emo-dependency" class="assessment-input" min="0" max="100" value="${data.emotionalFunctioning.dependency}" />
                        <div class="bar-chart">
                            <div class="bar-fill emotional-bar" style="width: ${data.emotionalFunctioning.dependency}%"></div>
                            <span class="bar-value">${data.emotionalFunctioning.dependency}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Senselessness of Existence</label>
                        <input type="number" id="emo-senselessness" class="assessment-input" min="0" max="100" value="${data.emotionalFunctioning.senselessnessOfExistence}" />
                        <div class="bar-chart">
                            <div class="bar-fill emotional-bar" style="width: ${data.emotionalFunctioning.senselessnessOfExistence}%"></div>
                            <span class="bar-value">${data.emotionalFunctioning.senselessnessOfExistence}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Memory Loss</label>
                        <input type="number" id="emo-memory" class="assessment-input" min="0" max="100" value="${data.emotionalFunctioning.memoryLoss}" />
                        <div class="bar-chart">
                            <div class="bar-fill emotional-bar" style="width: ${data.emotionalFunctioning.memoryLoss}%"></div>
                            <span class="bar-value">${data.emotionalFunctioning.memoryLoss}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Suicidal Thoughts</label>
                        <input type="number" id="emo-suicidal" class="assessment-input" min="0" max="100" value="${data.emotionalFunctioning.suicidalThoughts}" />
                        <div class="bar-chart">
                            <div class="bar-fill emotional-bar" style="width: ${data.emotionalFunctioning.suicidalThoughts}%"></div>
                            <span class="bar-value">${data.emotionalFunctioning.suicidalThoughts}%</span>
                        </div>
                    </div>

                    <div class="interpretation-guide emotional-guide">
                        <strong>Emotional Functioning:</strong><br>
                        0% - 16%: Optimally activated.<br>
                        17% - 21%: Warning area.<br>
                        22% - 70%: Over activated, needs attention.<br>
                        71% - 100%: Over activated, unable to rationalize.
                    </div>
                </div>

                <!-- Flow State Qualities -->
                <div class="assessment-category">
                    <h3>Flow State Qualities <span class="total-score">${flowTotal}</span></h3>

                    <div class="assessment-item">
                        <label>Perseverance</label>
                        <input type="number" id="flow-perseverance" class="assessment-input" min="0" max="100" value="${data.flowStateQualities.perseverance}" />
                        <div class="bar-chart">
                            <div class="bar-fill flow-bar" style="width: ${data.flowStateQualities.perseverance}%"></div>
                            <span class="bar-value">${data.flowStateQualities.perseverance}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Passion</label>
                        <input type="number" id="flow-passion" class="assessment-input" min="0" max="100" value="${data.flowStateQualities.passion}" />
                        <div class="bar-chart">
                            <div class="bar-fill flow-bar" style="width: ${data.flowStateQualities.passion}%"></div>
                            <span class="bar-value">${data.flowStateQualities.passion}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Focus</label>
                        <input type="number" id="flow-focus" class="assessment-input" min="0" max="100" value="${data.flowStateQualities.focus}" />
                        <div class="bar-chart">
                            <div class="bar-fill flow-bar" style="width: ${data.flowStateQualities.focus}%"></div>
                            <span class="bar-value">${data.flowStateQualities.focus}%</span>
                        </div>
                    </div>

                    <div class="assessment-item">
                        <label>Mastery</label>
                        <input type="number" id="flow-mastery" class="assessment-input" min="0" max="100" value="${data.flowStateQualities.mastery}" />
                        <div class="bar-chart">
                            <div class="bar-fill flow-bar" style="width: ${data.flowStateQualities.mastery}%"></div>
                            <span class="bar-value">${data.flowStateQualities.mastery}%</span>
                        </div>
                    </div>

                    <div class="interpretation-guide flow-guide">
                        <strong>Flow State Qualities:</strong><br>
                        0% - 65%: Under activated.<br>
                        66% - 71%: Warning area.<br>
                        72% - 100%: Optimally activated.
                    </div>
                </div>

            </div>

            <!-- Evaluation Questions -->
            <div class="evaluation-section">
                <h3>Evaluation of Assessment Session:</h3>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>What was your experience of this session?</label>
                        <textarea id="assess-eval-experience" rows="2" placeholder="Your answer...">${escapeHtml(data.evaluations?.experience || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">❓</div>
                    <div class="eval-content">
                        <label>What insights did you get, what did you learn from this interview?</label>
                        <textarea id="assess-eval-insights" rows="2" placeholder="Your answer...">${escapeHtml(data.evaluations?.insights || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🤝</div>
                    <div class="eval-content">
                        <label>What stood out?</label>
                        <textarea id="assess-eval-stood-out" rows="2" placeholder="Your answer...">${escapeHtml(data.evaluations?.stoodOut || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🏛️</div>
                    <div class="eval-content">
                        <label>If we had the same discussion 2/3 years from now what should be different both professional and personal</label>
                        <textarea id="assess-eval-future" rows="2" placeholder="Your answer...">${escapeHtml(data.evaluations?.future23Years || '')}</textarea>
                    </div>
                </div>

                <div class="eval-question">
                    <div class="eval-icon">🎯</div>
                    <div class="eval-content">
                        <label>One thing you can do within the next 24hours that will increase your chances to reach your goal?</label>
                        <textarea id="assess-eval-24hours" rows="2" placeholder="Your answer...">${escapeHtml(data.evaluations?.next24Hours || '')}</textarea>
                    </div>
                </div>
            </div>

            <!-- Session Notes -->
            <div class="session-notes-section">
                <h3>📝 Session Notes</h3>
                <textarea id="assess-session-notes" placeholder="Your personal notes about this assessment session..." rows="6">${escapeHtml(data.sessionNotes)}</textarea>
            </div>

            <!-- AI Coach Assistant -->
            <div class="ai-coach-section">
                <h3>🤖 AI Coach Assistant</h3>
                <p class="ai-intro">Discuss this assessment and the client. The AI has access to all client information.</p>
                <div class="ai-chat-container" id="ai-chat-assess">
                    <!-- AI chat will be rendered here -->
                </div>
                <div class="ai-input-section">
                    <textarea id="ai-input-assess" placeholder="Ask the AI coach about this client or session..." rows="3"></textarea>
                    <button class="btn-ai-send" onclick="sendAIMessageAssess()">Send to AI Coach</button>
                </div>
            </div>

            <div class="exercise-footer">
                <button class="btn-save" onclick="saveAssessments()">💾 Save Progress</button>
                <button class="btn-complete" onclick="completeAssessments()">✓ Complete & Move to Next Step</button>
            </div>
        </div>
    `;

    // Render AI chat if exists
    if (data.aiCoachNotes && data.aiCoachNotes.length > 0) {
        setTimeout(() => {
            const chatContainer = document.getElementById('ai-chat-assess');
            if (chatContainer) {
                chatContainer.innerHTML = data.aiCoachNotes.map(msg => `
                    <div class="ai-message ${msg.role}">
                        <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                        <div class="message-content">
                            <div class="message-text">${escapeHtml(msg.content)}</div>
                            <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                    </div>
                `).join('');
            }
        }, 100);
    }

    // Add live update listeners for all inputs
    setTimeout(() => {
        const inputs = container.querySelectorAll('.assessment-input');
        inputs.forEach(input => {
            input.addEventListener('input', updateAssessmentBars);
        });
    }, 100);
}

function renderCockpitReview(client, container) {
    renderPlaceholder(container, 7, '🎛️ The Cockpit', 'Your personal flight control center and metrics dashboard');
}

function renderPDD(client, container) {
    renderPlaceholder(container, 8, '⚙️ Personal Driving Dynamics (PDD)', 'Understand your core motivators and behavioral drivers');
}

function renderPsychoeducation(client, container) {
    renderPlaceholder(container, 9, '🧠 Psychoeducation', 'Learn the neuroscience behind behavior and change');
}

function renderMLNP(client, container) {
    // Initialize MLNP data
    if (!client.exerciseData.mlnp) {
        client.exerciseData.mlnp = {
            sessions: [],
            evaluations: {},
            sessionNotes: '',
            aiCoachNotes: []
        };
    }

    const data = client.exerciseData.mlnp;

    // Emotion faces data (25 emotions from the image grid)
    const emotionFaces = [
        { id: 1, name: 'Happy', emoji: '😊', row: 1, col: 1 },
        { id: 2, name: 'Confident', emoji: '😌', row: 1, col: 2 },
        { id: 3, name: 'Excited', emoji: '😃', row: 1, col: 3 },
        { id: 4, name: 'Content', emoji: '🙂', row: 1, col: 4 },
        { id: 5, name: 'Surprised', emoji: '😮', row: 1, col: 5 },

        { id: 6, name: 'Thoughtful', emoji: '🤔', row: 2, col: 1 },
        { id: 7, name: 'Joyful', emoji: '😄', row: 2, col: 2 },
        { id: 8, name: 'Confused', emoji: '😕', row: 2, col: 3 },
        { id: 9, name: 'Peaceful', emoji: '😇', row: 2, col: 4 },
        { id: 10, name: 'Angry', emoji: '😠', row: 2, col: 5 },

        { id: 11, name: 'Worried', emoji: '😟', row: 3, col: 1 },
        { id: 12, name: 'Anxious', emoji: '😰', row: 3, col: 2 },
        { id: 13, name: 'Serious', emoji: '😐', row: 3, col: 3 },
        { id: 14, name: 'Shocked', emoji: '😱', row: 3, col: 4 },
        { id: 15, name: 'Amazed', emoji: '😲', row: 3, col: 5 },

        { id: 16, name: 'Curious', emoji: '🧐', row: 4, col: 1 },
        { id: 17, name: 'Skeptical', emoji: '🤨', row: 4, col: 2 },
        { id: 18, name: 'Hopeful', emoji: '🙏', row: 4, col: 3 },
        { id: 19, name: 'Inspired', emoji: '✨', row: 4, col: 4 },
        { id: 20, name: 'Cool', emoji: '😎', row: 4, col: 5 },

        { id: 21, name: 'Frustrated', emoji: '😤', row: 5, col: 1 },
        { id: 22, name: 'Sad', emoji: '😢', row: 5, col: 2 },
        { id: 23, name: 'Determined', emoji: '😤', row: 5, col: 3 },
        { id: 24, name: 'Calm', emoji: '😌', row: 5, col: 4 },
        { id: 25, name: 'Overwhelmed', emoji: '😫', row: 5, col: 5 }
    ];

    const sessionDate = new Date().toLocaleDateString('en-ZA', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    container.innerHTML = `
        <div class="exercise-page mlnp-page">
            <!-- Back Button -->
            <div class="exercise-header">
                <button class="btn-back" onclick="closeExercise()">← Back to Journey</button>
                <div>
                    <h1>🧬 MLNP - Multi-Level Neuro Processing</h1>
                    <p class="exercise-subtitle">Rewire neural pathways through emotional awareness</p>
                </div>
            </div>

            <div class="exercise-content">
                <!-- Introduction -->
                <div class="mlnp-intro">
                    <p><strong>Session Date:</strong> ${sessionDate}</p>
                    <p>Click "Start Session" to begin working with emotion faces. Select an emotion to explore it deeper.</p>
                </div>

                <!-- Start Session Button / Emotion Grid -->
                <div id="mlnp-session-area">
                    ${data.sessions.length === 0 ? `
                        <div class="mlnp-start-section">
                            <button class="btn-start-mlnp" onclick="startMLNPSession()">
                                🚀 Start MLNP Session
                            </button>
                        </div>
                    ` : ''}

                    <div id="mlnp-emotion-grid" style="display: none;">
                        <h3>Select an Emotion Face to Work With:</h3>
                        <div class="emotion-grid">
                            ${emotionFaces.map(emotion => `
                                <div class="emotion-card" onclick="openEmotionWindow(${emotion.id}, '${emotion.name}', '${emotion.emoji}')">
                                    <div class="emotion-emoji">${emotion.emoji}</div>
                                    <div class="emotion-name">${emotion.name}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- Single Emotion Window (Modal) -->
                    <div id="emotion-modal" class="emotion-modal" style="display: none;">
                        <div class="emotion-modal-content">
                            <button class="emotion-modal-close" onclick="closeEmotionWindow()">✕</button>

                            <div class="emotion-modal-header">
                                <div class="emotion-modal-emoji" id="modal-emoji">😊</div>
                                <h2 id="modal-emotion-name">Happy</h2>
                            </div>

                            <div class="emotion-modal-body">
                                <div class="emotion-question">
                                    <label>What triggers this emotion in you?</label>
                                    <textarea id="modal-triggers" rows="3" placeholder="Describe situations, people, or thoughts..."></textarea>
                                </div>

                                <div class="emotion-question">
                                    <label>Where do you feel this in your body?</label>
                                    <textarea id="modal-body-sensations" rows="2" placeholder="Chest, stomach, head, shoulders..."></textarea>
                                </div>

                                <div class="emotion-question">
                                    <label>What thoughts come with this emotion?</label>
                                    <textarea id="modal-thoughts" rows="3" placeholder="Automatic thoughts, beliefs, inner dialogue..."></textarea>
                                </div>

                                <div class="emotion-question">
                                    <label>How do you typically respond to this emotion?</label>
                                    <textarea id="modal-responses" rows="3" placeholder="Actions, behaviors, coping strategies..."></textarea>
                                </div>

                                <div class="emotion-question">
                                    <label>What new response would serve you better?</label>
                                    <textarea id="modal-new-response" rows="3" placeholder="Desired behavior, healthier coping..."></textarea>
                                </div>

                                <div class="emotion-modal-actions">
                                    <button class="btn-save-emotion" onclick="saveEmotionWork()">
                                        💾 Save This Work
                                    </button>
                                    <button class="btn-back-to-grid" onclick="backToEmotionGrid()">
                                        ← Back to Emotion Grid
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Session History -->
                    <div id="mlnp-history" style="display: none;">
                        <h3>Session History:</h3>
                        <div id="session-history-list"></div>
                    </div>
                </div>

                <!-- Evaluation Questions -->
                <div class="evaluation-section">
                    <h3>Evaluation of MLNP Exercise:</h3>

                    <div class="eval-question">
                        <div class="eval-icon">🎯</div>
                        <div class="eval-content">
                            <label>What was your experience of this session?</label>
                            <textarea
                                id="mlnp-eval-experience"
                                rows="2"
                                placeholder="Your answer..."
                            >${escapeHtml(data.evaluations?.experience || '')}</textarea>
                        </div>
                    </div>

                    <div class="eval-question">
                        <div class="eval-icon">❓</div>
                        <div class="eval-content">
                            <label>What insights did you get, what did you learn from this interview?</label>
                            <textarea
                                id="mlnp-eval-insights"
                                rows="2"
                                placeholder="Your answer..."
                            >${escapeHtml(data.evaluations?.insights || '')}</textarea>
                        </div>
                    </div>

                    <div class="eval-question">
                        <div class="eval-icon">🤝</div>
                        <div class="eval-content">
                            <label>What stood out?</label>
                            <textarea
                                id="mlnp-eval-stood-out"
                                rows="2"
                                placeholder="Your answer..."
                            >${escapeHtml(data.evaluations?.stoodOut || '')}</textarea>
                        </div>
                    </div>

                    <div class="eval-question">
                        <div class="eval-icon">🔮</div>
                        <div class="eval-content">
                            <label>Where do you see yourself in the next 2-3 years?</label>
                            <textarea
                                id="mlnp-eval-future"
                                rows="2"
                                placeholder="Your answer..."
                            >${escapeHtml(data.evaluations?.future23Years || '')}</textarea>
                        </div>
                    </div>

                    <div class="eval-question">
                        <div class="eval-icon">⏰</div>
                        <div class="eval-content">
                            <label>What are you going to do in the next 24 hours?</label>
                            <textarea
                                id="mlnp-eval-next24"
                                rows="2"
                                placeholder="Your answer..."
                            >${escapeHtml(data.evaluations?.next24Hours || '')}</textarea>
                        </div>
                    </div>
                </div>

                <!-- Session Notes -->
                <div class="session-notes-section">
                    <h3>Session Notes:</h3>
                    <textarea
                        id="mlnp-session-notes"
                        rows="6"
                        placeholder="Add your session notes here..."
                    >${escapeHtml(data.sessionNotes || '')}</textarea>
                </div>

                <!-- AI Coach Section -->
                <div class="ai-coach-section">
                    <h3>💬 AI Coach</h3>
                    <div class="ai-chat-container" id="mlnp-ai-chat">
                        ${renderAIChat(data.aiCoachNotes || [])}
                    </div>
                    <div class="ai-input-area">
                        <input
                            type="text"
                            id="ai-input-mlnp"
                            placeholder="Ask the AI Coach about your emotional patterns..."
                            onkeypress="if(event.key==='Enter') sendAIMessageMLNP()"
                        />
                        <button onclick="sendAIMessageMLNP()" class="btn-send-ai">Send</button>
                    </div>
                </div>

                <!-- Action Buttons -->
                <div class="exercise-actions">
                    <button class="btn-save" onclick="saveMLNP()">💾 Save Progress</button>
                    <button class="btn-complete" onclick="completeMLNP()">✓ Complete Step 9</button>
                </div>
            </div>
        </div>
    `;

    // Show emotion grid if session already started
    if (data.sessions && data.sessions.length > 0) {
        setTimeout(() => {
            const grid = $('#mlnp-emotion-grid');
            const history = $('#mlnp-history');
            if (grid) grid.style.display = 'block';
            if (history) {
                history.style.display = 'block';
                renderSessionHistory();
            }
        }, 100);
    }
}


function renderReassess(client, container) {
    renderPlaceholder(container, 11, '🔄 Reassess', 'Re-evaluate progress and adjust course');
}

function renderRevisit(client, container) {
    renderPlaceholder(container, 12, '↩️ Revisit', 'Review and refine previous work');
}

function renderDreamSpot(client, container) {
    renderPlaceholder(container, 13, '💭 The Dream-Spot', 'Discover the intersection of passion, skill, and purpose');
}

function renderValuesBeliefs(client, container) {
    renderPlaceholder(container, 14, '⚖️ Values & Beliefs', 'Clarify core values and empowering beliefs');
}

function renderSuccessTraits(client, container) {
    renderPlaceholder(container, 15, '⛰️ Success Traits', 'Identify and develop traits for success');
}

function renderCuriosityPassionPurpose(client, container) {
    renderPlaceholder(container, 16, '🎯 Curiosity, Passion, Purpose', 'Integrate the three drivers of fulfillment');
}

function renderCreativityFlow(client, container) {
    renderPlaceholder(container, 17, '⚡ Creativity and Flow', 'Unlock creative potential and enter flow states');
}

// Generic placeholder for exercises not yet specified
function renderPlaceholder(container, stepNum, title, subtitle) {
    container.innerHTML = `
        <div class="exercise-page">
            <div class="exercise-header">
                <button class="btn-back" onclick="closeExercise()">← Back to Journey</button>
                <div>
                    <h1>${title}</h1>
                    <p class="exercise-subtitle">${subtitle}</p>
                </div>
            </div>

            <div class="exercise-content">
                <p style="text-align: center; color: #64748b; font-size: 18px; padding: 60px 20px;">
                    Exercise page ready for your specification.<br>
                    Tell me what elements you want for Step ${stepNum}.
                </p>
            </div>

            <div class="exercise-footer">
                <button class="btn-save" onclick="saveExercise()">💾 Save Progress</button>
                <button class="btn-complete" onclick="completeExercise()">✓ Mark Complete & Continue</button>
            </div>
        </div>
    `;
}

// Note: closeExercise is now in journey-helpers.js
// Global helper functions for placeholder exercises
window.saveExercise = function() {
    // Will be implemented to save exercise data
    console.log('Save exercise');
    alert('Progress saved!');
};

window.completeExercise = function() {
    // Will be implemented to mark step complete and move to next
    console.log('Complete exercise');
    alert('Step completed! Moving to next step...');
};
