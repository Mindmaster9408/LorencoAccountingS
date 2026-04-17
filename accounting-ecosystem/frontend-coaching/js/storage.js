// Storage management - online backend only (no localStorage fallback)
import { JOURNEY_STEPS } from './config.js';
import { api } from './api.js';

export async function readStore() {
    try {
        const data = await api.getClients('all');
        return {
            clients: data.clients || [],
            training: { uploads: [], prompts: [] }
        };
    } catch (error) {
        console.error('[Coaching] readStore failed:', error.message);
        return { clients: [], training: { uploads: [], prompts: [] } };
    }
}

export async function saveClient(client) {
    if (client.id && typeof client.id === 'number') {
        await api.updateClient(client.id, client);
    } else {
        const result = await api.createClient(client);
        client.id = result.client.id;
    }
    return client;
}

export function createNewClient(name) {
    return {
        id: null,
        name: name,
        preferred_lang: 'English',
        status: 'active',
        last_session: new Date().toISOString().slice(0,10),
        summary: '',
        dream: '',
        progress: {completed: 0, total: JOURNEY_STEPS.length},
        progress_completed: 0,
        progress_total: JOURNEY_STEPS.length,
        current_step: 0,
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
        }
    };
}

export function isPast(client) {
    return client.status && (
        client.status.toLowerCase().includes('completed') ||
        client.status.toLowerCase().includes('archived')
    );
}
