// Helper functions for journey exercises
import { $, escapeHtml } from './config.js';
import { saveClient } from './storage.js';
import { BASIS_QUESTIONS, SECTION_LABELS } from './basis-assessment.js';
import { api } from './api.js';

// Global current client reference
let currentClient = null;

function getInputValue(selector) {
    const el = $(selector);
    return el ? el.value : undefined;
}

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
        painsAndFrustrations: getInputValue('#q-pains') || '',
        goalsAndDesires: getInputValue('#q-goals') || '',
        fearsAndImplications: getInputValue('#q-fears') || '',
        dreamsAndAspirations: getInputValue('#q-dreams') || '',
        dreamSummary: getInputValue('#dream-summary') || '',
        our1Percent: getInputValue('#our-1-percent') || '',
        evaluations: {
            experience: getInputValue('#eval-experience') || '',
            insights: getInputValue('#eval-insights') || '',
            stoodOut: getInputValue('#eval-stood-out') || '',
            future23Years: getInputValue('#eval-future') || '',
            next24Hours: getInputValue('#eval-24hours') || ''
        },
        sessionNotes: getInputValue('#session-notes') || '',
        aiCoachNotes: (((currentClient.exerciseData || {}).fourQuadrant || {}).aiCoachNotes) || []
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
    if (!currentClient.journeyProgress || typeof currentClient.journeyProgress !== 'object') {
        currentClient.journeyProgress = {};
    }
    const jp1 = currentClient.journeyProgress;
    if (!Array.isArray(jp1.completedSteps)) jp1.completedSteps = [];
    if (!jp1.stepNotes) jp1.stepNotes = {};
    if (!jp1.stepCompletionDates) jp1.stepCompletionDates = {};
    if (!jp1.completedSteps.includes(1)) {
        jp1.completedSteps.push(1);
    }
    jp1.currentStep = 2;
    jp1.stepCompletionDates[1] = new Date().toISOString();

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

// ---------------------------------------------------------------------------
// BASIS Answers Appendix — for coach-mode PDF only
// ---------------------------------------------------------------------------

function buildBasisAnswersHTML(client) {
    const answers = client.basisAnswers || {};
    const results = client.basisResults || {};
    const sectionScores = results.sectionScores || {};
    const basisOrder = results.basisOrder || [];

    if (Object.keys(answers).length === 0) return '';

    const SECTION_KEYS = ['BALANS', 'AKSIE', 'SORG', 'INSIG', 'STRUKTUUR'];

    let html = `
        <div class="basis-answers-appendix" style="margin-top: 40px; border-top: 3px solid #7c3aed; padding-top: 20px;">
            <h2 style="color: #7c3aed; margin-bottom: 16px;">📋 BASIS Assessment — Individual Answers</h2>
    `;

    if (basisOrder.length > 0) {
        html += `
            <div style="background: #f5f3ff; border: 2px solid #7c3aed; border-radius: 8px; padding: 14px; margin-bottom: 24px;">
                <strong style="color: #5b21b6; display: block; margin-bottom: 6px;">BASIS Order (Highest → Lowest Adjusted Score):</strong>
                <div style="font-size: 15px; font-weight: 700; color: #4c1d95;">
                    ${basisOrder.map((s, i) => {
                        const score = sectionScores[s] !== undefined ? sectionScores[s].toFixed(1) : '—';
                        return `${i + 1}. ${SECTION_LABELS[s] || s} (${score})`;
                    }).join(' &rarr; ')}
                </div>
            </div>
        `;
    }

    SECTION_KEYS.forEach(section => {
        const questions = BASIS_QUESTIONS[section] || [];
        const sectionLabel = SECTION_LABELS[section] || section;
        const sectionScore = sectionScores[section] !== undefined ? sectionScores[section].toFixed(1) : '—';
        const orderRank = basisOrder.indexOf(section);
        const rankLabel = orderRank >= 0 ? ` | Rank #${orderRank + 1}` : '';

        html += `
            <div style="margin-bottom: 28px; page-break-inside: avoid;">
                <div style="background: #ede9fe; padding: 8px 14px; border-radius: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-weight: 700; font-size: 14px; color: #5b21b6;">${sectionLabel}</span>
                    <span style="font-size: 12px; color: #7c3aed; font-weight: 600;">Score: ${sectionScore}/10${rankLabel}</span>
                </div>
                <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                    <thead>
                        <tr style="background: #f5f3ff;">
                            <th style="text-align: center; padding: 6px 8px; border: 1px solid #d8b4fe; width: 34px; color: #5b21b6;">#</th>
                            <th style="text-align: left; padding: 6px 8px; border: 1px solid #d8b4fe; color: #5b21b6;">Question</th>
                            <th style="text-align: center; padding: 6px 8px; border: 1px solid #d8b4fe; width: 64px; color: #5b21b6;">Raw</th>
                            <th style="text-align: center; padding: 6px 8px; border: 1px solid #d8b4fe; width: 74px; color: #5b21b6;">Adjusted</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${questions.map(q => {
                            const key = `${section}_${q.id}`;
                            const raw = answers[key];
                            const hasAnswer = raw !== undefined && raw !== null;
                            const rawDisplay = hasAnswer ? raw : '—';
                            const adjustedDisplay = hasAnswer ? (q.reverse ? 11 - raw : raw) : '—';
                            const rowStyle = hasAnswer ? '' : 'background: #fef9c3;';
                            const reverseTag = ''; // reverse label intentionally not shown in client/coach view
                            return `
                                <tr style="${rowStyle}">
                                    <td style="padding: 5px 8px; border: 1px solid #e2e8f0; text-align: center; color: #94a3b8;">${q.id}</td>
                                    <td style="padding: 5px 8px; border: 1px solid #e2e8f0;">${escapeHtml(q.text)}${reverseTag}</td>
                                    <td style="padding: 5px 8px; border: 1px solid #e2e8f0; text-align: center; font-weight: 600; color: #334155;">${rawDisplay}</td>
                                    <td style="padding: 5px 8px; border: 1px solid #e2e8f0; text-align: center; font-weight: 700; color: #7c3aed;">${adjustedDisplay}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
    });

    html += `</div>`;
    return html;
}

