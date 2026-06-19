/* time.js — Lorenco Practice Management — Time Tracking & Billing Readiness */

var _allClients    = [];
var _editingId     = null;  // time entry ID currently open in edit modal
var _rejectingId   = null;  // time entry ID currently open in reject modal
var _cachedEntries = [];

var esc = PracticeAPI.escHtml;

var BILLING_STATUS_LABELS = {
  unbilled:       'Unbilled',
  pending_review: 'Pending Review',
  approved:       'Approved',
  rejected:       'Rejected',
  billed:         'Billed',
  written_off:    'Written Off'
};

var TIME_TYPE_LABELS = {
  billable:     'Billable',
  non_billable: 'Non-Bill.',
  internal:     'Internal',
  admin:        'Admin'
};

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  if (!AUTH.requireAuth()) return;
  LAYOUT.init('time');

  document.getElementById('teDate').valueAsDate = new Date();

  var now     = new Date();
  var yearSel = document.getElementById('fYear');
  for (var y = now.getFullYear(); y >= now.getFullYear() - 3; y--) {
    var o = document.createElement('option');
    o.value = y; o.textContent = y;
    if (y === now.getFullYear()) o.selected = true;
    yearSel.appendChild(o);
  }
  document.getElementById('fMonthSel').value = String(now.getMonth() + 1).padStart(2, '0');

  await loadClients();
  await Promise.all([loadEntries(), loadWip()]);
}

// ── Client + context loaders ──────────────────────────────────────────────────

async function loadClients() {
  try {
    var res = await PracticeAPI.fetch('/api/practice/clients?is_active=true&limit=500');
    if (!res.ok) return;
    var d = await res.json();
    _allClients = d.clients || [];
    var opts = _allClients.map(function(c) {
      return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
    }).join('');
    var noClientOpt   = '<option value="">No client</option>';
    var allClientsOpt = '<option value="">All Clients</option>';
    document.getElementById('teClient').innerHTML = noClientOpt   + opts;
    document.getElementById('fClient').innerHTML  = allClientsOpt + opts;
    document.getElementById('eClient').innerHTML  = '<option value="">None</option>' + opts;
  } catch (e) {
    console.error('loadClients error:', e);
  }
}

async function loadWorkflowsForClient() {
  var clientId = document.getElementById('teClient').value;
  var sel = document.getElementById('teWorkflow');
  sel.innerHTML = '<option value="">None</option>';
  if (!clientId) return;
  try {
    var res = await PracticeAPI.fetch('/api/practice/workflows/runs?client_id=' + clientId + '&limit=100');
    if (!res.ok) return;
    var d = await res.json();
    (d.runs || []).forEach(function(r) {
      var o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name || ('Run #' + r.id);
      sel.appendChild(o);
    });
  } catch (e) { /* non-fatal */ }
}

async function loadTasksForClient() {
  var clientId = document.getElementById('teClient').value;
  var sel = document.getElementById('teTask');
  sel.innerHTML = '<option value="">None</option>';
  if (!clientId) return;
  try {
    var res = await PracticeAPI.fetch('/api/practice/tasks?client_id=' + clientId + '&status=in_progress&limit=100');
    if (!res.ok) return;
    var d = await res.json();
    (d.tasks || []).forEach(function(t) {
      var o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.title;
      sel.appendChild(o);
    });
  } catch (e) { /* non-fatal */ }
}

// ── Rate calculator ───────────────────────────────────────────────────────────

function computeEffectiveRate(stdRate, ovrRate) {
  var ovr = ovrRate  !== '' && ovrRate  != null ? parseFloat(ovrRate)  : null;
  var std = stdRate  !== '' && stdRate  != null ? parseFloat(stdRate)  : null;
  return ovr != null ? ovr : std;
}

