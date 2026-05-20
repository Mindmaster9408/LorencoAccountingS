// Leads management for public BASIS assessments
import { $, escapeHtml } from './config.js';
import { createNewClient, saveClient, readStore } from './storage.js';
import { api } from './api.js';
import { BASIS_QUESTIONS, SECTION_LABELS, cleanQuestionText } from './basis-assessment.js';

// ── Cloud helpers — all leads data lives in the backend (never localStorage) ─

async function fetchLeads(status) {
    try {
        const data = await api.leads.list(status);
        return data.leads || [];
    } catch (e) {
        console.warn('Could not fetch leads from server:', e.message);
        return [];
    }
}

async function updateLead(id, changes) {
    return api.leads.update(id, changes);
}

async function deleteLead_api(id) {
    return api.leads.delete(id);
}

export function renderLeads() {
    updateLeadsStats();
    renderLeadsList();
    renderCampaigns();
}

async function updateLeadsStats() {
    const leads = await fetchLeads();

    const totalLeads = leads.length;
    // Map backend columns back to the display fields used in the card
    const interestedLeads = leads.filter(l => l.wants_coaching || l.wantsCoaching).length;
    const contactedLeads  = leads.filter(l => l.status === 'contacted' || l.contacted).length;
    const convertedLeads  = leads.filter(l => l.status === 'converted' || l.convertedToClient).length;

    if ($('#total-leads'))     $('#total-leads').textContent     = totalLeads;
    if ($('#interested-leads'))$('#interested-leads').textContent = interestedLeads;
    if ($('#contacted-leads')) $('#contacted-leads').textContent  = contactedLeads;
    if ($('#converted-leads')) $('#converted-leads').textContent  = convertedLeads;
}

