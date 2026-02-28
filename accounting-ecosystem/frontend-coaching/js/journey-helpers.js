// Helper functions for journey exercises
import { $, escapeHtml } from './config.js';
import { saveClient } from './storage.js';

// Global current client reference
let currentClient = null;

// Helper function to render AI chat
export function renderAIChat(chatHistory) {
    const container = document.getElementById('ai-chat');
    if (!container || !chatHistory) return;

    container.innerHTML = chatHistory.map(msg => `
        <div class="ai-message ${msg.role}">
            <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
            <div class="message-content">
                <div class="message-text">${escapeHtml(msg.content)}</div>
                <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
        </div>
    `).join('');
}

// Set current client
export function setCurrentClient(client) {
    currentClient = client;
}

// Global helper functions for 4 Quadrant Exercise
window.save4QuadrantExercise = async function() {
    if (!currentClient) return;

    const data = {
        painsAndFrustrations: $('#q-pains')?.value || '',
        goalsAndDesires: $('#q-goals')?.value || '',
        fearsAndImplications: $('#q-fears')?.value || '',
        dreamsAndAspirations: $('#q-dreams')?.value || '',
        dreamSummary: $('#dream-summary')?.value || '',
        our1Percent: $('#our-1-percent')?.value || '',
        evaluations: {
            experience: $('#eval-experience')?.value || '',
            insights: $('#eval-insights')?.value || '',
            stoodOut: $('#eval-stood-out')?.value || '',
            future23Years: $('#eval-future')?.value || '',
            next24Hours: $('#eval-24hours')?.value || ''
        },
        sessionNotes: $('#session-notes')?.value || '',
        aiCoachNotes: currentClient.exerciseData?.fourQuadrant?.aiCoachNotes || []
    };

    currentClient.exerciseData.fourQuadrant = data;

    // Update client dream if dream summary is filled
    if (data.dreamSummary.trim()) {
        currentClient.dream = data.dreamSummary.trim();
    }

    await saveClient(currentClient);
    alert('✓ Progress saved successfully!');
};

window.complete4Quadrant = async function() {
    await save4QuadrantExercise();

    // Mark step 1 as complete and move to step 2
    if (!currentClient.journeyProgress) {
        currentClient.journeyProgress = {
            currentStep: 2,
            completedSteps: [1],
            stepNotes: {},
            stepCompletionDates: {}
        };
    } else {
        if (!currentClient.journeyProgress.completedSteps.includes(1)) {
            currentClient.journeyProgress.completedSteps.push(1);
        }
        currentClient.journeyProgress.currentStep = 2;
        currentClient.journeyProgress.stepCompletionDates[1] = new Date().toISOString();
    }

    await saveClient(currentClient);
    alert('✓ Step 1 completed! Moving to Step 2...');

    // Return to journey tracker
    import('./journey-ui.js').then(module => {
        module.renderJourneyTracker(currentClient, 'journey-container');
    });
};

window.sendAIMessage = async function() {
    const input = $('#ai-input');
    if (!input || !input.value.trim()) return;

    const message = input.value.trim();
    input.value = '';

    // Initialize AI chat if not exists
    if (!currentClient.exerciseData.fourQuadrant.aiCoachNotes) {
        currentClient.exerciseData.fourQuadrant.aiCoachNotes = [];
    }

    // Add user message
    currentClient.exerciseData.fourQuadrant.aiCoachNotes.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    // Simulate AI response (will be replaced with actual AI API call)
    const aiResponse = `Based on the client information, I can provide these insights:

• Client: ${currentClient.name}
• Language: ${currentClient.preferred_lang}
• Dream: ${currentClient.dream || 'Not yet defined'}

Regarding your question: "${message}"

I notice from the 4 Quadrant Exercise that the client has shared valuable information about their pains, goals, fears, and aspirations. Would you like me to analyze any specific patterns or suggest coaching strategies?`;

    // Add AI response
    currentClient.exerciseData.fourQuadrant.aiCoachNotes.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date().toISOString()
    });

    // Re-render chat
    renderAIChat(currentClient.exerciseData.fourQuadrant.aiCoachNotes);

    // Save
    await saveClient(currentClient);
};

window.downloadQuadrantPDF = function() {
    alert('PDF download will be implemented. This will create a professional PDF with Infinite Legacy branding.');
};

window.closeExercise = function() {
    if (!currentClient) return;

    // Return to journey tracker
    import('./journey-ui.js').then(module => {
        module.renderJourneyTracker(currentClient, 'journey-container');
    });
};