function updateRateCalc() {
  var hours   = parseFloat(document.getElementById('teHours').value)   || 0;
  var stdRate = document.getElementById('teStdRate').value;
  var ovrRate = document.getElementById('teOvrRate').value;
  var timeType = document.getElementById('teTimeType').value;
  var effective = computeEffectiveRate(stdRate, ovrRate);
  var row = document.getElementById('rateCalcRow');

  if (effective != null && hours > 0 && timeType === 'billable') {
    var recoverable = hours * effective;
    document.getElementById('calcEffectiveRate').textContent = 'R' + effective.toFixed(2) + '/hr';
    document.getElementById('calcRecoverable').textContent   = 'R' + formatMoney(recoverable);
    row.classList.remove('hidden');
  } else {
    row.classList.add('hidden');
  }
}

function updateRateVisibility() {
  var timeType     = document.getElementById('teTimeType').value;
  var isBillable   = timeType === 'billable';
  document.getElementById('teStdRateWrap').style.opacity = isBillable ? '1' : '0.4';
  document.getElementById('teOvrRateWrap').style.opacity = isBillable ? '1' : '0.4';
  updateRateCalc();
}

function updateEditCalc() {
  var hours   = parseFloat(document.getElementById('eHours').value)   || 0;
  var stdRate = document.getElementById('eStdRate').value;
  var ovrRate = document.getElementById('eOvrRate').value;
  var timeType = document.getElementById('eTimeType').value;
  var effective = computeEffectiveRate(stdRate, ovrRate);
  var row = document.getElementById('editRateCalcRow');

  if (effective != null && hours > 0 && timeType === 'billable') {
    var recoverable = hours * effective;
    document.getElementById('editCalcEffective').textContent  = 'R' + effective.toFixed(2) + '/hr';
    document.getElementById('editCalcRecoverable').textContent = 'R' + formatMoney(recoverable);
    row.classList.remove('hidden');
  } else {
    row.classList.add('hidden');
  }
}

// ── WIP Dashboard ─────────────────────────────────────────────────────────────

async function loadWip() {
  var params = buildDateParams();
  var clientId = document.getElementById('fClient').value;
  if (clientId) params.push('client_id=' + clientId);

  try {
    var res = await PracticeAPI.fetch('/api/practice/time-entries/wip?' + params.join('&'));
    if (!res.ok) return;
    var d = await res.json();
    var b  = d.by_status || {};

    document.getElementById('wipUnbilledHours').textContent  = (b.unbilled      && b.unbilled.hours)      ? b.unbilled.hours.toFixed(1) + 'h'       : '0h';
    document.getElementById('wipPendingHours').textContent   = (b.pending_review && b.pending_review.hours) ? b.pending_review.hours.toFixed(1) + 'h' : '0h';
    document.getElementById('wipPendingValue').textContent   = (b.pending_review && b.pending_review.recoverable_value)
      ? 'R' + formatMoney(b.pending_review.recoverable_value) : 'Awaiting approval';
    document.getElementById('wipApprovedHours').textContent  = (b.approved       && b.approved.hours)       ? b.approved.hours.toFixed(1) + 'h'       : '0h';
    document.getElementById('wipApprovedValue').textContent  = (b.approved       && b.approved.recoverable_value)
      ? 'R' + formatMoney(b.approved.recoverable_value) : 'Ready to bill';
    document.getElementById('wipRecoverable').textContent    = d.total_recoverable != null
      ? 'R' + formatMoney(d.total_recoverable) : '–';

    document.getElementById('wipGrid').classList.remove('hidden');
  } catch (e) {
    console.error('loadWip error:', e);
  }
}

// ── Log new time entry ────────────────────────────────────────────────────────

