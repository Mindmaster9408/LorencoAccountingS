// question-builder.js
// Global reusable question library — coach creates questions here,
// attaches them to client journeys (PGF, Four Quadrants, etc.) later.
//
// No browser storage — all data persists via /api/coaching/question-builder/*.
// In-memory state is used only for current page render.

import { api } from './api.js';

const QUESTION_TYPE_LABELS = {
    short_text:    'Short Text',
    long_text:     'Long Text',
    rating:        'Rating Scale',
    yes_no:        'Yes / No',
    single_choice: 'Single Choice',
    multi_choice:  'Multi Choice'
};

// Module-level render state — filters survive navigation away and back.
let qbState = {
    questions:       [],
    filterCategory:  '',
    filterActive:    'true'
};

// ─── Public entry point ───────────────────────────────────────────────────────

export async function renderQuestionBuilder() {
    const section = document.getElementById('question-builder');
    if (!section) return;

    section.innerHTML = buildShellHTML();

    // Restore filter selects to current state
    const catEl = document.getElementById('qb-filter-category');
    if (catEl) catEl.value = qbState.filterCategory;
    const activeEl = document.getElementById('qb-filter-active');
    if (activeEl) activeEl.value = qbState.filterActive;

    attachShellListeners();
    await loadQuestions();
}

// ─── Shell HTML ───────────────────────────────────────────────────────────────