// Present-Gap-Future Exercise Functions
window.sendAIMessagePGF = async function() {
    const input = $('#ai-input-pgf');
    if (!input || !input.value.trim()) return;

    const message = input.value.trim();
    input.value = '';

    // Initialize AI chat if not exists
    if (!currentClient.exerciseData.presentGapFuture.aiCoachNotes) {
        currentClient.exerciseData.presentGapFuture.aiCoachNotes = [];
    }

    // Add user message
    currentClient.exerciseData.presentGapFuture.aiCoachNotes.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    // Simulate AI response
    const aiResponse = `Based on the Present-Gap-Future analysis:

• Client: ${currentClient.name}
• Language: ${currentClient.preferred_lang}
• Dream: ${currentClient.dream || 'Not yet defined'}

Regarding: "${message}"

I can see the client is navigating the gap between their current situation and future aspirations. The Present-Gap-Future framework helps identify specific obstacles and opportunities. Would you like me to analyze patterns or suggest coaching interventions?`;

    // Add AI response
    currentClient.exerciseData.presentGapFuture.aiCoachNotes.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date().toISOString()
    });

    // Re-render chat
    const container = document.getElementById('ai-chat-pgf');
    if (container) {
        container.innerHTML = currentClient.exerciseData.presentGapFuture.aiCoachNotes.map(msg => `
            <div class="ai-message ${msg.role}">
                <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                <div class="message-content">
                    <div class="message-text">${escapeHtml(msg.content)}</div>
                    <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
            </div>
        `).join('');
    }

    // Save
    await saveClient(currentClient);
};

window.savePresentGapFuture = async function() {
    if (!currentClient) return;

    const data = {
        present: Array(10).fill(null).map((_, i) => $('#present-' + i)?.value || ''),
        gap: Array(9).fill(null).map((_, i) => $('#gap-' + i)?.value || ''),
        future: Array(11).fill(null).map((_, i) => $('#future-' + i)?.value || ''),
        gapFillIn: Array(4).fill(null).map((_, i) => $('#gap-fill-' + i)?.value || ''),
        evaluations: {
            experience: $('#pgf-eval-experience')?.value || '',
            insights: $('#pgf-eval-insights')?.value || '',
            stoodOut: $('#pgf-eval-stood-out')?.value || '',
            future23Years: $('#pgf-eval-future')?.value || '',
            next24Hours: $('#pgf-eval-24hours')?.value || ''
        },
        sessionNotes: $('#pgf-session-notes')?.value || '',
        aiCoachNotes: currentClient.exerciseData?.presentGapFuture?.aiCoachNotes || []
    };

    currentClient.exerciseData.presentGapFuture = data;

    // Update client dream if answer to last question (11th) confirms dream
    const dreamConfirmation = data.future[10]; // Index 10 = "Do you still agree with your dream?"
    if (dreamConfirmation && dreamConfirmation.trim().toLowerCase().includes('yes')) {
        // Keep the dream from Step 1
        const dreamFromStep1 = currentClient.exerciseData?.fourQuadrant?.dreamSummary;
        if (dreamFromStep1) {
            currentClient.dream = dreamFromStep1.trim();
        }
    }

    await saveClient(currentClient);
    alert('✓ Progress saved successfully!');
};

window.completePresentGapFuture = async function() {
    await savePresentGapFuture();

    // Mark step 2 as complete and move to step 3
    if (!currentClient.journeyProgress) {
        currentClient.journeyProgress = {
            currentStep: 3,
            completedSteps: [2],
            stepNotes: {},
            stepCompletionDates: {}
        };
    } else {
        if (!currentClient.journeyProgress.completedSteps.includes(2)) {
            currentClient.journeyProgress.completedSteps.push(2);
        }
        currentClient.journeyProgress.currentStep = 3;
        currentClient.journeyProgress.stepCompletionDates[2] = new Date().toISOString();
    }

    await saveClient(currentClient);
    alert('✓ Step 2 completed! Moving to Step 3...');

    // Return to journey tracker
    import('./journey-ui.js').then(module => {
        module.renderJourneyTracker(currentClient, 'journey-container');
    });
};

// Flight Plan Exercise Functions
window.sendAIMessageFP = async function() {
    const input = $('#ai-input-fp');
    if (!input || !input.value.trim()) return;

    const message = input.value.trim();
    input.value = '';

    // Initialize AI chat if not exists
    if (!currentClient.exerciseData.flightPlan.aiCoachNotes) {
        currentClient.exerciseData.flightPlan.aiCoachNotes = [];
    }

    // Add user message
    currentClient.exerciseData.flightPlan.aiCoachNotes.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    // Simulate AI response
    const aiResponse = `Based on the Flight Plan:

• Client: ${currentClient.name}
• Language: ${currentClient.preferred_lang}
• Dream: ${currentClient.dream || 'Not yet defined'}

Regarding: "${message}"

The Flight Plan visualizes the journey from current reality to dream achievement through actionable steps. The 1% Rule ensures consistent progress. Would you like me to help refine the flight plan steps or suggest implementation strategies?`;

    // Add AI response
    currentClient.exerciseData.flightPlan.aiCoachNotes.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date().toISOString()
    });

    // Re-render chat
    const container = document.getElementById('ai-chat-fp');
    if (container) {
        container.innerHTML = currentClient.exerciseData.flightPlan.aiCoachNotes.map(msg => `
            <div class="ai-message ${msg.role}">
                <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                <div class="message-content">
                    <div class="message-text">${escapeHtml(msg.content)}</div>
                    <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
            </div>
        `).join('');
    }

    // Save
    await saveClient(currentClient);
};

