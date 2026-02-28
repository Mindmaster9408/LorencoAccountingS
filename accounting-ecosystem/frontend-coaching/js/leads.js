// Leads management for public BASIS assessments
import { $, escapeHtml } from './config.js';
import { createNewClient, saveClient, readStore } from './storage.js';

export function renderLeads() {
    updateLeadsStats();
    renderLeadsList();
}

function updateLeadsStats() {
    const leads = JSON.parse(localStorage.getItem('public_leads') || '[]');

    const totalLeads = leads.length;
    const interestedLeads = leads.filter(l => l.wantsCoaching).length;
    const contactedLeads = leads.filter(l => l.contacted).length;
    const convertedLeads = leads.filter(l => l.convertedToClient).length;

    $('#total-leads').textContent = totalLeads;
    $('#interested-leads').textContent = interestedLeads;
    $('#contacted-leads').textContent = contactedLeads;
    $('#converted-leads').textContent = convertedLeads;
}

export function renderLeadsList() {
    const leads = JSON.parse(localStorage.getItem('public_leads') || '[]');
    const container = $('#leads-list');
    if (!container) return;

    // Get active filter
    const activeTab = document.querySelector('.leads-filters .tab.active');
    const filter = activeTab?.dataset.filter || 'all';

    // Filter leads
    let filteredLeads = leads;
    if (filter === 'interested') {
        filteredLeads = leads.filter(l => l.wantsCoaching && !l.convertedToClient);
    } else if (filter === 'not-contacted') {
        filteredLeads = leads.filter(l => !l.contacted && !l.convertedToClient);
    } else if (filter === 'contacted') {
        filteredLeads = leads.filter(l => l.contacted && !l.convertedToClient);
    }

    // Sort by date (newest first)
    filteredLeads.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));

    if (filteredLeads.length === 0) {
        container.innerHTML = `
            <div class="empty-leads">
                <div class="empty-leads-icon">📭</div>
                <h3>No Leads Yet</h3>
                <p>Share your public assessment link to start generating leads!</p>
                <div class="public-link-box">
                    <h4>Share This Link:</h4>
                    <div class="link-input-group">
                        <input type="text" readonly value="${window.location.origin + window.location.pathname.replace('index.html', '')}public-assessment.html" id="public-link-input">
                        <button class="btn-primary" onclick="copyPublicLink()">Copy Link</button>
                    </div>
                    <p style="margin-top: 12px; font-size: 14px; color: #64748b;">
                        Share this on social media, your website, or via email to collect leads!
                    </p>
                </div>
            </div>
        `;
        return;
    }

    container.innerHTML = filteredLeads.map(lead => createLeadCard(lead)).join('');
}

function createLeadCard(lead) {
    const cardClasses = ['lead-card'];
    if (lead.wantsCoaching) cardClasses.push('interested');
    if (lead.contacted) cardClasses.push('contacted');

    const registeredDate = new Date(lead.registeredAt).toLocaleDateString('en-ZA', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    const completedDate = new Date(lead.completedAt).toLocaleDateString('en-ZA', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });

    const basisCode = lead.basisResults?.basisOrder?.join(' ') || '—';

    return `
        <div class="${cardClasses.join(' ')}" data-lead-id="${lead.id}">
            <div class="lead-card-header">
                <div class="lead-info">
                    <div class="lead-name">${escapeHtml(lead.name)}</div>
                    ${lead.company ? `<div class="lead-company">🏢 ${escapeHtml(lead.company)}</div>` : ''}
                    <div class="lead-contact">
                        <span>📧 ${escapeHtml(lead.email)}</span>
                        <span>📞 ${escapeHtml(lead.phone)}</span>
                        <span>🌐 ${escapeHtml(lead.preferred_lang)}</span>
                    </div>
                </div>
                <div class="lead-badges">
                    ${lead.wantsCoaching ? '<span class="lead-badge interested">💼 Wants Coaching</span>' : ''}
                    ${lead.contacted ? '<span class="lead-badge contacted">✓ Contacted</span>' : ''}
                    ${lead.convertedToClient ? '<span class="lead-badge converted">⭐ Client</span>' : ''}
                </div>
            </div>

            <div class="lead-basis">
                <strong>BASIS Profile:</strong> <span class="lead-basis-code">${basisCode}</span>
            </div>

            ${lead.wantsCoaching && lead.coachingGoals ? `
                <div class="lead-goals">
                    <strong>Goals/Challenges:</strong><br>
                    ${escapeHtml(lead.coachingGoals)}
                </div>
            ` : ''}

            <div class="lead-actions">
                ${!lead.contacted && !lead.convertedToClient ? `
                    <button class="btn-contact" onclick="markAsContacted('${lead.id}')">
                        ✓ Mark as Contacted
                    </button>
                ` : ''}
                ${!lead.convertedToClient ? `
                    <button class="btn-convert" onclick="convertToClient('${lead.id}')">
                        ⭐ Convert to Client
                    </button>
                ` : ''}
                <button class="btn-view-report" onclick="viewLeadReport('${lead.id}')">
                    📊 View BASIS Report
                </button>
                <button class="btn-delete" onclick="deleteLead('${lead.id}')">
                    🗑️ Delete
                </button>
            </div>

            <div class="lead-timestamp">
                Registered: ${registeredDate} | Completed: ${completedDate}
            </div>
        </div>
    `;
}