async function logTime() {
  var hours = document.getElementById('teHours').value;
  var date  = document.getElementById('teDate').value;
  var desc  = document.getElementById('teDesc').value.trim();

  if (!hours || parseFloat(hours) <= 0) { PracticeAPI.showToast('Hours must be a positive number', true); return; }
  if (!date)                             { PracticeAPI.showToast('Date is required', true); return; }

  var btn = document.getElementById('logBtn');
  btn.disabled    = true;
  btn.textContent = 'Logging…';

  var clientId    = document.getElementById('teClient').value   || null;
  var workflowId  = document.getElementById('teWorkflow').value || null;
  var taskId      = document.getElementById('teTask').value     || null;
  var timeType    = document.getElementById('teTimeType').value  || 'billable';
  var stdRate     = document.getElementById('teStdRate').value  || null;
  var ovrRate     = document.getElementById('teOvrRate').value  || null;
  var billingNotes = document.getElementById('teBillingNotes').value.trim() || null;

  try {
    var res = await PracticeAPI.fetch('/api/practice/time-entries', {
      method: 'POST',
      body: JSON.stringify({
        client_id:       clientId   ? parseInt(clientId)   : null,
        workflow_run_id: workflowId ? parseInt(workflowId) : null,
        task_id:         taskId     ? parseInt(taskId)     : null,
        hours:           parseFloat(hours),
        date:            date,
        description:     desc || null,
        time_type:       timeType,
        standard_rate:   stdRate ? parseFloat(stdRate) : null,
        override_rate:   ovrRate ? parseFloat(ovrRate) : null,
        billing_notes:   billingNotes
      })
    });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Log failed');
    PracticeAPI.showToast(hours + 'h logged');
    // Reset form
    document.getElementById('teHours').value        = '';
    document.getElementById('teDesc').value         = '';
    document.getElementById('teStdRate').value      = '';
    document.getElementById('teOvrRate').value      = '';
    document.getElementById('teBillingNotes').value = '';
    document.getElementById('teTask').innerHTML     = '<option value="">None</option>';
    document.getElementById('teWorkflow').innerHTML = '<option value="">None</option>';
    document.getElementById('rateCalcRow').classList.add('hidden');
    await Promise.all([loadEntries(), loadWip()]);
  } catch (err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Log Time';
  }
}

// ── List / filter entries ─────────────────────────────────────────────────────

function buildDateParams() {
  var year  = document.getElementById('fYear').value;
  var month = document.getElementById('fMonthSel').value;
  var params = [];
  if (year && month) {
    var lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    params.push('date_from=' + year + '-' + month + '-01');
    params.push('date_to='   + year + '-' + month + '-' + String(lastDay).padStart(2, '0'));
  }
  return params;
}

async function loadEntries() {
  document.getElementById('timeWrap').innerHTML =
    '<div class="loading"><div class="loading-spinner"></div><p>Loading…</p></div>';
  document.getElementById('summaryBar').classList.add('hidden');

  var params = buildDateParams();
  var clientId      = document.getElementById('fClient').value;
  var timeType      = document.getElementById('fTimeType').value;
  var billingStatus = document.getElementById('fBillingStatus').value;
  if (clientId)      params.push('client_id='      + clientId);
  if (timeType)      params.push('time_type='      + timeType);
  if (billingStatus) params.push('billing_status=' + billingStatus);
  params.push('limit=100');

  try {
    var res = await PracticeAPI.fetch('/api/practice/time-entries?' + params.join('&'));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    _cachedEntries = d.time_entries || [];
    renderEntries(_cachedEntries, d.total_hours || 0);
  } catch (e) {
    document.getElementById('timeWrap').innerHTML =
      '<div class="error-banner">Failed to load time entries: ' + esc(e.message) + '</div>';
  }
}