window.calculateOnePercent = function() {
    const timelineNumber = parseFloat($('#timeline-number')?.value) || 0;
    const timelineUnit = $('#timeline-unit')?.value || 'years';

    let totalDays = 0;
    if (timelineUnit === 'years') {
        totalDays = timelineNumber * 365;
    } else {
        totalDays = timelineNumber * 30; // Approximate month as 30 days
    }

    const onePercentDays = Math.round(totalDays * 0.01);

    // Update display
    const totalDaysEl = $('#total-days');
    const onePercentDaysEl = $('#one-percent-days');

    if (totalDaysEl) totalDaysEl.textContent = totalDays;
    if (onePercentDaysEl) {
        onePercentDaysEl.textContent = onePercentDays;
        // Update the reminder text
        const parent = onePercentDaysEl.closest('#calculation-result');
        if (parent) {
            const reminderText = parent.querySelector('div:last-child');
            if (reminderText) {
                reminderText.textContent = `Every ${onePercentDays} days, implement a small step towards your dream`;
            }
        }
    }
};

window.saveFlightPlan = async function() {
    if (!currentClient) return;

    const timelineNumber = $('#timeline-number')?.value || '';
    const timelineUnit = $('#timeline-unit')?.value || 'years';

    let totalDays = 0;
    if (timelineNumber) {
        totalDays = timelineUnit === 'years' ? timelineNumber * 365 : timelineNumber * 30;
    }
    const onePercentDays = Math.round(totalDays * 0.01);

    const data = {
        timelineNumber: timelineNumber,
        timelineUnit: timelineUnit,
        totalDays: totalDays,
        onePercentDays: onePercentDays,
        flightPlanItems: Array(5).fill(null).map((_, i) => $('#flight-item-' + i)?.value || ''),
        evaluations: {
            experience: $('#fp-eval-experience')?.value || '',
            insights: $('#fp-eval-insights')?.value || '',
            stoodOut: $('#fp-eval-stood-out')?.value || '',
            future23Years: $('#fp-eval-future')?.value || '',
            next24Hours: $('#fp-eval-24hours')?.value || ''
        },
        sessionNotes: $('#fp-session-notes')?.value || '',
        aiCoachNotes: currentClient.exerciseData?.flightPlan?.aiCoachNotes || []
    };

    currentClient.exerciseData.flightPlan = data;
    await saveClient(currentClient);
    alert('✓ Progress saved successfully!');
};

window.completeFlightPlan = async function() {
    await saveFlightPlan();

    // Mark step 3 as complete and move to step 4
    if (!currentClient.journeyProgress) {
        currentClient.journeyProgress = {
            currentStep: 4,
            completedSteps: [3],
            stepNotes: {},
            stepCompletionDates: {}
        };
    } else {
        if (!currentClient.journeyProgress.completedSteps.includes(3)) {
            currentClient.journeyProgress.completedSteps.push(3);
        }
        currentClient.journeyProgress.currentStep = 4;
        currentClient.journeyProgress.stepCompletionDates[3] = new Date().toISOString();
    }

    await saveClient(currentClient);
    alert('✓ Step 3 completed! Moving to Step 4...');

    // Return to journey tracker
    import('./journey-ui.js').then(module => {
        module.renderJourneyTracker(currentClient, 'journey-container');
    });
};

// Deep Dive Exercise Functions
window.addDeepDiveRow = function() {
    if (!currentClient || !currentClient.exerciseData.deepDive) return;

    currentClient.exerciseData.deepDive.deepDiveItems.push({ question: '', answer: '' });

    // Re-render the exercise
    import('./journey-exercises.js').then(module => {
        module.renderExercise(currentClient, 4, 'journey-container');
    });
};

window.removeDeepDiveRow = function(index) {
    if (!currentClient || !currentClient.exerciseData.deepDive) return;
    if (currentClient.exerciseData.deepDive.deepDiveItems.length <= 7) {
        alert('Minimum of 7 rows required');
        return;
    }

    currentClient.exerciseData.deepDive.deepDiveItems.splice(index, 1);

    // Re-render the exercise
    import('./journey-exercises.js').then(module => {
        module.renderExercise(currentClient, 4, 'journey-container');
    });
};

