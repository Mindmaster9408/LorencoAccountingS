/* workflows.js — Workflow Templates page for Lorenco Practice Management */

var esc = PracticeAPI.escHtml;
var _selectedTemplateId = null;
var _selectedTemplate   = null; // full template object (for defaults)
var _templates          = [];

// ── Init ──────────────────────────────────────────────────────────────────────

async function initWorkflows() {
  if (!AUTH.requireAuth()) return;
  LAYOUT.init('workflows');
  await Promise.all([loadTemplates(), loadClients(), loadTeamMembers()]);
}

// ── Data loads ────────────────────────────────────────────────────────────────

async function loadClients() {
  try {
    var res = await PracticeAPI.fetch('/api/practice/clients?is_active=true');
    if (!res.ok) return;
    var d   = await res.json();
    var opts = (d.clients || [])
      .map(function(c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; })
      .join('');
    document.getElementById('gClient').innerHTML = '<option value="">No client</option>' + opts;
  } catch (e) { /* non-fatal */ }
}

async function loadTeamMembers() {
  try {
    var res = await PracticeAPI.fetch('/api/practice/team');
    if (!res.ok) return;
    var d    = await res.json();
    var members = (d.team || d.members || []);
    var opts = members
      .filter(function(m) { return m.is_active !== false; })
      .map(function(m) {
        var label = (m.first_name || '') + ' ' + (m.last_name || '');
        return '<option value="' + m.id + '">' + esc(label.trim() || m.email || String(m.id)) + '</option>';
      })
      .join('');
    document.getElementById('gResponsible').innerHTML = '<option value="">Unassigned</option>' + opts;
  } catch (e) { /* non-fatal */ }
}

async function loadTemplates() {
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/templates');
    if (!res.ok) throw new Error('Load failed');
    var d = await res.json();
    _templates = d.templates || [];
    renderTemplates(_templates);
  } catch (e) {
    document.getElementById('workflowsWrap').innerHTML =
      '<div class="error-banner">Failed to load templates: ' + esc(e.message) + '</div>';
  }
}

