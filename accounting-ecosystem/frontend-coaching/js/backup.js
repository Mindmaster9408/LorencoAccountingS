// Automatic Backup System for Client Data
import { getCurrentUser } from './auth.js';

const BACKUP_KEY_PREFIX = 'coaching_backup_';
const AUTO_BACKUP_INTERVAL = 5 * 60 * 1000; // Auto-backup every 5 minutes
const MAX_BACKUPS = 10; // Keep last 10 automatic backups

// Start automatic backup system
export function startAutoBackup() {
    console.log('Starting automatic backup system...');

    // Initial backup
    createAutoBackup();

    // Schedule regular backups
    setInterval(() => {
        createAutoBackup();
    }, AUTO_BACKUP_INTERVAL);
}

// Create automatic backup
function createAutoBackup() {
    try {
        const currentUser = getCurrentUser();
        if (!currentUser) return;

        const userStorageKey = `coaching_app_store_${currentUser.username}`;
        const userData = localStorage.getItem(userStorageKey);

        if (!userData) return;

        // Create backup with timestamp
        const timestamp = Date.now();
        const backupKey = `${BACKUP_KEY_PREFIX}${currentUser.username}_${timestamp}`;

        // Store backup
        localStorage.setItem(backupKey, userData);

        // Clean old backups
        cleanOldBackups(currentUser.username);

        console.log(`Auto-backup created: ${new Date(timestamp).toLocaleString()}`);
    } catch (error) {
        console.error('Auto-backup failed:', error);
    }
}

// Clean old backups (keep only MAX_BACKUPS most recent)
function cleanOldBackups(username) {
    try {
        const backupKeys = Object.keys(localStorage)
            .filter(key => key.startsWith(`${BACKUP_KEY_PREFIX}${username}_`))
            .sort()
            .reverse(); // Most recent first

        // Remove old backups
        if (backupKeys.length > MAX_BACKUPS) {
            backupKeys.slice(MAX_BACKUPS).forEach(key => {
                localStorage.removeItem(key);
            });
        }
    } catch (error) {
        console.error('Error cleaning old backups:', error);
    }
}

// Get all backups for current user
export function getAllBackups() {
    const currentUser = getCurrentUser();
    if (!currentUser) return [];

    const backupKeys = Object.keys(localStorage)
        .filter(key => key.startsWith(`${BACKUP_KEY_PREFIX}${currentUser.username}_`))
        .sort()
        .reverse(); // Most recent first

    return backupKeys.map(key => {
        const timestamp = parseInt(key.split('_').pop());
        const data = localStorage.getItem(key);

        let clientCount = 0;
        try {
            const parsed = JSON.parse(data);
            clientCount = parsed.clients?.length || 0;
        } catch(e) {}

        return {
            key,
            timestamp,
            date: new Date(timestamp),
            clientCount,
            size: new Blob([data]).size
        };
    });
}

// Restore from backup
export function restoreFromBackup(backupKey) {
    try {
        const currentUser = getCurrentUser();
        if (!currentUser) {
            throw new Error('No user logged in');
        }

        const backupData = localStorage.getItem(backupKey);
        if (!backupData) {
            throw new Error('Backup not found');
        }

        // Restore to current user's storage
        const userStorageKey = `coaching_app_store_${currentUser.username}`;
        localStorage.setItem(userStorageKey, backupData);

        console.log('Backup restored successfully');
        return true;
    } catch (error) {
        console.error('Restore failed:', error);
        throw error;
    }
}

// Export all data as downloadable JSON file
export function exportToFile() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;

    const userStorageKey = `coaching_app_store_${currentUser.username}`;
    const userData = localStorage.getItem(userStorageKey);

    if (!userData) {
        alert('No data to export');
        return;
    }

    try {
        // Create JSON file
        const blob = new Blob([userData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        // Create download link
        const a = document.createElement('a');
        a.href = url;
        a.download = `coaching-app-backup-${currentUser.username}-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('Data exported to file');
    } catch (error) {
        console.error('Export failed:', error);
        alert('Export failed: ' + error.message);
    }
}

// Import data from JSON file
export function importFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                const data = e.target.result;

                // Validate JSON
                const parsed = JSON.parse(data);

                if (!parsed.clients || !Array.isArray(parsed.clients)) {
                    throw new Error('Invalid backup file format');
                }

                const currentUser = getCurrentUser();
                if (!currentUser) {
                    throw new Error('No user logged in');
                }

                // Import to current user's storage
                const userStorageKey = `coaching_app_store_${currentUser.username}`;
                localStorage.setItem(userStorageKey, data);

                console.log('Data imported successfully');
                resolve(parsed.clients.length);
            } catch (error) {
                console.error('Import failed:', error);
                reject(error);
            }
        };

        reader.onerror = () => {
            reject(new Error('Failed to read file'));
        };

        reader.readAsText(file);
    });
}

// Manual backup trigger
export function createManualBackup() {
    createAutoBackup();
    alert('Manual backup created successfully!');
}

// Get storage statistics
export function getStorageStats() {
    const currentUser = getCurrentUser();
    if (!currentUser) return null;

    const userStorageKey = `coaching_app_store_${currentUser.username}`;
    const userData = localStorage.getItem(userStorageKey);

    if (!userData) return null;

    try {
        const parsed = JSON.parse(userData);
        const backups = getAllBackups();

        return {
            clientCount: parsed.clients?.length || 0,
            dataSize: new Blob([userData]).size,
            backupCount: backups.length,
            lastBackup: backups[0]?.date || null,
            totalBackupSize: backups.reduce((sum, b) => sum + b.size, 0)
        };
    } catch(e) {
        return null;
    }
}