window.sendAIMessageDD = async function() {
    const input = $('#ai-input-dd');
    if (!input || !input.value.trim()) return;

    const message = input.value.trim();
    input.value = '';

    // Initialize AI chat if not exists
    if (!currentClient.exerciseData.deepDive.aiCoachNotes) {
        currentClient.exerciseData.deepDive.aiCoachNotes = [];
    }

    // Add user message
    currentClient.exerciseData.deepDive.aiCoachNotes.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    // Simulate AI response
    const aiResponse = `Based on the Deep Dive exploration:

• Client: ${currentClient.name}
• Language: ${currentClient.preferred_lang}
• Dream: ${currentClient.dream || 'Not yet defined'}

Regarding: "${message}"

The Deep Dive process uncovers the core values and motivations behind the dream. By repeatedly asking "What is most important?", we help clients discover their deepest drivers. Would you like me to suggest coaching strategies or analyze the patterns emerging?`;

    // Add AI response
    currentClient.exerciseData.deepDive.aiCoachNotes.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date().toISOString()
    });

    // Re-render chat
    const container = document.getElementById('ai-chat-dd');
    if (container) {
        container.innerHTML = currentClient.exerciseData.deepDive.aiCoachNotes.map(msg => `
            <div class="ai-message ${msg.role}">
                <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                <div class="message-content">
                    <div class="message-text">${escapeHtml(msg.content)}</div>
                    <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
            </div>
        `).join('');
    }

    // Save
    await saveClient(currentClient);
};

window.saveDeepDive = async function() {
    if (!currentClient) return;

    const deepDiveItems = currentClient.exerciseData.deepDive.deepDiveItems.map((item, i) => ({
        question: `What is most important${i > 0 ? ' about that' : ''}?`,
        answer: $(`#dd-answer-${i}`)?.value || ''
    }));

    const data = {
        deepDiveItems: deepDiveItems,
        evaluations: {
            experience: $('#dd-eval-experience')?.value || '',
            insights: $('#dd-eval-insights')?.value || '',
            stoodOut: $('#dd-eval-stood-out')?.value || '',
            future23Years: $('#dd-eval-future')?.value || '',
            next24Hours: $('#dd-eval-24hours')?.value || ''
        },
        sessionNotes: $('#dd-session-notes')?.value || '',
        aiCoachNotes: currentClient.exerciseData?.deepDive?.aiCoachNotes || []
    };

    currentClient.exerciseData.deepDive = data;
    await saveClient(currentClient);
    alert('✓ Progress saved successfully!');
};

window.completeDeepDive = async function() {
    await saveDeepDive();

    // Mark step 4 as complete and move to step 5
    if (!currentClient.journeyProgress) {
        currentClient.journeyProgress = {
            currentStep: 5,
            completedSteps: [4],
            stepNotes: {},
            stepCompletionDates: {}
        };
    } else {
        if (!currentClient.journeyProgress.completedSteps.includes(4)) {
            currentClient.journeyProgress.completedSteps.push(4);
        }
        currentClient.journeyProgress.currentStep = 5;
        currentClient.journeyProgress.stepCompletionDates[4] = new Date().toISOString();
    }

    await saveClient(currentClient);
    alert('✓ Step 4 completed! Moving to Step 5...');

    // Return to journey tracker
    import('./journey-ui.js').then(module => {
        module.renderJourneyTracker(currentClient, 'journey-container');
    });
};

// ===== STEP 5: ECOCHART FUNCTIONS =====

window.addEcochartBlock = function() {
    if (!currentClient || !currentClient.exerciseData.ecochart) return;

    currentClient.exerciseData.ecochart.blocks.push({ name: '', give: 0, take: 0 });

    // Re-render the exercise
    import('./journey-exercises.js').then(module => {
        module.renderExercise(currentClient, 5, 'journey-container');
    });
};

window.removeEcochartBlock = function(index) {
    if (!currentClient || !currentClient.exerciseData.ecochart) return;
    if (currentClient.exerciseData.ecochart.blocks.length <= 4) {
        alert('Minimum of 4 blocks required');
        return;
    }

    currentClient.exerciseData.ecochart.blocks.splice(index, 1);

    // Re-render the exercise
    import('./journey-exercises.js').then(module => {
        module.renderExercise(currentClient, 5, 'journey-container');
    });
};

