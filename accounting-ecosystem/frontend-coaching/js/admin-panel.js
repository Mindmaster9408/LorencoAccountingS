// Admin Panel - User and system management

import { $, escapeHtml } from './config.js';
import { getAllUsers } from './auth.js';

export function renderAdminPanel() {
    const app = $('.app');
    if (!app) return;

    const users = getAllUsers();

    app.innerHTML = `
        <div class="admin-panel">
            <aside class="admin-sidebar">
                <div class="admin-brand">Admin Panel</div>
                <nav class="admin-nav">
                    <ul>
                        <li class="admin-nav-item active" data-section="dashboard">
                            📊 Dashboard
                        </li>
                        <li class="admin-nav-item" data-section="users">
                            👥 Users
                        </li>
                        <li class="admin-nav-item" data-section="analytics">
                            📈 Analytics
                        </li>
                        <li class="admin-nav-item" data-section="settings">
                            ⚙️ Settings
                        </li>
                    </ul>
                </nav>
                <div class="admin-sidebar-footer">
                    <button id="switch-to-coaching" class="btn-secondary">Switch to Coaching</button>
                    <button id="admin-logout" class="logout-btn">🚪 Logout</button>
                </div>
            </aside>

            <main class="admin-main">
                <header class="admin-header">
                    <h1 id="admin-section-title">Dashboard</h1>
                    <div class="admin-user-info">
                        <span>Admin: Ruan van Loggerenberg</span>
                    </div>
                </header>

                <section id="admin-content" class="admin-content">
                    ${renderAdminDashboard(users)}
                </section>
            </main>
        </div>
    `;

    attachAdminListeners();
}

function renderAdminDashboard(users) {
    const totalUsers = users.length;
    const totalClients = users.reduce((sum, user) => {
        const userDataKey = `coaching_app_store_${user.username}`;
        const userData = localStorage.getItem(userDataKey);
        if (userData) {
            const parsed = JSON.parse(userData);
            return sum + (parsed.clients?.length || 0);
        }
        return sum;
    }, 0);

    return `
        <div class="admin-dashboard">
            <div class="admin-stats">
                <div class="admin-stat-card">
                    <div class="stat-icon">👥</div>
                    <div class="stat-info">
                        <div class="stat-value">${totalUsers}</div>
                        <div class="stat-label">Total Users</div>
                    </div>
                </div>

                <div class="admin-stat-card">
                    <div class="stat-icon">📊</div>
                    <div class="stat-info">
                        <div class="stat-value">${totalClients}</div>
                        <div class="stat-label">Total Clients</div>
                    </div>
                </div>

                <div class="admin-stat-card">
                    <div class="stat-icon">💾</div>
                    <div class="stat-info">
                        <div class="stat-value">${getStorageUsage()}</div>
                        <div class="stat-label">Storage Used</div>
                    </div>
                </div>
            </div>

            <div class="admin-section">
                <h2>Recent Users</h2>
                <div class="admin-users-list">
                    ${users.slice(0, 10).map(user => `
                        <div class="admin-user-item">
                            <div class="user-avatar">${user.fullName.charAt(0).toUpperCase()}</div>
                            <div class="user-info">
                                <div class="user-name">${escapeHtml(user.fullName)}</div>
                                <div class="user-username">@${escapeHtml(user.username)}</div>
                            </div>
                            <div class="user-stats">
                                <span class="user-stat">Created: ${new Date(user.createdAt).toLocaleDateString()}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="admin-section">
                <h2>Quick Actions</h2>
                <div class="quick-actions">
                    <button class="action-btn" id="export-all-data">
                        📤 Export All Data
                    </button>
                    <button class="action-btn" id="backup-data">
                        💾 Backup Database
                    </button>
                    <button class="action-btn" id="view-logs">
                        📋 View System Logs
                    </button>
                </div>
            </div>
        </div>
    `;
}

function getStorageUsage() {
    let total = 0;
    for (let key in localStorage) {
        if (localStorage.hasOwnProperty(key)) {
            total += localStorage[key].length + key.length;
        }
    }
    return (total / 1024).toFixed(2) + ' KB';
}

function attachAdminListeners() {
    // Navigation
    document.querySelectorAll('.admin-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.admin-nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            const section = item.dataset.section;
            $('#admin-section-title').textContent = section.charAt(0).toUpperCase() + section.slice(1);

            // Render section content
            const content = $('#admin-content');
            if (content) {
                content.innerHTML = `<p>Section "${section}" - Coming soon</p>`;
            }
        });
    });

    // Switch to coaching
    $('#switch-to-coaching')?.addEventListener('click', () => {
        import('./auth.js').then(authModule => {
            authModule.setAdminMode(false);
            window.location.reload();
        });
    });

    // Logout
    $('#admin-logout')?.addEventListener('click', () => {
        if (confirm('Logout from admin panel?')) {
            import('./auth.js').then(authModule => {
                authModule.logout();
                authModule.clearAdminMode();
                window.location.reload();
            });
        }
    });

    // Quick actions
    $('#export-all-data')?.addEventListener('click', () => {
        exportAllData();
    });

    $('#backup-data')?.addEventListener('click', () => {
        alert('Backup feature coming soon');
    });

    $('#view-logs')?.addEventListener('click', () => {
        alert('System logs feature coming soon');
    });
}

function exportAllData() {
    const allData = {};

    for (let key in localStorage) {
        if (localStorage.hasOwnProperty(key)) {
            try {
                allData[key] = JSON.parse(localStorage[key]);
            } catch (e) {
                allData[key] = localStorage[key];
            }
        }
    }

    const dataStr = JSON.stringify(allData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coaching_app_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    alert('Data exported successfully!');
}