// ---------------------------------------------------------------------------
// PDF Download — shared across ALL exercise pages
// ---------------------------------------------------------------------------

window.showPDFDownloadModal = function() {
    const existing = document.getElementById('pdf-mode-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'pdf-mode-modal';
    modal.innerHTML = `
        <div class="pdf-modal-backdrop" onclick="closePDFModal()"></div>
        <div class="pdf-modal-box">
            <h3 class="pdf-modal-title">📄 Download PDF Report</h3>
            <p class="pdf-modal-subtitle">Choose what to include:</p>
            <div class="pdf-modal-options">
                <button class="pdf-modal-btn pdf-modal-btn--client" onclick="downloadExercisePDF('client')">
                    <span class="pdf-btn-icon">👤</span>
                    <span class="pdf-btn-label">Client Report</span>
                    <span class="pdf-btn-desc">Exercise content only — no session notes or AI discussions</span>
                </button>
                <button class="pdf-modal-btn pdf-modal-btn--coach" onclick="downloadExercisePDF('coach')">
                    <span class="pdf-btn-icon">🎓</span>
                    <span class="pdf-btn-label">Coach Report</span>
                    <span class="pdf-btn-desc">Full report — includes session notes and AI coach discussions</span>
                </button>
            </div>
            <button class="pdf-modal-cancel" onclick="closePDFModal()">Cancel</button>
        </div>
    `;
    document.body.appendChild(modal);
};

window.closePDFModal = function() {
    const modal = document.getElementById('pdf-mode-modal');
    if (modal) modal.remove();
};

window.downloadExercisePDF = function(mode) {
    closePDFModal();

    const exercisePage = document.querySelector('.exercise-page');
    if (!exercisePage) {
        alert('No exercise content found to export.');
        return;
    }

    // Capture live values BEFORE cloning (cloneNode does not copy input.value)
    const liveTextareas = Array.from(exercisePage.querySelectorAll('textarea'));
    const liveInputs    = Array.from(exercisePage.querySelectorAll('input[type="text"], input:not([type])'));
    const liveSelects   = Array.from(exercisePage.querySelectorAll('select'));
    const liveCheckboxes = Array.from(exercisePage.querySelectorAll('input[type="checkbox"]'));

    const clone = exercisePage.cloneNode(true);

    // Replace textareas with readable divs containing the live value
    const clonedTextareas = Array.from(clone.querySelectorAll('textarea'));
    clonedTextareas.forEach((ta, i) => {
        const val = liveTextareas[i] ? liveTextareas[i].value : '';
        const div = document.createElement('div');
        div.className = 'pdf-text-value';
        div.textContent = val;
        ta.parentNode.replaceChild(div, ta);
    });

    // Replace text inputs
    const clonedInputs = Array.from(clone.querySelectorAll('input[type="text"], input:not([type])'));
    clonedInputs.forEach((inp, i) => {
        const val = liveInputs[i] ? liveInputs[i].value : '';
        const div = document.createElement('div');
        div.className = 'pdf-input-value';
        div.textContent = val;
        inp.parentNode.replaceChild(div, inp);
    });

    // Sync select values
    const clonedSelects = Array.from(clone.querySelectorAll('select'));
    clonedSelects.forEach((sel, i) => {
        if (liveSelects[i]) sel.value = liveSelects[i].value;
    });

    // Sync checkboxes
    const clonedCheckboxes = Array.from(clone.querySelectorAll('input[type="checkbox"]'));
    clonedCheckboxes.forEach((cb, i) => {
        if (liveCheckboxes[i]) cb.checked = liveCheckboxes[i].checked;
    });

    // Client mode: strip coach-only sections
    if (mode === 'client') {
        clone.querySelectorAll('.session-notes-section, .ai-coach-section').forEach(el => el.remove());
    }

    // Always strip interactive chrome
    clone.querySelectorAll('.exercise-footer, .exercise-actions, .btn-back, .btn-ai-send, .btn-save-emotion').forEach(el => el.remove());

    // Hide the transformation axis overlay (content is already in the grid cards)
    clone.querySelectorAll('.transformation-axis').forEach(el => el.remove());

    const titleEl = exercisePage.querySelector('h1, .exercise-title');
    const title = titleEl ? titleEl.textContent.trim() : 'Exercise Report';
    const dateStr = new Date().toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
    const modeLabel = mode === 'client' ? '👤 Client Report' : '🎓 Coach Report';

    const printWindow = window.open('', '_blank', 'width=1000,height=800');
    if (!printWindow) {
        alert('Popup blocked. Please allow popups for this site to download PDF reports.');
        return;
    }

    printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)} — ${mode === 'client' ? 'Client' : 'Coach'} Report</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: white;
            color: #1e293b;
            padding: 24px 32px;
            font-size: 14px;
            line-height: 1.6;
        }
        .pdf-report-header {
            background: linear-gradient(135deg, #3b82f6, #8b5cf6);
            color: white;
            padding: 20px 28px;
            border-radius: 10px;
            margin-bottom: 28px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .pdf-report-header h2 { color: white; font-size: 20px; }
        .pdf-report-header .pdf-meta { font-size: 12px; opacity: 0.88; text-align: right; line-height: 1.8; }
        .exercise-page { max-width: 860px; margin: 0 auto; }
        .exercise-header { margin-bottom: 20px; border-bottom: 3px solid #3b82f6; padding-bottom: 14px; }
        .exercise-header h1 { font-size: 24px; color: #1e293b; }
        .exercise-subtitle { color: #64748b; font-size: 14px; margin-top: 4px; }
        .four-quadrants-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            row-gap: 16px;
            margin-bottom: 20px;
        }
        .quadrant-card {
            border: 2px solid #e2e8f0;
            border-radius: 10px;
            padding: 14px;
            background: #f8fafc;
            page-break-inside: avoid;
        }
        .quadrant-title { font-weight: 700; font-size: 14px; margin-bottom: 10px; color: #334155; }
        .quadrant-axis-wrapper { position: static; }
        .transformation-axis { display: none !important; }
        .pdf-text-value {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
            padding: 10px 12px;
            min-height: 48px;
            white-space: pre-wrap;
            font-size: 13px;
            color: #1e293b;
            margin-bottom: 6px;
            width: 100%;
        }
        .pdf-input-value {
            padding: 6px 0;
            font-size: 13px;
            color: #1e293b;
            border-bottom: 1px solid #cbd5e1;
            min-height: 24px;
            margin-bottom: 6px;
            width: 100%;
        }
        .session-notes-section {
            margin-top: 20px;
            padding: 18px;
            background: #f0f9ff;
            border-radius: 10px;
            border-left: 4px solid #0ea5e9;
            page-break-inside: avoid;
        }
        .session-notes-section h3 { color: #0369a1; margin-bottom: 10px; }
        .ai-coach-section {
            margin-top: 20px;
            padding: 18px;
            background: #f0fdf4;
            border-radius: 10px;
            border-left: 4px solid #22c55e;
            page-break-inside: avoid;
        }
        .ai-coach-section h3 { color: #15803d; margin-bottom: 10px; }
        .ai-chat-container { display: flex; flex-direction: column; gap: 10px; }
        .ai-message { display: flex; gap: 10px; }
        .message-avatar { font-size: 18px; flex-shrink: 0; }
        .ai-message.user .message-content { background: #dbeafe; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
        .ai-message.assistant .message-content { background: #dcfce7; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
        .ai-input-section { display: none; }
        .exercise-section, .exercise-card, .exercise-group, .pgf-column, .flight-section,
        .deep-dive-section, .eco-section, .assessment-section {
            margin-bottom: 18px;
            padding: 14px;
            background: #f8fafc;
            border-radius: 10px;
            border: 1px solid #e2e8f0;
            page-break-inside: avoid;
        }
        h2 { font-size: 17px; color: #1e293b; margin: 18px 0 8px; }
        h3 { font-size: 14px; color: #334155; margin: 14px 0 6px; }
        h4 { font-size: 13px; color: #475569; margin: 10px 0 4px; }
        label, .field-label, .input-label {
            font-size: 11px;
            font-weight: 600;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            display: block;
            margin-bottom: 3px;
        }
        @page { margin: 14mm 12mm; size: A4; }
        @media print { body { padding: 0; } }
    </style>
</head>
<body>
    <div class="pdf-report-header">
        <h2>${escapeHtml(title)}</h2>
        <div class="pdf-meta">${modeLabel}<br>${dateStr}</div>
    </div>
    ${clone.outerHTML}
    ${mode === 'coach' && currentClient && currentClient.basisAnswers && Object.keys(currentClient.basisAnswers).length > 0 ? buildBasisAnswersHTML(currentClient) : ''}
    <script>
        window.onload = function() { setTimeout(function() { window.print(); }, 500); };
    <\/script>
</body>
</html>`);
    printWindow.document.close();
};

// Keep old name as alias so existing onclick="downloadQuadrantPDF()" still works
window.downloadQuadrantPDF = window.showPDFDownloadModal;

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
        present: Array(10).fill(null).map((_, i) => getInputValue('#present-' + i) || ''),
        gap: Array(9).fill(null).map((_, i) => getInputValue('#gap-' + i) || ''),
        future: Array(11).fill(null).map((_, i) => getInputValue('#future-' + i) || ''),
        gapFillIn: Array(4).fill(null).map((_, i) => getInputValue('#gap-fill-' + i) || ''),
        evaluations: {
            experience: getInputValue('#pgf-eval-experience') || '',
            insights: getInputValue('#pgf-eval-insights') || '',
            stoodOut: getInputValue('#pgf-eval-stood-out') || '',
            future23Years: getInputValue('#pgf-eval-future') || '',
            next24Hours: getInputValue('#pgf-eval-24hours') || ''
        },
        sessionNotes: getInputValue('#pgf-session-notes') || '',
        aiCoachNotes: (((currentClient.exerciseData || {}).presentGapFuture || {}).aiCoachNotes) || []
    };

    currentClient.exerciseData.presentGapFuture = data;

    // Update client dream if answer to last question (11th) confirms dream
    const dreamConfirmation = data.future[10]; // Index 10 = "Do you still agree with your dream?"
    if (dreamConfirmation && dreamConfirmation.trim().toLowerCase().includes('yes')) {
        // Keep the dream from Step 1
        const dreamFromStep1 = (((currentClient.exerciseData || {}).fourQuadrant || {}).dreamSummary);
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
    const timelineNumber = parseFloat(getInputValue('#timeline-number')) || 0;
    const timelineUnit = getInputValue('#timeline-unit') || 'years';

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

    const timelineNumber = getInputValue('#timeline-number') || '';
    const timelineUnit = getInputValue('#timeline-unit') || 'years';

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
        flightPlanItems: Array(5).fill(null).map((_, i) => getInputValue('#flight-item-' + i) || ''),
        evaluations: {
            experience: getInputValue('#fp-eval-experience') || '',
            insights: getInputValue('#fp-eval-insights') || '',
            stoodOut: getInputValue('#fp-eval-stood-out') || '',
            future23Years: getInputValue('#fp-eval-future') || '',
            next24Hours: getInputValue('#fp-eval-24hours') || ''
        },
        sessionNotes: getInputValue('#fp-session-notes') || '',
        aiCoachNotes: (((currentClient.exerciseData || {}).flightPlan || {}).aiCoachNotes) || []
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
    import('./journey-exercises-r2.js?v=11').then(module => {
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
    import('./journey-exercises-r2.js?v=11').then(module => {
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
        answer: getInputValue(`#dd-answer-${i}`) || ''
    }));

    const data = {
        deepDiveItems: deepDiveItems,
        evaluations: {
            experience: getInputValue('#dd-eval-experience') || '',
            insights: getInputValue('#dd-eval-insights') || '',
            stoodOut: getInputValue('#dd-eval-stood-out') || '',
            future23Years: getInputValue('#dd-eval-future') || '',
            next24Hours: getInputValue('#dd-eval-24hours') || ''
        },
        sessionNotes: getInputValue('#dd-session-notes') || '',
        aiCoachNotes: (((currentClient.exerciseData || {}).deepDive || {}).aiCoachNotes) || []
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
    import('./journey-exercises-r2.js?v=11').then(module => {
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
    import('./journey-exercises-r2.js?v=11').then(module => {
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

        const giveValue = parseFloat((giveInput && giveInput.value) || 0);
        const takeValue = parseFloat((takeInput && takeInput.value) || 0);

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
        name: getInputValue('#block-name-' + i) || '',
        give: parseFloat(getInputValue('#block-give-' + i) || 0),
        take: parseFloat(getInputValue('#block-take-' + i) || 0)
    }));

    const data = {
        blocks: blocks,
        evaluations: {
            experience: getInputValue('#eco-eval-experience') || '',
            insights: getInputValue('#eco-eval-insights') || '',
            stoodOut: getInputValue('#eco-eval-stood-out') || '',
            future23Years: getInputValue('#eco-eval-future') || '',
            next24Hours: getInputValue('#eco-eval-24hours') || ''
        },
        sessionNotes: getInputValue('#eco-session-notes') || '',
        aiCoachNotes: (((currentClient.exerciseData || {}).ecochart || {}).aiCoachNotes) || []
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
        const barFill = input.nextElementSibling ? input.nextElementSibling.querySelector('.bar-fill') : null;
        const barValue = input.nextElementSibling ? input.nextElementSibling.querySelector('.bar-value') : null;

        if (barFill) barFill.style.width = value + '%';
        if (barValue) barValue.textContent = value + '%';
    });

    // Update total scores
    const posTotal = (parseFloat(getInputValue('#pos-expectation') || 0)) +
                     (parseFloat(getInputValue('#pos-achievement') || 0)) +
                     (parseFloat(getInputValue('#pos-satisfaction') || 0));

    const negTotal = (parseFloat(getInputValue('#neg-frustration') || 0)) +
                     (parseFloat(getInputValue('#neg-helplessness') || 0)) +
                     (parseFloat(getInputValue('#neg-stress') || 0));

    const selfTotal = (parseFloat(getInputValue('#self-insecurity') || 0)) +
                      (parseFloat(getInputValue('#self-guilt') || 0)) +
                      (parseFloat(getInputValue('#self-worth') || 0));

    const emoTotal = (parseFloat(getInputValue('#emo-thoughts') || 0)) +
                     (parseFloat(getInputValue('#emo-paranoia') || 0)) +
                     (parseFloat(getInputValue('#emo-anxiety') || 0)) +
                     (parseFloat(getInputValue('#emo-dependency') || 0)) +
                     (parseFloat(getInputValue('#emo-senselessness') || 0)) +
                     (parseFloat(getInputValue('#emo-memory') || 0)) +
                     (parseFloat(getInputValue('#emo-suicidal') || 0));

    const flowTotal = (parseFloat(getInputValue('#flow-perseverance') || 0)) +
                      (parseFloat(getInputValue('#flow-passion') || 0)) +
                      (parseFloat(getInputValue('#flow-focus') || 0)) +
                      (parseFloat(getInputValue('#flow-mastery') || 0));

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
            expectation: parseFloat(getInputValue('#pos-expectation') || 0),
            achievement: parseFloat(getInputValue('#pos-achievement') || 0),
            satisfaction: parseFloat(getInputValue('#pos-satisfaction') || 0)
        },
        negativePsychoSocial: {
            frustration: parseFloat(getInputValue('#neg-frustration') || 0),
            helplessness: parseFloat(getInputValue('#neg-helplessness') || 0),
            stress: parseFloat(getInputValue('#neg-stress') || 0)
        },
        selfPerception: {
            innerInsecurity: parseFloat(getInputValue('#self-insecurity') || 0),
            guiltFeelings: parseFloat(getInputValue('#self-guilt') || 0),
            lackOfSelfWorth: parseFloat(getInputValue('#self-worth') || 0)
        },
        emotionalFunctioning: {
            disturbingThoughts: parseFloat(getInputValue('#emo-thoughts') || 0),
            paranoia: parseFloat(getInputValue('#emo-paranoia') || 0),
            anxiety: parseFloat(getInputValue('#emo-anxiety') || 0),
            dependency: parseFloat(getInputValue('#emo-dependency') || 0),
            senselessnessOfExistence: parseFloat(getInputValue('#emo-senselessness') || 0),
            memoryLoss: parseFloat(getInputValue('#emo-memory') || 0),
            suicidalThoughts: parseFloat(getInputValue('#emo-suicidal') || 0)
        },
        flowStateQualities: {
            perseverance: parseFloat(getInputValue('#flow-perseverance') || 0),
            passion: parseFloat(getInputValue('#flow-passion') || 0),
            focus: parseFloat(getInputValue('#flow-focus') || 0),
            mastery: parseFloat(getInputValue('#flow-mastery') || 0)
        },
        evaluations: {
            experience: getInputValue('#assess-eval-experience') || '',
            insights: getInputValue('#assess-eval-insights') || '',
            stoodOut: getInputValue('#assess-eval-stood-out') || '',
            future23Years: getInputValue('#assess-eval-future') || '',
            next24Hours: getInputValue('#assess-eval-24hours') || ''
        },
        sessionNotes: getInputValue('#assess-session-notes') || '',
        aiCoachNotes: (((currentClient.exerciseData || {}).assessments || {}).aiCoachNotes) || []
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
        triggers: getInputValue('#modal-triggers') || '',
        bodySensations: getInputValue('#modal-body-sensations') || '',
        thoughts: getInputValue('#modal-thoughts') || '',
        responses: getInputValue('#modal-responses') || '',
        newResponse: getInputValue('#modal-new-response') || '',
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
            experience: getInputValue('#mlnp-eval-experience') || '',
            insights: getInputValue('#mlnp-eval-insights') || '',
            stoodOut: getInputValue('#mlnp-eval-stood-out') || '',
            future23Years: getInputValue('#mlnp-eval-future') || '',
            next24Hours: getInputValue('#mlnp-eval-next24') || ''
        },
        sessionNotes: getInputValue('#mlnp-session-notes') || '',
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
    const sessionCount = (currentClient.exerciseData.mlnp.sessions && currentClient.exerciseData.mlnp.sessions.length) || 0;

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

// ─── Question Linker: 4 Quadrant Dream Summary section ───────────────────────
// Handles "Coaching Questions" zone — coach links questions from Question Builder.
// Business data (answers) stored in DB only — NO localStorage.

const FQ_CONTEXT_KEY = 'four_quadrants.dream_summary';
let _linkerClientId = null;
let _linkerAllQuestions = [];
let _linkerSelected = new Set();

export async function loadLinkedQuestionsSection(client) {
    if (!client || !client.id) return;
    _linkerClientId = client.id;

    const openBtn = document.getElementById('btn-open-qlinker');
    if (openBtn) openBtn.addEventListener('click', window.openQuestionLinker);

    const closeBtn = document.getElementById('qlinker-close');
    if (closeBtn) closeBtn.addEventListener('click', window.closeQuestionLinker);

    const cancelBtn = document.getElementById('qlinker-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', window.closeQuestionLinker);

    const overlay = document.getElementById('qlinker-overlay');
    if (overlay) {
        overlay.addEventListener('click', e => {
            if (e.target.id === 'qlinker-overlay') window.closeQuestionLinker();
        });
    }

    const addBtn = document.getElementById('qlinker-add-btn');
    if (addBtn) addBtn.addEventListener('click', window.addLinkedQuestions);

    await _renderLinkedQuestionsList(client.id);
}

async function _renderLinkedQuestionsList(clientId) {
    const container = document.getElementById('linked-questions-list');
    if (!container) return;
    container.innerHTML = '<p class="linked-q-loading">Loading\u2026</p>';
    try {
        const questions = await api.questionBuilder.getClientContextQuestions(clientId, FQ_CONTEXT_KEY);
        if (!questions || questions.length === 0) {
            container.innerHTML = '<p class="linked-q-empty">No questions linked yet. Click <strong>+ Add Question</strong> to add questions from the Question Builder.</p>';
            return;
        }
        container.innerHTML = questions.map(q => `
            <div class="linked-q-item" data-assignment-id="${q.assignment_id}">
                <div class="linked-q-item-header">
                    ${q.category ? `<span class="linked-q-badge">${escapeHtml(q.category)}</span>` : ''}
                    <button class="linked-q-remove-btn" onclick="removeLinkedQuestion(${q.assignment_id})" title="Remove question">&#x2715;</button>
                </div>
                <div class="linked-q-text">${escapeHtml(q.question_text)}</div>
                ${q.help_text ? `<div class="linked-q-hint">${escapeHtml(q.help_text)}</div>` : ''}
                <textarea class="linked-q-answer" id="linked-q-answer-${q.assignment_id}"
                    data-assignment-id="${q.assignment_id}" data-question-id="${q.id}"
                    placeholder="Enter answer..." rows="3">${escapeHtml(q.answer_text || '')}</textarea>
                <button class="linked-q-save-answer-btn"
                    onclick="saveLinkedAnswer(${q.assignment_id}, ${q.id})">Save Answer</button>
            </div>
        `).join('');
    } catch (err) {
        console.error('[linkedQuestions] Failed to load:', err);
        container.innerHTML = '<p class="linked-q-error">Failed to load questions. Please try again.</p>';
    }
}

function _renderLinkerList() {
    const listEl = document.getElementById('qlinker-list');
    if (!listEl) return;
    const searchTerm = (document.getElementById('qlinker-search')?.value || '').toLowerCase().trim();
    const catFilter = document.getElementById('qlinker-filter-cat')?.value || '';
    let filtered = _linkerAllQuestions;
    if (searchTerm) {
        filtered = filtered.filter(q =>
            q.question_text.toLowerCase().includes(searchTerm) ||
            (q.category || '').toLowerCase().includes(searchTerm)
        );
    }
    if (catFilter) filtered = filtered.filter(q => q.category === catFilter);
    if (filtered.length === 0) {
        listEl.innerHTML = '<p class="qlinker-empty">No questions found.</p>';
        return;
    }
    listEl.innerHTML = filtered.map(q => `
        <label class="qlinker-item ${_linkerSelected.has(q.id) ? 'qlinker-item-selected' : ''}">
            <input type="checkbox" class="qlinker-check" value="${q.id}"
                ${_linkerSelected.has(q.id) ? 'checked' : ''}
                onchange="toggleLinkerQuestion(${q.id}, this.checked)" />
            <div class="qlinker-item-body">
                <div class="qlinker-item-text">${escapeHtml(q.question_text)}</div>
                ${q.category ? `<span class="qlinker-item-cat">${escapeHtml(q.category)}</span>` : ''}
            </div>
        </label>
    `).join('');
}

function _updateLinkerAddButton() {
    const addBtn = document.getElementById('qlinker-add-btn');
    const countEl = document.getElementById('qlinker-selected-count');
    const count = _linkerSelected.size;
    if (addBtn) addBtn.disabled = count === 0;
    if (countEl) countEl.textContent = count === 0 ? '0 selected' : `${count} selected`;
}

window.openQuestionLinker = async function() {
    const overlay = document.getElementById('qlinker-overlay');
    if (!overlay) return;
    _linkerSelected.clear();
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const listEl = document.getElementById('qlinker-list');
    if (listEl) listEl.innerHTML = '<p class="qlinker-list-loading">Loading questions\u2026</p>';
    try {
        _linkerAllQuestions = await api.questionBuilder.listQuestions({ active: 'true' });
        _renderLinkerList();
    } catch (err) {
        console.error('[questionLinker] Failed to load questions:', err);
        if (listEl) listEl.innerHTML = '<p class="qlinker-list-error">Failed to load questions. Please try again.</p>';
    }
    _updateLinkerAddButton();
};

window.closeQuestionLinker = function() {
    const overlay = document.getElementById('qlinker-overlay');
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
};

window.toggleLinkerQuestion = function(questionId, checked) {
    if (checked) {
        _linkerSelected.add(questionId);
    } else {
        _linkerSelected.delete(questionId);
    }
    const checkbox = document.querySelector(`.qlinker-check[value="${questionId}"]`);
    if (checkbox) {
        const item = checkbox.closest('.qlinker-item');
        if (item) item.classList.toggle('qlinker-item-selected', checked);
    }
    _updateLinkerAddButton();
};

window.filterLinkerList = function() {
    _renderLinkerList();
    _updateLinkerAddButton();
};

window.addLinkedQuestions = async function() {
    if (!_linkerClientId || _linkerSelected.size === 0) return;
    const addBtn = document.getElementById('qlinker-add-btn');
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Adding\u2026'; }
    try {
        await api.questionBuilder.assignClientQuestions(
            _linkerClientId,
            FQ_CONTEXT_KEY,
            Array.from(_linkerSelected)
        );
        window.closeQuestionLinker();
        await _renderLinkedQuestionsList(_linkerClientId);
    } catch (err) {
        console.error('[questionLinker] Failed to assign questions:', err);
        alert('Failed to link questions. Please try again.');
    } finally {
        if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Add Selected'; }
    }
};

window.removeLinkedQuestion = async function(assignmentId) {
    if (!_linkerClientId) return;
    if (!confirm('Remove this question from the Coaching Questions section?\nThe original question and any saved answers are preserved.')) return;
    try {
        await api.questionBuilder.unassignClientQuestion(_linkerClientId, FQ_CONTEXT_KEY, assignmentId);
        await _renderLinkedQuestionsList(_linkerClientId);
    } catch (err) {
        console.error('[linkedQuestions] Failed to remove question:', err);
        alert('Failed to remove question. Please try again.');
    }
};

window.saveLinkedAnswer = async function(assignmentId, questionId) {
    if (!_linkerClientId) return;
    const textarea = document.getElementById(`linked-q-answer-${assignmentId}`);
    if (!textarea) return;
    const saveBtn = document.querySelector(`.linked-q-item[data-assignment-id="${assignmentId}"] .linked-q-save-answer-btn`);
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving\u2026'; }
    try {
        await api.questionBuilder.saveClientQuestionAnswers(
            _linkerClientId,
            FQ_CONTEXT_KEY,
            [{ questionId, answerText: textarea.value }]
        );
        if (saveBtn) { saveBtn.textContent = '\u2713 Saved'; }
        setTimeout(() => {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Answer'; }
        }, 1500);
    } catch (err) {
        console.error('[linkedQuestions] Failed to save answer:', err);
        alert('Failed to save answer. Please try again.');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Answer'; }
    }
};

