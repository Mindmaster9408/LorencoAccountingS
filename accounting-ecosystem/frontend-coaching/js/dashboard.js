// Dashboard rendering and client cards
import { JOURNEY_STEPS, $, $all, escapeHtml } from './config.js';
import { readStore, isPast } from './storage.js';
import { JOURNEY_STEPS as JOURNEY_DATA, getJourneyProgress } from './journey-data.js';
import { api } from './api.js';

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
    const basisCode = (client.basisResults && client.basisResults.basisOrder)
        ? client.basisResults.basisOrder.join(' ')
        : null;
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
      ${client.photo_signed_url
        ? `<div class="avatar" style="overflow:hidden;padding:0;" data-initial="${escapeHtml((client.name||'')[0]||'P')}">
             <img src="${escapeHtml(client.photo_signed_url)}"
                  class="client-card-avatar-photo"
                  alt=""
                  style="width:100%;height:100%;object-fit:cover;display:block;">
           </div>`
        : `<div class="avatar">${escapeHtml((client.name||'')[0]||'P')}</div>`
      }
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
        <div class="g-badge">Fuel ${Math.round((client.gauges && client.gauges.fuel) || 0)}%</div>
        <div class="g-badge">Flow ${Math.round((client.gauges && client.gauges.horizon) || 0)}%</div>
        <div class="g-badge">Engine ${Math.round((client.gauges && client.gauges.engine) || 0)}%</div>
      </div>
      <div class="progress-bar"><i style="width:${percentComplete}%"></i></div>
      <button class="get-alink-btn" style="margin-top:10px;width:100%;padding:7px 0;background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">🔗 Assessment Link</button>
    </div>
    <div class="card-footer">Last update: ${escapeHtml(client.last_session || '—')}</div>
    <div class="card-assessment-link" id="alink-${escapeHtml(client.id)}" style="display:none; padding:8px 12px; background:#f0f9ff; border-top:1px solid #bae6fd;">
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" readonly style="flex:1;font-size:12px;padding:6px 8px;border:1px solid #bae6fd;border-radius:6px;font-family:monospace;" value="" />
        <button class="copy-alink-btn" style="font-size:12px;padding:6px 12px;background:#0369a1;color:#fff;border:none;border-radius:6px;cursor:pointer;">Copy</button>
      </div>
    </div>
  `;

    // Assessment link button — stop propagation so it doesn't open the client
    const linkBtn = card.querySelector('.get-alink-btn');
    if (linkBtn) {
        linkBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const linkBox = card.querySelector('.card-assessment-link');
            const linkInput = linkBox && linkBox.querySelector('input');
            // If already generated, just toggle visibility
            if (linkInput && linkInput.value) {
                linkBox.style.display = linkBox.style.display === 'none' ? 'block' : 'none';
                return;
            }
            const originalText = linkBtn.textContent;
            linkBtn.textContent = '...';
            linkBtn.disabled = true;
            try {
                const result = await api.createAssessmentToken(client.id, client.name);
                const base = window.location.origin + '/coaching/';
                const url = `${base}client-assessment.html?token=${result.token}`;
                if (linkInput) linkInput.value = url;
                if (linkBox) linkBox.style.display = 'block';
                linkBtn.textContent = '🔗 Link';
            } catch (err) {
                alert('Could not generate link: ' + (err.message || 'Server error'));
                linkBtn.textContent = originalText;
            } finally {
                linkBtn.disabled = false;
            }
        });
    }

    // Copy button
    const copyBtn = card.querySelector('.copy-alink-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = card.querySelector('.card-assessment-link input');
            if (!input || !input.value) return;
            navigator.clipboard.writeText(input.value).then(() => {
                const orig = copyBtn.textContent;
                copyBtn.textContent = '✓ Copied!';
                setTimeout(() => { copyBtn.textContent = orig; }, 2000);
            }).catch(() => {
                input.select();
                document.execCommand('copy');
            });
        });
    }

    card.addEventListener('click', () => {
        // Import and call openClient dynamically
        import('./clients.js?v=10').then(module => {
            module.openClient(client.id);
        });
    });

    return card;
}

export function setupDashboardListeners() {
    // Photo error fallback — if a signed URL expires during the session, revert
    // to the initial letter avatar. Uses capture phase because 'error' does not bubble.
    if (!document._avatarErrorListenerBound) {
        document._avatarErrorListenerBound = true;
        document.addEventListener('error', function(e) {
            const img = e.target;
            if (!img || img.tagName !== 'IMG' || !img.classList.contains('client-card-avatar-photo')) return;
            const avatar = img.parentElement;
            if (!avatar) return;
            // Restore the text initial — data-initial holds the pre-escaped character
            avatar.style.overflow = '';
            avatar.style.padding = '';
            avatar.removeAttribute('data-initial');
            avatar.textContent = avatar.dataset.initial || '?';
        }, true);
    }

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
            import('./clients.js?v=10').then(module => {
                module.createNewPilot();
            });
        });
    }

    // Sample client button
    const sampleBtn = $('#seed-sample');
    if(sampleBtn) {
        sampleBtn.addEventListener('click', () => {
            import('./clients.js?v=10').then(module => {
                module.addSampleClient();
            });
        });
    }
}
