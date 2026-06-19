/* ============================================================
   Lorenco Practice — Compliance Calendar
   compliance.js — all logic for compliance.html
   ============================================================ */

var esc = PracticeAPI.escHtml;

// ── State ────────────────────────────────────────────────────────────────────
var _view = 'calendar';          // 'calendar' | 'list'
var _calYear, _calMonth;         // current calendar month
var _allDeadlines = [];          // full deadline list (for list view + calendar)
var _listPage = 1;
var _listTotal = 0;
var _LIST_SIZE = 30;
var _editDeadlineId = null;
var _editRuleId = null;
var _statusTargetId = null;

// ── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  if (!AUTH.requireAuth()) return;
  LAYOUT.init('compliance');

  var today = new Date();
  _calYear  = today.getFullYear();
  _calMonth = today.getMonth();   // 0-based

  Promise.all([loadClients(), loadTeamMembers()]).then(function() {
    refresh();
    loadRules();
  });
})();

// ── View toggle ───────────────────────────────────────────────────────────────
function setView(v) {
  _view = v;
  document.getElementById('calendarSection').style.display = v === 'calendar' ? '' : 'none';
  document.getElementById('listSection').style.display     = v === 'list'     ? '' : 'none';
  document.getElementById('btnCalView').classList.toggle('active', v === 'calendar');
  document.getElementById('btnListView').classList.toggle('active', v === 'list');
  refresh();
}

// ── Loaders ───────────────────────────────────────────────────────────────────
async function loadClients() {
  try {
    var r = await PracticeAPI.fetch('/api/practice/clients?is_active=true');
    if (!r.ok) return;
    var d = await r.json();
    var opts = (d.clients || []).map(function(c) {
      return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
    }).join('');
    ['fClient','dlClient'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML += opts;
    });
  } catch(e) {}
}

async function loadTeamMembers() {
  try {
    var r = await PracticeAPI.fetch('/api/practice/team?active=true');
    if (!r.ok) return;
    var d = await r.json();
    var opts = (d.members || []).map(function(m) {
      return '<option value="' + m.id + '">' + esc(m.display_name) + '</option>';
    }).join('');
    ['fMember','dlResponsible','dlReviewer'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML += opts;
    });
  } catch(e) {}
}

async function refresh() {
  await loadDeadlines();
  if (_view === 'calendar') renderCalendar();
  else renderList();
}

async function loadDeadlines() {
  var params = buildFilterParams();
  // For calendar, load entire month range
  if (_view === 'calendar') {
    var first = new Date(_calYear, _calMonth, 1);
    var last  = new Date(_calYear, _calMonth + 1, 0);
    params.set('date_from', dateStr(first));
    params.set('date_to',   dateStr(last));
    params.delete('page');
    params.delete('limit');
  }
  try {
    var r = await PracticeAPI.fetch('/api/practice/deadlines?' + params.toString());
    if (!r.ok) throw new Error();
    var d = await r.json();
    _allDeadlines = d.deadlines || [];
    _listTotal = d.total || _allDeadlines.length;
    updateSummary();
  } catch(e) {
    _allDeadlines = [];
  }
}

function buildFilterParams() {
  var p = new URLSearchParams();
  var client = document.getElementById('fClient').value;
  var area   = document.getElementById('fArea').value;
  var status = document.getElementById('fStatus').value;
  var member = document.getElementById('fMember').value;
  if (client) p.set('client_id', client);
  if (area)   p.set('compliance_area', area);
  if (status) p.set('status', status);
  if (member) p.set('responsible_team_member_id', member);
  if (_view === 'list') {
    p.set('page', _listPage);
    p.set('limit', _LIST_SIZE);
  }
  return p;
}

// ── Summary bar ───────────────────────────────────────────────────────────────
async function updateSummary() {
  // Load summary across all deadlines for the company (no date filter)
  try {
    var r = await PracticeAPI.fetch('/api/practice/deadlines?limit=1000');
    if (!r.ok) return;
    var d = await r.json();
    var all = d.deadlines || [];
    var today = dateStr(new Date());
    var soon  = dateStr(new Date(Date.now() + 30 * 86400000));
    var open = 0, overdue = 0, dueSoon = 0, completed = 0;
    all.forEach(function(dl) {
      if (['completed','submitted','cancelled'].includes(dl.status)) {
        if (dl.status === 'completed') completed++;
        return;
      }
      open++;
      if (dl.due_date < today) overdue++;
      else if (dl.due_date <= soon) dueSoon++;
    });
    document.getElementById('sumOpen').textContent = open;
    document.getElementById('sumOverdue').textContent = overdue;
    document.getElementById('sumDueSoon').textContent = dueSoon;
    document.getElementById('sumCompleted').textContent = completed;
  } catch(e) {}
}

