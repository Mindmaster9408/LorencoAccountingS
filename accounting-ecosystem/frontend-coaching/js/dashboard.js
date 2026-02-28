// Dashboard rendering and client cards
import { JOURNEY_STEPS, $, $all, escapeHtml } from './config.js';
import { readStore, isPast } from './storage.js';
import { JOURNEY_STEPS as JOURNEY_DATA, getJourneyProgress } from './journey-data.js';

export async function renderDashboard() {
    const store = await readStore();
    const container = $('#clients-cards');
    if(!container) return;
    container.innerHTML = '';

    // Update stats
    updateStats(store);

    // Get filter
    const filter = (document.querySelector('.tabs .tab.active') || {}).dataset.filter || 'active';
    let clients = store.clients.slice().sort((a,b) => (b.last_session||'').localeCompare(a.last_session||''));
    if(filter === 'active') clients = clients.filter(c => !isPast(c));
    if(filter === 'past') clients = clients.filter(c => isPast(c));

    // Render client cards
    clients.forEach(client => {
        const card = createClientCard(client);
        container.appendChild(card);
    });
}

function updateStats(store) {
    const activeCount = (store.clients || []).filter(c => !isPast(c)).length;
    const completedCount = (store.clients || []).filter(c => isPast(c)).length;
    const progressArray = (store.clients || []).map(c => {
        if(!c.progress || !c.progress.total) return 0;
        return (c.progress.completed || 0) / c.progress.total;
    });
    const avgProgress = progressArray.length > 0
        ? Math.round((progressArray.reduce((a,b) => a+b, 0) / progressArray.length) * 100)
        : 0;

    const activeEl = $('#stat-active');
    const completedEl = $('#stat-completed');
    const avgEl = $('#stat-avg');
    const stepsEl = $('#stat-steps');

    if(activeEl) activeEl.textContent = activeCount;
    if(completedEl) completedEl.textContent = completedCount;
    if(avgEl) avgEl.textContent = avgProgress + '%';
    if(stepsEl) stepsEl.textContent = JOURNEY_STEPS.length;
}

function createClientCard(client) {
    const card = document.createElement('div');
    card.className = 'client-card';

    // Get journey progress
    const { currentStep, percentComplete, currentPhase } = getJourneyProgress(client);
    const currentStepData = JOURNEY_DATA[currentStep];

    // Get BASIS code if available
    const basisCode = client.basisResults?.basisOrder?.join(' ') || null;
    const hasBasis = !!basisCode;

    // Determine color based on language preference
    const isAfrikaans = client.preferred_lang === 'Afrikaans';
    const cardTopGradient = isAfrikaans
        ? 'linear-gradient(90deg,#36a3ff,#6c5cff)'
        : 'linear-gradient(90deg,#10b981,#059669)';

    // Determine phase name based on current phase
    const phaseNames = {
        'phase1': 'Phase 1: Discovery',
        'phase2': 'Phase 2: Transformation',
        'phase3': 'Phase 3: Mastery'
    };
    const phaseName = phaseNames[currentPhase] || 'Phase 1: Discovery';

    card.innerHTML = `
    <div class="card-top" style="background:${cardTopGradient}">
      <div class="phase-badge">${phaseName}</div>
      <div class="plane-badge">✈️</div>
      <div class="avatar">${(client.name || '')[0] || 'P'}</div>
    </div>
    <div class="card-body">
      <div class="client-name">${escapeHtml(client.name)}</div>
      ${hasBasis ? `
        <div class="basis-code-display">
          <span class="basis-label">BASIS:</span>
          <span class="basis-code">${escapeHtml(basisCode)}</span>
        </div>
      ` : ''}
      <div class="client-step">
        <span class="step-icon">${currentStepData.icon}</span>
        Step ${currentStep}: ${currentStepData.title}
      </div>
      <div class="mini-gauges">
        <div class="g-badge">Fuel ${Math.round(client.gauges?.fuel || 0)}%</div>
        <div class="g-badge">Flow ${Math.round(client.gauges?.horizon || 0)}%</div>
        <div class="g-badge">Engine ${Math.round(client.gauges?.engine || 0)}%</div>
      </div>
      <div class="progress-bar"><i style="width:${percentComplete}%"></i></div>
    </div>
    <div class="card-footer">Last update: ${escapeHtml(client.last_session || '—')}</div>
  `;

    card.addEventListener('click', () => {
        // Import and call openClient dynamically
        import('./clients.js').then(module => {
            module.openClient(client.id);
        });
    });

    return card;
}

export function setupDashboardListeners() {
    // Search functionality
    const searchInput = $('#search-pilots');
    if(searchInput && !searchInput._bound) {
        searchInput._bound = true;
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim().toLowerCase();
            document.querySelectorAll('.client-card').forEach(card => {
                const name = card.querySelector('.client-name').textContent.toLowerCase();
                card.style.display = name.includes(query) ? '' : 'none';
            });
        });
    }

    // Tab filters
    document.querySelectorAll('.tabs .tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderDashboard();
        });
    });

    // Filter dropdown
    const filterSelect = $('#filter-type');
    if(filterSelect) {
        filterSelect.addEventListener('change', renderDashboard);
    }

    // New pilot button
    const newPilotBtn = $('#new-pilot');
    if(newPilotBtn) {
        newPilotBtn.addEventListener('click', () => {
            import('./clients.js').then(module => {
                module.createNewPilot();
            });
        });
    }

    // Sample client button
    const sampleBtn = $('#seed-sample');
    if(sampleBtn) {
        sampleBtn.addEventListener('click', () => {
            import('./clients.js').then(module => {
                module.addSampleClient();
            });
        });
    }
}