window.updateEcochartTotals = function() {
    if (!currentClient || !currentClient.exerciseData.ecochart) return;

    // Get all block values
    const blocks = currentClient.exerciseData.ecochart.blocks;
    let totalGive = 0;
    let totalTake = 0;

    blocks.forEach((block, i) => {
        const giveInput = document.getElementById(`block-give-${i}`);
        const takeInput = document.getElementById(`block-take-${i}`);

        const giveValue = parseFloat(giveInput?.value || 0);
        const takeValue = parseFloat(takeInput?.value || 0);

        totalGive += giveValue;
        totalTake += takeValue;
    });

    const grandTotal = totalGive + totalTake;

    // Update summary totals
    const totalGiveElem = document.getElementById('total-give');
    const totalTakeElem = document.getElementById('total-take');

    if (totalGiveElem) totalGiveElem.textContent = totalGive;
    if (totalTakeElem) totalTakeElem.textContent = totalTake;

    // Calculate percentages
    let givePercent = 0;
    let takePercent = 0;
    if (grandTotal > 0) {
        givePercent = Math.round((totalGive / grandTotal) * 100);
        takePercent = Math.round((totalTake / grandTotal) * 100);
    }

    // Update dashboard bars
    const giveBar = document.querySelector('.give-bar');
    const takeBar = document.querySelector('.take-bar');
    const givePercentElems = document.querySelectorAll('.dashboard-percent');

    if (giveBar) giveBar.style.width = givePercent + '%';
    if (takeBar) takeBar.style.width = takePercent + '%';

    if (givePercentElems[0]) givePercentElems[0].textContent = givePercent + '%';
    if (givePercentElems[1]) givePercentElems[1].textContent = takePercent + '%';

    // Update insight
    const insightElem = document.querySelector('.dashboard-insight');
    if (insightElem) {
        if (givePercent > 60) {
            insightElem.textContent = '💚 You are giving more than you take - ensure you\'re not depleting yourself';
        } else if (takePercent > 60) {
            insightElem.textContent = '❤️ You are taking more than you give - consider how you can contribute more';
        } else {
            insightElem.textContent = '⚖️ You have a balanced ecosystem - well done!';
        }
    }
};

window.saveEcochart = async function() {
    if (!currentClient || !currentClient.exerciseData.ecochart) return;

    // Collect all block data
    const blocks = currentClient.exerciseData.ecochart.blocks.map((block, i) => ({
        name: $('#block-name-' + i)?.value || '',
        give: parseFloat($('#block-give-' + i)?.value || 0),
        take: parseFloat($('#block-take-' + i)?.value || 0)
    }));

    const data = {
        blocks: blocks,
        evaluations: {
            experience: $('#eco-eval-experience')?.value || '',
            insights: $('#eco-eval-insights')?.value || '',
            stoodOut: $('#eco-eval-stood-out')?.value || '',
            future23Years: $('#eco-eval-future')?.value || '',
            next24Hours: $('#eco-eval-24hours')?.value || ''
        },
        sessionNotes: $('#eco-session-notes')?.value || '',
        aiCoachNotes: currentClient.exerciseData?.ecochart?.aiCoachNotes || []
    };

    currentClient.exerciseData.ecochart = data;
    await saveClient(currentClient);
    alert('✓ Progress saved successfully!');
};

window.completeEcochart = async function() {
    await saveEcochart();

    // Mark step 5 as complete and move to step 6
    if (!currentClient.journeyProgress) {
        currentClient.journeyProgress = {
            currentStep: 6,
            completedSteps: [5],
            stepNotes: {},
            stepCompletionDates: {}
        };
    } else {
        if (!currentClient.journeyProgress.completedSteps.includes(5)) {
            currentClient.journeyProgress.completedSteps.push(5);
        }
        currentClient.journeyProgress.currentStep = 6;
        currentClient.journeyProgress.stepCompletionDates[5] = new Date().toISOString();
    }

    await saveClient(currentClient);
    alert('✓ Step 5 completed! Moving to Step 6...');

    // Return to journey tracker
    import('./journey-ui.js').then(module => {
        module.renderJourneyTracker(currentClient, 'journey-container');
    });
};

window.sendAIMessageEco = async function() {
    const input = $('#ai-input-eco');
    if (!input || !input.value.trim()) return;

    const message = input.value.trim();
    input.value = '';

    if (!currentClient.exerciseData.ecochart.aiCoachNotes) {
        currentClient.exerciseData.ecochart.aiCoachNotes = [];
    }

    currentClient.exerciseData.ecochart.aiCoachNotes.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    // Simulate AI response
    const aiResponse = `Based on your Ecochart analysis, I notice ${
        message.toLowerCase().includes('balance') ? 'you\'re exploring the balance between giving and taking in your relationships. This is crucial for sustainable success.' :
        message.toLowerCase().includes('give') ? 'giving is an important part of your ecosystem. Make sure you\'re also receiving adequate support.' :
        message.toLowerCase().includes('take') ? 'understanding what you take from relationships helps identify areas of dependency and support.' :
        'you\'re mapping your relationship ecosystem. This visual representation helps identify imbalances and opportunities for growth.'
    }`;

    currentClient.exerciseData.ecochart.aiCoachNotes.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date().toISOString()
    });

    // Re-render chat
    const container = document.getElementById('ai-chat-eco');
    if (container) {
        container.innerHTML = currentClient.exerciseData.ecochart.aiCoachNotes.map(msg => `
            <div class="ai-message ${msg.role}">
                <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                <div class="message-content">
                    <div class="message-text">${escapeHtml(msg.content)}</div>
                    <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
            </div>
        `).join('');
        container.scrollTop = container.scrollHeight;
    }

    await saveClient(currentClient);
};

// ===== STEP 6: ASSESSMENTS FUNCTIONS =====