function buildShellHTML() {
    return `
<div class="qb-header">
    <div>
        <h2 class="qb-title">Question Builder</h2>
        <p class="qb-subtitle">Create reusable coaching questions and use them across client journeys.</p>
    </div>
    <button id="qb-new-btn" class="btn-primary">+ New Question</button>
</div>

<div class="qb-pgf-note">
    Questions tagged <strong>pgf.present</strong>, <strong>pgf.gap</strong>, or <strong>pgf.future</strong>
    can later be selected inside the Present-Gap-Future coaching flow.
</div>

<div class="qb-filters">
    <select id="qb-filter-category" title="Filter by category">
        <option value="">All categories</option>
        <option value="PGF">PGF</option>
        <option value="Four Quadrants">Four Quadrants</option>
        <option value="Session">Session</option>
        <option value="Reflection">Reflection</option>
        <option value="General">General</option>
    </select>
    <select id="qb-filter-active" title="Show active or all">
        <option value="true">Active only</option>
        <option value="">All questions</option>
    </select>
</div>

<div id="qb-list" class="qb-list"></div>

<div id="qb-modal-overlay" class="qb-modal-overlay hidden">
    <div class="qb-modal" role="dialog" aria-modal="true" aria-labelledby="qb-modal-title">
        <div class="qb-modal-header">
            <h3 id="qb-modal-title">New Question</h3>
            <button id="qb-modal-close" class="qb-close-btn" title="Close" aria-label="Close">&#x2715;</button>
        </div>
        <form id="qb-form" class="qb-form" novalidate>

            <div class="qb-form-group">
                <label for="qb-question-text">Question text <span class="qb-required">*</span></label>
                <textarea id="qb-question-text" rows="3"
                    placeholder="e.g. What is the biggest gap between where you are and where you want to be?"></textarea>
            </div>

            <div class="qb-form-row">
                <div class="qb-form-group">
                    <label for="qb-question-type">Type <span class="qb-required">*</span></label>
                    <select id="qb-question-type">
                        <option value="">Select type&hellip;</option>
                        <option value="short_text">Short Text</option>
                        <option value="long_text">Long Text</option>
                        <option value="rating">Rating Scale</option>
                        <option value="yes_no">Yes / No</option>
                        <option value="single_choice">Single Choice</option>
                        <option value="multi_choice">Multi Choice</option>
                    </select>
                </div>
                <div class="qb-form-group">
                    <label for="qb-category">Category</label>
                    <select id="qb-category">
                        <option value="">None</option>
                        <option value="PGF">PGF</option>
                        <option value="Four Quadrants">Four Quadrants</option>
                        <option value="Session">Session</option>
                        <option value="Reflection">Reflection</option>
                        <option value="General">General</option>
                    </select>
                </div>
            </div>

            <div class="qb-form-row">
                <div class="qb-form-group">
                    <label for="qb-context-key">Context key</label>
                    <select id="qb-context-key">
                        <option value="">None</option>
                        <option value="pgf.present">pgf.present</option>
                        <option value="pgf.gap">pgf.gap</option>
                        <option value="pgf.future">pgf.future</option>
                        <option value="four_quadrants.goals">four_quadrants.goals</option>
                        <option value="four_quadrants.fears">four_quadrants.fears</option>
                        <option value="session.checkin">session.checkin</option>
                        <option value="session.reflection">session.reflection</option>
                        <option value="general">general</option>
                    </select>
                </div>
                <div class="qb-form-group">
                    <label for="qb-sort-order">Sort order</label>
                    <input type="number" id="qb-sort-order" value="0" min="0" />
                </div>
            </div>

            <div id="qb-rating-fields" class="qb-conditional-section hidden">
                <div class="qb-form-row">
                    <div class="qb-form-group">
                        <label for="qb-scale-min">Scale min</label>
                        <input type="number" id="qb-scale-min" value="1" />
                    </div>
                    <div class="qb-form-group">
                        <label for="qb-scale-max">Scale max</label>
                        <input type="number" id="qb-scale-max" value="10" />
                    </div>
                </div>
                <div class="qb-form-row">
                    <div class="qb-form-group">
                        <label for="qb-scale-label-min">Min label <span class="qb-hint">(optional)</span></label>
                        <input type="text" id="qb-scale-label-min" placeholder="e.g. Not at all" />
                    </div>
                    <div class="qb-form-group">
                        <label for="qb-scale-label-max">Max label <span class="qb-hint">(optional)</span></label>
                        <input type="text" id="qb-scale-label-max" placeholder="e.g. Completely" />
                    </div>
                </div>
            </div>

            <div id="qb-choice-fields" class="qb-conditional-section hidden">
                <div class="qb-form-group">
                    <label for="qb-options">
                        Options <span class="qb-required">*</span>
                        <span class="qb-hint">(one per line)</span>
                    </label>
                    <textarea id="qb-options" rows="4" placeholder="Option A&#10;Option B&#10;Option C"></textarea>
                </div>
            </div>

            <div class="qb-form-group">
                <label for="qb-help-text">Help text <span class="qb-hint">(shown below the question)</span></label>
                <input type="text" id="qb-help-text" placeholder="e.g. Think about the last 3 months" />
            </div>

            <div class="qb-form-row qb-form-row-checks">
                <label class="qb-check-label">
                    <input type="checkbox" id="qb-is-required" />
                    Required
                </label>
                <label class="qb-check-label">
                    <input type="checkbox" id="qb-is-active" checked />
                    Active
                </label>
            </div>

            <div class="qb-form-actions">
                <button type="button" id="qb-cancel-btn" class="btn-secondary">Cancel</button>
                <button type="submit" id="qb-save-btn" class="btn-primary">Save Question</button>
            </div>
        </form>
    </div>
</div>
`;
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

function attachShellListeners() {
    document.getElementById('qb-new-btn')
        ?.addEventListener('click', openCreateModal);

    document.getElementById('qb-filter-category')
        ?.addEventListener('change', e => { qbState.filterCategory = e.target.value; loadQuestions(); });

    document.getElementById('qb-filter-active')
        ?.addEventListener('change', e => { qbState.filterActive = e.target.value; loadQuestions(); });

    document.getElementById('qb-modal-close')
        ?.addEventListener('click', closeModal);

    document.getElementById('qb-cancel-btn')
        ?.addEventListener('click', closeModal);

    // Click outside the modal panel to dismiss
    document.getElementById('qb-modal-overlay')
        ?.addEventListener('click', e => { if (e.target.id === 'qb-modal-overlay') closeModal(); });

    document.getElementById('qb-question-type')
        ?.addEventListener('change', onTypeChange);

    document.getElementById('qb-form')
        ?.addEventListener('submit', onFormSubmit);
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadQuestions() {
    const listEl = document.getElementById('qb-list');
    if (!listEl) return;
    listEl.innerHTML = '<p class="qb-loading">Loading questions&hellip;</p>';

    try {
        const params = {};
        if (qbState.filterCategory) params.category = qbState.filterCategory;
        if (qbState.filterActive !== '') params.active = qbState.filterActive;

        qbState.questions = await api.questionBuilder.listQuestions(params);
        renderList();
    } catch (err) {
        console.error('[QuestionBuilder] loadQuestions error:', err);
        listEl.innerHTML = '<p class="qb-error">Failed to load questions. Please try again.</p>';
    }
}

// ─── List rendering ───────────────────────────────────────────────────────────

function renderList() {
    const listEl = document.getElementById('qb-list');
    if (!listEl) return;

    if (qbState.questions.length === 0) {
        listEl.innerHTML = `
            <div class="qb-empty">
                <div class="qb-empty-icon">&#10067;</div>
                <p>No questions yet. Create your first reusable coaching question.</p>
                <button class="btn-primary" id="qb-empty-create">+ Create Question</button>
            </div>
        `;
        document.getElementById('qb-empty-create')
            ?.addEventListener('click', openCreateModal);
        return;
    }

    listEl.innerHTML = qbState.questions.map(q => buildQuestionCard(q)).join('');

    listEl.querySelectorAll('[data-action="edit"]').forEach(btn => {
        btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.id, 10)));
    });
    listEl.querySelectorAll('[data-action="deactivate"]').forEach(btn => {
        btn.addEventListener('click', () => deactivateQuestion(parseInt(btn.dataset.id, 10)));
    });
    listEl.querySelectorAll('[data-action="activate"]').forEach(btn => {
        btn.addEventListener('click', () => activateQuestion(parseInt(btn.dataset.id, 10)));
    });
}