// ── Calendar rendering ────────────────────────────────────────────────────────
function renderCalendar() {
  var monthNames = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
  document.getElementById('calTitle').textContent = monthNames[_calMonth] + ' ' + _calYear;

  var grid = document.getElementById('calGrid');
  var days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var html = days.map(function(d){ return '<div class="cal-header-cell">' + d + '</div>'; }).join('');

  var first = new Date(_calYear, _calMonth, 1);
  var last  = new Date(_calYear, _calMonth + 1, 0);
  var startDow = (first.getDay() + 6) % 7; // 0=Mon

  // Build day → events map
  var byDay = {};
  _allDeadlines.forEach(function(dl) {
    var k = dl.due_date;
    if (!byDay[k]) byDay[k] = [];
    byDay[k].push(dl);
  });

  var todayStr = dateStr(new Date());

  // Pad start with previous month days
  for (var i = 0; i < startDow; i++) {
    var d = new Date(_calYear, _calMonth, -startDow + i + 1);
    html += '<div class="cal-day other-month"><div class="cal-day-num">' + d.getDate() + '</div></div>';
  }

  // Current month days
  for (var d = 1; d <= last.getDate(); d++) {
    var ds = _calYear + '-' + pad2(_calMonth + 1) + '-' + pad2(d);
    var evts = byDay[ds] || [];
    var isToday = ds === todayStr;
    html += '<div class="cal-day' + (isToday ? ' today' : '') + '">';
    html += '<div class="cal-day-num">' + d + '</div>';
    var max = 3;
    evts.slice(0, max).forEach(function(dl) {
      var cls = calEventClass(dl, todayStr);
      html += '<div class="cal-event ' + cls + '" onclick="openDeadlineModal(' + dl.id + ')" title="' + esc(dl.title) + '">' + esc(dl.title) + '</div>';
    });
    if (evts.length > max) html += '<div class="cal-more">+' + (evts.length - max) + ' more</div>';
    html += '</div>';
  }

  // Pad end
  var totalCells = startDow + last.getDate();
  var endPad = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (var i = 1; i <= endPad; i++) {
    html += '<div class="cal-day other-month"><div class="cal-day-num">' + i + '</div></div>';
  }

  grid.innerHTML = html;
}

function calEventClass(dl, todayStr) {
  if (['completed'].includes(dl.status)) return 'completed';
  if (['submitted'].includes(dl.status)) return 'submitted';
  if (dl.due_date < todayStr) return 'overdue';
  if (dl.priority === 'urgent' || dl.priority === 'high') return 'high';
  return 'normal';
}

function prevMonth() {
  _calMonth--;
  if (_calMonth < 0) { _calMonth = 11; _calYear--; }
  refresh();
}
function nextMonth() {
  _calMonth++;
  if (_calMonth > 11) { _calMonth = 0; _calYear++; }
  refresh();
}
function goToday() {
  var t = new Date();
  _calYear = t.getFullYear();
  _calMonth = t.getMonth();
  refresh();
}

// ── List rendering ────────────────────────────────────────────────────────────
function renderList() {
  var wrap = document.getElementById('deadlineListWrap');
  if (!_allDeadlines.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><h3>No deadlines found</h3><p>Adjust filters or create a new deadline.</p></div>';
    document.getElementById('deadlinePagination').innerHTML = '';
    return;
  }
  var todayStr = dateStr(new Date());
  var rows = _allDeadlines.map(function(dl) {
    var isOverdue = dl.due_date < todayStr && !['completed','submitted','cancelled'].includes(dl.status);
    var clientName = dl.practice_clients ? dl.practice_clients.name : '—';
    var responsible = dl.practice_team_members ? dl.practice_team_members.display_name : '—';
    return '<tr class="' + (isOverdue ? 'overdue-row' : '') + '">' +
      '<td><span class="col-nowrap">' + esc(dl.title) + '</span></td>' +
      '<td class="col-muted">' + esc(clientName) + '</td>' +
      '<td>' + areaLabel(dl.compliance_area || dl.type) + '</td>' +
      '<td class="col-nowrap' + (isOverdue ? '" style="color:var(--danger)"' : '"') + '>' + formatDate(dl.due_date) + '</td>' +
      '<td>' + statusBadge(dl.status) + '</td>' +
      '<td>' + priorityBadge(dl.priority) + '</td>' +
      '<td class="col-muted col-small">' + esc(responsible) + '</td>' +
      '<td class="td-actions">' +
        '<button class="btn btn-ghost btn-sm" onclick="openStatusModal(' + dl.id + ',\'' + dl.status + '\')">Status</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="openDeadlineModal(' + dl.id + ')">Edit</button>' +
      '</td>' +
    '</tr>';
  }).join('');

  wrap.innerHTML =
    '<div class="table-wrap"><table>' +
    '<thead><tr><th>Title</th><th>Client</th><th>Area</th><th>Due Date</th><th>Status</th><th>Priority</th><th>Assigned</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div>';

  renderPagination();
}