window.updateAssessmentBars = function() {
    if (!currentClient || !currentClient.exerciseData.assessments) return;

    // Update all bar charts dynamically
    const inputs = document.querySelectorAll('.assessment-input');
    inputs.forEach(input => {
        const value = parseFloat(input.value) || 0;
        const id = input.id;

        // Find corresponding bar
        const barFill = input.nextElementSibling?.querySelector('.bar-fill');
        const barValue = input.nextElementSibling?.querySelector('.bar-value');

        if (barFill) barFill.style.width = value + '%';
        if (barValue) barValue.textContent = value + '%';
    });

    // Update total scores
    const posTotal = (parseFloat($('#pos-expectation')?.value || 0)) +
                     (parseFloat($('#pos-achievement')?.value || 0)) +
                     (parseFloat($('#pos-satisfaction')?.value || 0));

    const negTotal = (parseFloat($('#neg-frustration')?.value || 0)) +
                     (parseFloat($('#neg-helplessness')?.value || 0)) +
                     (parseFloat($('#neg-stress')?.value || 0));

    const selfTotal = (parseFloat($('#self-insecurity')?.value || 0)) +
                      (parseFloat($('#self-guilt')?.value || 0)) +
                      (parseFloat($('#self-worth')?.value || 0));

    const emoTotal = (parseFloat($('#emo-thoughts')?.value || 0)) +
                     (parseFloat($('#emo-paranoia')?.value || 0)) +
                     (parseFloat($('#emo-anxiety')?.value || 0)) +
                     (parseFloat($('#emo-dependency')?.value || 0)) +
                     (parseFloat($('#emo-senselessness')?.value || 0)) +
                     (parseFloat($('#emo-memory')?.value || 0)) +
                     (parseFloat($('#emo-suicidal')?.value || 0));

    const flowTotal = (parseFloat($('#flow-perseverance')?.value || 0)) +
                      (parseFloat($('#flow-passion')?.value || 0)) +
                      (parseFloat($('#flow-focus')?.value || 0)) +
                      (parseFloat($('#flow-mastery')?.value || 0));

    // Update total score displays
    const totals = document.querySelectorAll('.total-score');
    if (totals[0]) totals[0].textContent = posTotal;
    if (totals[1]) totals[1].textContent = negTotal;
    if (totals[2]) totals[2].textContent = selfTotal;
    if (totals[3]) totals[3].textContent = emoTotal;
    if (totals[4]) totals[4].textContent = flowTotal;
};

window.saveAssessments = async function() {
    if (!currentClient || !currentClient.exerciseData.assessments) return;

    const data = {
        positivePsychoSocial: {
            expectation: parseFloat($('#pos-expectation')?.value || 0),
            achievement: parseFloat($('#pos-achievement')?.value || 0),
            satisfaction: parseFloat($('#pos-satisfaction')?.value || 0)
        },
        negativePsychoSocial: {
            frustration: parseFloat($('#neg-frustration')?.value || 0),
            helplessness: parseFloat($('#neg-helplessness')?.value || 0),
            stress: parseFloat($('#neg-stress')?.value || 0)
        },
        selfPerception: {
            innerInsecurity: parseFloat($('#self-insecurity')?.value || 0),
            guiltFeelings: parseFloat($('#self-guilt')?.value || 0),
            lackOfSelfWorth: parseFloat($('#self-worth')?.value || 0)
        },
        emotionalFunctioning: {
            disturbingThoughts: parseFloat($('#emo-thoughts')?.value || 0),
            paranoia: parseFloat($('#emo-paranoia')?.value || 0),
            anxiety: parseFloat($('#emo-anxiety')?.value || 0),
            dependency: parseFloat($('#emo-dependency')?.value || 0),
            senselessnessOfExistence: parseFloat($('#emo-senselessness')?.value || 0),
            memoryLoss: parseFloat($('#emo-memory')?.value || 0),
            suicidalThoughts: parseFloat($('#emo-suicidal')?.value || 0)
        },
        flowStateQualities: {
            perseverance: parseFloat($('#flow-perseverance')?.value || 0),
            passion: parseFloat($('#flow-passion')?.value || 0),
            focus: parseFloat($('#flow-focus')?.value || 0),
            mastery: parseFloat($('#flow-mastery')?.value || 0)
        },
        evaluations: {
            experience: $('#assess-eval-experience')?.value || '',
            insights: $('#assess-eval-insights')?.value || '',
            stoodOut: $('#assess-eval-stood-out')?.value || '',
            future23Years: $('#assess-eval-future')?.value || '',
            next24Hours: $('#assess-eval-24hours')?.value || ''
        },
        sessionNotes: $('#assess-session-notes')?.value || '',
        aiCoachNotes: currentClient.exerciseData?.assessments?.aiCoachNotes || []
    };

    currentClient.exerciseData.assessments = data;
    await saveClient(currentClient);
    alert('✓ Assessment scores saved successfully!');
};

