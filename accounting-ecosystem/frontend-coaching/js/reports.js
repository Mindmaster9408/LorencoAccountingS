// Reports Module - View and download client reports

import { $, escapeHtml } from './config.js';
import { readStore } from './storage.js';
import { renderBASISReportViewer } from './basis-report-ui.js';

export async function renderReports() {
    const store = await readStore();
    const view = $('#reports');

    if (!view) return;

    view.innerHTML = `
        <div class="reports-container">
            <header class="reports-header">
                <h2>Client Reports</h2>
                <p class="reports-subtitle">Generate and download professional BASIS reports for your clients</p>
            </header>

            <div class="reports-content">
                <div class="client-selector">
                    <h3>Select a Client</h3>
                    ${renderClientList(store.clients)}
                </div>

                <div id="report-display-area" class="report-display-area">
                    <div class="empty-state">
                        <div class="empty-icon">📊</div>
                        <h3>No Client Selected</h3>
                        <p>Select a client from the list to view and download their BASIS report.</p>
                    </div>
                </div>
            </div>
        </div>
    `;

    attachReportsListeners(store.clients);
}

function renderClientList(clients) {
    if (clients.length === 0) {
        return `
            <div class="no-clients">
                <p>No clients found. Add clients from the Dashboard.</p>
            </div>
        `;
    }

    return `
        <div class="client-list">
            ${clients.map(client => {
                const hasAssessment = client.basisResults ? '✓' : '○';
                const statusClass = client.basisResults ? 'has-assessment' : 'no-assessment';

                return `
                    <div class="client-list-item ${statusClass}" data-client-id="${client.id}">
                        <span class="client-status">${hasAssessment}</span>
                        <span class="client-name">${escapeHtml(client.name)}</span>
                        ${client.basisResults ?
                            `<span class="client-code">${client.basisResults.basisOrder.join('-')}</span>` :
                            `<span class="client-no-code">No assessment</span>`
                        }
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function attachReportsListeners(clients) {
    const clientItems = document.querySelectorAll('.client-list-item');

    clientItems.forEach(item => {
        item.addEventListener('click', () => {
            // Remove active class from all items
            clientItems.forEach(i => i.classList.remove('active'));

            // Add active class to clicked item
            item.classList.add('active');

            // Get client
            const clientId = item.dataset.clientId;
            const client = clients.find(c => c.id === clientId);

            if (client) {
                displayClientReport(client);
            }
        });
    });
}

function displayClientReport(client) {
    const displayArea = $('#report-display-area');
    if (!displayArea) return;

    displayArea.innerHTML = '<div id="basis-report-viewer"></div>';
    renderBASISReportViewer(client, 'basis-report-viewer');
}