export async function renderLeadsList() {
    const leads = await fetchLeads();
    const container = $('#leads-list');
    if (!container) return;

    // Get active filter
    const activeTab = document.querySelector('.leads-filters .tab.active');
    const filter = (activeTab && activeTab.dataset && activeTab.dataset.filter) || 'all';

    let filteredLeads = leads;
    const wantsCoaching = l => l.wants_coaching || l.wantsCoaching;
    const isContacted   = l => l.status === 'contacted' || l.contacted;
    const isConverted   = l => l.status === 'converted' || l.convertedToClient;

    if (filter === 'interested')    filteredLeads = leads.filter(l => wantsCoaching(l) && !isConverted(l));
    if (filter === 'not-contacted') filteredLeads = leads.filter(l => !isContacted(l) && !isConverted(l));
    if (filter === 'contacted')     filteredLeads = leads.filter(l =>  isContacted(l) && !isConverted(l));

    filteredLeads.sort((a, b) => new Date(b.created_at || b.registeredAt) - new Date(a.created_at || a.registeredAt));

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
                </div>
            </div>
        `;
        return;
    }

    container.innerHTML = filteredLeads.map(lead => createLeadCard(lead)).join('');
}

function createLeadCard(lead) {
    const isContacted  = lead.status === 'contacted'  || lead.contacted;
    const isConverted  = lead.status === 'converted'  || lead.convertedToClient;
    const wantsCoach   = lead.wants_coaching || lead.wantsCoaching;

    const cardClasses = ['lead-card'];
    if (wantsCoach)   cardClasses.push('interested');
    if (isContacted)  cardClasses.push('contacted');

    const registeredDate = formatDateTime(parseStandardDate(lead.created_at || lead.registeredAt));

    const basisSource = lead.basis_results || lead.basisResults;
    const basisOrder = (basisSource && basisSource.basisOrder) ? basisSource.basisOrder : [];
    const basisCode = basisOrder.join(' ') || '—';

    return `
        <div class="${cardClasses.join(' ')}" data-lead-id="${lead.id}">
            <div class="lead-card-header">
                <div class="lead-info">
                    <div class="lead-name">${escapeHtml(lead.name)}</div>
                    ${lead.company ? `<div class="lead-company">🏢 ${escapeHtml(lead.company)}</div>` : ''}
                    <div class="lead-contact">
                        <span>📧 ${escapeHtml(lead.email || '—')}</span>
                        <span>📞 ${escapeHtml(lead.phone || '—')}</span>
                    </div>
                </div>
                <div class="lead-badges">
                    ${wantsCoach  ? '<span class="lead-badge interested">💼 Wants Coaching</span>' : ''}
                    ${isContacted ? '<span class="lead-badge contacted">✓ Contacted</span>' : ''}
                    ${isConverted ? '<span class="lead-badge converted">⭐ Client</span>' : ''}
                </div>
            </div>
            <div class="lead-basis">
                <strong>BASIS Profile:</strong> <span class="lead-basis-code">${basisCode}</span>
            </div>
            ${(lead.coaching_goals || lead.coachingGoals) ? `
                <div class="lead-goals">
                    <strong>Goals:</strong><br>${escapeHtml(lead.coaching_goals || lead.coachingGoals)}
                </div>
            ` : ''}
            <div class="lead-actions">
                <button class="btn-secondary" onclick="viewLeadAnswers(${lead.id})">📋 View Answers</button>
                ${!isContacted && !isConverted ? `<button class="btn-contact" onclick="markAsContacted('${lead.id}')">✓ Mark as Contacted</button>` : ''}
                ${!isConverted ? `<button class="btn-convert" onclick="convertToClient('${lead.id}')">⭐ Convert to Client</button>` : ''}
                <button class="btn-delete" onclick="deleteLead('${lead.id}')">🗑️ Delete</button>
            </div>
            <div class="lead-timestamp">Registered: ${registeredDate}</div>
        </div>
    `;
}

// Global functions for button clicks
window.markAsContacted = async function(leadId) {
    try {
        await updateLead(leadId, { status: 'contacted' });
        renderLeads();
    } catch(e) { alert('Could not update lead: ' + e.message); }
};

window.convertToClient = async function(leadId) {
    try {
        const leads = await fetchLeads();
        const lead = leads.find(l => String(l.id) === String(leadId));
        if (!lead) return;
        const confirmed = confirm('Convert ' + lead.name + ' to a client?');
        if (!confirmed) return;

        const client = createNewClient(lead.name);
        client.email = lead.email;
        client.phone = lead.phone;
        client.preferred_lang = lead.preferred_lang || 'English';
        client.status = 'Active - New Client from Lead';
        client.notes = 'Converted from public lead on ' + formatDate(new Date(), 'ZA');
        const saved = await saveClient(client);

        await updateLead(leadId, { status: 'converted' });
        alert(lead.name + ' has been added as a client!');
        renderLeads();
    } catch(e) { alert('Could not convert lead: ' + e.message); }
};

window.deleteLead = async function(leadId) {
    try {
        const leads = await fetchLeads();
        const lead = leads.find(l => String(l.id) === String(leadId));
        if (!lead) return;
        const confirmed = confirm('Delete lead for ' + lead.name + '? This cannot be undone.');
        if (!confirmed) return;
        await deleteLead_api(leadId);
        renderLeads();
    } catch(e) { alert('Could not delete lead: ' + e.message); }
};

window.copyPublicLink = function() {
    const input = $('#public-link-input');
    if (input) {
        input.select();
        document.execCommand('copy');
        alert('Public assessment link copied to clipboard!');
    }
};

// ── View Lead Answers modal ──────────────────────────────────────────────────

window.viewLeadAnswers = async function(leadId) {
    let lead;
    try {
        const data = await api.leads.get(leadId);
        lead = data.lead;
    } catch (e) {
        alert('Could not load lead answers: ' + e.message);
        return;
    }

    const answers = lead.basis_answers;
    if (!answers || Object.keys(answers).length === 0) {
        alert('No assessment answers recorded for this lead.');
        return;
    }

    // Build HTML showing each section with question text and value
    let html = `<div class="answers-modal-header">
        <h3>${escapeHtml(lead.name)}</h3>
        <p>${escapeHtml(lead.email || '')} &mdash; ${new Date(lead.created_at).toLocaleDateString()}</p>
    </div>`;

    for (const [sectionKey, questions] of Object.entries(BASIS_QUESTIONS)) {
        const sectionLabel = SECTION_LABELS[sectionKey] || sectionKey;
        html += `<div class="answers-section"><h4>${escapeHtml(sectionLabel)}</h4><ol>`;
        questions.forEach((question, idx) => {
            const flatKey = `${sectionKey}_${question.id}`;
            const val = answers[flatKey] !== undefined ? answers[flatKey] : '—';
            html += `<li><span class="q-text">${escapeHtml(cleanQuestionText(question.text))}</span>
                         <span class="q-value">${escapeHtml(String(val))}/10</span></li>`;
        });
        html += `</ol></div>`;
    }

    // Show in modal — use existing modal infrastructure if available, otherwise create one
    let modal = $('#lead-answers-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'lead-answers-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content answers-modal">
                <button class="modal-close" onclick="document.getElementById('lead-answers-modal').style.display='none'">✕</button>
                <div id="lead-answers-body"></div>
            </div>`;
        document.body.appendChild(modal);
    }
    document.getElementById('lead-answers-body').innerHTML = html;
    modal.style.display = 'flex';
};

