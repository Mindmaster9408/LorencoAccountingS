/* tasks.js — Lorenco Practice Management — Task List & Review/Approval Flow */

var _allClients     = [];
var _allUsers       = [];   // team members with user_id (for assigned_to select)
var _allMembers     = [];   // ALL team members with id (for review selects)
var _currentTaskId  = null;
var _reviewTaskId   = null; // task currently open in a review action modal
var _page           = 1;
var PAGE_SIZE       = 25;

var esc = PracticeAPI.escHtml;

// ── Status/priority helpers ───────────────────────────────────────────────────

var STATUS_LABELS = {
  open:        'Open',
  in_progress: 'In Progress',
  review:      'In Review',
  completed:   'Completed',
  cancelled:   'Cancelled'
};

var STATUS_CLASSES = {
  open:        'status-open',
  in_progress: 'status-in-progress',
  review:      'status-review',
  completed:   'status-completed',
  cancelled:   'status-cancelled'
};

var PRIORITY_LABELS = {
  urgent: 'Urgent',
  high:   'High',
  medium: 'Medium',
  low:    'Low'
};

var PRIORITY_CLASSES = {
  urgent: 'priority-urgent',
  high:   'priority-high',
  medium: 'priority-medium',
  low:    'priority-low'
};

var QA_STATUS_LABELS = {
  none:           null,
  required:       'QA Required',
  pending_review: 'Pending Review',
  rejected:       'Rejected',
  approved:       'QA Approved',
  locked:         'QA Locked'
};

var QA_STATUS_CLASSES = {
  required:       'badge-qa-required',
  pending_review: 'badge-qa-pending',
  rejected:       'badge-qa-rejected',
  approved:       'badge-qa-approved',
  locked:         'badge-qa-locked'
};

var REVIEW_STATUS_LABELS = {
  not_required: null,
  pending:      'Review Pending',
  in_review:    'In Review',
  approved:     'Review Approved',
  rejected:     'Review Rejected'
};

