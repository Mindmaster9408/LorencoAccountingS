// ============================================================
// Authentication & Session Management — API-backed
// ============================================================
// Converted from hardcoded credentials to REST API calls
// against the Accounting Ecosystem backend at /api/auth/*
// ============================================================

// Safety shim: ensures safeLocalStorage is always available even if
// polyfills.js failed to load or was not deployed.
if (typeof window.safeLocalStorage === 'undefined') {
    window.safeLocalStorage = window.localStorage;
}

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
                    return { success: true, user: session };
                }

                return { success: false, message: 'Invalid credentials' };
            } catch(e) {
                return { success: false, message: e.message || 'Login failed' };
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
            try {
                const token = safeLocalStorage.getItem('token');
                if (token) {
                    fetch(API_BASE + '/auth/logout', {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + token }
                    }).catch(function() {});
                }
            } catch(e) {}

            safeLocalStorage.removeItem('token');
            safeLocalStorage.removeItem('session');

            // Redirect to ecosystem login
            window.location.href = '/';
        },

        // ─── Auth Guards ─────────────────────────────────────────────────

        requireAuth: function() {
            if (!this.isAuthenticated()) {
                window.location.href = '/';
                return false;
            }
            return true;
        },

        requireCompany: function() {
            if (!this.requireAuth()) return false;
            const session = this.getSession();
            if (!session || !session.company_id) {
                window.location.href = '/dashboard/company-selection.html';
                return false;
            }
            return true;
        },

        // ─── Role Checks ────────────────────────────────────────────────

        isSuperAdmin: function() {
            const session = this.getSession();
            return session && (session.is_super_admin === true || session.role === 'super_admin');
        },

        isLoggedIn: function() {
            return this.isAuthenticated();
        },

        getCompanyById: function(companyId) {
            try {
                const companies = JSON.parse(safeLocalStorage.getItem('availableCompanies')) || [];
                const c = companies.find(function(co) {
                    return String(co.id || co.company_id) === String(companyId);
                });
                if (!c) return null;
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
