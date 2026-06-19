/* workflow-editor.js — Template Editor for Lorenco Practice Management */

var _currentTemplate   = null;
var _editingStepId     = null;
var _reorderTimer      = null;
var _reorderLock       = false;

var esc = PracticeAPI.escHtml;

// ── Init ──────────────────────────────────────────────────────────────────────

async function initEditor() {
  if (!AUTH.requireAuth()) return;
  LAYOUT.init('workflows');

  var params = new URLSearchParams(window.location.search);
  var id = params.get('id');

  if (id) {
    await loadTemplate(id);
  } else {
    document.getElementById('pageTitle').textContent = 'New Workflow Template';
    document.getElementById('saveBtn').textContent   = 'Create Template';
    // Steps section hidden until template is saved and has an ID
  }
}

// ── Template load / save ──────────────────────────────────────────────────────

async function loadTemplate(id) {
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + id);
    if (!res.ok) throw new Error('Load failed (' + res.status + ')');
    var d = await res.json();
    populateForm(d.template);
    document.getElementById('pageTitle').textContent = d.template.name || 'Edit Template';
    document.getElementById('saveBtn').textContent = 'Save Template';
    document.getElementById('stepsSection').style.display = '';
    await loadSteps(id);
  } catch (e) {
    PracticeAPI.showToast('Failed to load template: ' + e.message, true);
  }
}

function populateForm(t) {
  _currentTemplate = t;
  document.getElementById('tName').value         = t.name        || '';
  document.getElementById('tDesc').value         = t.description || '';
  document.getElementById('tCategory').value     = t.category    || '';
  document.getElementById('tPriority').value     = t.priority    || 'normal';

  // Compliance deadline defaults
  var creates = t.creates_compliance_deadline === true;
  document.getElementById('tCreatesDeadline').checked = creates;
  document.getElementById('tDefaultComplianceArea').value  = t.default_compliance_area       || '';
  document.getElementById('tDefaultDeadlineType').value    = t.default_deadline_type         || '';
  document.getElementById('tDefaultDeadlineTitle').value   = t.default_deadline_title        || '';
  document.getElementById('tDefaultPriority').value        = t.default_deadline_priority     || 'normal';
  document.getElementById('tDefaultOffsetDays').value      = t.default_deadline_offset_days  != null ? t.default_deadline_offset_days : '';
  document.getElementById('tDefaultOffsetBasis').value     = t.default_deadline_offset_basis || 'anchor_date';

  if (creates) {
    document.getElementById('deadlineDefaultsBody').classList.add('visible');
  }
}

function toggleDeadlineDefaults() {
  var checked = document.getElementById('tCreatesDeadline').checked;
  var body = document.getElementById('deadlineDefaultsBody');
  if (checked) body.classList.add('visible');
  else body.classList.remove('visible');
}

async function saveTemplate() {
  var name = (document.getElementById('tName').value || '').trim();
  if (!name) {
    PracticeAPI.showToast('Template name is required', true);
    document.getElementById('tName').focus();
    return;
  }

  var offsetDaysRaw = document.getElementById('tDefaultOffsetDays').value;
  var offsetDays = offsetDaysRaw !== '' ? parseInt(offsetDaysRaw) : null;

  var body = {
    name:        name,
    description: document.getElementById('tDesc').value.trim(),
    category:    document.getElementById('tCategory').value    || null,
    priority:    document.getElementById('tPriority').value    || 'normal',
    // Compliance defaults
    creates_compliance_deadline:  document.getElementById('tCreatesDeadline').checked,
    default_compliance_area:      document.getElementById('tDefaultComplianceArea').value  || null,
    default_deadline_type:        document.getElementById('tDefaultDeadlineType').value    || null,
    default_deadline_title:       document.getElementById('tDefaultDeadlineTitle').value.trim() || null,
    default_deadline_priority:    document.getElementById('tDefaultPriority').value        || 'normal',
    default_deadline_offset_days: offsetDays,
    default_deadline_offset_basis: document.getElementById('tDefaultOffsetBasis').value   || 'anchor_date'
  };

  var btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    var isNew = !_currentTemplate;
    var url    = '/api/practice/workflows/templates' + (isNew ? '' : '/' + _currentTemplate.id);
    var method = isNew ? 'POST' : 'PUT';
    var res = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(body) });
    var d   = await res.json();
    if (!res.ok) throw new Error(d.error || 'Save failed');
    PracticeAPI.showToast('Template saved');
    if (isNew) {
      // Redirect to edit mode with the new ID so steps section appears
      window.location.href = '/practice/workflow-template.html?id=' + d.template.id;
    } else {
      _currentTemplate = d.template;
      document.getElementById('pageTitle').textContent = d.template.name;
      btn.disabled    = false;
      btn.textContent = 'Save Template';
    }
  } catch (err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
    btn.disabled    = false;
    btn.textContent = _currentTemplate ? 'Save Template' : 'Create Template';
  }
}