window.completeAssessments = async function() {
    await saveAssessments();

    // Mark step 6 as complete and move to step 7
    if (!currentClient.journeyProgress) {
        currentClient.journeyProgress = {
            currentStep: 7,
            completedSteps: [6],
            stepNotes: {},
            stepCompletionDates: {}
        };
    } else {
        if (!currentClient.journeyProgress.completedSteps.includes(6)) {
            currentClient.journeyProgress.completedSteps.push(6);
        }
        currentClient.journeyProgress.currentStep = 7;
        currentClient.journeyProgress.stepCompletionDates[6] = new Date().toISOString();
    }

    await saveClient(currentClient);
    alert('✓ Step 6 completed! Moving to Step 7 (The Dashboard)...');

    // Return to journey tracker
    import('./journey-ui.js').then(module => {
        module.renderJourneyTracker(currentClient, 'journey-container');
    });
};

window.sendAIMessageAssess = async function() {
    const input = $('#ai-input-assess');
    if (!input || !input.value.trim()) return;

    const message = input.value.trim();
    input.value = '';

    if (!currentClient.exerciseData.assessments.aiCoachNotes) {
        currentClient.exerciseData.assessments.aiCoachNotes = [];
    }

    currentClient.exerciseData.assessments.aiCoachNotes.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    // Simulate AI response with assessment context
    const aiResponse = `Based on the assessment results, I notice ${
        message.toLowerCase().includes('positive') ? 'the positive psycho-social functioning scores show areas of strength and growth potential.' :
        message.toLowerCase().includes('negative') ? 'the negative psycho-social functioning indicators suggest areas that need attention and support.' :
        message.toLowerCase().includes('flow') ? 'the flow state qualities reveal the client\'s capacity for peak performance and engagement.' :
        'the comprehensive assessment provides valuable insights into multiple dimensions of psychological functioning.'
    }`;

    currentClient.exerciseData.assessments.aiCoachNotes.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date().toISOString()
    });

    // Re-render chat
    const container = document.getElementById('ai-chat-assess');
    if (container) {
        container.innerHTML = currentClient.exerciseData.assessments.aiCoachNotes.map(msg => `
            <div class="ai-message ${msg.role}">
                <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
                <div class="message-content">
                    <div class="message-text">${escapeHtml(msg.content)}</div>
                    <div class="message-time">${new Date(msg.timestamp).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
            </div>
        `).join('');
        container.scrollTop = container.scrollHeight;
    }

    await saveClient(currentClient);
};

// ===== STEP 9: MLNP FUNCTIONS =====

let currentEmotionWork = null;

window.startMLNPSession = function() {
    const grid = $('#mlnp-emotion-grid');
    const startBtn = document.querySelector('.mlnp-start-section');
    const history = $('#mlnp-history');

    if (grid) grid.style.display = 'block';
    if (startBtn) startBtn.style.display = 'none';
    if (history) history.style.display = 'block';

    // Initialize first session
    if (!currentClient.exerciseData.mlnp.sessions) {
        currentClient.exerciseData.mlnp.sessions = [];
    }
};

window.openEmotionWindow = function(emotionId, emotionName, emotionEmoji) {
    const modal = $('#emotion-modal');
    const modalEmoji = $('#modal-emoji');
    const modalName = $('#modal-emotion-name');

    if (modal) {
        modal.style.display = 'flex';
        if (modalEmoji) modalEmoji.textContent = emotionEmoji;
        if (modalName) modalName.textContent = emotionName;

        // Initialize current emotion work
        currentEmotionWork = {
            emotionId,
            emotionName,
            emotionEmoji,
            timestamp: new Date().toISOString()
        };

        // Clear previous inputs
        const inputs = ['modal-triggers', 'modal-body-sensations', 'modal-thoughts', 'modal-responses', 'modal-new-response'];
        inputs.forEach(id => {
            const elem = $(`#${id}`);
            if (elem) elem.value = '';
        });
    }
};

window.closeEmotionWindow = function() {
    const modal = $('#emotion-modal');
    if (modal) modal.style.display = 'none';
    currentEmotionWork = null;
};

window.backToEmotionGrid = function() {
    closeEmotionWindow();
};

window.saveEmotionWork = async function() {
    if (!currentEmotionWork) return;

    const emotionData = {
        ...currentEmotionWork,
        triggers: $('#modal-triggers')?.value || '',
        bodySensations: $('#modal-body-sensations')?.value || '',
        thoughts: $('#modal-thoughts')?.value || '',
        responses: $('#modal-responses')?.value || '',
        newResponse: $('#modal-new-response')?.value || '',
        savedAt: new Date().toISOString()
    };

    // Add to sessions
    if (!currentClient.exerciseData.mlnp.sessions) {
        currentClient.exerciseData.mlnp.sessions = [];
    }
    currentClient.exerciseData.mlnp.sessions.push(emotionData);

    await saveClient(currentClient);
    alert(`✓ Work on "${currentEmotionWork.emotionName}" saved successfully!`);

    // Update history display
    renderSessionHistory();

    // Close modal
    closeEmotionWindow();
};

