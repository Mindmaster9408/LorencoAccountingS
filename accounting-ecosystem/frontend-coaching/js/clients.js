// Client management and individual client view
import { $, escapeHtml } from './config.js';
import { readStore, writeStore, ensureStore, saveClient, createNewClient } from './storage.js';
import { renderCockpit, saveGauges } from './gauges.js';
import { renderDashboard } from './dashboard.js';
import { renderBASISAssessment } from './basis-ui.js?v=2';
import { renderJourneyTracker } from './journey-ui.js';

export async function openClient(clientId, options = {}) {
    const store = await readStore();
    const client = store.clients.find(c => c.id === clientId);
    if(!client) return;

    // Ensure client has gauges initialized
    if(!client.gauges) {
        client.gauges = {
            fuel: 50,
            horizon: 50,
            thrust: 50,
            engine: 50,
            compass: 50,
            weight: 50,
            positive: 50,
            negative: 50,
            nav: 50
        };
    }

    // Switch to clients view
    switchToView('clients');

    // Hide the header actions when viewing a client
    const headerActions = $('.header-actions');
    if(headerActions) {
        headerActions.style.display = 'none';
    }

    // Update sidebar with client info
    const sidebarInfo = $('#client-sidebar-info');
    if(sidebarInfo) {
        const photoHtml = client.photo ?
            `<img src="${client.photo}" alt="${escapeHtml(client.name)}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; margin: 0 auto 16px; display: block; border: 3px solid #3b82f6;" />` :
            `<div class="client-photo" style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 32px; font-weight: 700; margin: 0 auto 16px;">${(client.name || '')[0] || 'P'}</div>`;

        sidebarInfo.innerHTML = `
            <a href="#" id="back-to-tower" style="display: block; margin-bottom: 16px; color: #3b82f6; text-decoration: none;">← Back to Control Tower</a>
            ${photoHtml}
            <div class="client-name-large" style="font-size: 20px; font-weight: 700; text-align: center; margin-bottom: 8px;">${escapeHtml(client.name)}</div>
            <div class="client-dream" style="font-size: 14px; color: #64748b; text-align: center;">${client.dream ? escapeHtml(client.dream) : 'No dream set yet'}</div>
        `;
    }

    // Setup back button
    setTimeout(() => {
        $('#back-to-tower')?.addEventListener('click', (e) => {
            e.preventDefault();

            // Show header actions again
            const headerActions = $('.header-actions');
            if(headerActions) {
                headerActions.style.display = '';
            }

            switchToView('dashboard');
        });
    }, 0);

    // Hide dashboard, show client detail
    const detailArea = $('#client-detail');
    if(!detailArea) return;

    detailArea.innerHTML = '';

    // Create header with tabs
    const header = createClientHeader();
    detailArea.appendChild(header);
    
    // Create main content area
    const mainContent = document.createElement('div');
    mainContent.className = 'client-main-content';
    mainContent.innerHTML = `
        <div id="client-details" class="client-panel">
            <h3>Client Details</h3>
            <div class="details-form">
                <div class="form-group" style="text-align: center; margin-bottom: 24px;">
                    <label>Client Photo</label>
                    <div class="client-photo-upload"
                         id="client-photo-drop-zone"
                         ondrop="handleClientPhotoDrop(event, '${client.id}')"
                         ondragover="handleClientPhotoDragOver(event)"
                         ondragleave="handleClientPhotoDragLeave(event)"
                         onclick="handleClientPhotoAreaClick(event, '${client.id}')"
                         style="cursor: pointer; padding: 20px; border: 2px dashed #e2e8f0; border-radius: 12px; transition: all 0.3s ease;">
                        ${client.photo ? `
                            <img src="${client.photo}" id="client-photo-preview" alt="Client" style="width: 120px; height: 120px; border-radius: 50%; object-fit: cover; margin: 12px auto; display: block; border: 3px solid #3b82f6;" />
                            <button type="button" class="btn-remove-photo" onclick="event.stopPropagation(); removeClientPhoto('${client.id}')" style="margin-top: 12px;">✕ Remove Photo</button>
                        ` : `
                            <div id="client-photo-preview" style="width: 120px; height: 120px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-size: 48px; margin: 12px auto;">${(client.name || '')[0] || 'P'}</div>
                            <p style="color: #94a3b8; margin-top: 12px; font-size: 14px;">Drag & drop photo here or click to browse</p>
                        `}
                        <input type="file" id="client-photo-input" accept="image/*" style="display: none;" onchange="handleClientPhotoUpload(event, '${client.id}')" />
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>First Name</label>
                        <input type="text" id="detail-firstname" value="${escapeHtml(client.firstName || client.name?.split(' ')[0] || '')}" placeholder="First name">
                    </div>
                    <div class="form-group">
                        <label>Surname</label>
                        <input type="text" id="detail-surname" value="${escapeHtml(client.surname || client.name?.split(' ').slice(1).join(' ') || '')}" placeholder="Surname">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" id="detail-email" value="${escapeHtml(client.email || '')}" placeholder="email@example.com">
                    </div>
                    <div class="form-group">
                        <label>Phone</label>
                        <input type="tel" id="detail-phone" value="${escapeHtml(client.phone || '')}" placeholder="+27 123 456 7890">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Language Preference</label>
                        <select id="detail-language">
                            <option value="English" ${client.preferred_lang === 'English' ? 'selected' : ''}>English</option>
                            <option value="Afrikaans" ${client.preferred_lang === 'Afrikaans' ? 'selected' : ''}>Afrikaans</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Status</label>
                        <select id="detail-status">
                            <option value="Active" ${(client.status || 'Active') === 'Active' ? 'selected' : ''}>Active</option>
                            <option value="Archived" ${client.status === 'Archived' ? 'selected' : ''}>Archived</option>
                            <option value="On Hold" ${client.status === 'On Hold' ? 'selected' : ''}>On Hold</option>
                            <option value="Completed" ${client.status === 'Completed' ? 'selected' : ''}>Completed</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label>Notes</label>
                    <textarea id="detail-notes" rows="4" placeholder="Additional notes about this client...">${escapeHtml(client.notes || '')}</textarea>
                </div>
                <div style="margin-top:16px">
                    <button id="save-details" class="btn-primary">Save Details</button>
                </div>
            </div>
        </div>
        <div id="client-cockpit" class="client-panel" style="display:none">
            <div class="cockpit-grid" id="cockpit-grid"></div>
            <div style="margin-top:8px">
                <button id="save-gauges" class="btn-primary">Save Gauges</button>
            </div>
        </div>
        <div id="flowchart-canvas" class="client-panel" style="display:none">
            <div id="journey-container"></div>
        </div>
        <div id="destination-panel" class="client-panel" style="display:none">
            <h3>Destination</h3>
            <label>Dream / Vision</label>
            <textarea id="dest-dream" rows="4">${escapeHtml(client.dream || '')}</textarea>
            <label style="margin-top:8px">Stress Points / Challenges</label>
            <textarea id="dest-stress" rows="4">${escapeHtml((client.stress || []).join('\n') || '')}</textarea>
            <div style="margin-top:8px">
                <button id="save-destination" class="btn-primary">Save Destination</button>
            </div>
        </div>
        <div id="basis-panel" class="client-panel" style="display:none">
            <div id="basis-assessment-container"></div>
        </div>
    `;
    detailArea.appendChild(mainContent);

    // Setup tab switching
    setupTabSwitching(header, client);

    // Setup back button
    $('#back-to-tower').addEventListener('click', (e) => {
        e.preventDefault();
        switchToView('dashboard');
    });
    
    // Render cockpit
    renderCockpit(client, 'cockpit-grid');
    
    // Setup save gauges button
    $('#save-gauges').addEventListener('click', async () => {
        await saveGauges(client);
        await renderDashboard();
    });
    
    // Setup destination save
    const saveDestBtn = $('#save-destination');
    if(saveDestBtn) {
        saveDestBtn.addEventListener('click', () => {
            client.dream = $('#dest-dream').value;
            client.stress = $('#dest-stress').value.split('\n').map(s => s.trim()).filter(Boolean);
            saveClient(client);
            alert('Destination saved!');
        });
    }
}