// ── Steps list ────────────────────────────────────────────────────────────────

async function loadSteps(templateId) {
  var tid = templateId || (_currentTemplate && _currentTemplate.id);
  if (!tid) return;
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + tid + '/steps');
    var d = await res.json();
    renderStepsList(d.steps || []);
  } catch (e) {
    document.getElementById('stepsList').innerHTML =
      '<div class="error-banner">Failed to load steps: ' + esc(e.message) + '</div>';
  }
}

function renderStepsList(steps) {
  var el = document.getElementById('stepsList');
  var countEl = document.getElementById('stepsCount');
  if (countEl) countEl.textContent = steps.length + ' step' + (steps.length === 1 ? '' : 's');

  if (!steps.length) {
    el.innerHTML = '<div class="empty-steps">No steps yet — click "+ Add Step" to create the first step.</div>';
    return;
  }

  el.innerHTML = steps.map(function(s) {
    var meta = [];
    if (s.priority) meta.push(s.priority);
    if (s.due_offset_days != null) meta.push('+' + s.due_offset_days + ' days');
    return '<div class="step-card" data-step-id="' + s.id + '">' +
      '<div class="step-card-drag" title="Drag to reorder">⋮⋮</div>' +
      '<div class="step-card-body">' +
        '<div class="step-card-title">' + esc(s.title) + '</div>' +
        (meta.length ? '<div class="step-card-meta">' + meta.map(esc).join(' · ') + '</div>' : '') +
        (s.description ? '<div class="step-card-meta" style="margin-top:4px;white-space:pre-line;">' + esc(s.description) + '</div>' : '') +
      '</div>' +
      '<div class="step-card-actions">' +
        '<button class="btn-ghost-sm" onclick="moveUp(' + s.id + ')" title="Move up" aria-label="Move up">↑</button>' +
        '<button class="btn-ghost-sm" onclick="moveDown(' + s.id + ')" title="Move down" aria-label="Move down">↓</button>' +
        '<button class="btn-ghost-sm" onclick="openEditStep(' + s.id + ')" aria-label="Edit step">Edit</button>' +
        '<button class="btn-danger-sm" onclick="confirmDeleteStep(' + s.id + ')" aria-label="Delete step">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Step modal ────────────────────────────────────────────────────────────────

function openAddStep() {
  _editingStepId = null;
  document.getElementById('stepModalTitle').textContent = 'Add Step';
  document.getElementById('stepSubmitBtn').textContent  = 'Add Step';
  document.getElementById('sTitle').value  = '';
  document.getElementById('sDesc').value   = '';
  document.getElementById('sOffset').value = '0';
  document.getElementById('sPriority').value = 'medium';
  document.getElementById('sRequiresReview').checked   = false;
  document.getElementById('sRequiresApproval').checked = false;
  document.getElementById('stepModal').style.display = 'flex';
  document.getElementById('sTitle').focus();
}

async function openEditStep(id) {
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates/' + _currentTemplate.id + '/steps');
    var d = await res.json();
    var s = (d.steps || []).find(function(x) { return x.id === id; });
    if (!s) { PracticeAPI.showToast('Step not found', true); return; }
    _editingStepId = id;
    document.getElementById('stepModalTitle').textContent = 'Edit Step';
    document.getElementById('stepSubmitBtn').textContent  = 'Save Step';
    document.getElementById('sTitle').value    = s.title        || '';
    document.getElementById('sDesc').value     = s.description  || '';
    document.getElementById('sOffset').value   = s.due_offset_days != null ? s.due_offset_days : '0';
    document.getElementById('sPriority').value = s.priority     || 'medium';
    document.getElementById('sRequiresReview').checked   = s.requires_review   === true;
    document.getElementById('sRequiresApproval').checked = s.requires_approval === true;
    document.getElementById('stepModal').style.display = 'flex';
    document.getElementById('sTitle').focus();
  } catch (e) {
    PracticeAPI.showToast('Failed to load step: ' + e.message, true);
  }
}

function closeStepModal() {
  document.getElementById('stepModal').style.display = 'none';
  _editingStepId = null;
}

async function submitStepForm(e) {
  e.preventDefault();
  var title = (document.getElementById('sTitle').value || '').trim();
  if (!title) { PracticeAPI.showToast('Step title is required', true); return; }

  var body = {
    title:             title,
    description:       document.getElementById('sDesc').value.trim(),
    due_offset_days:   parseInt(document.getElementById('sOffset').value || 0),
    priority:          document.getElementById('sPriority').value || 'medium',
    requires_review:   document.getElementById('sRequiresReview').checked,
    requires_approval: document.getElementById('sRequiresApproval').checked
  };

  var btn = document.getElementById('stepSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    var url, method;
    if (_editingStepId) {
      url    = '/api/practice/workflows/templates/' + _currentTemplate.id + '/steps/' + _editingStepId;
      method = 'PUT';
    } else {
      url    = '/api/practice/workflows/templates/' + _currentTemplate.id + '/steps';
      method = 'POST';
    }
    var res = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(body) });
    var d   = await res.json();
    if (!res.ok) throw new Error(d.error || 'Save failed');
    PracticeAPI.showToast(_editingStepId ? 'Step updated' : 'Step added');
    closeStepModal();
    await loadSteps();
  } catch (err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
    btn.disabled    = false;
    btn.textContent = _editingStepId ? 'Save Step' : 'Add Step';
  }
}

