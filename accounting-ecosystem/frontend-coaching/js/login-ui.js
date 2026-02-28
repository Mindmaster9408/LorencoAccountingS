// Login UI - User selection and registration

import { $ } from './config.js';
import { getAllUsers, login, registerUser, getCurrentUser, logout } from './auth.js';

export function showLoginScreen() {
    const app = $('.app');
    if (!app) return;

    const users = getAllUsers();

    app.innerHTML = `
        <div class="login-container">
            <div class="login-box">
                <div class="login-header">
                    <h1>Coaching App</h1>
                    <p>Select your profile or create a new one</p>
                </div>

                <div class="user-list" id="user-list">
                    ${users.length > 0 ? renderUserList(users) : '<p class="no-users">No users yet. Create your first profile below.</p>'}
                </div>

                <div class="login-divider">or</div>

                <div class="new-user-form">
                    <h3>Create New Profile</h3>
                    <input
                        type="text"
                        id="new-username"
                        placeholder="Username (e.g., john_doe)"
                        autocomplete="off"
                    />
                    <input
                        type="text"
                        id="new-fullname"
                        placeholder="Full Name (e.g., John Doe)"
                        autocomplete="off"
                    />
                    <button id="create-user-btn" class="btn-primary">Create Profile</button>
                </div>

                ${users.length > 0 ? `
                    <div class="login-footer">
                        <button id="manage-users-btn" class="btn-secondary">Manage Profiles</button>
                    </div>
                ` : ''}

                <div class="admin-login-section">
                    <div class="login-divider">admin access</div>
                    <button id="admin-login-btn" class="btn-admin">Admin Login</button>
                </div>
            </div>
        </div>
    `;

    attachLoginListeners();
}

function renderUserList(users) {
    return `
        <div class="users-grid">
            ${users.map(user => `
                <div class="user-card" data-username="${user.username}">
                    <div class="user-avatar">${user.fullName.charAt(0).toUpperCase()}</div>
                    <div class="user-info">
                        <div class="user-name">${user.fullName}</div>
                        <div class="user-username">@${user.username}</div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function attachLoginListeners() {
    // User card clicks
    const userCards = document.querySelectorAll('.user-card');
    userCards.forEach(card => {
        card.addEventListener('click', () => {
            const username = card.dataset.username;
            try {
                login(username);
                // Reload page to show main app
                window.location.reload();
            } catch (error) {
                alert('Login failed: ' + error.message);
            }
        });
    });

    // Create user button
    const createBtn = $('#create-user-btn');
    if (createBtn) {
        createBtn.addEventListener('click', () => {
            const username = $('#new-username')?.value.trim();
            const fullName = $('#new-fullname')?.value.trim();

            if (!username || !fullName) {
                alert('Please enter both username and full name');
                return;
            }

            // Validate username format
            if (!/^[a-z0-9_]+$/.test(username)) {
                alert('Username can only contain lowercase letters, numbers, and underscores');
                return;
            }

            try {
                registerUser(username, fullName);
                login(username);
                // Reload page to show main app
                window.location.reload();
            } catch (error) {
                alert('Registration failed: ' + error.message);
            }
        });
    }

    // Enter key to create user
    const usernameInput = $('#new-username');
    const fullnameInput = $('#new-fullname');

    [usernameInput, fullnameInput].forEach(input => {
        if (input) {
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    createBtn?.click();
                }
            });
        }
    });

    // Manage users button
    const manageBtn = $('#manage-users-btn');
    if (manageBtn) {
        manageBtn.addEventListener('click', () => {
            showManageUsersDialog();
        });
    }

    // Admin login button
    const adminBtn = $('#admin-login-btn');
    if (adminBtn) {
        adminBtn.addEventListener('click', () => {
            showAdminLoginDialog();
        });
    }
}