function createClientHeader() {
    const header = document.createElement('div');
    header.className = 'client-clean-header';
    header.innerHTML = `
        <div class="client-header-tabs">
            <button class="client-tab active" data-view="details">Details</button>
            <button class="client-tab" data-view="cockpit">Cockpit</button>
            <button class="client-tab" data-view="journey">Journey Map</button>
            <button class="client-tab" data-view="destination">Destination</button>
            <button class="client-tab" data-view="basis">BASIS Assessment</button>
        </div>
    `;
    return header;
}

function setupTabSwitching(header, client) {
    header.querySelectorAll('.client-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            header.querySelectorAll('.client-tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');

            const view = btn.dataset.view;
            $('#client-details').style.display = view === 'details' ? '' : 'none';
            $('#client-cockpit').style.display = view === 'cockpit' ? '' : 'none';
            $('#flowchart-canvas').style.display = view === 'journey' ? '' : 'none';
            $('#destination-panel').style.display = view === 'destination' ? '' : 'none';
            $('#basis-panel').style.display = view === 'basis' ? '' : 'none';

            // Render BASIS assessment when tab is opened
            if (view === 'basis') {
                renderBASISAssessment(client, 'basis-assessment-container');
            }

            // Render Journey tracker when tab is opened
            if (view === 'journey') {
                renderJourneyTracker(client, 'journey-container');
            }
        });
    });

    // Setup save details button
    const saveDetailsBtn = $('#save-details');
    if (saveDetailsBtn) {
        saveDetailsBtn.addEventListener('click', async () => {
            const firstName = $('#detail-firstname').value.trim();
            const surname = $('#detail-surname').value.trim();

            // Update client object
            client.firstName = firstName;
            client.surname = surname;
            client.name = `${firstName} ${surname}`.trim();
            client.email = $('#detail-email').value.trim();
            client.phone = $('#detail-phone').value.trim();
            client.preferred_lang = $('#detail-language').value;
            client.status = $('#detail-status').value.trim();
            client.notes = $('#detail-notes').value.trim();

            // Save to storage
            await saveClient(client);

            // Update sidebar info
            const sidebarInfo = $('#client-sidebar-info');
            if (sidebarInfo) {
                const photoDiv = sidebarInfo.querySelector('.client-photo');
                const nameDiv = sidebarInfo.querySelector('.client-name-large');
                if (photoDiv) photoDiv.textContent = (client.name || '')[0] || 'P';
                if (nameDiv) nameDiv.textContent = client.name;
            }

            // Refresh dashboard to show updated name
            await renderDashboard();

            alert('Client details saved successfully!');
        });
    }
}