async function confirmDeleteStep(id) {
  if (!confirm('Delete this step? This cannot be undone.')) return;
  try {
    var res = await PracticeAPI.fetch(
      '/api/practice/workflows/templates/' + _currentTemplate.id + '/steps/' + id,
      { method: 'DELETE' }
    );
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Delete failed');
    PracticeAPI.showToast('Step deleted');
    await loadSteps();
  } catch (err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  }
}

// ── Step reorder (move up/down + debounced API call) ─────────────────────────

function moveUp(stepId) {
  if (_reorderLock) return;
  var list  = document.getElementById('stepsList');
  var card  = list.querySelector('[data-step-id="' + stepId + '"]');
  if (!card) return;
  var prev = card.previousElementSibling;
  if (prev && prev.dataset.stepId) {
    list.insertBefore(card, prev);
    scheduleReorder();
  }
}

function moveDown(stepId) {
  if (_reorderLock) return;
  var list = document.getElementById('stepsList');
  var card = list.querySelector('[data-step-id="' + stepId + '"]');
  if (!card) return;
  var next = card.nextElementSibling;
  if (next && next.dataset.stepId) {
    list.insertBefore(next, card);
    scheduleReorder();
  }
}

function scheduleReorder() {
  if (_reorderTimer) clearTimeout(_reorderTimer);
  _reorderTimer = setTimeout(sendReorder, 700);
}

async function sendReorder() {
  if (_reorderLock || !_currentTemplate) return;
  var cards  = Array.from(document.querySelectorAll('#stepsList [data-step-id]'));
  var stepIds = cards.map(function(n) { return parseInt(n.getAttribute('data-step-id')); });
  if (!stepIds.length) return;

  _reorderLock = true;
  document.getElementById('stepsList').classList.add('reorder-locked');

  try {
    var res = await PracticeAPI.fetch(
      '/api/practice/workflows/templates/' + _currentTemplate.id + '/steps/reorder',
      { method: 'PUT', body: JSON.stringify({ stepIds: stepIds }) }
    );
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Reorder failed');
    PracticeAPI.showToast('Order saved');
  } catch (err) {
    PracticeAPI.showToast('Reorder failed — ' + err.message, true);
    await loadSteps(); // reload to restore server order
  } finally {
    _reorderLock = false;
    document.getElementById('stepsList').classList.remove('reorder-locked');
  }
}

// ── Close modal on overlay click ──────────────────────────────────────────────

document.addEventListener('click', function(e) {
  if (e.target && e.target.id === 'stepModal') closeStepModal();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

initEditor();
