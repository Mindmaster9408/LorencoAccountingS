// Storage management - Cloud-only via Supabase backend API
// All data lives in Supabase PostgreSQL — no localStorage for client data.
// Switch browsers freely — same data everywhere.
import { JOURNEY_STEPS } from './config.js';
import { api, isAuthenticated } from './api.js';
import { normalizeClientCoachingState } from './journey-data.js';

export async function readStore() {
    // Always fetch from Supabase backend
    try {
        const data = await api.getClients('all');
        // Normalize each client: maps DB snake_case keys to camelCase and ensures
        // all coaching sub-fields (exerciseData, journeyProgress, completedSteps, etc.)
        // are safe objects/arrays before any UI code touches them.
        const clients = (data.clients || []).map(c => normalizeClientCoachingState(c));
        return {
            clients,
            training: { uploads: [], prompts: [] }
        };
    } catch (error) {
        console.error('Failed to fetch from Supabase backend:', error);
        return { clients: [], training: { uploads: [], prompts: [] } };
    }
}

export function writeStore(state) {
    // No-op: all writes go through individual saveClient() calls to the API.
    // This function exists only for backward compatibility.
    console.log('writeStore called — data is saved via API, no local storage used.');
}

export function ensureStore() {
    // No local store to initialize — data lives in Supabase
    return { clients: [], training: { uploads: [], prompts: [] } };
}

export async function saveClient(client) {
    try {
        // Normalize before write: ensures camelCase coaching fields are populated,
        // all sub-fields (completedSteps, stepNotes, exerciseData) are safe objects/arrays,
        // and current_step is in sync with journeyProgress.currentStep.
        // This is the final safety net before any data reaches the API.
        normalizeClientCoachingState(client);

        if (client.id && typeof client.id === 'number') {
            // Update existing client in Supabase
            await api.updateClient(client.id, client);
        } else {
            // Create new client in Supabase
            const result = await api.createClient(client);
            client.id = result.client.id;
        }
        return client;
    } catch (error) {
        console.error('Failed to save client to Supabase:', error);
        throw error;
    }
}

export function createNewClient(name) {
    return {
        id: null, // Always null — Supabase assigns the ID
        name: name,
        preferred_lang: 'English',
        status: 'active',
        last_session: new Date().toISOString().slice(0,10),
        summary: '',
        dream: '',
        progress: {completed: 0, total: JOURNEY_STEPS.length},
        progress_completed: 0,
        progress_total: JOURNEY_STEPS.length,
        current_step: 1,
        steps: JOURNEY_STEPS.map(s => ({
            id: s.id,
            name: s.name,
            completed: false,
            notes: [],
            why: '',
            fields: {}
        })),
        gauges: {
            fuel: 50,
            horizon: 50,
            thrust: 50,
            engine: 50,
            compass: 50,
            weight: 50,
            positive: 50,
            negative: 50,
            nav: 50
        },
        // Initialize exercise data and journey progress for persistence
        exerciseData: {},
        journeyProgress: {
            currentStep: 1,
            completedSteps: [],
            stepNotes: {},
            stepCompletionDates: {}
        }
    };
}

export function isPast(client) {
    return client.status && (
        client.status.toLowerCase().includes('completed') ||
        client.status.toLowerCase().includes('archived')
    );
}
