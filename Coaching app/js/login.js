// Login page functionality
import { API_BASE_URL, setAuthToken, getAuthToken } from './api.js';

// Check if already logged in
if (getAuthToken()) {
    window.location.href = 'index.html';
}

const form = document.getElementById('login-form');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const btnLogin = document.getElementById('btn-login');
const alertBox = document.getElementById('alert');

// Form submission
form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Clear previous errors
    clearErrors();

    // Get form values
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    // Validate
    if (!email) {
        showFieldError('email', 'Email is required');
        return;
    }

    if (!password) {
        showFieldError('password', 'Password is required');
        return;
    }

    // Disable button and show loading
    btnLogin.disabled = true;
    btnLogin.innerHTML = '<span class="loading-spinner"></span> Signing in...';

    try {
        const response = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Login failed');
        }

        // Store token and user data
        setAuthToken(data.token);
        localStorage.setItem('user', JSON.stringify(data.user));

        // Show success message
        showAlert('Login successful! Redirecting...', 'success');

        // BYPASSED: Admins now go to main app like everyone else (with extra access)
        // Admin dashboard code preserved for future use
        // Previously: admin role -> admin.html, others -> index.html
        // Now: everyone goes to index.html, admins just have more features
        setTimeout(() => {
            /* Original admin redirect - bypassed
            if (data.user.role === 'admin') {
                window.location.href = 'admin.html';
            } else {
                window.location.href = 'index.html';
            }
            */
            window.location.href = 'index.html';
        }, 1000);

    } catch (error) {
        console.error('Login error:', error);
        showAlert(error.message || 'Login failed. Please check your credentials.', 'error');
        btnLogin.disabled = false;
        btnLogin.textContent = 'Sign In';
    }
});

function showAlert(message, type) {
    alertBox.textContent = message;
    alertBox.className = `alert alert-${type} show`;
}

function showFieldError(field, message) {
    const errorEl = document.getElementById(`${field}-error`);
    errorEl.textContent = message;
    errorEl.classList.add('show');
}

function clearErrors() {
    alertBox.className = 'alert';
    document.querySelectorAll('.form-error').forEach(el => {
        el.classList.remove('show');
        el.textContent = '';
    });
}
