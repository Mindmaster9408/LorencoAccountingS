// Journey Report Generator - Creates reports for individual steps and comprehensive journey reports

import { readStore } from './storage.js';
import { JOURNEY_STEPS } from './journey-data.js';

/**
 * Generate a report for a specific journey step
 * @param {Object} client - The client object
 * @param {number} stepNumber - The step number (1-17)
 * @returns {string} HTML report for the step
 */
export async function generateStepReport(client, stepNumber) {
    const store = await readStore();
    const settings = store.appSettings || {};
    const company = settings.company || { name: 'The Neuro-Coach Method' };

    const step = JOURNEY_STEPS[stepNumber];
    if (!step) {
        throw new Error(`Step ${stepNumber} not found`);
    }

    // Add phase name and number to step object
    const stepWithMeta = {
        ...step,
        number: stepNumber,
        phase: step.phase === 'phase1' ? 'Phase 1: Foundation' :
               step.phase === 'phase2' ? 'Phase 2: Transformation' :
               'Phase 3: Mastery'
    };

    const stepData = client.journeyProgress?.[`step${stepNumber}`] || {};
    const notes = stepData.notes || 'No notes recorded for this step.';
    const aiDiscussions = stepData.aiDiscussions || [];
    const completedDate = stepData.completedDate || 'Not completed';

    const currentYear = new Date().getFullYear();
    const reportDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Step ${stepNumber}: ${step.title} - ${client.name}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 20px;
            background: #f8fafc;
        }
        .header {
            text-align: center;
            padding: 40px 0;
            background: linear-gradient(135deg, ${company.primaryColor || '#3b82f6'} 0%, ${company.secondaryColor || '#8b5cf6'} 100%);
            color: white;
            border-radius: 12px;
            margin-bottom: 40px;
        }
        .logo { max-width: 200px; margin-bottom: 20px; }
        h1 { font-size: 36px; margin-bottom: 10px; }
        .subtitle { font-size: 18px; opacity: 0.95; }
        .report-meta {
            background: white;
            padding: 24px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .meta-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
        }
        .meta-item {
            padding: 16px;
            background: #f8fafc;
            border-radius: 8px;
            border-left: 4px solid ${company.primaryColor || '#3b82f6'};
        }
        .meta-label {
            font-size: 12px;
            text-transform: uppercase;
            color: #64748b;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .meta-value {
            font-size: 16px;
            color: #1e293b;
            font-weight: 600;
        }
        .section {
            background: white;
            padding: 32px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .section-title {
            color: ${company.primaryColor || '#3b82f6'};
            font-size: 24px;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e2e8f0;
        }
        .step-description {
            background: #eff6ff;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            border-left: 4px solid ${company.primaryColor || '#3b82f6'};
        }
        .notes-content {
            background: #f8fafc;
            padding: 24px;
            border-radius: 8px;
            white-space: pre-wrap;
            font-family: 'Segoe UI', sans-serif;
            line-height: 1.8;
        }
        .ai-discussion {
            background: #f0fdf4;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 16px;
            border-left: 4px solid #10b981;
        }
        .ai-discussion-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            padding-bottom: 12px;
            border-bottom: 1px solid #d1fae5;
        }
        .ai-label {
            font-weight: 600;
            color: #059669;
            font-size: 14px;
        }
        .ai-timestamp {
            font-size: 12px;
            color: #64748b;
        }
        .ai-content {
            color: #1e293b;
            line-height: 1.8;
        }
        .no-content {
            color: #64748b;
            font-style: italic;
            text-align: center;
            padding: 40px;
        }
        .footer {
            text-align: center;
            margin-top: 60px;
            padding-top: 30px;
            border-top: 2px solid #e2e8f0;
            color: #64748b;
        }
        .phase-badge {
            display: inline-block;
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 16px;
        }
        .phase-1 { background: #dbeafe; color: #1e40af; }
        .phase-2 { background: #ede9fe; color: #6b21a8; }
        .phase-3 { background: #fce7f3; color: #9f1239; }
        @media print {
            body { background: white; }
            .section { box-shadow: none; border: 1px solid #e2e8f0; }
        }
    </style>
</head>
<body>
    <div class="header">
        ${company.logo ? `<img src="${company.logo}" alt="${company.name}" class="logo" />` : ''}
        <h1>Journey Step Report</h1>
        <div class="subtitle">Step ${stepNumber} of 17: ${stepWithMeta.title}</div>
    </div>

    <div class="report-meta">
        <div class="meta-grid">
            <div class="meta-item">
                <div class="meta-label">Client Name</div>
                <div class="meta-value">${client.name}</div>
            </div>
            <div class="meta-item">
                <div class="meta-label">Report Date</div>
                <div class="meta-value">${reportDate}</div>
            </div>
            <div class="meta-item">
                <div class="meta-label">Step Completed</div>
                <div class="meta-value">${completedDate !== 'Not completed' ? new Date(completedDate).toLocaleDateString() : 'In Progress'}</div>
            </div>
            <div class="meta-item">
                <div class="meta-label">Phase</div>
                <div class="meta-value">${stepWithMeta.phase}</div>
            </div>
        </div>
    </div>

    <div class="section">
        <span class="phase-badge phase-${stepWithMeta.phase === 'Phase 1: Foundation' ? '1' : stepWithMeta.phase === 'Phase 2: Transformation' ? '2' : '3'}">
            ${stepWithMeta.phase}
        </span>
        <h2 class="section-title">${stepWithMeta.icon} ${stepWithMeta.title}</h2>
        <div class="step-description">
            <strong>Purpose:</strong> ${stepWithMeta.description}
        </div>
    </div>

    <div class="section">
        <h2 class="section-title">Session Notes</h2>
        ${notes !== 'No notes recorded for this step.' ?
            `<div class="notes-content">${notes}</div>` :
            `<div class="no-content">No notes recorded for this step yet.</div>`
        }
    </div>

    ${aiDiscussions.length > 0 ? `
    <div class="section">
        <h2 class="section-title">AI Coach Discussions</h2>
        ${aiDiscussions.map((discussion, index) => `
            <div class="ai-discussion">
                <div class="ai-discussion-header">
                    <span class="ai-label">🤖 AI Coach Session ${index + 1}</span>
                    <span class="ai-timestamp">${discussion.timestamp ? new Date(discussion.timestamp).toLocaleString() : 'No timestamp'}</span>
                </div>
                <div class="ai-content">${discussion.content || discussion.message || 'No content'}</div>
            </div>
        `).join('')}
    </div>
    ` : ''}

    <div class="footer">
        <p>© ${currentYear} ${company.name}. All rights reserved.</p>
        <p style="margin-top: 8px; font-size: 14px;">Generated by The Neuro-Coach Method Journey Platform</p>
    </div>
</body>
</html>`;
}

/**
 * Generate a comprehensive report covering all journey steps
 * @param {Object} client - The client object
 * @returns {string} HTML comprehensive report
 */
export async function generateComprehensiveJourneyReport(client) {
    const store = await readStore();
    const settings = store.appSettings || {};
    const company = settings.company || { name: 'The Neuro-Coach Method' };

    const currentYear = new Date().getFullYear();
    const reportDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    // Convert JOURNEY_STEPS object to array and count completed steps
    const allSteps = Object.keys(JOURNEY_STEPS).map(key => ({
        number: parseInt(key),
        ...JOURNEY_STEPS[key]
    }));

    const completedSteps = allSteps.filter(step => {
        const stepData = client.journeyProgress?.[`step${step.number}`];
        return stepData?.completed;
    });

    const progress = client.journeyProgress || {};

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Comprehensive Journey Report - ${client.name}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 20px;
            background: #f8fafc;
        }
        .cover-page {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            background: linear-gradient(135deg, ${company.primaryColor || '#3b82f6'} 0%, ${company.secondaryColor || '#8b5cf6'} 100%);
            color: white;
            border-radius: 12px;
            padding: 60px;
            margin-bottom: 60px;
        }
        .cover-logo { max-width: 300px; margin-bottom: 40px; }
        .cover-title { font-size: 56px; margin-bottom: 20px; font-weight: 800; }
        .cover-subtitle { font-size: 28px; margin-bottom: 40px; opacity: 0.95; }
        .cover-client { font-size: 32px; margin-top: 40px; padding: 20px 40px; background: rgba(255,255,255,0.2); border-radius: 12px; }
        .header {
            text-align: center;
            padding: 40px;
            background: white;
            border-radius: 12px;
            margin-bottom: 40px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 24px;
            margin-bottom: 40px;
        }
        .summary-card {
            background: white;
            padding: 32px;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            border-top: 4px solid ${company.primaryColor || '#3b82f6'};
        }
        .summary-number {
            font-size: 48px;
            font-weight: 800;
            color: ${company.primaryColor || '#3b82f6'};
            margin-bottom: 8px;
        }
        .summary-label {
            font-size: 16px;
            color: #64748b;
            font-weight: 600;
        }
        .section {
            background: white;
            padding: 40px;
            border-radius: 12px;
            margin-bottom: 40px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            page-break-inside: avoid;
        }
        .section-title {
            color: ${company.primaryColor || '#3b82f6'};
            font-size: 32px;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 3px solid #e2e8f0;
        }
        .step-entry {
            background: #f8fafc;
            padding: 32px;
            border-radius: 12px;
            margin-bottom: 32px;
            border-left: 6px solid ${company.primaryColor || '#3b82f6'};
        }
        .step-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 2px solid #e2e8f0;
        }
        .step-title {
            font-size: 24px;
            font-weight: 700;
            color: #1e293b;
        }
        .step-meta {
            font-size: 14px;
            color: #64748b;
        }
        .step-description {
            color: #475569;
            margin-bottom: 20px;
            font-style: italic;
        }
        .notes-section {
            background: white;
            padding: 24px;
            border-radius: 8px;
            margin-top: 16px;
            border: 2px solid #e2e8f0;
        }
        .notes-title {
            font-size: 16px;
            font-weight: 700;
            color: #334155;
            margin-bottom: 12px;
        }
        .notes-content {
            white-space: pre-wrap;
            line-height: 1.8;
            color: #1e293b;
        }
        .ai-discussions {
            margin-top: 20px;
        }
        .ai-discussion {
            background: #f0fdf4;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 12px;
            border-left: 4px solid #10b981;
        }
        .ai-header {
            font-weight: 600;
            color: #059669;
            margin-bottom: 8px;
            font-size: 14px;
        }
        .phase-divider {
            background: linear-gradient(135deg, ${company.primaryColor || '#3b82f6'} 0%, ${company.secondaryColor || '#8b5cf6'} 100%);
            color: white;
            padding: 24px 40px;
            border-radius: 12px;
            text-align: center;
            font-size: 28px;
            font-weight: 700;
            margin: 60px 0 40px 0;
        }
        .footer {
            text-align: center;
            margin-top: 80px;
            padding-top: 40px;
            border-top: 3px solid #e2e8f0;
            color: #64748b;
        }
        @media print {
            body { background: white; }
            .cover-page { page-break-after: always; }
            .section { page-break-inside: avoid; }
            .phase-divider { page-break-before: always; }
        }
    </style>
</head>
<body>
    <!-- COVER PAGE -->
    <div class="cover-page">
        ${company.logo ? `<img src="${company.logo}" alt="${company.name}" class="cover-logo" />` : ''}
        <h1 class="cover-title">Comprehensive Journey Report</h1>
        <p class="cover-subtitle">The Neuro-Coach Method - 17 Step Transformation</p>
        <div class="cover-client">${client.name}</div>
        <p style="margin-top: 40px; font-size: 18px; opacity: 0.9;">${reportDate}</p>
    </div>

    <!-- EXECUTIVE SUMMARY -->
    <div class="header">
        <h2 style="font-size: 36px; color: ${company.primaryColor || '#3b82f6'}; margin-bottom: 16px;">Executive Summary</h2>
        <p style="font-size: 18px; color: #64748b; max-width: 800px; margin: 0 auto;">
            Complete overview of ${client.name}'s transformation journey through The Neuro-Coach Method
        </p>
    </div>

    <div class="summary-grid">
        <div class="summary-card">
            <div class="summary-number">${completedSteps.length}</div>
            <div class="summary-label">Steps Completed</div>
        </div>
        <div class="summary-card">
            <div class="summary-number">${Math.round((completedSteps.length / 17) * 100)}%</div>
            <div class="summary-label">Journey Progress</div>
        </div>
        <div class="summary-card">
            <div class="summary-number">17</div>
            <div class="summary-label">Total Steps</div>
        </div>
        <div class="summary-card">
            <div class="summary-number">3</div>
            <div class="summary-label">Phases</div>
        </div>
    </div>

    <!-- PHASE 1: FOUNDATION -->
    <div class="phase-divider">Phase 1: Foundation</div>
    ${allSteps.filter(s => s.phase === 'phase1').map(step => {
        const stepData = progress[`step${step.number}`] || {};
        const notes = stepData.notes || 'No notes recorded.';
        const aiDiscussions = stepData.aiDiscussions || [];
        const completed = stepData.completed;
        const completedDate = stepData.completedDate;

        return `
        <div class="step-entry">
            <div class="step-header">
                <div class="step-title">${step.icon} Step ${step.number}: ${step.title}</div>
                <div class="step-meta">
                    ${completed ? `✓ Completed: ${new Date(completedDate).toLocaleDateString()}` : '⏳ In Progress'}
                </div>
            </div>
            <div class="step-description">${step.description}</div>

            ${notes !== 'No notes recorded.' ? `
            <div class="notes-section">
                <div class="notes-title">📝 Session Notes</div>
                <div class="notes-content">${notes}</div>
            </div>
            ` : ''}

            ${aiDiscussions.length > 0 ? `
            <div class="ai-discussions">
                <div class="notes-title">🤖 AI Coach Discussions (${aiDiscussions.length})</div>
                ${aiDiscussions.map((discussion, i) => `
                    <div class="ai-discussion">
                        <div class="ai-header">Session ${i + 1} - ${discussion.timestamp ? new Date(discussion.timestamp).toLocaleString() : 'No timestamp'}</div>
                        <div>${discussion.content || discussion.message || 'No content'}</div>
                    </div>
                `).join('')}
            </div>
            ` : ''}
        </div>
        `;
    }).join('')}

    <!-- PHASE 2: TRANSFORMATION -->
    <div class="phase-divider">Phase 2: Transformation</div>
    ${allSteps.filter(s => s.phase === 'phase2').map(step => {
        const stepData = progress[`step${step.number}`] || {};
        const notes = stepData.notes || 'No notes recorded.';
        const aiDiscussions = stepData.aiDiscussions || [];
        const completed = stepData.completed;
        const completedDate = stepData.completedDate;

        return `
        <div class="step-entry">
            <div class="step-header">
                <div class="step-title">${step.icon} Step ${step.number}: ${step.title}</div>
                <div class="step-meta">
                    ${completed ? `✓ Completed: ${new Date(completedDate).toLocaleDateString()}` : '⏳ In Progress'}
                </div>
            </div>
            <div class="step-description">${step.description}</div>

            ${notes !== 'No notes recorded.' ? `
            <div class="notes-section">
                <div class="notes-title">📝 Session Notes</div>
                <div class="notes-content">${notes}</div>
            </div>
            ` : ''}

            ${aiDiscussions.length > 0 ? `
            <div class="ai-discussions">
                <div class="notes-title">🤖 AI Coach Discussions (${aiDiscussions.length})</div>
                ${aiDiscussions.map((discussion, i) => `
                    <div class="ai-discussion">
                        <div class="ai-header">Session ${i + 1} - ${discussion.timestamp ? new Date(discussion.timestamp).toLocaleString() : 'No timestamp'}</div>
                        <div>${discussion.content || discussion.message || 'No content'}</div>
                    </div>
                `).join('')}
            </div>
            ` : ''}
        </div>
        `;
    }).join('')}

    <!-- PHASE 3: MASTERY -->
    <div class="phase-divider">Phase 3: Mastery</div>
    ${allSteps.filter(s => s.phase === 'phase3').map(step => {
        const stepData = progress[`step${step.number}`] || {};
        const notes = stepData.notes || 'No notes recorded.';
        const aiDiscussions = stepData.aiDiscussions || [];
        const completed = stepData.completed;
        const completedDate = stepData.completedDate;

        return `
        <div class="step-entry">
            <div class="step-header">
                <div class="step-title">${step.icon} Step ${step.number}: ${step.title}</div>
                <div class="step-meta">
                    ${completed ? `✓ Completed: ${new Date(completedDate).toLocaleDateString()}` : '⏳ In Progress'}
                </div>
            </div>
            <div class="step-description">${step.description}</div>

            ${notes !== 'No notes recorded.' ? `
            <div class="notes-section">
                <div class="notes-title">📝 Session Notes</div>
                <div class="notes-content">${notes}</div>
            </div>
            ` : ''}

            ${aiDiscussions.length > 0 ? `
            <div class="ai-discussions">
                <div class="notes-title">🤖 AI Coach Discussions (${aiDiscussions.length})</div>
                ${aiDiscussions.map((discussion, i) => `
                    <div class="ai-discussion">
                        <div class="ai-header">Session ${i + 1} - ${discussion.timestamp ? new Date(discussion.timestamp).toLocaleString() : 'No timestamp'}</div>
                        <div>${discussion.content || discussion.message || 'No content'}</div>
                    </div>
                `).join('')}
            </div>
            ` : ''}
        </div>
        `;
    }).join('')}

    <div class="footer">
        <h3 style="font-size: 24px; color: #1e293b; margin-bottom: 16px;">Journey Complete</h3>
        <p style="font-size: 16px; margin-bottom: 8px;">This comprehensive report documents the complete transformation journey of ${client.name}</p>
        <p style="margin-top: 24px;">© ${currentYear} ${company.name}. All rights reserved.</p>
        <p style="margin-top: 8px; font-size: 14px;">Generated by The Neuro-Coach Method Journey Platform</p>
    </div>
</body>
</html>`;
}
