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

        // Handle 401 (unauthorized) - redirect to login
        if (response.status === 401) {
            clearAuthToken();
            window.location.href = '/coaching/login.html';
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
        clearAuthToken();
        window.location.href = '/coaching/login.html';
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

    getStats: () => apiRequest('/admin/stats')
};