function buildQuestionCard(q) {
    const typeLabel = QUESTION_TYPE_LABELS[q.question_type] || q.question_type;
    const inactiveClass = q.is_active ? '' : 'qb-card-inactive';

    const statusBadge = q.is_active
        ? '<span class="qb-badge qb-badge-active">Active</span>'
        : '<span class="qb-badge qb-badge-inactive">Inactive</span>';

    const actionBtn = q.is_active
        ? `<button class="qb-btn-danger" data-action="deactivate" data-id="${q.id}">Deactivate</button>`
        : `<button class="qb-btn-secondary" data-action="activate" data-id="${q.id}">Reactivate</button>`;

    const pgfTag = q.context_key && q.context_key.startsWith('pgf.')
        ? '<span class="qb-tag-pgf" title="Tagged for Present-Gap-Future">PGF</span>'
        : '';

    const ratingInfo = q.question_type === 'rating' && q.scale_min != null && q.scale_max != null
        ? `<span class="qb-meta-chip">${q.scale_min}–${q.scale_max}</span>`
        : '';

    return `
<div class="qb-card ${inactiveClass}" data-id="${q.id}">
    <div class="qb-card-body">
        <div class="qb-card-text">${escapeHtml(q.question_text)}</div>
        <div class="qb-card-meta">
            <span class="qb-meta-chip qb-chip-type">${typeLabel}</span>
            ${ratingInfo}
            ${q.category ? `<span class="qb-meta-chip">${escapeHtml(q.category)}</span>` : ''}
            ${q.context_key ? `<span class="qb-meta-chip qb-chip-ctx">${escapeHtml(q.context_key)}</span>` : ''}
            ${pgfTag}
            ${statusBadge}
        </div>
        ${q.help_text ? `<div class="qb-card-help">${escapeHtml(q.help_text)}</div>` : ''}
    </div>
    <div class="qb-card-actions">
        <button class="qb-btn-secondary" data-action="edit" data-id="${q.id}">Edit</button>
        ${actionBtn}
    </div>
</div>
    `.trim();
}

// ─── Modal open / close ───────────────────────────────────────────────────────

let editingId = null;

function openCreateModal() {
    editingId = null;
    const title = document.getElementById('qb-modal-title');
    if (title) title.textContent = 'New Question';
    resetForm();
    document.getElementById('qb-modal-overlay')?.classList.remove('hidden');
}

function openEditModal(id) {
    const q = qbState.questions.find(x => x.id === id);
    if (!q) return;
    editingId = id;
    const title = document.getElementById('qb-modal-title');
    if (title) title.textContent = 'Edit Question';
    populateForm(q);
    document.getElementById('qb-modal-overlay')?.classList.remove('hidden');
}

function closeModal() {
    document.getElementById('qb-modal-overlay')?.classList.add('hidden');
    editingId = null;
}

// ─── Form helpers ─────────────────────────────────────────────────────────────

function resetForm() {
    document.getElementById('qb-form')?.reset();
    const isActiveEl = document.getElementById('qb-is-active');
    if (isActiveEl) isActiveEl.checked = true;
    const scaleMinEl = document.getElementById('qb-scale-min');
    if (scaleMinEl) scaleMinEl.value = '1';
    const scaleMaxEl = document.getElementById('qb-scale-max');
    if (scaleMaxEl) scaleMaxEl.value = '10';
    onTypeChange();
}