// ── Campaign management ──────────────────────────────────────────────────────

export async function renderCampaigns() {
    const container = $('#campaigns-list');
    if (!container) return;

    let campaigns = [];
    try {
        campaigns = await api.campaigns.list();
    } catch (e) {
        container.innerHTML = '<p class="error-text">Could not load campaigns.</p>';
        return;
    }

    if (!campaigns.length) {
        container.innerHTML = '<p class="campaigns-empty">No public assessment links yet. Create one above.</p>';
        return;
    }

    const baseUrl = window.location.origin + window.location.pathname.replace('index.html', '') + 'public-assessment.html';

    container.innerHTML = campaigns.map(c => {
        const shareUrl = `${baseUrl}?campaign=${c.slug}`;
        const isActive = c.is_active;
        return `
            <div class="campaign-row ${isActive ? '' : 'campaign-inactive'}">
                <div class="campaign-info">
                    <div class="campaign-name">${escapeHtml(c.name)}</div>
                    <div class="campaign-meta">
                        ${c.submission_count} submission${c.submission_count !== 1 ? 's' : ''}
                        &mdash; ${isActive ? '<span class="status-active">Active</span>' : '<span class="status-inactive">Inactive</span>'}
                    </div>
                    <div class="campaign-url">
                        <input type="text" readonly value="${escapeHtml(shareUrl)}" class="share-url-input">
                        <button class="btn-copy-small" onclick="copyCampaignLink('${escapeHtml(shareUrl)}')">Copy</button>
                    </div>
                </div>
                <div class="campaign-actions">
                    <button class="btn-toggle-campaign" onclick="toggleCampaign(${c.id})">
                        ${isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button class="btn-delete-campaign" onclick="deleteCampaign(${c.id})">Delete</button>
                </div>
            </div>`;
    }).join('');
}

window.copyCampaignLink = function(url) {
    navigator.clipboard.writeText(url).then(() => {
        alert('Link copied to clipboard!');
    }).catch(() => {
        prompt('Copy this link:', url);
    });
};

window.toggleCampaign = async function(id) {
    try {
        await api.campaigns.toggle(id);
        renderCampaigns();
    } catch (e) {
        alert('Could not toggle campaign: ' + e.message);
    }
};

window.deleteCampaign = async function(id) {
    const confirmed = confirm('Delete this campaign link? Existing submissions will be kept, but the link will stop working.');
    if (!confirmed) return;
    try {
        await api.campaigns.delete(id);
        renderCampaigns();
        renderLeads(); // refresh lead counts
    } catch (e) {
        alert('Could not delete campaign: ' + e.message);
    }
};

export function setupCampaignsListeners() {
    const createBtn = $('#create-campaign-btn');
    if (createBtn) {
        createBtn.addEventListener('click', async () => {
            const nameInput = $('#new-campaign-name');
            const name = nameInput ? nameInput.value.trim() : '';
            if (!name) {
                alert('Please enter a name for this campaign link.');
                return;
            }
            try {
                await api.campaigns.create({ name });
                if (nameInput) nameInput.value = '';
                renderCampaigns();
            } catch (e) {
                alert('Could not create campaign: ' + e.message);
            }
        });
    }
}

export function setupLeadsListeners() {
    setupCampaignsListeners();

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
                setTimeout(() => { copyLinkBtn.textContent = originalText; }, 2000);
            });
        });
    }
}