function renderEntries(entries, totalHours) {
  var wrap = document.getElementById('timeWrap');

  if (!entries.length) {
    wrap.innerHTML = '<div class="empty-state"><p>No time entries found. Log some time above.</p></div>';
    return;
  }

  // Summary bar
  var billableHours = 0, nonBillableHours = 0, recoverable = 0;
  entries.forEach(function(e) {
    var h  = parseFloat(e.hours || 0);
    var tt = e.time_type || (e.billable ? 'billable' : 'non_billable');
    if (tt === 'billable') {
      billableHours += h;
      recoverable   += parseFloat(e.recoverable_value || 0);
    } else {
      nonBillableHours += h;
    }
  });

  document.getElementById('sumTotal').textContent       = totalHours.toFixed(2);
  document.getElementById('sumBillable').textContent    = billableHours.toFixed(2);
  document.getElementById('sumNonBillable').textContent = nonBillableHours.toFixed(2);
  document.getElementById('sumRecoverable').textContent = 'R' + formatMoney(recoverable);
  document.getElementById('summaryBar').classList.remove('hidden');

  var rows = entries.map(function(e) {
    var clientName = e.practice_clients && e.practice_clients.name ? esc(e.practice_clients.name) : '–';
    var taskTitle  = e.practice_tasks   && e.practice_tasks.title  ? esc(e.practice_tasks.title)  : '–';
    var timeType   = e.time_type || (e.billable ? 'billable' : 'non_billable');
    var typeBadge  = '<span class="badge badge-time-' + timeType + '">' + esc(TIME_TYPE_LABELS[timeType] || timeType) + '</span>';
    var billingStatus = e.billing_status || 'unbilled';
    var statusBadge = '<span class="badge badge-billing-' + billingStatus + '">' +
      esc(BILLING_STATUS_LABELS[billingStatus] || billingStatus) + '</span>';
    var effectiveRate = e.effective_rate || e.rate;
    var rateStr    = effectiveRate ? 'R' + parseFloat(effectiveRate).toFixed(2) : '–';
    var recoverStr = e.recoverable_value ? 'R' + formatMoney(parseFloat(e.recoverable_value)) : '–';

    var actions = buildEntryActions(e);

    return '<tr>' +
      '<td class="col-muted col-nowrap">' + esc(e.date) + '</td>' +
      '<td>' + clientName + '</td>' +
      '<td class="col-small col-muted">' + taskTitle + '</td>' +
      '<td><strong>' + e.hours + 'h</strong></td>' +
      '<td class="col-small">' + esc(e.description || '–') + '</td>' +
      '<td>' + typeBadge + '</td>' +
      '<td class="col-muted col-small">' + rateStr + '</td>' +
      '<td class="col-muted col-small">' + recoverStr + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td><div class="time-entry-actions">' + actions + '</div></td>' +
    '</tr>';
  }).join('');

  wrap.innerHTML =
    '<div class="time-table-wrap"><table><thead><tr>' +
      '<th>Date</th><th>Client</th><th>Task</th><th>Hours</th>' +
      '<th>Description</th><th>Type</th><th>Rate</th><th>Recoverable</th>' +
      '<th>Status</th><th></th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function buildEntryActions(e) {
  var btns = [];
  var status = e.billing_status || 'unbilled';

  btns.push('<button class="btn btn-ghost btn-sm" onclick="openEditModal(' + e.id + ')">Edit</button>');

  if (status === 'unbilled' || status === 'rejected') {
    if (e.time_type === 'billable' || e.billable) {
      btns.push('<button class="btn btn-sm btn-ghost" onclick="submitForReview(' + e.id + ')">Submit</button>');
    }
  }
  if (status === 'pending_review') {
    btns.push('<button class="btn btn-sm btn-success" onclick="approveEntry(' + e.id + ')">Approve</button>');
    btns.push('<button class="btn btn-sm btn-danger" onclick="openRejectModal(' + e.id + ')">Reject</button>');
  }
  if (status === 'approved') {
    btns.push('<button class="btn btn-sm btn-danger" onclick="openRejectModal(' + e.id + ')">Reject</button>');
  }

  return btns.join('');
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function openEditModal(id) {
  _editingId = id;
  var e = _cachedEntries.find(function(x) { return x.id === id; });
  if (!e) return;

  document.getElementById('eClient').value       = e.client_id       || '';
  document.getElementById('eDate').value         = e.date            || '';
  document.getElementById('eHours').value        = e.hours           || '';
  document.getElementById('eTimeType').value     = e.time_type       || (e.billable ? 'billable' : 'non_billable');
  document.getElementById('eStdRate').value      = e.standard_rate   || '';
  document.getElementById('eOvrRate').value      = e.override_rate   || e.rate || '';
  document.getElementById('eDesc').value         = e.description     || '';
  document.getElementById('eBillingNotes').value = e.billing_notes   || '';

  updateEditCalc();
  document.getElementById('editModal').classList.add('show');
}

function closeModal(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('show');
  if (id === 'editModal')  _editingId   = null;
  if (id === 'rejectModal') {
    _rejectingId = null;
    document.getElementById('rejectReason').value = '';
  }
}

async function saveEdit(e) {
  e.preventDefault();
  if (!_editingId) return false;

  var hours   = document.getElementById('eHours').value;
  var date    = document.getElementById('eDate').value;
  if (!hours || !date) { PracticeAPI.showToast('Hours and date are required', true); return false; }

  var btn = document.getElementById('editSaveBtn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  var stdRate = document.getElementById('eStdRate').value;
  var ovrRate = document.getElementById('eOvrRate').value;

  try {
    var res = await PracticeAPI.fetch('/api/practice/time-entries/' + _editingId, {
      method: 'PUT',
      body: JSON.stringify({
        client_id:     document.getElementById('eClient').value   || null,
        date:          date,
        hours:         parseFloat(hours),
        time_type:     document.getElementById('eTimeType').value || 'billable',
        standard_rate: stdRate ? parseFloat(stdRate) : null,
        override_rate: ovrRate ? parseFloat(ovrRate) : null,
        description:   document.getElementById('eDesc').value.trim() || null,
        billing_notes: document.getElementById('eBillingNotes').value.trim() || null
      })
    });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Update failed');
    closeModal('editModal');
    PracticeAPI.showToast('Entry updated');
    await Promise.all([loadEntries(), loadWip()]);
  } catch (err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save';
  }
  return false;
}

async function deleteCurrentEntry() {
  if (!_editingId) return;
  if (!confirm('Delete this time entry?')) return;
  try {
    var res = await PracticeAPI.fetch('/api/practice/time-entries/' + _editingId, { method: 'DELETE' });
    var d   = await res.json();
    if (!res.ok) throw new Error(d.error || 'Delete failed');
    closeModal('editModal');
    PracticeAPI.showToast('Entry deleted');
    await Promise.all([loadEntries(), loadWip()]);
  } catch (err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  }
}

// ── Billing review actions ────────────────────────────────────────────────────

async function submitForReview(id) {
  try {
    var res = await PracticeAPI.fetch('/api/practice/time-entries/' + id + '/submit-review', {
      method: 'PUT', body: JSON.stringify({})
    });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Submit failed');
    PracticeAPI.showToast('Submitted for review');
    await Promise.all([loadEntries(), loadWip()]);
  } catch (e) {
    PracticeAPI.showToast('Error: ' + e.message, true);
  }
}

async function approveEntry(id) {
  try {
    var res = await PracticeAPI.fetch('/api/practice/time-entries/' + id + '/approve', {
      method: 'PUT', body: JSON.stringify({})
    });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Approve failed');
    PracticeAPI.showToast('Time entry approved');
    await Promise.all([loadEntries(), loadWip()]);
  } catch (e) {
    PracticeAPI.showToast('Error: ' + e.message, true);
  }
}

function openRejectModal(id) {
  _rejectingId = id;
  document.getElementById('rejectReason').value = '';
  document.getElementById('rejectModal').classList.add('show');
}

async function submitReject() {
  if (!_rejectingId) return;
  var reason = document.getElementById('rejectReason').value.trim();
  if (!reason) {
    PracticeAPI.showToast('Rejection reason is required', true);
    document.getElementById('rejectReason').focus();
    return;
  }
  try {
    var res = await PracticeAPI.fetch('/api/practice/time-entries/' + _rejectingId + '/reject', {
      method: 'PUT',
      body: JSON.stringify({ reason: reason })
    });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Reject failed');
    closeModal('rejectModal');
    PracticeAPI.showToast('Entry rejected');
    await Promise.all([loadEntries(), loadWip()]);
  } catch (e) {
    PracticeAPI.showToast('Error: ' + e.message, true);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatMoney(n) {
  return parseFloat(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Close modals on overlay click ─────────────────────────────────────────────

document.addEventListener('click', function(e) {
  if (e.target.id === 'editModal')   closeModal('editModal');
  if (e.target.id === 'rejectModal') closeModal('rejectModal');
});

// ── Boot ──────────────────────────────────────────────────────────────────────

init();
