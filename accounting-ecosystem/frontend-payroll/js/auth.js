// ============================================================
// Authentication & Session Management — API-backed
// ============================================================
// Converted from hardcoded credentials to REST API calls
// against the Accounting Ecosystem backend at /api/auth/*
// ============================================================

const AUTH = (function() {
    'use strict';

    const API_BASE = window.location.origin + '/api';

    async function apiRequest(method, path, body) {
        const url = API_BASE + path;
        const headers = { 'Content-Type': 'application/json' };
        const token = safeLocalStorage.getItem('token');
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const opts = { method, headers };
        if (body) opts.body = JSON.stringify(body);

        const response = await fetch(url, opts);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Request failed');
        }
        return data;
    }

    return {

        // ─── Login ───────────────────────────────────────────────────────

        login: async function(email, password) {
            try {
                const result = await apiRequest('POST', '/auth/login', {
                    username: email,
                    password: password
                });

                if (result.token) {
                    safeLocalStorage.setItem('token', result.token);

                    const user = result.user || {};
                    const companies = result.companies || [];
                    const selectedCompany = result.selectedCompany || null;

                    // Store companies list — normalize to always include a .name field
                    // (server returns company_name; all pages rely on .name)
                    const normalizedCompanies = companies.map(function(c) {
                        return Object.assign({}, c, { name: c.name || c.company_name || c.trading_name || 'Unnamed' });
                    });
                    safeLocalStorage.setItem('availableCompanies', JSON.stringify(normalizedCompanies));

                    const session = {
                        user_id: user.id,
                        email: user.email || email,
                        name: user.fullName || user.full_name || user.username,
                        role: selectedCompany ? selectedCompany.role : (user.isSuperAdmin ? 'super_admin' : null),
                        is_super_admin: user.isSuperAdmin || false,
                        company_id: selectedCompany ? selectedCompany.id : null,
                        company_ids: companies.map(function(c) { return c.id; })
                    };

                    this.setSession(session);

                    // Determine redirect
                    let redirect = 'company-selection.html';
                    if (companies.length === 1 && selectedCompany) {
                        redirect = 'company-dashboard.html';
                    } else if (companies.length === 0 && !user.isSuperAdmin) {
                        redirect = 'company-selection.html';
                    }

                    return { success: true, user: session, redirect: redirect };
                }

                return { success: false, message: 'Invalid credentials' };
            } catch(e) {
                return { success: false, message: e.message || 'Login failed' };
            }
        },

        // ─── Register ────────────────────────────────────────────────────

        register: async function(userData) {
            try {
                const result = await apiRequest('POST', '/auth/register', {
                    username: userData.email,
                    email: userData.email,
                    password: userData.password,
                    full_name: userData.name || userData.full_name,
                    role: userData.role || 'business_owner'
                });

                if (result.token) {
                    safeLocalStorage.setItem('token', result.token);
                    return { success: true, user: result.user };
                }

                return { success: true, message: 'Registration successful' };
            } catch(e) {
                return { success: false, message: e.message || 'Registration failed' };
            }
        },

        // ─── Select Company (switch active company) ──────────────────────

        selectCompany: async function(companyId) {
            try {
                const result = await apiRequest('POST', '/auth/select-company', {
                    companyId: companyId
                });

                if (result.token) {
                    safeLocalStorage.setItem('token', result.token);

                    const session = this.getSession() || {};
                    session.company_id = companyId;
                    session.company_name = result.company_name || (result.company && result.company.company_name) || '';
                    // role comes back from the server — must update session so Permissions work
                    if (result.role) session.role = result.role;
                    this.setSession(session);

                    return { success: true };
                }

                return { success: false, message: 'Failed to select company' };
            } catch(e) {
                return { success: false, message: e.message };
            }
        },

        // ─── Session Management ──────────────────────────────────────────

        setSession: function(session) {
            safeLocalStorage.setItem('session', JSON.stringify(session));
        },

        getSession: function() {
            try {
                const val = safeLocalStorage.getItem('session');
                return val ? JSON.parse(val) : null;
            } catch(e) {
                return null;
            }
        },

        isAuthenticated: function() {
            return !!safeLocalStorage.getItem('token') && !!this.getSession();
        },

        getCurrentUser: function() {
            return this.getSession();
        },

        // ─── Logout ─────────────────────────────────────────────────────

        logout: function() {
            // Try to notify server (fire and forget)
            try {
                const token = safeLocalStorage.getItem('token');
                if (token) {
                    fetch(API_BASE + '/auth/logout', {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + token }
                    }).catch(() => {});
                }
            } catch(e) {}

            safeLocalStorage.removeItem('token');
            safeLocalStorage.removeItem('session');

            // Clear cached data
            Object.keys(localStorage).forEach(function(key) {
                if (key.startsWith('cache_')) {
                    safeLocalStorage.removeItem(key);
                }
            });

            window.location.href = 'login.html';
        },

        // ─── Role Checks ────────────────────────────────────────────────

        isSuperAdmin: function() {
            const session = this.getSession();
            return session && (session.is_super_admin === true || session.role === 'super_admin');
        },

        hasRole: function(role) {
            const session = this.getSession();
            if (!session) return false;
            if (session.is_super_admin) return true;

            const ROLE_LEVELS = {
                'super_admin': 100,
                'business_owner': 95,
                'accountant': 90,
                'payroll_admin': 70,
                'store_manager': 70,
                'cashier': 20,
                'trainee': 5
            };

            const userLevel = ROLE_LEVELS[session.role] || 0;
            const requiredLevel = ROLE_LEVELS[role] || 0;
            return userLevel >= requiredLevel;
        },

        // ─── Get User's Companies ────────────────────────────────────────

        getCompanies: async function() {
            try {
                const result = await apiRequest('GET', '/auth/companies');
                const companies = result.companies || result.data || [];
                const normalized = companies.map(function(c) {
                    return Object.assign({}, c, { name: c.name || c.company_name || c.trading_name || 'Unnamed' });
                });
                safeLocalStorage.setItem('availableCompanies', JSON.stringify(normalized));
                return normalized;
            } catch(e) {
                // Fall back to cached list from login
                try {
                    return JSON.parse(safeLocalStorage.getItem('availableCompanies')) || [];
                } catch(e2) { return []; }
            }
        },

        // Synchronous version — reads from localStorage cache (used by company-selection.html)
        getCompaniesForUser: function() {
            try {
                return JSON.parse(safeLocalStorage.getItem('availableCompanies')) || [];
            } catch(e) { return []; }
        },

        // ─── Create Company via API ──────────────────────────────────────

        createCompany: async function(companyData) {
            try {
                const result = await apiRequest('POST', '/companies', {
                    company_name: companyData.name,
                    trading_name: companyData.name,
                    email: companyData.email || null
                });
                return { success: true, company: result.company || result };
            } catch(e) {
                return { success: false, message: e.message };
            }
        },

        addCompanyToUser: function() { /* handled by backend */ },
        refreshSessionCompanyIds: function() { /* handled by backend */ },

        // ─── Get Current User Info from server ───────────────────────────

        refreshUser: async function() {
            try {
                const result = await apiRequest('GET', '/auth/me');
                const user = result.user || result;

                const session = {
                    user_id: user.id,
                    email: user.email,
                    name: user.full_name || user.username,
                    role: user.role,
                    is_super_admin: user.is_super_admin,
                    company_id: user.company_id,
                    company_ids: user.company_ids || []
                };

                this.setSession(session);
                return session;
            } catch(e) {
                return null;
            }
        },

        // ─── Auth Guard — redirect if not authenticated ──────────────────

        requireAuth: function() {
            if (!this.isAuthenticated()) {
                window.location.href = 'login.html';
                return false;
            }
            return true;
        },

        requireCompany: function() {
            if (!this.requireAuth()) return false;
            const session = this.getSession();
            if (!session.company_id) {
                window.location.href = 'company-selection.html';
                return false;
            }
            return true;
        },

        requireSuperAdmin: function() {
            if (!this.requireAuth()) return false;
            if (!this.isSuperAdmin()) {
                window.location.href = 'company-dashboard.html';
                return false;
            }
            return true;
        },

        // ─── isLoggedIn — alias for isAuthenticated (used by payruns.html etc.) ──
        isLoggedIn: function() {
            return this.isAuthenticated();
        },

        // ─── getCompanyById — look up a company from the cached list ────────────
        getCompanyById: function(companyId) {
            try {
                const companies = JSON.parse(safeLocalStorage.getItem('availableCompanies')) || [];
                const c = companies.find(function(co) {
                    return String(co.id || co.company_id) === String(companyId);
                });
                if (!c) return null;
                // Normalise the .name field regardless of what the backend called it
                if (!c.name) {
                    c.name = c.company_name || c.trading_name || c.companyName || 'Unknown Company';
                }
                return c;
            } catch(e) {
                return null;
            }
        }
    };
})();