window.renderSessionHistory = function() {
    const historyList = $('#session-history-list');
    if (!historyList) return;

    const sessions = currentClient.exerciseData.mlnp.sessions || [];

    if (sessions.length === 0) {
        historyList.innerHTML = '<p style="color: #94a3b8;">No emotions explored yet. Click on emotion faces above to start.</p>';
        return;
    }

    historyList.innerHTML = sessions.map((session, index) => `
        <div class="session-history-item">
            <div class="history-header">
                <span class="history-emoji">${session.emotionEmoji}</span>
                <strong>${session.emotionName}</strong>
                <span class="history-date">${new Date(session.savedAt).toLocaleDateString()}</span>
            </div>
            <div class="history-details">
                <p><strong>Triggers:</strong> ${session.triggers.substring(0, 100)}${session.triggers.length > 100 ? '...' : ''}</p>
                <p><strong>New Response:</strong> ${session.newResponse.substring(0, 100)}${session.newResponse.length > 100 ? '...' : ''}</p>
            </div>
        </div>
    `).join('');
};

window.saveMLNP = async function() {
    const data = {
        sessions: currentClient.exerciseData.mlnp.sessions || [],
        evaluations: {
            experience: $('#mlnp-eval-experience')?.value || '',
            insights: $('#mlnp-eval-insights')?.value || '',
            stoodOut: $('#mlnp-eval-stood-out')?.value || '',
            future23Years: $('#mlnp-eval-future')?.value || '',
            next24Hours: $('#mlnp-eval-next24')?.value || ''
        },
        sessionNotes: $('#mlnp-session-notes')?.value || '',
        aiCoachNotes: currentClient.exerciseData.mlnp.aiCoachNotes || []
    };

    currentClient.exerciseData.mlnp = data;
    await saveClient(currentClient);
    alert('✓ MLNP progress saved successfully!');
};

window.completeMLNP = async function() {
    await saveMLNP();

    // Mark step 10 complete
    if (!currentClient.journeyProgress.completedSteps.includes(10)) {
        currentClient.journeyProgress.completedSteps.push(10);
    }
    currentClient.journeyProgress.currentStep = 11;
    currentClient.journeyProgress.stepCompletionDates[10] = new Date().toISOString();

    await saveClient(currentClient);
    alert('✓ Step 10 completed! Moving to Step 11 (Reassess)...');

    // Return to journey tracker
    import('./journey-ui.js').then(module => {
        module.renderJourneyTracker(currentClient, 'journey-container');
    });
};

window.sendAIMessageMLNP = async function() {
    const input = $('#ai-input-mlnp');
    if (!input) return;

    const message = input.value.trim();
    if (!message) return;

    // Initialize AI notes if needed
    if (!currentClient.exerciseData.mlnp.aiCoachNotes) {
        currentClient.exerciseData.mlnp.aiCoachNotes = [];
    }

    // Add user message
    currentClient.exerciseData.mlnp.aiCoachNotes.push({
        role: 'user',
        content: message,
        timestamp: new Date().toISOString()
    });

    // Simulate AI response based on MLNP context
    let aiResponse = '';
    const sessionCount = currentClient.exerciseData.mlnp.sessions?.length || 0;

    if (message.toLowerCase().includes('pattern') || message.toLowerCase().includes('notice')) {
        aiResponse = `Based on your ${sessionCount} emotion exploration(s), I notice you're becoming more aware of your emotional patterns. This awareness is the first step in rewiring neural pathways. What specific pattern would you like to shift?`;
    } else if (message.toLowerCase().includes('trigger')) {
        aiResponse = `Triggers are powerful indicators of unprocessed emotions or unmet needs. By identifying your triggers, you're giving yourself the power to choose new responses. What trigger feels most important to work with right now?`;
    } else if (message.toLowerCase().includes('body') || message.toLowerCase().includes('sensation')) {
        aiResponse = `Your body is an incredible messenger. Physical sensations are often the first signal of an emotion. By tuning into these body sensations, you're developing interoceptive awareness - a key skill in emotional regulation.`;
    } else {
        aiResponse = `That's a valuable reflection. Through MLNP, you're creating new neural pathways by consciously choosing different responses to emotions. Each time you practice this, you strengthen these new pathways. What emotion would you like to explore next?`;
    }

    currentClient.exerciseData.mlnp.aiCoachNotes.push({
        role: 'assistant',
        content: aiResponse,
        timestamp: new Date().toISOString()
    });

    // Re-render chat
    const chatContainer = $('#mlnp-ai-chat');
    if (chatContainer) {
        chatContainer.innerHTML = renderAIChat(currentClient.exerciseData.mlnp.aiCoachNotes);
    }

    // Clear input and save
    input.value = '';
    await saveClient(currentClient);
};

