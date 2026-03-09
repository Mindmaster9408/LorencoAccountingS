// Leads management for public BASIS assessments
import { $, escapeHtml } from './config.js';
import { createNewClient, saveClient } from './storage.js';
import { apiRequest } from './api.js';

// ── Cloud helpers — all leads data lives in the backend (never localStorage) ─

async function fetchLeads() {
    try {
        const data = await apiRequest('/leads');
        return data.leads || [];
    } catch (e) {
        console.warn('Could not fetch leads from server:', e.message);
        return [];
    }
}

async function updateLead(id, changes) {
    return apiRequest('/leads/' + id, { method: 'PUT', body: JSON.stringify(changes) });
}

async function deleteLead_api(id) {
    return apiRequest('/leads/' + id, { method: 'DELETE' });
}

export function renderLeads() {
    updateLeadsStats();
    renderLeadsList();
}

async function updateLeadsStats() {
    const leads = await fetchLeads();

    const totalLeads      = leads.length;
    const interestedLeads = leads.filter(l => l.wants_coaching || l.wantsCoaching).length;
    const contactedLeads  = leads.filter(l => l.status === 'contacted' || l.contacted).length;
    const convertedLeads  = leads.filter(l => l.status === 'converted' || l.convertedToClient).length;

    if ($('#total-leads'))      $('#total-leads').textContent      = totalLeads;
    if ($('#interested-leads')) $('#interested-leads').textContent = interestedLeads;
    if ($('#contacted-leads'))  $('#contacted-leads').textContent  = contactedLeads;
    if ($('#converted-leads'))  $('#converted-leads').textContent  = convertedLeads;
}

export async function renderLeadsList() {
    const leads = await fetchLeads();
    const container = $('#leads-list');
    if (!container) return;

    const activeTab = document.querySelector('.leads-filters .tab.active');
    const filter = activeTab?.dataset.filter || 'all';

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
    const isContacted = lead.status === 'contacted' || lead.contacted;
    const isConverted = lead.status === 'converted' || lead.convertedToClient;
    const wantsCoach  = lead.wants_coaching || lead.wantsCoaching;

    const cardClasses = ['lead-card'];
    if (wantsCoach)  cardClasses.push('interested');
    if (isContacted) cardClasses.push('contacted');

    const registeredDate = formatDateTime(parseStandardDate(lead.created_at || lead.registeredAt));

    const basisCode = (lead.basis_results || lead.basisResults)?.basisOrder?.join(' ') || '—';

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
        await saveClient(client);

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

export function setupLeadsListeners() {
    document.querySelectorAll('.leads-filters .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.leads-filters .tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderLeadsList();
        });
    });

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
