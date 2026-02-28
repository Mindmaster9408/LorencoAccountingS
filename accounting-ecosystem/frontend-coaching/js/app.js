// Main application initialization
import { $ } from './config.js';
import { ensureStore, readStore } from './storage.js';
import { renderDashboard, setupDashboardListeners } from './dashboard.js';
import { renderReports } from './reports.js';
import { renderLeads, setupLeadsListeners } from './leads.js';
import { renderSettings } from './settings.js';
import { isLoggedIn, getCurrentUser, isAdmin, getAdminMode } from './auth.js';
import { showLoginScreen, showUserInfo } from './login-ui.js';
import { renderAdminPanel } from './admin-panel.js';
import { startAutoBackup } from './backup.js';

// Initialize the app
function init() {
    console.log('Coaching App initializing...');

    // Check if user is logged in
    if (!isLoggedIn()) {
        console.log('No user logged in, showing login screen');
        showLoginScreen();
        return;
    }

    const currentUser = getCurrentUser();
    console.log('User logged in:', currentUser?.fullName);

    // Check if admin and in admin mode
    if (isAdmin(currentUser) && getAdminMode()) {
        console.log('Loading admin panel...');
        renderAdminPanel();
        return;
    }

    // Regular coaching app
    console.log('Loading coaching app...');

    // Ensure localStorage is set up
    ensureStore();

    // Add user info to sidebar
    addUserInfoToSidebar();

    // Update company branding
    updateCompanyBranding();

    // Setup routing
    setupRouting();

    // Setup dashboard listeners
    setupDashboardListeners();

    // Setup leads listeners
    setupLeadsListeners();

    // Setup logout button
    setupLogout();

    // Render initial view
    switchRoute('dashboard');

    // Start automatic backup system
    startAutoBackup();

    console.log('Coaching App ready!');
}

function addUserInfoToSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const brand = sidebar?.querySelector('.brand');

    if (brand) {
        const userInfoHtml = showUserInfo();
        const userInfoDiv = document.createElement('div');
        userInfoDiv.innerHTML = userInfoHtml;
        brand.insertAdjacentElement('afterend', userInfoDiv.firstElementChild);
    }
}

function setupRouting() {
    // Sidebar navigation
    document.querySelectorAll('.sidebar nav li').forEach(li => {
        li.addEventListener('click', () => {
            const route = li.dataset.route;
            
            if(route === 'clients') {
                // Toggle clients sidebar list
                toggleSidebarClients();
                return;
            }
            
            // Mark active
            document.querySelectorAll('.sidebar nav > ul > li').forEach(x => x.classList.remove('active'));
            li.classList.add('active');
            
            switchRoute(route);
        });
    });
}

function switchRoute(route) {
    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    
    // Show selected view
    const view = $(`#${route}`);
    if(view) view.classList.remove('hidden');
    
    // Update page title
    const titleEl = $('#page-title');
    if(titleEl) {
        const titleText = route.charAt(0).toUpperCase() + route.slice(1);
        titleEl.textContent = titleText;
        titleEl.style.display = route === 'clients' ? 'none' : '';
    }
    
    // Render content based on route
    if(route === 'dashboard') {
        renderDashboard();
    } else if(route === 'leads') {
        renderLeads();
    } else if(route === 'training') {
        renderTraining();
    } else if(route === 'reports') {
        renderReports();
    } else if(route === 'settings') {
        renderSettings();
    }
}

function toggleSidebarClients() {
    const list = document.getElementById('sidebar-clients-list');
    if(!list) return;
    
    if(list.classList.contains('hidden')) {
        renderSidebarClients();
        list.classList.remove('hidden');
    } else {
        list.classList.add('hidden');
    }
}