export function createNewPilot() {
    const name = prompt('Enter pilot name:');
    if(!name) return;
    
    const client = createNewClient(name);
    saveClient(client);
    renderDashboard();
    
    // Open the new client
    setTimeout(() => openClient(client.id), 100);
}

export function addSampleClient() {
    const store = ensureStore();
    const client = createNewClient('Lia van der Merwe');
    client.preferred_lang = 'Afrikaans';
    client.status = 'Active - Step 1';
    client.summary = 'Dream: Freelance success; Stress: Time management';
    client.progress = {completed: 3, total: 15};
    saveClient(client);
    renderDashboard();
    alert('Sample client added!');
}

function switchToView(viewName) {
    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    
    // Show selected view
    const view = $(`#${viewName}`);
    if(view) view.classList.remove('hidden');
    
    // Update page title
    const titleEl = $('#page-title');
    if(titleEl) {
        titleEl.textContent = viewName.charAt(0).toUpperCase() + viewName.slice(1);
        titleEl.style.display = viewName === 'clients' ? 'none' : '';
    }
    
    // Render the appropriate view
    if(viewName === 'dashboard') {
        renderDashboard();
    }
}
// Client Photo Upload Functions
window.handleClientPhotoAreaClick = function(event, clientId) {
    // Don't trigger if clicking on remove button
    if (event.target.classList.contains('btn-remove-photo')) return;

    const fileInput = $('#client-photo-input');
    if (fileInput) fileInput.click();
};

window.handleClientPhotoDrop = function(event, clientId) {
    event.preventDefault();
    event.stopPropagation();

    const dropZone = $('#client-photo-drop-zone');
    if (dropZone) dropZone.classList.remove('drag-over');

    const file = event.dataTransfer.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        alert('Please drop an image file (JPG, PNG, GIF, etc.)');
        return;
    }

    processClientPhotoFile(file, clientId);
};

window.handleClientPhotoDragOver = function(event) {
    event.preventDefault();
    event.stopPropagation();
    const dropZone = $('#client-photo-drop-zone');
    if (dropZone) {
        dropZone.classList.add('drag-over');
        dropZone.style.background = '#eff6ff';
        dropZone.style.borderColor = '#3b82f6';
        dropZone.style.transform = 'scale(1.02)';
    }
};

window.handleClientPhotoDragLeave = function(event) {
    event.preventDefault();
    const dropZone = $('#client-photo-drop-zone');
    if (dropZone) {
        dropZone.classList.remove('drag-over');
        dropZone.style.background = '';
        dropZone.style.borderColor = '';
        dropZone.style.transform = '';
    }
};

function processClientPhotoFile(file, clientId) {
    if (file.size > 5 * 1024 * 1024) {
        alert('Photo file is too large. Maximum size is 5MB.');
        return;
    }

    const reader = new FileReader();
    reader.onload = async function(e) {
        const store = await readStore();
        const client = store.clients.find(c => c.id === clientId);
        if (!client) return;

        client.photo = e.target.result;
        await saveClient(client);

        // Reload client view
        openClient(clientId);
        alert('✓ Client photo uploaded successfully!');
    };
    reader.readAsDataURL(file);
}

window.handleClientPhotoUpload = async function(event, clientId) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        alert('Please select a valid image file.');
        return;
    }

    processClientPhotoFile(file, clientId);
};

window.removeClientPhoto = async function(clientId) {
    if (!confirm('Are you sure you want to remove this client\'s photo?')) {
        return;
    }

    const store = await readStore();
    const client = store.clients.find(c => c.id === clientId);
    if (!client) return;

    client.photo = '';
    await saveClient(client);

    // Reload client view
    openClient(clientId);
    alert('✓ Client photo removed.');
};
