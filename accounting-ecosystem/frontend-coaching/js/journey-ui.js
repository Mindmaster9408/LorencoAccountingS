// Journey UI - Visual tracker for The Neuro-Coach Method
import { $, escapeHtml } from './config.js';
import { JOURNEY_STEPS, JOURNEY_PHASES, getJourneyProgress, getPhaseProgress, initializeJourneyProgress } from './journey-data.js';
import { saveClient, readStore } from './storage.js';
import { generateStepReport, generateComprehensiveJourneyReport } from './journey-report-generator.js';

export function renderJourneyTracker(client, containerId = 'journey-container') {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Initialize journey progress if not exists
    initializeJourneyProgress(client);

    const { currentStep, completedSteps, percentComplete, currentPhase } = getJourneyProgress(client);

    container.innerHTML = `
        <div class="journey-tracker">
            <div class="journey-header">
                <div>
                    <h2>The Neuro-Coach Method Journey</h2>
                    <p class="journey-subtitle">Track ${escapeHtml(client.name)}'s transformation through 17 powerful steps</p>
                    <div style="margin-top: 16px; display: flex; gap: 12px;">
                        <button class="btn-secondary" onclick="generateComprehensiveReport('${client.id}')" style="font-size: 14px; padding: 8px 16px;">
                            📄 Generate Comprehensive Report
                        </button>
                    </div>
                </div>
                <div class="journey-overall-progress">
                    <div class="progress-circle">
                        <svg width="120" height="120">
                            <circle cx="60" cy="60" r="54" fill="none" stroke="#e2e8f0" stroke-width="8"/>
                            <circle cx="60" cy="60" r="54" fill="none" stroke="#10b981" stroke-width="8"
                                stroke-dasharray="${339.292}"
                                stroke-dashoffset="${339.292 - (339.292 * percentComplete / 100)}"
                                transform="rotate(-90 60 60)"
                                style="transition: stroke-dashoffset 0.5s ease"/>
                            <text x="60" y="60" text-anchor="middle" dy="0.3em" font-size="24" font-weight="700" fill="#1f2937">
                                ${percentComplete}%
                            </text>
                        </svg>
                    </div>
                    <div class="progress-stats">
                        <div class="stat-item">
                            <span class="stat-label">Current Step:</span>
                            <span class="stat-value">${currentStep} of 15</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Completed:</span>
                            <span class="stat-value">${completedSteps.length} steps</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Current Phase:</span>
                            <span class="stat-value">${JOURNEY_PHASES[currentPhase].name}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="journey-phases">
                ${renderAllPhases(client)}
            </div>
        </div>
    `;

    attachJourneyListeners(client);
}