function populateForm(q) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val != null ? val : '';
    };
    set('qb-question-text', q.question_text);
    set('qb-question-type', q.question_type);
    set('qb-category',      q.category || '');
    set('qb-context-key',   q.context_key || '');
    set('qb-sort-order',    q.sort_order ?? 0);
    set('qb-help-text',     q.help_text || '');
    set('qb-scale-min',     q.scale_min ?? 1);
    set('qb-scale-max',     q.scale_max ?? 10);
    set('qb-scale-label-min', q.scale_label_min || '');
    set('qb-scale-label-max', q.scale_label_max || '');

    const opts = Array.isArray(q.options) ? q.options : [];
    set('qb-options', opts.join('\n'));

    const reqEl = document.getElementById('qb-is-required');
    if (reqEl) reqEl.checked = Boolean(q.is_required);
    const activeEl = document.getElementById('qb-is-active');
    if (activeEl) activeEl.checked = Boolean(q.is_active);

    onTypeChange();
}

function onTypeChange() {
    const type = document.getElementById('qb-question-type')?.value;
    document.getElementById('qb-rating-fields')
        ?.classList.toggle('hidden', type !== 'rating');
    document.getElementById('qb-choice-fields')
        ?.classList.toggle('hidden', type !== 'single_choice' && type !== 'multi_choice');
}

// ─── Form submit ──────────────────────────────────────────────────────────────

async function onFormSubmit(e) {
    e.preventDefault();

    const questionText = document.getElementById('qb-question-text')?.value.trim() || '';
    const questionType = document.getElementById('qb-question-type')?.value || '';

    if (!questionText) { alert('Question text is required.'); return; }
    if (!questionType) { alert('Please select a question type.'); return; }

    const optionsRaw = document.getElementById('qb-options')?.value || '';
    const options    = optionsRaw.split('\n').map(s => s.trim()).filter(Boolean);

    if ((questionType === 'single_choice' || questionType === 'multi_choice') && options.length === 0) {
        alert('Please add at least one option (one per line).');
        return;
    }

    const scaleMin = parseInt(document.getElementById('qb-scale-min')?.value, 10);
    const scaleMax = parseInt(document.getElementById('qb-scale-max')?.value, 10);

    if (questionType === 'rating' && scaleMin >= scaleMax) {
        alert('Scale min must be less than scale max.');
        return;
    }

    const payload = {
        questionText,
        questionType,
        category:      document.getElementById('qb-category')?.value    || null,
        contextKey:    document.getElementById('qb-context-key')?.value  || null,
        sortOrder:     parseInt(document.getElementById('qb-sort-order')?.value, 10) || 0,
        helpText:      document.getElementById('qb-help-text')?.value.trim() || null,
        isRequired:    document.getElementById('qb-is-required')?.checked || false,
        isActive:      document.getElementById('qb-is-active')?.checked !== false,
        scaleMin:      questionType === 'rating' ? scaleMin : null,
        scaleMax:      questionType === 'rating' ? scaleMax : null,
        scaleLabelMin: questionType === 'rating' ? (document.getElementById('qb-scale-label-min')?.value.trim() || null) : null,
        scaleLabelMax: questionType === 'rating' ? (document.getElementById('qb-scale-label-max')?.value.trim() || null) : null,
        options:       (questionType === 'single_choice' || questionType === 'multi_choice') ? options : []
    };

    const saveBtn = document.getElementById('qb-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    try {
        if (editingId) {
            await api.questionBuilder.updateQuestion(editingId, payload);
        } else {
            await api.questionBuilder.createQuestion(payload);
        }
        closeModal();
        await loadQuestions();
    } catch (err) {
        console.error('[QuestionBuilder] save error:', err);
        alert('Failed to save question: ' + (err.message || 'Unknown error'));
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Question'; }
    }
}

// ─── Question actions ─────────────────────────────────────────────────────────

async function deactivateQuestion(id) {
    if (!confirm('Deactivate this question? It will be hidden from active lists but no data is deleted.')) return;
    try {
        await api.questionBuilder.deactivateQuestion(id);
        await loadQuestions();
    } catch (err) {
        console.error('[QuestionBuilder] deactivate error:', err);
        alert('Failed to deactivate: ' + (err.message || 'Unknown error'));
    }
}

async function activateQuestion(id) {
    try {
        await api.questionBuilder.updateQuestion(id, { isActive: true });
        await loadQuestions();
    } catch (err) {
        console.error('[QuestionBuilder] activate error:', err);
        alert('Failed to reactivate: ' + (err.message || 'Unknown error'));
    }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}