function renderTemplates(list) {
  var wrap = document.getElementById('workflowsWrap');
  if (!list.length) {
    wrap.innerHTML =
      '<div class="empty">' +
        '<h3>No workflow templates</h3>' +
        '<p>Create a template to define repeatable workflows for your practice.</p>' +
        '<button type="button" class="btn btn-primary" onclick="openNewTemplate()">+ New Template</button>' +
      '</div>';
    return;
  }

  wrap.innerHTML = list.map(function(t) {
    var badges = '';
    if (t.category) {
      badges += '<span class="badge badge-blue">' + esc(t.category) + '</span>';
    }
    if (t.creates_compliance_deadline) {
      badges += '<span class="badge badge-purple">Creates Deadline</span>';
    }
    if (t.default_compliance_area) {
      badges += '<span class="badge badge-green">' + esc(t.default_compliance_area) + '</span>';
    }
    return (
      '<div class="template-card">' +
        '<div class="template-card-body">' +
          '<div class="template-card-name">' + esc(t.name) + '</div>' +
          (t.description ? '<div class="template-card-desc">' + esc(t.description) + '</div>' : '') +
          (badges ? '<div class="template-card-badges">' + badges + '</div>' : '') +
        '</div>' +
        '<div class="template-card-actions">' +
          '<button type="button" class="btn btn-ghost" onclick="openGenerateModal(' + t.id + ')">Generate</button>' +
          '<button type="button" class="btn btn-ghost" onclick="editTemplate(' + t.id + ')">Edit</button>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

// ── Navigation ────────────────────────────────────────────────────────────────

function openNewTemplate() {
  window.location.href = '/practice/workflow-template.html';
}

function editTemplate(id) {
  window.location.href = '/practice/workflow-template.html?id=' + id;
}

// ── Generate modal ────────────────────────────────────────────────────────────

function openGenerateModal(templateId) {
  _selectedTemplateId = templateId;
  _selectedTemplate   = _templates.find(function(t) { return t.id === templateId; }) || null;

  // Reset form
  document.getElementById('gClient').selectedIndex       = 0;
  document.getElementById('gStart').value                = '';
  document.getElementById('gCreateDeadline').checked     = false;
  document.getElementById('gDeadlineTitle').value        = '';
  document.getElementById('gComplianceArea').value       = '';
  document.getElementById('gDeadlineType').value         = '';
  document.getElementById('gPeriodStart').value          = '';
  document.getElementById('gPeriodEnd').value            = '';
  document.getElementById('gDueDate').value              = '';
  document.getElementById('gPriority').value             = 'normal';
  document.getElementById('gResponsible').selectedIndex  = 0;
  document.getElementById('deadlineGenSection').classList.remove('visible');

  // Pre-fill from template defaults
  var note = document.getElementById('tplDefaultsNote');
  if (_selectedTemplate) {
    var t = _selectedTemplate;
    document.getElementById('generateTitle').textContent = 'Generate — ' + t.name;

    // Pre-tick deadline checkbox and show section if template defaults it
    if (t.creates_compliance_deadline) {
      document.getElementById('gCreateDeadline').checked = true;
      document.getElementById('deadlineGenSection').classList.add('visible');
      showDueDateRequired(true);
    }

    // Pre-fill compliance defaults
    if (t.default_compliance_area)  document.getElementById('gComplianceArea').value = t.default_compliance_area;
    if (t.default_deadline_type)    document.getElementById('gDeadlineType').value    = t.default_deadline_type;
    if (t.default_deadline_title)   document.getElementById('gDeadlineTitle').value   = t.default_deadline_title;
    if (t.default_deadline_priority) document.getElementById('gPriority').value       = t.default_deadline_priority;

    // Show template defaults info banner
    var notes = [];
    if (t.creates_compliance_deadline)           notes.push('This template is configured to auto-create a deadline.');
    if (t.default_deadline_offset_days != null)  notes.push('Due date offset: +' + t.default_deadline_offset_days + ' days from ' + (t.default_deadline_offset_basis || 'anchor date') + '.');
    if (notes.length) {
      note.textContent = notes.join(' ');
      note.classList.add('visible');
    } else {
      note.classList.remove('visible');
    }
  } else {
    document.getElementById('generateTitle').textContent = 'Generate Workflow';
    note.classList.remove('visible');
  }

  document.getElementById('generateModal').classList.add('show');
}

function closeGenerateModal() {
  document.getElementById('generateModal').classList.remove('show');
  _selectedTemplateId = null;
  _selectedTemplate   = null;
}

function toggleDeadlineSection() {
  var checked = document.getElementById('gCreateDeadline').checked;
  var section = document.getElementById('deadlineGenSection');
  if (checked) {
    section.classList.add('visible');
    showDueDateRequired(true);
  } else {
    section.classList.remove('visible');
    showDueDateRequired(false);
  }
}

function showDueDateRequired(show) {
  var el = document.getElementById('gDueDateRequired');
  if (el) el.style.display = show ? '' : 'none';
}

// ── Generate submit ───────────────────────────────────────────────────────────

async function submitGenerate(e) {
  e.preventDefault();
  if (!_selectedTemplateId) return false;

  var createDeadline = document.getElementById('gCreateDeadline').checked;

  // Validate: if creating deadline and no due_date, check if template has an offset fallback
  var dueDate = document.getElementById('gDueDate').value || null;
  var templateHasOffset = _selectedTemplate && _selectedTemplate.default_deadline_offset_days != null;
  if (createDeadline && !dueDate && !templateHasOffset) {
    PracticeAPI.showToast('Please enter a due date for the compliance deadline.', true);
    document.getElementById('gDueDate').focus();
    return false;
  }

  var payload = {
    template_id: _selectedTemplateId,
    client_id:   document.getElementById('gClient').value   || null,
    start_date:  document.getElementById('gStart').value    || null,
    source_type: 'manual'
  };

  if (createDeadline) {
    var responsible = document.getElementById('gResponsible').value;
    payload.create_deadline                = true;
    payload.deadline_title                 = document.getElementById('gDeadlineTitle').value.trim() || null;
    payload.compliance_area                = document.getElementById('gComplianceArea').value || null;
    payload.deadline_type                  = document.getElementById('gDeadlineType').value  || null;
    payload.period_start                   = document.getElementById('gPeriodStart').value   || null;
    payload.period_end                     = document.getElementById('gPeriodEnd').value     || null;
    payload.due_date                       = dueDate;
    payload.priority                       = document.getElementById('gPriority').value      || 'normal';
    payload.responsible_team_member_id     = responsible ? parseInt(responsible) : null;
  }

  var btn = document.getElementById('generateSubmitBtn');
  btn.disabled    = true;
  btn.textContent = 'Generating…';

  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/generate', {
      method: 'POST',
      body:   JSON.stringify(payload)
    });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Generation failed');

    var taskCount     = d.tasks   ? d.tasks.length : 0;
    var deadlineCreated = !!d.deadline;
    var msg = 'Generated ' + taskCount + ' task' + (taskCount !== 1 ? 's' : '');
    if (deadlineCreated) msg += ' + compliance deadline';
    if (d.warning)       msg += ' (warning: ' + d.warning + ')';
    PracticeAPI.showToast(msg);
    closeGenerateModal();
  } catch (err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
    btn.disabled    = false;
    btn.textContent = 'Generate';
  }
  return false;
}

// Close modal on overlay click
document.addEventListener('click', function(e) {
  if (e.target && e.target.id === 'generateModal') closeGenerateModal();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

initWorkflows();