var REVIEW_STATUS_CLASSES = {
  pending:   'badge-review-pending',
  in_review: 'badge-review-inrev',
  approved:  'badge-review-approved',
  rejected:  'badge-review-rejected'
};

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  if (!AUTH.requireAuth()) return;
  LAYOUT.init('tasks');
  await Promise.all([loadClients(), loadUsers()]);
  await loadTeamMembersForReview();
  await loadTasks();
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadClients() {
  try {
    var res = await PracticeAPI.fetch('/api/practice/clients?limit=500');
    var d   = await res.json();
    _allClients = d.clients || [];
    var sel = document.getElementById('fClient');
    var modalSel = document.getElementById('tClient');
    var opts = '<option value="">All Clients</option>' +
      _allClients.map(function(c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    if (sel) sel.innerHTML = opts;
    if (modalSel) {
      modalSel.innerHTML = '<option value="">None</option>' +
        _allClients.map(function(c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    }
  } catch (e) {
    console.error('loadClients error:', e);
  }
}

async function loadUsers() {
  // Team members with user accounts — used for "Assigned To" (uses user_id as value)
  try {
    var res = await PracticeAPI.fetch('/api/practice/team?limit=200');
    var d   = await res.json();
    _allUsers = (d.members || []).filter(function(m) {
      return m.user_id && m.can_receive_tasks !== false;
    });
    var fSel = document.getElementById('fAssigned');
    if (fSel) {
      fSel.innerHTML = '<option value="">All Assignees</option>' +
        _allUsers.map(function(m) {
          return '<option value="' + m.user_id + '">' + esc(m.display_name || m.email) + '</option>';
        }).join('');
    }
    var modalSel = document.getElementById('tAssigned');
    if (modalSel) {
      modalSel.innerHTML = '<option value="">Unassigned</option>' +
        _allUsers.map(function(m) {
          return '<option value="' + m.user_id + '">' + esc(m.display_name || m.email) + '</option>';
        }).join('');
    }
  } catch (e) {
    console.error('loadUsers error:', e);
  }
}

async function loadTeamMembersForReview() {
  // ALL active team members — used for preparer/reviewer/approver selects (uses m.id as value)
  try {
    var res = await PracticeAPI.fetch('/api/practice/team?limit=200');
    var d   = await res.json();
    _allMembers = (d.members || []).filter(function(m) { return m.is_active !== false; });
    var memberOpts = '<option value="">Unassigned</option>' +
      _allMembers.map(function(m) {
        return '<option value="' + m.id + '">' + esc(m.display_name || m.email) + '</option>';
      }).join('');
    ['tPreparer', 'tReviewer', 'tApprover'].forEach(function(selId) {
      var el = document.getElementById(selId);
      if (el) el.innerHTML = memberOpts;
    });
  } catch (e) {
    console.error('loadTeamMembersForReview error:', e);
  }
}

// ── Task list ─────────────────────────────────────────────────────────────────

async function loadTasks(resetPage) {
  if (resetPage) _page = 1;
  var wrap = document.getElementById('tasksWrap');
  wrap.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading tasks…</p></div>';

  var params = new URLSearchParams();
  params.set('page',     _page);
  params.set('limit',    PAGE_SIZE);
  var fStatus   = document.getElementById('fStatus');
  var fQaStatus = document.getElementById('fQaStatus');
  var fClient   = document.getElementById('fClient');
  var fType     = document.getElementById('fType');
  var fAssigned = document.getElementById('fAssigned');
  if (fStatus   && fStatus.value)   params.set('status',     fStatus.value);
  if (fQaStatus && fQaStatus.value) params.set('qa_status',  fQaStatus.value);
  if (fClient   && fClient.value)   params.set('client_id',  fClient.value);
  if (fType     && fType.value)     params.set('type',       fType.value);
  if (fAssigned && fAssigned.value) params.set('assigned_to', fAssigned.value);

  try {
    var res = await PracticeAPI.fetch('/api/practice/tasks?' + params.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    renderTasks(d.tasks || [], d.total || 0);
  } catch (e) {
    wrap.innerHTML = '<div class="error-banner">Failed to load tasks: ' + esc(e.message) + '</div>';
  }
}

function renderTasks(tasks, total) {
  var wrap = document.getElementById('tasksWrap');

  if (!tasks.length) {
    wrap.innerHTML = '<div class="empty-state"><p>No tasks found. Adjust filters or add a new task.</p></div>';
    return;
  }

  var html = '<div class="task-grid">';
  tasks.forEach(function(t) {
    var clientName = (t.practice_clients && t.practice_clients.name) ? esc(t.practice_clients.name) : '';
    var assigneeName = getUserName(t.assigned_to);
    var overdue = t.due_date && t.status !== 'completed' && t.status !== 'cancelled' &&
      new Date(t.due_date) < new Date();
    var dueDateStr = t.due_date ? formatDate(t.due_date) : '';

    // Status badge
    var statusBadge = '<span class="badge ' + (STATUS_CLASSES[t.status] || '') + '">' +
      esc(STATUS_LABELS[t.status] || t.status) + '</span>';

    // Priority badge
    var priClass = PRIORITY_CLASSES[t.priority] || '';
    var priBadge = t.priority ? '<span class="badge ' + priClass + '">' + esc(PRIORITY_LABELS[t.priority] || t.priority) + '</span>' : '';

    // Overdue badge
    var overdueBadge = overdue ? '<span class="badge badge-overdue">Overdue</span>' : '';

    // QA/Review badges
    var qaBadge = '';
    if (t.qa_status && t.qa_status !== 'none' && QA_STATUS_LABELS[t.qa_status]) {
      qaBadge = '<span class="badge ' + (QA_STATUS_CLASSES[t.qa_status] || '') + '">' +
        esc(QA_STATUS_LABELS[t.qa_status]) + '</span>';
    }
    var reviewBadge = '';
    if (t.review_status && t.review_status !== 'not_required' && REVIEW_STATUS_LABELS[t.review_status]) {
      reviewBadge = '<span class="badge ' + (REVIEW_STATUS_CLASSES[t.review_status] || '') + '">' +
        esc(REVIEW_STATUS_LABELS[t.review_status]) + '</span>';
    }

    // QA locked indicator
    var lockedStr = t.qa_locked ? '<span style="font-size:11px;color:var(--accent);margin-left:4px;" title="QA Locked">🔒</span>' : '';

    // Meta line
    var metaParts = [];
    if (t.type) metaParts.push(esc(t.type.replace(/_/g, ' ')));
    if (clientName) metaParts.push(clientName);
    if (assigneeName) metaParts.push(esc(assigneeName));

    // Review actions row
    var reviewActions = buildReviewActions(t);

    html += '<div class="task-card" data-task-id="' + t.id + '">' +
      '<div class="task-card-header">' +
        '<div class="task-badges">' + statusBadge + priBadge + overdueBadge + qaBadge + reviewBadge + '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;">' +
          '<button class="btn-ghost-sm" onclick="openTaskModal(' + t.id + ')" aria-label="Edit task">Edit</button>' +
        '</div>' +
      '</div>' +
      '<div class="task-card-title">' + esc(t.title) + lockedStr + '</div>' +
      (metaParts.length ? '<div class="task-card-meta">' + metaParts.join(' · ') + '</div>' : '') +
      (dueDateStr ? '<div class="task-card-meta">Due: ' + dueDateStr + '</div>' : '') +
      (t.description ? '<div class="task-card-desc">' + esc(t.description.substring(0, 120)) + (t.description.length > 120 ? '…' : '') + '</div>' : '') +
      (reviewActions ? '<div class="task-review-actions">' + reviewActions + '</div>' : '') +
    '</div>';
  });
  html += '</div>';

  // Pagination
  if (total > PAGE_SIZE) {
    var pages = Math.ceil(total / PAGE_SIZE);
    html += '<div class="pagination">';
    if (_page > 1) {
      html += '<button class="btn btn-ghost btn-sm" onclick="goPage(' + (_page - 1) + ')">← Prev</button>';
    }
    html += '<span style="color:var(--text-muted);font-size:13px;">Page ' + _page + ' of ' + pages + ' (' + total + ' total)</span>';
    if (_page < pages) {
      html += '<button class="btn btn-ghost btn-sm" onclick="goPage(' + (_page + 1) + ')">Next →</button>';
    }
    html += '</div>';
  }

  wrap.innerHTML = html;
}

function buildReviewActions(t) {
  if (!t.review_required && !t.approval_required) return '';
  if (t.qa_status === 'none') return '';

  var btns = [];

  // Submit for review — task is complete but not yet submitted
  if (t.review_required && t.review_status === 'not_required' && t.qa_status === 'required') {
    btns.push('<button class="btn btn-sm btn-ghost" onclick="quickReviewAction(\'submit-review\',' + t.id + ')">Submit for Review</button>');
  }

  // Start review — submitted, someone picks it up
  if (t.review_status === 'pending') {
    btns.push('<button class="btn btn-sm btn-ghost" onclick="quickReviewAction(\'start-review\',' + t.id + ')">Start Review</button>');
    btns.push('<button class="btn btn-sm btn-success" onclick="openReviewModal(\'approve-review\',' + t.id + ')">Approve</button>');
    btns.push('<button class="btn btn-sm btn-danger" onclick="openReviewModal(\'reject-review\',' + t.id + ')">Reject</button>');
  }

  // In review — reviewer actively working
  if (t.review_status === 'in_review') {
    btns.push('<button class="btn btn-sm btn-success" onclick="openReviewModal(\'approve-review\',' + t.id + ')">Approve Review</button>');
    btns.push('<button class="btn btn-sm btn-danger" onclick="openReviewModal(\'reject-review\',' + t.id + ')">Reject Review</button>');
  }

  // Final approval — review approved, now needs final approver
  if (t.approval_required && t.review_status === 'approved' && t.approval_status === 'pending') {
    btns.push('<button class="btn btn-sm btn-success" onclick="openReviewModal(\'approve-final\',' + t.id + ')">Final Approve</button>');
    btns.push('<button class="btn btn-sm btn-danger" onclick="openReviewModal(\'reject-final\',' + t.id + ')">Final Reject</button>');
  }

  // QA lock (after approved)
  if (t.qa_status === 'approved' && !t.qa_locked) {
    btns.push('<button class="btn btn-sm btn-ghost" onclick="quickReviewAction(\'qa-lock\',' + t.id + ')">🔒 Lock</button>');
  }

  // QA unlock
  if (t.qa_locked) {
    btns.push('<button class="btn btn-sm btn-ghost" onclick="quickReviewAction(\'qa-unlock\',' + t.id + ')">Unlock</button>');
  }

  // History always available if there's a review flow
  btns.push('<button class="btn btn-sm btn-ghost" onclick="openReviewHistory(' + t.id + ', \'' + esc(t.title) + '\')">History</button>');

  return btns.join('');
}

function getUserName(userId) {
  if (!userId) return '';
  var m = _allUsers.find(function(u) { return u.user_id === userId; });
  return m ? (m.display_name || m.email) : '';
}

function formatDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

function goPage(p) {
  _page = p;
  loadTasks();
  window.scrollTo(0, 0);
}

// ── Quick status change on card ───────────────────────────────────────────────

async function quickStatus(taskId, newStatus) {
  try {
    var res = await PracticeAPI.fetch('/api/practice/tasks/' + taskId, {
      method: 'PUT',
      body:   JSON.stringify({ status: newStatus })
    });
    if (!res.ok) {
      var d = await res.json();
      throw new Error(d.error || 'Update failed');
    }
    PracticeAPI.showToast('Status updated');
    await loadTasks();
  } catch (e) {
    PracticeAPI.showToast('Error: ' + e.message, true);
  }
}

// ── Review section visibility ─────────────────────────────────────────────────

function updateReviewSectionVisibility() {
  var reviewRequired  = document.getElementById('tReviewRequired').checked;
  var notesWrap = document.getElementById('tReviewNotesWrap');
  if (notesWrap) notesWrap.style.display = reviewRequired ? '' : 'none';
}

// ── Task modal: open / populate / close ──────────────────────────────────────

async function openTaskModal(taskId) {
  _currentTaskId = taskId || null;
  var isEdit     = !!taskId;

  document.getElementById('taskModalTitle').textContent = isEdit ? 'Edit Task' : 'Add Task';
  document.getElementById('taskSaveBtn').textContent    = isEdit ? 'Save Changes' : 'Save Task';
  document.getElementById('tDeleteBtn').classList.toggle('hidden', !isEdit);

  // Reset form
  document.getElementById('tTitle').value           = '';
  document.getElementById('tClient').value          = '';
  document.getElementById('tAssigned').value        = '';
  document.getElementById('tType').value            = 'general';
  document.getElementById('tPriority').value        = 'medium';
  document.getElementById('tStatus').value          = 'open';
  document.getElementById('tDueDate').value         = '';
  document.getElementById('tDesc').value            = '';
  document.getElementById('tNotes').value           = '';
  document.getElementById('tReviewRequired').checked  = false;
  document.getElementById('tApprovalRequired').checked = false;
  document.getElementById('tPreparer').value        = '';
  document.getElementById('tReviewer').value        = '';
  document.getElementById('tApprover').value        = '';
  document.getElementById('tReviewNotes').value     = '';
  updateReviewSectionVisibility();

  if (isEdit) {
    try {
      var res = await PracticeAPI.fetch('/api/practice/tasks/' + taskId);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var d = await res.json();
      var t = d.task;
      document.getElementById('tTitle').value           = t.title        || '';
      document.getElementById('tClient').value          = t.client_id    || '';
      document.getElementById('tAssigned').value        = t.assigned_to  || '';
      document.getElementById('tType').value            = t.type         || 'general';
      document.getElementById('tPriority').value        = t.priority     || 'medium';
      document.getElementById('tStatus').value          = t.status       || 'open';
      document.getElementById('tDueDate').value         = t.due_date ? t.due_date.substring(0, 10) : '';
      document.getElementById('tDesc').value            = t.description  || '';
      document.getElementById('tNotes').value           = t.notes        || '';
      document.getElementById('tReviewRequired').checked  = t.review_required   === true;
      document.getElementById('tApprovalRequired').checked = t.approval_required === true;
      document.getElementById('tPreparer').value        = t.preparer_team_member_id  || '';
      document.getElementById('tReviewer').value        = t.reviewer_team_member_id  || '';
      document.getElementById('tApprover').value        = t.approver_team_member_id  || '';
      document.getElementById('tReviewNotes').value     = t.review_notes || '';
      updateReviewSectionVisibility();
    } catch (e) {
      PracticeAPI.showToast('Failed to load task: ' + e.message, true);
      return;
    }
  }

  document.getElementById('taskModal').classList.add('show');
}

function closeModal(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('show');
  // Clear sensitive review inputs
  if (id === 'rejectReviewModal')  document.getElementById('rejectReviewReason').value  = '';
  if (id === 'rejectFinalModal')   document.getElementById('rejectFinalReason').value   = '';
  if (id === 'approveReviewModal') document.getElementById('approveReviewNotes').value  = '';
  if (id === 'approveFinalModal')  document.getElementById('approveFinalNotes').value   = '';
  if (id === 'taskModal') _currentTaskId = null;
  if (id === 'approveReviewModal' || id === 'rejectReviewModal' ||
      id === 'approveFinalModal'  || id === 'rejectFinalModal') _reviewTaskId = null;
}

// ── Task save ─────────────────────────────────────────────────────────────────

async function saveTask(e) {
  e.preventDefault();
  var title = (document.getElementById('tTitle').value || '').trim();
  if (!title) {
    PracticeAPI.showToast('Task title is required', true);
    return false;
  }

  var reviewRequired  = document.getElementById('tReviewRequired').checked;
  var approvalRequired = document.getElementById('tApprovalRequired').checked;

  var body = {
    title:       title,
    client_id:   document.getElementById('tClient').value   || null,
    assigned_to: document.getElementById('tAssigned').value || null,
    type:        document.getElementById('tType').value     || 'general',
    priority:    document.getElementById('tPriority').value || 'medium',
    status:      document.getElementById('tStatus').value   || 'open',
    due_date:    document.getElementById('tDueDate').value  || null,
    description: document.getElementById('tDesc').value.trim()  || null,
    notes:       document.getElementById('tNotes').value.trim() || null,
    // Review fields
    review_required:            reviewRequired,
    approval_required:          approvalRequired,
    preparer_team_member_id:    document.getElementById('tPreparer').value  || null,
    reviewer_team_member_id:    document.getElementById('tReviewer').value  || null,
    approver_team_member_id:    document.getElementById('tApprover').value  || null,
    review_notes:               document.getElementById('tReviewNotes').value.trim() || null
  };

  var btn = document.getElementById('taskSaveBtn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    var isNew  = !_currentTaskId;
    var url    = '/api/practice/tasks' + (isNew ? '' : '/' + _currentTaskId);
    var method = isNew ? 'POST' : 'PUT';
    var res    = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(body) });
    var d      = await res.json();
    if (!res.ok) throw new Error(d.error || 'Save failed');
    PracticeAPI.showToast(isNew ? 'Task created' : 'Task updated');
    closeModal('taskModal');
    await loadTasks();
  } catch (err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  } finally {
    btn.disabled    = false;
    btn.textContent = _currentTaskId ? 'Save Changes' : 'Save Task';
  }
  return false;
}

// ── Task delete ───────────────────────────────────────────────────────────────

async function deleteCurrentTask() {
  if (!_currentTaskId) return;
  if (!confirm('Delete this task? Review history will be preserved, but the task itself will be removed.')) return;
  try {
    var res = await PracticeAPI.fetch('/api/practice/tasks/' + _currentTaskId, { method: 'DELETE' });
    var d   = await res.json();
    if (!res.ok) throw new Error(d.error || 'Delete failed');
    PracticeAPI.showToast('Task deleted');
    closeModal('taskModal');
    await loadTasks();
  } catch (err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// REVIEW / APPROVAL FLOW
// ══════════════════════════════════════════════════════════════════════════════

// ── Quick actions (no notes required) ────────────────────────────────────────

async function quickReviewAction(action, taskId) {
  try {
    var res = await PracticeAPI.fetch('/api/practice/tasks/' + taskId + '/' + action, {
      method: 'PUT',
      body:   JSON.stringify({})
    });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Action failed');
    PracticeAPI.showToast(reviewActionLabel(action) + ' complete');
    await loadTasks();
  } catch (e) {
    PracticeAPI.showToast('Error: ' + e.message, true);
  }
}

function reviewActionLabel(action) {
  var labels = {
    'submit-review': 'Submitted for review',
    'start-review':  'Review started',
    'qa-lock':       'QA locked',
    'qa-unlock':     'QA unlocked'
  };
  return labels[action] || action;
}

// ── Open review modal (actions that may have notes/reason) ───────────────────

function openReviewModal(action, taskId) {
  _reviewTaskId = taskId;
  var modalIds = {
    'approve-review': 'approveReviewModal',
    'reject-review':  'rejectReviewModal',
    'approve-final':  'approveFinalModal',
    'reject-final':   'rejectFinalModal'
  };
  var modalId = modalIds[action];
  if (!modalId) return;
  document.getElementById(modalId).classList.add('show');
}

// ── Submit review modal action ────────────────────────────────────────────────

async function submitReviewAction(action) {
  if (!_reviewTaskId) return;

  var body = {};
  var modalId;

  if (action === 'approve-review') {
    body.notes  = document.getElementById('approveReviewNotes').value.trim() || null;
    modalId = 'approveReviewModal';
  } else if (action === 'reject-review') {
    var reason = document.getElementById('rejectReviewReason').value.trim();
    if (!reason) {
      PracticeAPI.showToast('Rejection reason is required', true);
      document.getElementById('rejectReviewReason').focus();
      return;
    }
    body.rejection_reason = reason;
    modalId = 'rejectReviewModal';
  } else if (action === 'approve-final') {
    body.notes  = document.getElementById('approveFinalNotes').value.trim() || null;
    modalId = 'approveFinalModal';
  } else if (action === 'reject-final') {
    var reason2 = document.getElementById('rejectFinalReason').value.trim();
    if (!reason2) {
      PracticeAPI.showToast('Rejection reason is required', true);
      document.getElementById('rejectFinalReason').focus();
      return;
    }
    body.rejection_reason = reason2;
    modalId = 'rejectFinalModal';
  } else {
    return;
  }

  try {
    var res = await PracticeAPI.fetch('/api/practice/tasks/' + _reviewTaskId + '/' + action, {
      method: 'PUT',
      body:   JSON.stringify(body)
    });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Action failed');
    var successMsgs = {
      'approve-review': 'Review approved',
      'reject-review':  'Review rejected',
      'approve-final':  'Final approval granted',
      'reject-final':   'Final approval rejected'
    };
    PracticeAPI.showToast(successMsgs[action] || 'Done');
    closeModal(modalId);
    await loadTasks();
  } catch (e) {
    PracticeAPI.showToast('Error: ' + e.message, true);
  }
}

// ── Review history modal ──────────────────────────────────────────────────────

async function openReviewHistory(taskId, taskTitle) {
  document.getElementById('reviewHistoryTitle').textContent = 'Review History' + (taskTitle ? ': ' + taskTitle : '');
  document.getElementById('reviewHistoryContent').innerHTML =
    '<div class="loading"><div class="loading-spinner"></div><p>Loading history…</p></div>';
  document.getElementById('reviewHistoryModal').classList.add('show');

  try {
    var res = await PracticeAPI.fetch('/api/practice/tasks/' + taskId + '/review-events');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    renderReviewHistory(d.events || []);
  } catch (e) {
    document.getElementById('reviewHistoryContent').innerHTML =
      '<div class="error-banner">Failed to load history: ' + esc(e.message) + '</div>';
  }
}

function renderReviewHistory(events) {
  var el = document.getElementById('reviewHistoryContent');
  if (!events.length) {
    el.innerHTML = '<div class="empty-state" style="padding:20px;text-align:center;color:var(--text-muted);">No review events yet.</div>';
    return;
  }

  var EVENT_LABELS = {
    ready_for_review:    'Submitted for Review',
    review_started:      'Review Started',
    review_approved:     'Review Approved',
    review_rejected:     'Review Rejected',
    approval_approved:   'Final Approval Granted',
    approval_rejected:   'Final Approval Rejected',
    qa_locked:           'QA Locked',
    qa_unlocked:         'QA Unlocked',
    review_fields_updated: 'Review Assignment Updated',
    created:             'Task Created'
  };

  var html = '<div class="review-timeline">';
  events.forEach(function(ev) {
    var label = EVENT_LABELS[ev.event_type] || ev.event_type.replace(/_/g, ' ');
    var when  = ev.created_at ? new Date(ev.created_at).toLocaleString('en-ZA') : '';
    var statusChange = '';
    if (ev.old_status && ev.new_status && ev.old_status !== ev.new_status) {
      statusChange = '<div class="review-event-meta">Status: ' + esc(ev.old_status) + ' → ' + esc(ev.new_status) + '</div>';
    }
    var reviewChange = '';
    if (ev.old_review_status && ev.new_review_status && ev.old_review_status !== ev.new_review_status) {
      reviewChange = '<div class="review-event-meta">Review: ' + esc(ev.old_review_status) + ' → ' + esc(ev.new_review_status) + '</div>';
    }
    var notesHtml = '';
    if (ev.notes) {
      notesHtml = '<div class="review-event-notes">' + esc(ev.notes) + '</div>';
    }
    html += '<div class="review-event">' +
      '<div class="review-event-type ' + esc(ev.event_type) + '">' + esc(label) + '</div>' +
      '<div class="review-event-meta">' + when + '</div>' +
      statusChange + reviewChange + notesHtml +
    '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

// ── Close modals on overlay click ─────────────────────────────────────────────

document.addEventListener('click', function(e) {
  var overlayIds = [
    'taskModal', 'approveReviewModal', 'rejectReviewModal',
    'approveFinalModal', 'rejectFinalModal', 'reviewHistoryModal'
  ];
  if (overlayIds.indexOf(e.target.id) !== -1) {
    closeModal(e.target.id);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