// Global functions for button clicks
window.markAsContacted = function(leadId) {
    const leads = JSON.parse(localStorage.getItem('public_leads') || '[]');
    const lead = leads.find(l => l.id === leadId);
    if (lead) {
        lead.contacted = true;
        lead.contactedAt = new Date().toISOString();
        localStorage.setItem('public_leads', JSON.stringify(leads));
        renderLeads();
    }
};

window.convertToClient = async function(leadId) {
    const leads = JSON.parse(localStorage.getItem('public_leads') || '[]');
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    const confirmed = confirm(`Convert ${lead.name} to a client?`);
    if (!confirmed) return;

    // Create client from lead
    const client = createNewClient(lead.name);
    client.firstName = lead.firstName;
    client.surname = lead.surname;
    client.email = lead.email;
    client.phone = lead.phone;
    client.company = lead.company;
    client.preferred_lang = lead.preferred_lang;
    client.basisAnswers = lead.basisAnswers;
    client.basisResults = lead.basisResults;
    client.status = 'Active - New Client from Lead';
    client.notes = `Converted from public lead on ${new Date().toLocaleDateString()}`;
    if (lead.coachingGoals) {
        client.notes += `\n\nGoals: ${lead.coachingGoals}`;
    }

    await saveClient(client);

    // Mark lead as converted
    lead.convertedToClient = true;
    lead.convertedAt = new Date().toISOString();
    lead.clientId = client.id;
    localStorage.setItem('public_leads', JSON.stringify(leads));

    alert(`${lead.name} has been added as a client!`);
    renderLeads();
};

window.viewLeadReport = function(leadId) {
    const leads = JSON.parse(localStorage.getItem('public_leads') || '[]');
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    // Import and generate BASIS report
    import('./basis-report-ui.js').then(module => {
        // Create a temporary client object with lead data
        const tempClient = {
            name: lead.name,
            preferred_lang: lead.preferred_lang,
            basisResults: lead.basisResults
        };
        module.generateAndDownloadReport(tempClient);
    });
};

window.deleteLead = function(leadId) {
    const leads = JSON.parse(localStorage.getItem('public_leads') || '[]');
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    const confirmed = confirm(`Delete lead for ${lead.name}? This cannot be undone.`);
    if (!confirmed) return;

    const updatedLeads = leads.filter(l => l.id !== leadId);
    localStorage.setItem('public_leads', JSON.stringify(updatedLeads));
    renderLeads();
};

window.copyPublicLink = function() {
    const input = $('#public-link-input');
    if (input) {
        input.select();
        document.execCommand('copy');
        alert('Public assessment link copied to clipboard!');
    }
};

export function setupLeadsListeners() {
    // Tab filters
    document.querySelectorAll('.leads-filters .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.leads-filters .tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderLeadsList();
        });
    });

    // Copy public link button
    const copyLinkBtn = $('#copy-public-link');
    if (copyLinkBtn) {
        copyLinkBtn.addEventListener('click', () => {
            const publicUrl = window.location.origin + window.location.pathname.replace('index.html', '') + 'public-assessment.html';
            navigator.clipboard.writeText(publicUrl).then(() => {
                const originalText = copyLinkBtn.textContent;
                copyLinkBtn.textContent = '✓ Copied!';
                setTimeout(() => {
                    copyLinkBtn.textContent = originalText;
                }, 2000);
            });
        });
    }
}