function renderSidebarClients() {
    import('./storage.js').then(storageModule => {
        const store = storageModule.readStore();
        const list = document.getElementById('sidebar-clients-list');
        if(!list) return;
        
        list.innerHTML = '';
        
        const activeClients = (store.clients || []).filter(c => !storageModule.isPast(c));
        
        if(activeClients.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'No active clients';
            li.style.opacity = '0.6';
            list.appendChild(li);
            return;
        }
        
        activeClients.slice(0, 10).forEach(client => {
            const li = document.createElement('li');
            li.textContent = client.name + (client.status ? (' — ' + client.status) : '');
            li.dataset.clientId = client.id;
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                list.querySelectorAll('li').forEach(x => x.classList.remove('active'));
                li.classList.add('active');
                
                // Open client
                import('./clients.js').then(module => {
                    module.openClient(client.id);
                });
            });
            list.appendChild(li);
        });
    });
}

function renderTraining() {
    console.log('Training view - placeholder');
    // Training module will be added later if needed
}

function setupLogout() {
    const logoutBtn = document.getElementById('logout-btn');

    if (!logoutBtn) {
        console.warn('Logout button not found');
        return;
    }

    console.log('Logout button found, attaching listener');

    logoutBtn.addEventListener('click', () => {
        console.log('Logout button clicked');

        import('./auth.js').then(authModule => {
            const currentUser = authModule.getCurrentUser();

            const confirmLogout = confirm(
                `Logout from ${currentUser.fullName}'s profile?\n\n` +
                `Your client data will be saved and available when you log back in.\n\n` +
                `You will return to the user selection screen.`
            );

            if (confirmLogout) {
                // Logout (removes current user, but keeps all data)
                authModule.logout();

                // Reload the page to show login screen
                window.location.reload();
            }
        });
    });
}

// Update company branding (logo and name) in sidebar and dashboard
function updateCompanyBranding() {
    const store = readStore();
    const settings = store.appSettings || {};
    const company = settings.company || {};

    // Update sidebar brand
    const sidebarBrand = $('#sidebar-brand');
    const sidebarBrandText = $('#sidebar-brand-text');

    if (sidebarBrand && company.logo) {
        // If logo exists, show logo with company name
        const existingLogo = sidebarBrand.querySelector('.sidebar-logo');

        if (!existingLogo) {
            const logoImg = document.createElement('img');
            logoImg.src = company.logo;
            logoImg.alt = company.name || 'Company Logo';
            logoImg.className = 'sidebar-logo';
            logoImg.style.maxHeight = '40px';
            logoImg.style.maxWidth = '150px';
            logoImg.style.objectFit = 'contain';
            logoImg.style.marginBottom = '8px';
            logoImg.style.display = 'block';

            sidebarBrand.insertBefore(logoImg, sidebarBrandText);
        } else {
            existingLogo.src = company.logo;
        }

        // Update text to company name if available
        if (company.name && sidebarBrandText) {
            sidebarBrandText.textContent = company.name;
        }
    } else if (company.name && sidebarBrandText) {
        // No logo, but company name exists
        sidebarBrandText.textContent = company.name;
    }

    // Update Control Tower branding on dashboard
    const controlBrand = $('#control-brand');
    const controlTitle = $('#control-tower-title');

    if (controlBrand && company.logo) {
        // Check if logo already exists
        const existingLogo = controlBrand.querySelector('.control-logo');

        if (!existingLogo) {
            const logoImg = document.createElement('img');
            logoImg.src = company.logo;
            logoImg.alt = company.name || 'Company Logo';
            logoImg.className = 'control-logo';
            logoImg.style.maxHeight = '60px';
            logoImg.style.maxWidth = '200px';
            logoImg.style.objectFit = 'contain';
            logoImg.style.marginRight = '20px';

            // Insert logo before the text div
            const textDiv = controlBrand.querySelector('div');
            controlBrand.insertBefore(logoImg, textDiv);
        } else {
            existingLogo.src = company.logo;
        }

        // Update title if company name exists
        if (company.name && controlTitle) {
            controlTitle.textContent = company.name;
        }
    } else if (company.name && controlTitle) {
        // No logo, but company name exists
        controlTitle.textContent = company.name;
    }
}

// Export for use in settings.js
window.updateCompanyBranding = updateCompanyBranding;

// Start the app when DOM is ready
if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
