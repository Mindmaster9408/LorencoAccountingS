// User Authentication and Management

const USERS_KEY = 'coaching_app_users';
const CURRENT_USER_KEY = 'coaching_app_current_user';
const ADMIN_MODE_KEY = 'coaching_app_admin_mode';

// Admin credentials
const ADMIN_USER = {
    username: 'ruanvlog@lorenco.co.za',
    password: 'Mindmaster@277477',
    fullName: 'Ruan van Loggerenberg (Admin)',
    isAdmin: true
};

// Get all registered users
export function getAllUsers() {
    const usersJson = localStorage.getItem(USERS_KEY);
    return usersJson ? JSON.parse(usersJson) : [];
}

// Save users list
function saveUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

// Get current logged-in user
export function getCurrentUser() {
    const username = localStorage.getItem(CURRENT_USER_KEY);
    if (!username) return null;

    // Check if admin
    if (username === ADMIN_USER.username) {
        return {
            username: ADMIN_USER.username,
            fullName: ADMIN_USER.fullName,
            isAdmin: true
        };
    }

    const users = getAllUsers();
    return users.find(u => u.username === username) || null;
}

// Set current user
export function setCurrentUser(username) {
    localStorage.setItem(CURRENT_USER_KEY, username);
}

// Register a new user
export function registerUser(username, fullName) {
    if (!username || !fullName) {
        throw new Error('Username and full name are required');
    }

    const users = getAllUsers();

    // Check if username already exists
    if (users.find(u => u.username === username)) {
        throw new Error('Username already exists');
    }

    const newUser = {
        username: username.toLowerCase().trim(),
        fullName: fullName.trim(),
        createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);

    return newUser;
}

// Login user
export function login(username) {
    const users = getAllUsers();
    const user = users.find(u => u.username === username.toLowerCase().trim());

    if (!user) {
        throw new Error('User not found');
    }

    setCurrentUser(user.username);
    return user;
}

// Logout current user
export function logout() {
    localStorage.removeItem(CURRENT_USER_KEY);
}

// Delete a user and all their data
export function deleteUser(username) {
    const users = getAllUsers();
    const filteredUsers = users.filter(u => u.username !== username);

    saveUsers(filteredUsers);

    // Delete user's data
    const userDataKey = `coaching_app_store_${username}`;
    localStorage.removeItem(userDataKey);

    // If deleting current user, logout
    const currentUser = getCurrentUser();
    if (currentUser && currentUser.username === username) {
        logout();
    }
}

// Check if user is logged in
export function isLoggedIn() {
    return getCurrentUser() !== null;
}

// Get user-specific storage key
export function getUserStorageKey(username) {
    return `coaching_app_store_${username || getCurrentUser()?.username}`;
}

// Admin-specific functions
export function isAdmin(user) {
    return user?.isAdmin === true || user?.username === ADMIN_USER.username;
}

export function loginAdmin(password) {
    if (password !== ADMIN_USER.password) {
        throw new Error('Invalid admin password');
    }

    setCurrentUser(ADMIN_USER.username);
    return {
        username: ADMIN_USER.username,
        fullName: ADMIN_USER.fullName,
        isAdmin: true
    };
}

export function setAdminMode(isAdminMode) {
    localStorage.setItem(ADMIN_MODE_KEY, isAdminMode ? 'true' : 'false');
}

export function getAdminMode() {
    return localStorage.getItem(ADMIN_MODE_KEY) === 'true';
}

export function clearAdminMode() {
    localStorage.removeItem(ADMIN_MODE_KEY);
}
