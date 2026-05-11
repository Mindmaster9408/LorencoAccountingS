// API configuration and helper functions
export const API_BASE_URL = '/api/coaching';

const TOKEN_KEY = 'auth_token';

// Get auth token from localStorage
export function getAuthToken() {
    return localStorage.getItem(TOKEN_KEY);
}

// Set auth token in localStorage
export function setAuthToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
}

// Remove auth token
export function clearAuthToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('user');
}

// Check if user is authenticated
export function isAuthenticated() {
    return !!getAuthToken();
}

// Get current user from localStorage
export function getCurrentUser() {
    const userStr = localStorage.getItem('user');
    return userStr ? JSON.parse(userStr) : null;
}

// Make authenticated API request
export async function apiRequest(endpoint, options = {}) {
    const token = getAuthToken();

    const config = {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    };

    // Add auth token if available
    if (token) {
        config.headers['Authorization'] = `Bearer ${token}`;
    }

    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

        // Handle 401 (unauthorized) - redirect to login or back to ecosystem
        if (response.status === 401) {
            clearAuthToken();
            const ssoSource = localStorage.getItem('sso_source');
            if (ssoSource === 'ecosystem') {
                localStorage.removeItem('sso_source');
                window.location.href = '/';
            } else {
                window.location.href = '/coaching/login.html';
            }
            throw new Error('Session expired. Please login again.');
        }

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `Request failed with status ${response.status}`);
        }

        return data;

    } catch (error) {
        console.error('API request error:', error);
        throw error;
    }
}

// Logout user
export async function logout() {
    try {
        await apiRequest('/auth/logout', { method: 'POST' });
    } catch (error) {
        console.error('Logout error:', error);
    } finally {
        const ssoSource = localStorage.getItem('sso_source');
        clearAuthToken();
        if (ssoSource === 'ecosystem') {
            localStorage.removeItem('sso_source');
            window.location.href = '/';
        } else {
            window.location.href = '/coaching/login.html';
        }
    }
}

// API helper methods
export const api = {
    // Auth
    login: (email, password) =>
        apiRequest('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        }),

    getCurrentUser: () => apiRequest('/auth/me'),

    // Clients
    getClients: (status = 'all') =>
        apiRequest(`/clients?status=${status}`),

    getClient: (clientId) =>
        apiRequest(`/clients/${clientId}`),

    createClient: (clientData) =>
        apiRequest('/clients', {
            method: 'POST',
            body: JSON.stringify(clientData)
        }),

    updateClient: (clientId, clientData) =>
        apiRequest(`/clients/${clientId}`, {
            method: 'PUT',
            body: JSON.stringify(clientData)
        }),

    updateClientGauges: (clientId, gauges) =>
        apiRequest(`/clients/${clientId}/gauges`, {
            method: 'PUT',
            body: JSON.stringify({ gauges })
        }),

    deleteClient: (clientId) =>
        apiRequest(`/clients/${clientId}`, {
            method: 'DELETE'
        }),

    // AI
    chatWithAI: (message, clientId = null) =>
        apiRequest('/ai/chat', {
            method: 'POST',
            body: JSON.stringify({ message, clientId })
        }),

    getClientInsights: (clientId) =>
        apiRequest(`/ai/insights/${clientId}`),

    // Admin
    getUsers: () => apiRequest('/admin/users'),

    getModules: () => apiRequest('/admin/modules'),

    getCoachModules: (coachId) =>
        apiRequest(`/admin/coaches/${coachId}/modules`),

    toggleModuleAccess: (coachId, moduleId, isEnabled) =>
        apiRequest(`/admin/coaches/${coachId}/modules/${moduleId}`, {
            method: 'POST',
            body: JSON.stringify({ isEnabled })
        }),

    toggleUserStatus: (userId, isActive) =>
        apiRequest(`/admin/users/${userId}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive })
        }),

    getStats: () => apiRequest('/admin/stats'),

    // Settings
    getSettings: () => apiRequest('/settings'),

    saveSettings: (settings) =>
        apiRequest('/settings', {
            method: 'PUT',
            body: JSON.stringify({ settings })
        }),

    // Assessment tokens — coach creates; client validates/submits (public endpoint)
    createAssessmentToken: (clientId, clientName) =>
        apiRequest('/assessment-tokens', {
            method: 'POST',
            body: JSON.stringify({ clientId, clientName })
        }),

    // ── Client Profile Photos (Supabase Storage) ───────────────────────────────
    // uploadClientPhoto: POSTs as multipart/form-data so the backend can receive
    // the raw file buffer via multer.  Must NOT set Content-Type — the browser
    // sets it automatically with the correct multipart boundary.
    uploadClientPhoto: (clientId, formData) => {
        const token = getAuthToken();
        return fetch(`${API_BASE_URL}/clients/${clientId}/photo`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
                // No Content-Type — browser adds multipart/form-data + boundary
            },
            body: formData
        }).then(async (res) => {
            if (res.status === 401) {
                clearAuthToken();
                window.location.href = '/coaching/login.html';
                throw new Error('Session expired. Please login again.');
            }
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Photo upload failed: ${res.status}`);
            return data;
        });
    },

    deleteClientPhoto: (clientId) =>
        apiRequest(`/clients/${clientId}/photo`, { method: 'DELETE' }),

    // Question Builder — global reusable question library
    questionBuilder: {
        listQuestions: (params = {}) => {
            const qs = new URLSearchParams();
            if (params.category)                                    qs.set('category',    params.category);
            if (params.contextKey)                                  qs.set('context_key', params.contextKey);
            if (params.active !== undefined && params.active !== '') qs.set('active',      params.active);
            const q = qs.toString() ? '?' + qs.toString() : '';
            return apiRequest(`/question-builder/questions${q}`);
        },

        createQuestion: (data) =>
            apiRequest('/question-builder/questions', {
                method: 'POST',
                body: JSON.stringify(data)
            }),

        updateQuestion: (id, data) =>
            apiRequest(`/question-builder/questions/${id}`, {
                method: 'PUT',
                body: JSON.stringify(data)
            }),

        deactivateQuestion: (id) =>
            apiRequest(`/question-builder/questions/${id}`, {
                method: 'DELETE'
            }),

        listContexts: () =>
            apiRequest('/question-builder/contexts'),

        getClientContextQuestions: (clientId, contextKey) =>
            apiRequest(`/question-builder/client/${clientId}/context/${encodeURIComponent(contextKey)}`),

        assignClientQuestions: (clientId, contextKey, questionIds) =>
            apiRequest(`/question-builder/client/${clientId}/context/${encodeURIComponent(contextKey)}/assign`, {
                method: 'POST',
                body: JSON.stringify({ questionIds })
            }),

        saveClientQuestionAnswers: (clientId, contextKey, answers) =>
            apiRequest(`/question-builder/client/${clientId}/context/${encodeURIComponent(contextKey)}/answers`, {
                method: 'PUT',
                body: JSON.stringify({ answers })
            }),

        unassignClientQuestion: (clientId, contextKey, assignmentId) =>
            apiRequest(`/question-builder/client/${clientId}/context/${encodeURIComponent(contextKey)}/assignments/${assignmentId}`, {
                method: 'DELETE'
            })
    }
};