function renderAllPhases(client) {
    return Object.keys(JOURNEY_PHASES).map(phaseKey => {
        const phase = JOURNEY_PHASES[phaseKey];
        const progress = getPhaseProgress(client, phaseKey);
        const { currentPhase } = getJourneyProgress(client);
        const isActive = phaseKey === currentPhase;

        return `
            <div class="journey-phase ${isActive ? 'active' : ''}">
                <div class="phase-header">
                    <h3 style="color: ${phase.color}">${phase.name}</h3>
                    <div class="phase-progress-bar">
                        <div class="phase-progress-fill" style="width: ${progress}%; background: ${phase.color}"></div>
                    </div>
                    <span class="phase-progress-text">${progress}% complete</span>
                </div>
                <div class="phase-steps">
                    ${phase.steps.map(stepNum => renderJourneyStep(client, stepNum)).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function renderJourneyStep(client, stepNum) {
    const step = JOURNEY_STEPS[stepNum];
    const { currentStep, completedSteps } = getJourneyProgress(client);

    const isCompleted = completedSteps.includes(stepNum);
    const isCurrent = currentStep === stepNum;
    const isLocked = stepNum > currentStep && !isCompleted;

    const stepData = client.journeyProgress?.stepNotes?.[stepNum] || '';
    const completionDate = client.journeyProgress?.stepCompletionDates?.[stepNum] || null;

    let statusClass = '';
    let statusIcon = '';

    if (isCompleted) {
        statusClass = 'completed';
        statusIcon = '✓';
    } else if (isCurrent) {
        statusClass = 'current';
        statusIcon = '▶';
    } else if (isLocked) {
        statusClass = 'locked';
        statusIcon = '🔒';
    } else {
        statusClass = 'available';
        statusIcon = '○';
    }

    return `
        <div class="journey-step ${statusClass}" data-step="${stepNum}">
            <div class="step-card">
                <div class="step-status-icon">${statusIcon}</div>
                <div class="step-icon">${step.icon}</div>
                <div class="step-content">
                    <div class="step-number">Step ${stepNum}</div>
                    <h4 class="step-title">${step.title}</h4>
                    <p class="step-description">${step.description}</p>

                    ${isCompleted && completionDate ? `
                        <div class="step-completed-date">
                            ✓ Completed ${new Date(completionDate).toLocaleDateString('en-ZA', {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric'
                            })}
                        </div>
                    ` : ''}

                    ${!isLocked ? `
                        <div class="step-actions">
                            <button class="btn-open-exercise" data-step="${stepNum}">
                                🚀 Open Exercise
                            </button>
                            ${!isCompleted ? `
                                <button class="btn-step-complete" data-step="${stepNum}">
                                    ${isCurrent ? 'Complete Step' : 'Mark Complete'}
                                </button>
                            ` : `
                                <button class="btn-step-uncomplete" data-step="${stepNum}">
                                    Undo Complete
                                </button>
                            `}
                            <button class="btn-step-details" data-step="${stepNum}">
                                ${stepData ? 'View Notes' : 'Add Notes'}
                            </button>
                            <button class="btn-step-report" onclick="generateStepReport('${client.id}', ${stepNum})" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
                                📄 Step Report
                            </button>
                        </div>
                    ` : ''}
                </div>
            </div>

            <div class="step-details-panel" id="step-details-${stepNum}" style="display: none;">
                <div class="step-why-matters">
                    <h5>Why This Step Matters:</h5>
                    <ul>
                        ${step.whyMatters.map(reason => `<li>${reason}</li>`).join('')}
                    </ul>
                </div>
                <div class="step-notes-section">
                    <label for="step-notes-${stepNum}">Notes & Insights:</label>
                    <textarea
                        id="step-notes-${stepNum}"
                        class="step-notes-input"
                        placeholder="Add your notes, insights, and outcomes from this step..."
                        rows="4"
                    >${escapeHtml(stepData)}</textarea>
                    <button class="btn-save-notes" data-step="${stepNum}">Save Notes</button>
                </div>
            </div>
        </div>
    `;
}

function attachJourneyListeners(client) {
    // Open exercise buttons
    document.querySelectorAll('.btn-open-exercise').forEach(btn => {
        btn.addEventListener('click', async () => {
            const stepNum = parseInt(btn.dataset.step);
            await openExercise(client, stepNum);
        });
    });

    // Complete step buttons
    document.querySelectorAll('.btn-step-complete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const stepNum = parseInt(btn.dataset.step);
            await completeStep(client, stepNum);
        });
    });

    // Uncomplete step buttons
    document.querySelectorAll('.btn-step-uncomplete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const stepNum = parseInt(btn.dataset.step);
            await uncompleteStep(client, stepNum);
        });
    });

    // Show/hide step details
    document.querySelectorAll('.btn-step-details').forEach(btn => {
        btn.addEventListener('click', () => {
            const stepNum = parseInt(btn.dataset.step);
            const detailsPanel = document.getElementById(`step-details-${stepNum}`);
            if (detailsPanel) {
                const isVisible = detailsPanel.style.display !== 'none';
                detailsPanel.style.display = isVisible ? 'none' : 'block';
                btn.textContent = isVisible ? 'Add Notes' : 'Hide Notes';
            }
        });
    });

    // Save notes buttons
    document.querySelectorAll('.btn-save-notes').forEach(btn => {
        btn.addEventListener('click', async () => {
            const stepNum = parseInt(btn.dataset.step);
            const notesInput = document.getElementById(`step-notes-${stepNum}`);
            if (notesInput) {
                await saveStepNotes(client, stepNum, notesInput.value);
            }
        });
    });
}

async function completeStep(client, stepNum) {
    if (!client.journeyProgress) {
        initializeJourneyProgress(client);
    }

    // Add to completed steps if not already there
    if (!client.journeyProgress.completedSteps.includes(stepNum)) {
        client.journeyProgress.completedSteps.push(stepNum);
        client.journeyProgress.stepCompletionDates[stepNum] = new Date().toISOString();
    }

    // Move to next step if completing current step
    if (client.journeyProgress.currentStep === stepNum) {
        if (stepNum < 15) {
            client.journeyProgress.currentStep = stepNum + 1;
        }
    }

    await saveClient(client);
    renderJourneyTracker(client);
}

async function uncompleteStep(client, stepNum) {
    if (!client.journeyProgress) return;

    // Remove from completed steps
    client.journeyProgress.completedSteps = client.journeyProgress.completedSteps.filter(s => s !== stepNum);
    delete client.journeyProgress.stepCompletionDates[stepNum];

    // If uncompleting a step before current, move current back
    if (stepNum < client.journeyProgress.currentStep) {
        client.journeyProgress.currentStep = stepNum;
    }

    await saveClient(client);
    renderJourneyTracker(client);
}

async function saveStepNotes(client, stepNum, notes) {
    if (!client.journeyProgress) {
        initializeJourneyProgress(client);
    }

    if (!client.journeyProgress.stepNotes) {
        client.journeyProgress.stepNotes = {};
    }

    client.journeyProgress.stepNotes[stepNum] = notes;
    await saveClient(client);

    // Show success feedback
    const btn = document.querySelector(`.btn-save-notes[data-step="${stepNum}"]`);
    if (btn) {
        const originalText = btn.textContent;
        btn.textContent = '✓ Saved!';
        btn.style.background = '#10b981';
        setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
        }, 2000);
    }
}

async function openExercise(client, stepNum) {
    // Import exercise renderer
    const { renderExercise } = await import('./journey-exercises.js');
    const { setCurrentClient } = await import('./journey-helpers.js');

    // Set the current client for the exercise
    setCurrentClient(client);

    // Render the exercise in the journey container
    renderExercise(client, stepNum, 'journey-container');
}

// Global report generation functions
window.generateStepReport = async function(clientId, stepNumber) {
    try {
        const store = await readStore();
        const client = store.clients.find(c => c.id === clientId);

        if (!client) {
            alert('Client not found');
            return;
        }

        const reportHTML = await generateStepReport(client, stepNumber);

        // Open in new window
        const reportWindow = window.open('', '_blank');
        reportWindow.document.write(reportHTML);
        reportWindow.document.close();

        // Also offer to download
        const blob = new Blob([reportHTML], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${client.name.replace(/\s+/g, '_')}_Step_${stepNumber}_Report.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (error) {
        console.error('Error generating step report:', error);
        alert('Error generating report: ' + error.message);
    }
};

window.generateComprehensiveReport = async function(clientId) {
    try {
        const store = await readStore();
        const client = store.clients.find(c => c.id === clientId);

        if (!client) {
            alert('Client not found');
            return;
        }

        const reportHTML = await generateComprehensiveJourneyReport(client);

        // Open in new window
        const reportWindow = window.open('', '_blank');
        reportWindow.document.write(reportHTML);
        reportWindow.document.close();

        // Also offer to download
        const blob = new Blob([reportHTML], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${client.name.replace(/\s+/g, '_')}_Comprehensive_Journey_Report.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert('✓ Comprehensive report generated and downloaded!');

    } catch (error) {
        console.error('Error generating comprehensive report:', error);
        alert('Error generating report: ' + error.message);
    }
};