function showAdminLoginDialog() {
    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay';
    dialog.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2>Admin Login</h2>
                <button class="modal-close" id="close-admin-modal">×</button>
            </div>
            <div class="modal-body">
                <div class="admin-login-form">
                    <input
                        type="text"
                        id="admin-username"
                        placeholder="Email"
                        value="ruanvlog@lorenco.co.za"
                        readonly
                        style="background: #f1f5f9;"
                    />
                    <input
                        type="password"
                        id="admin-password"
                        placeholder="Password"
                        autocomplete="off"
                    />
                    <button id="admin-login-submit" class="btn-primary">Login as Admin</button>
                    <div id="admin-login-error" class="error-message" style="display: none;"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(dialog);

    // Close button
    $('#close-admin-modal')?.addEventListener('click', () => {
        dialog.remove();
    });

    // Focus password field
    const passwordInput = $('#admin-password');
    passwordInput?.focus();

    // Submit on Enter
    passwordInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            $('#admin-login-submit')?.click();
        }
    });

    // Login button
    $('#admin-login-submit')?.addEventListener('click', () => {
        const password = passwordInput?.value;
        const errorDiv = $('#admin-login-error');

        if (!password) {
            errorDiv.textContent = 'Please enter password';
            errorDiv.style.display = 'block';
            return;
        }

        try {
            import('./auth.js').then(authModule => {
                authModule.loginAdmin(password);
                dialog.remove();
                // Show admin choice screen
                showAdminChoiceScreen();
            });
        } catch (error) {
            errorDiv.textContent = 'Invalid password';
            errorDiv.style.display = 'block';
            passwordInput.value = '';
            passwordInput.focus();
        }
    });

    // Click outside to close
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            dialog.remove();
        }
    });
}

function showAdminChoiceScreen() {
    const app = $('.app');
    if (!app) return;

    app.innerHTML = `
        <div class="admin-choice-container">
            <div class="admin-choice-box">
                <div class="admin-choice-header">
                    <h1>Welcome, Admin</h1>
                    <p>Choose how you want to proceed</p>
                </div>

                <div class="choice-cards">
                    <div class="choice-card" id="choice-admin-panel">
                        <div class="choice-icon">⚙️</div>
                        <h3>Admin Panel</h3>
                        <p>Manage users, view analytics, and configure system settings</p>
                        <button class="btn-primary">Go to Admin Panel</button>
                    </div>

                    <div class="choice-card" id="choice-coaching">
                        <div class="choice-icon">👥</div>
                        <h3>Coaching Program</h3>
                        <p>Work with clients, conduct assessments, and generate reports</p>
                        <button class="btn-primary">Go to Coaching</button>
                    </div>
                </div>

                <div class="choice-footer">
                    <button id="logout-from-choice" class="btn-secondary">Logout</button>
                </div>
            </div>
        </div>
    `;

    // Admin panel choice
    $('#choice-admin-panel')?.addEventListener('click', () => {
        import('./auth.js').then(authModule => {
            authModule.setAdminMode(true);
            window.location.reload();
        });
    });

    // Coaching choice
    $('#choice-coaching')?.addEventListener('click', () => {
        import('./auth.js').then(authModule => {
            authModule.setAdminMode(false);
            window.location.reload();
        });
    });

    // Logout button
    $('#logout-from-choice')?.addEventListener('click', () => {
        import('./auth.js').then(authModule => {
            authModule.logout();
            authModule.clearAdminMode();
            window.location.reload();
        });
    });
}

function showManageUsersDialog() {
    const users = getAllUsers();

    const dialog = document.createElement('div');
    dialog.className = 'modal-overlay';
    dialog.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2>Manage User Profiles</h2>
                <button class="modal-close" id="close-modal">×</button>
            </div>
            <div class="modal-body">
                <div class="manage-users-list">
                    ${users.map(user => `
                        <div class="manage-user-item">
                            <div class="user-avatar-small">${user.fullName.charAt(0).toUpperCase()}</div>
                            <div class="user-details">
                                <div class="user-name">${user.fullName}</div>
                                <div class="user-username">@${user.username}</div>
                                <div class="user-created">Created: ${new Date(user.createdAt).toLocaleDateString()}</div>
                            </div>
                            <button class="btn-danger-small delete-user-btn" data-username="${user.username}">Delete</button>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(dialog);

    // Close button
    $('#close-modal')?.addEventListener('click', () => {
        dialog.remove();
    });

    // Delete user buttons
    dialog.querySelectorAll('.delete-user-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const username = btn.dataset.username;
            const user = users.find(u => u.username === username);

            const confirmDelete = confirm(
                `Delete user "${user.fullName}" (@${username})?\n\n` +
                `This will permanently delete ALL client data for this user.\n\n` +
                `This action CANNOT be undone!`
            );

            if (confirmDelete) {
                import('./auth.js').then(authModule => {
                    authModule.deleteUser(username);
                    alert('User deleted successfully');
                    dialog.remove();
                    showLoginScreen(); // Refresh login screen
                });
            }
        });
    });

    // Click outside to close
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) {
            dialog.remove();
        }
    });
}

export function showUserInfo() {
    const currentUser = getCurrentUser();
    if (!currentUser) return '';

    return `
        <div class="current-user-info">
            <div class="user-avatar-tiny">${currentUser.fullName.charAt(0).toUpperCase()}</div>
            <span class="user-name-tiny">${currentUser.fullName}</span>
        </div>
    `;
}