function renderPagination() {
  var totalPages = Math.ceil(_listTotal / _LIST_SIZE);
  if (totalPages <= 1) { document.getElementById('deadlinePagination').innerHTML = ''; return; }
  var btns = '';
  for (var i = 1; i <= totalPages; i++) {
    btns += '<button class="page-btn' + (i === _listPage ? ' active' : '') + '" onclick="goPage(' + i + ')">' + i + '</button>';
  }
  document.getElementById('deadlinePagination').innerHTML = '<div class="pagination"><div class="pagination-pages">' + btns + '</div></div>';
}

function goPage(p) { _listPage = p; refresh(); }

// ── Rules ─────────────────────────────────────────────────────────────────────
async function loadRules() {
  var wrap = document.getElementById('rulesWrap');
  try {
    var r = await PracticeAPI.fetch('/api/practice/compliance/rules');
    if (!r.ok) throw new Error();
    var d = await r.json();
    var rules = d.rules || [];
    if (!rules.length) {
      wrap.innerHTML = '<div class="empty"><div class="empty-icon">📜</div><h3>No compliance rules defined</h3><p>Add rules to document your practice\'s compliance obligations.</p></div>';
      return;
    }
    wrap.innerHTML =
      '<div class="table-wrap"><table>' +
      '<thead><tr><th>Rule Name</th><th>Area</th><th>Type</th><th>Client Type</th><th>Recurrence</th><th>Due Day</th><th></th></tr></thead>' +
      '<tbody>' + rules.map(function(r) {
        return '<tr>' +
          '<td>' + esc(r.rule_name) + '</td>' +
          '<td>' + areaLabel(r.compliance_area) + '</td>' +
          '<td class="col-small">' + esc(r.deadline_type || '—') + '</td>' +
          '<td class="col-small col-muted">' + esc(r.client_type || 'All') + '</td>' +
          '<td class="col-small">' + esc(r.recurrence_type || '—') + '</td>' +
          '<td class="col-small col-muted">' + (r.due_day ? r.due_day : '—') + '</td>' +
          '<td class="td-actions"><button class="btn btn-ghost btn-sm" onclick="openRuleModal(' + r.id + ')">Edit</button></td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';
  } catch(e) {
    wrap.innerHTML = '<div class="error-banner">Failed to load compliance rules.</div>';
  }
}

// ── Deadline modal ─────────────────────────────────────────────────────────────
async function openDeadlineModal(id) {
  _editDeadlineId = id || null;
  resetDeadlineForm();
  document.getElementById('dlModalTitle').textContent = id ? 'Edit Deadline' : 'New Deadline';
  document.getElementById('dlDeleteBtn').style.display = id ? '' : 'none';

  if (id) {
    try {
      var r = await PracticeAPI.fetch('/api/practice/deadlines/' + id);
      if (!r.ok) throw new Error();
      var d = await r.json();
      var dl = d.deadline;
      document.getElementById('dlTitle').value           = dl.title || '';
      document.getElementById('dlClient').value          = dl.client_id || '';
      document.getElementById('dlArea').value            = dl.compliance_area || '';
      document.getElementById('dlDeadlineType').value    = dl.deadline_type || '';
      document.getElementById('dlDueDate').value         = dl.due_date || '';
      document.getElementById('dlReminderDate').value    = dl.reminder_date || '';
      document.getElementById('dlPeriodStart').value     = dl.period_start || '';
      document.getElementById('dlPeriodEnd').value       = dl.period_end || '';
      document.getElementById('dlResponsible').value     = dl.responsible_team_member_id || '';
      document.getElementById('dlReviewer').value        = dl.reviewer_team_member_id || '';
      document.getElementById('dlPriority').value        = dl.priority || 'normal';
      document.getElementById('dlStatus').value          = dl.status || 'open';
      document.getElementById('dlSubmissionRef').value   = dl.submission_reference || '';
      document.getElementById('dlNotes').value           = dl.notes || '';
      document.getElementById('dlInternalNotes').value   = dl.internal_notes || '';
    } catch(e) {
      PracticeAPI.showToast('Failed to load deadline', true);
      return;
    }
  }
  document.getElementById('deadlineModal').classList.add('show');
}

function resetDeadlineForm() {
  document.getElementById('deadlineForm').reset();
  document.getElementById('dlStatus').value   = 'open';
  document.getElementById('dlPriority').value = 'normal';
}

async function saveDeadline(e) {
  e.preventDefault();
  var btn = document.getElementById('dlSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  var payload = {
    title:                    document.getElementById('dlTitle').value.trim(),
    client_id:                document.getElementById('dlClient').value || null,
    compliance_area:          document.getElementById('dlArea').value || null,
    deadline_type:            document.getElementById('dlDeadlineType').value || null,
    due_date:                 document.getElementById('dlDueDate').value,
    reminder_date:            document.getElementById('dlReminderDate').value || null,
    period_start:             document.getElementById('dlPeriodStart').value || null,
    period_end:               document.getElementById('dlPeriodEnd').value || null,
    responsible_team_member_id: document.getElementById('dlResponsible').value || null,
    reviewer_team_member_id:  document.getElementById('dlReviewer').value || null,
    priority:                 document.getElementById('dlPriority').value || 'normal',
    status:                   document.getElementById('dlStatus').value || 'open',
    submission_reference:     document.getElementById('dlSubmissionRef').value.trim() || null,
    notes:                    document.getElementById('dlNotes').value.trim() || null,
    internal_notes:           document.getElementById('dlInternalNotes').value.trim() || null
  };

  try {
    var method = _editDeadlineId ? 'PUT' : 'POST';
    var url    = '/api/practice/deadlines' + (_editDeadlineId ? '/' + _editDeadlineId : '');
    var r = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(payload) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Save failed');
    PracticeAPI.showToast(_editDeadlineId ? 'Deadline updated' : 'Deadline created');
    closeModal('deadlineModal');
    await refresh();
  } catch(err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Deadline';
  }
  return false;
}

async function cancelDeadline() {
  if (!_editDeadlineId) return;
  if (!confirm('Cancel this deadline? It will be marked as cancelled and hidden. This cannot be undone.')) return;
  try {
    var r = await PracticeAPI.fetch('/api/practice/deadlines/' + _editDeadlineId, { method: 'DELETE' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    PracticeAPI.showToast('Deadline cancelled');
    closeModal('deadlineModal');
    await refresh();
  } catch(err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  }
}

// ── Rule modal ────────────────────────────────────────────────────────────────
async function openRuleModal(id) {
  _editRuleId = id || null;
  document.getElementById('ruleForm').reset();
  document.getElementById('ruleModalTitle').textContent = id ? 'Edit Rule' : 'New Compliance Rule';
  document.getElementById('rlDeactivateBtn').style.display = id ? '' : 'none';

  if (id) {
    try {
      var r = await PracticeAPI.fetch('/api/practice/compliance/rules');
      var d = await r.json();
      var rule = (d.rules || []).find(function(x){ return x.id === id; });
      if (!rule) throw new Error();
      document.getElementById('rlName').value          = rule.rule_name || '';
      document.getElementById('rlArea').value          = rule.compliance_area || '';
      document.getElementById('rlDeadlineType').value  = rule.deadline_type || '';
      document.getElementById('rlClientType').value    = rule.client_type || '';
      document.getElementById('rlRecurrence').value    = rule.recurrence_type || '';
      document.getElementById('rlDueDay').value        = rule.due_day || '';
      document.getElementById('rlDueMonth').value      = rule.due_month || '';
      document.getElementById('rlOffsetBasis').value   = rule.due_offset_basis || '';
      document.getElementById('rlOffsetDays').value    = rule.due_offset_days || '';
      document.getElementById('rlNotes').value         = rule.notes || '';
    } catch(e) {
      PracticeAPI.showToast('Failed to load rule', true); return;
    }
  }
  document.getElementById('ruleModal').classList.add('show');
}

async function saveRule(e) {
  e.preventDefault();
  var payload = {
    rule_name:       document.getElementById('rlName').value.trim(),
    compliance_area: document.getElementById('rlArea').value,
    deadline_type:   document.getElementById('rlDeadlineType').value,
    client_type:     document.getElementById('rlClientType').value || null,
    recurrence_type: document.getElementById('rlRecurrence').value || null,
    due_day:         document.getElementById('rlDueDay').value ? parseInt(document.getElementById('rlDueDay').value) : null,
    due_month:       document.getElementById('rlDueMonth').value ? parseInt(document.getElementById('rlDueMonth').value) : null,
    due_offset_basis:document.getElementById('rlOffsetBasis').value || null,
    due_offset_days: document.getElementById('rlOffsetDays').value ? parseInt(document.getElementById('rlOffsetDays').value) : null,
    notes:           document.getElementById('rlNotes').value.trim() || null
  };
  try {
    var method = _editRuleId ? 'PUT' : 'POST';
    var url    = '/api/practice/compliance/rules' + (_editRuleId ? '/' + _editRuleId : '');
    var r = await PracticeAPI.fetch(url, { method: method, body: JSON.stringify(payload) });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Save failed');
    PracticeAPI.showToast(_editRuleId ? 'Rule updated' : 'Rule created');
    closeModal('ruleModal');
    loadRules();
  } catch(err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  }
  return false;
}

async function deactivateRule() {
  if (!_editRuleId) return;
  if (!confirm('Deactivate this compliance rule? It will be hidden but not deleted.')) return;
  try {
    var r = await PracticeAPI.fetch('/api/practice/compliance/rules/' + _editRuleId, { method: 'DELETE' });
    if (!r.ok) { var d = await r.json(); throw new Error(d.error || 'Failed'); }
    PracticeAPI.showToast('Rule deactivated');
    closeModal('ruleModal');
    loadRules();
  } catch(err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  }
}

// ── Quick status modal ────────────────────────────────────────────────────────
function openStatusModal(id, currentStatus) {
  _statusTargetId = id;
  document.getElementById('stStatus').value = currentStatus || 'open';
  document.getElementById('stNote').value   = '';
  document.getElementById('stRef').value    = '';
  document.getElementById('statusModal').classList.add('show');
  document.getElementById('stStatus').onchange = function() {
    document.getElementById('stRefWrap').style.display = this.value === 'submitted' ? '' : 'none';
  };
  document.getElementById('stRefWrap').style.display = currentStatus === 'submitted' ? '' : 'none';
}

async function saveStatus(e) {
  e.preventDefault();
  var status = document.getElementById('stStatus').value;
  var ref    = document.getElementById('stRef').value.trim() || null;
  var note   = document.getElementById('stNote').value.trim() || null;
  try {
    var r = await PracticeAPI.fetch('/api/practice/deadlines/' + _statusTargetId + '/status', {
      method: 'PUT',
      body: JSON.stringify({ status: status, submission_reference: ref, event_note: note })
    });
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed');
    PracticeAPI.showToast('Status updated to: ' + status);
    closeModal('statusModal');
    await refresh();
  } catch(err) {
    PracticeAPI.showToast('Error: ' + err.message, true);
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function formatDate(s) {
  if (!s) return '—';
  var p = s.split('-');
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return parseInt(p[2]) + ' ' + months[parseInt(p[1]) - 1] + ' ' + p[0];
}

function statusBadge(s) {
  var map = {
    open: 'badge-open', in_progress: 'badge-in-progress', waiting_client: 'badge-info',
    waiting_review: 'badge-review', submitted: 'badge-submitted', completed: 'badge-completed',
    overdue: 'badge-overdue', cancelled: 'badge-cancelled', pending: 'badge-pending', missed: 'badge-overdue'
  };
  var label = s ? s.replace(/_/g, ' ') : 'unknown';
  label = label.charAt(0).toUpperCase() + label.slice(1);
  return '<span class="badge ' + (map[s] || '') + '">' + esc(label) + '</span>';
}

function priorityBadge(p) {
  if (!p || p === 'normal') return '';
  var map = { low: 'badge-low', high: 'badge-high', urgent: 'badge-urgent' };
  return '<span class="badge ' + (map[p] || '') + '">' + esc(p) + '</span>';
}

function areaLabel(area) {
  if (!area) return '<span class="col-muted">—</span>';
  var map = {
    vat: 'VAT', paye: 'PAYE', emp501: 'EMP501', provisional_tax: 'Prov Tax',
    income_tax: 'Income Tax', cipc: 'CIPC', bo: 'BO', annual_financials: 'Annual FS',
    bookkeeping: 'Bookkeeping', payroll: 'Payroll', internal: 'Internal', other: 'Other',
    // Legacy type values from old deadlines
    vat_return: 'VAT', tax_return: 'Tax', annual_financial: 'Annual FS',
    provisional_tax_p1: 'Prov Tax P1', provisional_tax_p2: 'Prov Tax P2',
    provisional_tax_top_up: 'Prov Tax Top-Up', cipc_annual_return: 'CIPC',
    beneficial_ownership: 'BO', general: 'General'
  };
  return '<span class="badge badge-info" style="font-size:0.7rem">' + esc(map[area] || area) + '</span>';
}
