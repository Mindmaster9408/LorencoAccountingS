/* ============================================================
   Lorenco Practice — Client Health Scoring
   IIFE module. Auth-gated. No localStorage for business data.
   Rule D compliant.
   ============================================================ */
(function () {

  // ─── State ───────────────────────────────────────────────────────────────────

  var _allClients     = [];   // cache of full list for client-side filtering
  var _activeFilter   = '';   // current status filter
  var _activeClientId = null; // client shown in detail modal
  var _recalcRunning  = false;
  var _teamMembers    = [];   // cached for action assignee picker
  var _actionSubmitting = false;

  // ─── Init ────────────────────────────────────────────────────────────────────

  function init() {
    var token = localStorage.getItem('practice_token') || localStorage.getItem('token');
    if (!token) { window.location.href = '/'; return; }
    LAYOUT.init('client-health');
    loadTeamMembers();
    loadAll();
  }

  function loadAll() {
    loadSummary();
    loadList();
  }

  // ─── Team members (for action assignee picker) ────────────────────────────────

  function loadTeamMembers() {
    PracticeAPI.fetch('/api/practice/team?active=true')
      .then(function (d) { _teamMembers = d.members || []; })
      .catch(function () { _teamMembers = []; });
  }

  function buildAssigneeOptions(selectedId) {
    var base = '<option value="">Unassigned</option>';
    return base + _teamMembers.map(function (m) {
      var sel = (selectedId && m.id === parseInt(selectedId)) ? ' selected' : '';
      return '<option value="' + m.id + '"' + sel + '>' + esc(m.display_name) + '</option>';
    }).join('');
  }

  // ─── Summary stats ────────────────────────────────────────────────────────────

  function loadSummary() {
    PracticeAPI.fetch('/api/practice/client-health/summary')
      .then(function (d) {
        setText('hsTotalVal',   d.total_clients ?? '—');
        setText('hsGoodVal',    d.good          ?? '—');
        setText('hsWatchVal',   d.watch         ?? '—');
        setText('hsAtRiskVal',  d.at_risk       ?? '—');
        setText('hsCriticalVal',d.critical      ?? '—');
        setText('hsUnknownVal', d.unknown       ?? '—');
        hide('summaryError');
      })
      .catch(function (err) {
        showError('summaryError', 'Summary unavailable: ' + (err.message || 'Server error'));
      });
  }

  // ─── Client list ─────────────────────────────────────────────────────────────

  function loadList() {
    show('listLoading');
    hide('listWrap');
    hide('listEmpty');
    hide('listError');

    PracticeAPI.fetch('/api/practice/client-health?limit=500')
      .then(function (d) {
        hide('listLoading');
        _allClients = d.clients || [];
        applyFilters();
      })
      .catch(function (err) {
        hide('listLoading');
        showError('listError', 'Failed to load health data: ' + (err.message || 'Server error'));
      });
  }

  function applyFilters() {
    var status = document.getElementById('filterStatus').value || _activeFilter;
    var search = (document.getElementById('filterSearch').value || '').toLowerCase().trim();

    var filtered = _allClients.filter(function (c) {
      if (status && c.health_status !== status) return false;
      if (search && !c.client_name.toLowerCase().includes(search)) return false;
      return true;
    });

    // Sort: critical first, then at_risk, watch, good, unknown
    var order = { critical: 0, at_risk: 1, watch: 2, good: 3, unknown: 4 };
    filtered.sort(function (a, b) {
      var ao = order[a.health_status] ?? 5;
      var bo = order[b.health_status] ?? 5;
      if (ao !== bo) return ao - bo;
      // Within same status: lowest score first (most risky)
      var as = a.health_score ?? -1;
      var bs = b.health_score ?? -1;
      return as - bs;
    });

    setText('listCount', filtered.length + ' client' + (filtered.length !== 1 ? 's' : ''));

    if (!filtered.length) {
      hide('listWrap');
      show('listEmpty');
      return;
    }
    hide('listEmpty');

    var rows = filtered.map(function (c) {
      var st    = c.health_status || 'unknown';
      var score = c.health_score  != null ? c.health_score : '—';
      var stLabel = { good: 'Good', watch: 'Watch', at_risk: 'At Risk', critical: 'Critical', unknown: 'Unknown' }[st] || st;

      var chips = (c.top_risks || []).map(function (r) {
        return '<span class="risk-chip">' + esc(r) + '</span>';
      }).join('');

      var odClass = c.overdue_deadlines > 0 ? 'style="color:var(--danger)"' : '';
      var wipClass = c.high_wip > 0 ? 'style="color:var(--warning)"' : '';
      var calcLabel = c.health_last_calculated_at ? fmtDate(c.health_last_calculated_at) : 'Not calculated';

      return '<tr>' +
        '<td><div style="font-weight:500;">' + esc(c.client_name) + '</div>' +
          '<div style="font-size:0.75rem;color:var(--muted);">' + esc(c.client_type || '') + '</div></td>' +
        '<td style="color:var(--muted);font-size:0.82rem;">' + esc(c.responsible || '—') + '</td>' +
        '<td style="text-align:center;">' +
          '<div class="score-circle sc-' + st + '">' + score + '</div>' +
          '<div style="font-size:0.68rem;color:var(--muted);margin-top:3px;">' + esc(calcLabel) + '</div>' +
        '</td>' +
        '<td><span class="health-badge hb-' + st + '">' + esc(stLabel) + '</span></td>' +
        '<td><div class="risk-chips">' + (chips || '<span style="color:var(--muted);font-size:0.78rem;">None</span>') + '</div></td>' +
        '<td class="td-num" ' + odClass + '>' + (c.overdue_deadlines || 0) + '</td>' +
        '<td class="td-num">' + (c.pending_reviews || 0) + '</td>' +
        '<td class="td-num" ' + wipClass + '>' + (c.high_wip || 0) + '</td>' +
        '<td class="td-actions">' +
          '<button class="btn btn-xs btn-ghost" onclick="openHdModal(' + c.client_id + ',\'' + esc(c.client_name).replace(/'/g,"&#39;") + '\')">Detail</button>' +
          ' <button class="btn btn-xs btn-ghost" onclick="recalcOne(' + c.client_id + ')">Recalc</button>' +
          ' <a href="/practice/client-detail.html?id=' + c.client_id + '" class="btn btn-xs btn-ghost" style="text-decoration:none">Profile</a>' +
        '</td>' +
      '</tr>';
    }).join('');

    document.getElementById('listBody').innerHTML = rows;
    document.getElementById('listWrap').style.display = '';
  }

  // ─── Status filter from summary cards ────────────────────────────────────────

  function filterByStatus(status) {
    _activeFilter = status;
    document.getElementById('filterStatus').value = status;
    // Reset search when clicking a summary stat
    applyFilters();

    // Highlight active summary stat
    document.querySelectorAll('.health-stat').forEach(function (el) {
      el.classList.remove('active-filter');
    });
    if (status) {
      var map = { good: 'hs-good', watch: 'hs-watch', at_risk: 'hs-at_risk', critical: 'hs-critical', unknown: 'hs-unknown' };
      var el = document.querySelector('.' + (map[status] || ''));
      if (el) el.classList.add('active-filter');
    }
  }

  // ─── Recalculate all ─────────────────────────────────────────────────────────

  function recalcAll() {
    if (_recalcRunning) return;
    var btn = document.getElementById('recalcAllBtn');
    _recalcRunning = true;
    btn.textContent = 'Recalculating…';
    btn.disabled    = true;

    PracticeAPI.fetch('/api/practice/client-health/recalculate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    })
    .then(function (d) {
      _recalcRunning  = false;
      btn.textContent = 'Recalculate All';
      btn.disabled    = false;
      loadSummary();
      loadList();
    })
    .catch(function (err) {
      _recalcRunning  = false;
      btn.textContent = 'Recalculate All';
      btn.disabled    = false;
      alert('Recalculation failed: ' + (err.message || 'Server error'));
    });
  }

  function recalcOne(clientId) {
    PracticeAPI.fetch('/api/practice/client-health/recalculate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ client_id: clientId }),
    })
    .then(function () {
      loadSummary();
      loadList();
      if (_activeClientId === clientId) {
        openHdModal(clientId, document.getElementById('hdTitle').textContent);
      }
    })
    .catch(function (err) {
      alert('Recalculation failed: ' + (err.message || 'Server error'));
    });
  }

  // ─── Client health detail modal ───────────────────────────────────────────────

  function openHdModal(clientId, clientName) {
    _activeClientId   = clientId;
    _actionSubmitting = false;
    document.getElementById('hdTitle').textContent = clientName || 'Client Health';
    document.getElementById('hdSub').textContent   = '';
    document.getElementById('hdScoreVal').textContent = '…';
    document.getElementById('hdMetrics').innerHTML  = '<div style="color:var(--muted);font-size:0.83rem;">Loading…</div>';
    document.getElementById('hdRisks').innerHTML    = '';
    document.getElementById('hdStatusBadge').textContent = '';
    document.getElementById('hdCalcAt').textContent  = '';
    document.getElementById('hdActionForm').classList.add('hidden');
    document.getElementById('hdActionsList').innerHTML = '<div class="action-list-loading">Loading actions…</div>';
    document.getElementById('hdModal').classList.remove('hidden');
    document.getElementById('hdRecalcBtn').dataset.clientId = clientId;

    PracticeAPI.fetch('/api/practice/client-health/' + clientId)
      .then(function (d) {
        renderHdModal(d);
      })
      .catch(function (err) {
        document.getElementById('hdMetrics').innerHTML = '<div class="error-banner">' + esc(err.message || 'Failed to load') + '</div>';
      });
  }

  function renderHdModal(d) {
    var st = d.health_status || 'unknown';
    var stLabel = { good: 'Good', watch: 'Watch', at_risk: 'At Risk', critical: 'Critical', unknown: 'Unknown' }[st] || st;
    var score   = d.health_score != null ? d.health_score : '—';

    // Score
    var scoreEl = document.getElementById('hdScoreVal');
    scoreEl.textContent = score;
    scoreEl.className   = 'hd-score-big c-' + st;

    // Status badge
    var badgeEl = document.getElementById('hdStatusBadge');
    badgeEl.textContent = stLabel;
    badgeEl.className   = 'health-badge hb-' + st;

    // Last calculated
    var snap = d.last_snapshot;
    document.getElementById('hdCalcAt').textContent = snap
      ? 'Last calculated: ' + fmtDate(snap.calculated_at)
      : 'Not yet persisted — run Recalculate to save';

    // Sub-title
    document.getElementById('hdSub').textContent = 'Client Health Detail';

    // Metrics grid
    var m = d.metrics || {};
    var metricDefs = [
      { label: 'Overdue Deadlines', value: m.overdue_deadlines || 0, danger: (m.overdue_deadlines || 0) > 0 },
      { label: 'Pending Reviews',   value: m.pending_reviews   || 0, warn:  (m.pending_reviews   || 0) > 5 },
      { label: 'Unassigned Tasks',  value: m.unassigned_tasks  || 0, warn:  (m.unassigned_tasks  || 0) > 0 },
      { label: 'Overdue Periods',   value: m.queued_overdue_periods || 0, warn: (m.queued_overdue_periods || 0) > 0 },
      { label: 'Active Engagements',value: m.active_engagements || 0 },
      { label: 'Old WIP Packs',     value: m.old_wip_count || 0, warn: (m.old_wip_count || 0) > 0 },
      { label: 'Write-off %',       value: (m.writeoff_percentage || 0) + '%', warn: (m.writeoff_percentage || 0) > 20 },
    ];
    document.getElementById('hdMetrics').innerHTML = metricDefs.map(function (md) {
      var cls = md.danger ? 'v-danger' : (md.warn ? 'v-warning' : '');
      return '<div class="hd-metric">' +
        '<div class="hd-metric-value ' + cls + '">' + esc(String(md.value)) + '</div>' +
        '<div class="hd-metric-label">' + esc(md.label) + '</div>' +
      '</div>';
    }).join('');

    // Risk factors — with action + module-link buttons
    var RISK_MODULE = {
      overdue_deadlines:      { label: 'Deadlines', path: '/practice/deadlines.html' },
      many_overdue_deadlines: { label: 'Deadlines', path: '/practice/deadlines.html' },
      review_backlog:         { label: 'Tasks',     path: '/practice/tasks.html' },
      unassigned_tasks:       { label: 'Tasks',     path: '/practice/tasks.html' },
      overdue_periods:        { label: 'Period Queue', path: '/practice/engagement-periods.html' },
      old_wip:                { label: 'Billing',   path: '/practice/billing.html' },
      high_writeoff:          { label: 'Billing',   path: '/practice/billing.html' },
      engagement_no_owner:    { label: 'Client', path: '/practice/client-detail.html?id=' + d.client_id },
      missing_recurrence:     { label: 'Client', path: '/practice/client-detail.html?id=' + d.client_id },
      no_client_owner:        { label: 'Client', path: '/practice/client-detail.html?id=' + d.client_id },
    };

    var risks = d.risk_factors || [];
    if (!risks.length) {
      document.getElementById('hdRisks').innerHTML = '<div class="no-risk-msg">No risk factors identified.</div>';
    } else {
      document.getElementById('hdRisks').innerHTML = risks.map(function (r) {
        var dotClass = 'dot-' + (r.severity === 'critical' ? 'critical' : r.severity === 'warning' ? 'warning' : 'info');
        var meta = [];
        if (r.count != null) meta.push('Count: ' + r.count);
        if (r.value != null) meta.push(r.value);
        if (r.items && r.items.length) meta.push(r.items.map(function (i) { return i.label || i.title || ('ID ' + i.id); }).join(', '));
        var ml = RISK_MODULE[r.code];
        var moduleBtn = ml
          ? '<a href="' + ml.path + '" class="btn btn-xs btn-ghost btn-link-plain">→ ' + esc(ml.label) + '</a>'
          : '';
        var actionBtn = '<button type="button" class="btn btn-xs btn-ghost" onclick="openActionForm(' +
          JSON.stringify(r.code) + ',' + JSON.stringify(r.label) + ')">+ Action</button>';
        return '<div class="hd-risk-item">' +
          '<div class="hd-risk-dot ' + dotClass + '"></div>' +
          '<div class="hd-risk-item-body">' +
            '<div class="hd-risk-label">' + esc(r.label) + '</div>' +
            (meta.length ? '<div class="hd-risk-meta">' + esc(meta.join(' · ')) + '</div>' : '') +
          '</div>' +
          '<div class="hd-risk-item-actions">' + moduleBtn + actionBtn + '</div>' +
        '</div>';
      }).join('');
    }

    // Load actions list for this client
    loadClientActions(_activeClientId);
    // Populate assignee picker
    document.getElementById('hdActionAssignee').innerHTML = buildAssigneeOptions(null);
  }

  function closeHdModal() {
    document.getElementById('hdModal').classList.add('hidden');
    _activeClientId = null;
  }

  function recalcSingle() {
    var clientId = parseInt(document.getElementById('hdRecalcBtn').dataset.clientId);
    if (!clientId) return;
    var btn = document.getElementById('hdRecalcBtn');
    btn.textContent = 'Recalculating…';
    btn.disabled    = true;

    PracticeAPI.fetch('/api/practice/client-health/recalculate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ client_id: clientId }),
    })
    .then(function () {
      btn.textContent = 'Recalculate';
      btn.disabled    = false;
      // Reload detail
      openHdModal(clientId, document.getElementById('hdTitle').textContent);
      loadSummary();
      loadList();
    })
    .catch(function (err) {
      btn.textContent = 'Recalculate';
      btn.disabled    = false;
      alert('Recalculation failed: ' + (err.message || 'Server error'));
    });
  }

  // ─── Actions — load list ─────────────────────────────────────────────────────

  function loadClientActions(clientId) {
    var el = document.getElementById('hdActionsList');
    if (!el || !clientId) return;
    el.innerHTML = '<div class="action-list-loading">Loading actions…</div>';

    PracticeAPI.fetch('/api/practice/client-health/' + clientId + '/actions')
      .then(function (d) {
        renderActionsList(d.actions || []);
      })
      .catch(function (err) {
        el.innerHTML = '<div class="error-banner">' + esc(err.message || 'Failed to load actions') + '</div>';
      });
  }

  function renderActionsList(actions) {
    var el = document.getElementById('hdActionsList');
    if (!el) return;
    if (!actions.length) {
      el.innerHTML = '<div class="action-list-empty">No follow-up actions yet. Click "+ Action" on a risk factor above.</div>';
      return;
    }
    var TYPE_LABELS = {
      create_task: 'Task', assign_owner: 'Assign Owner', open_deadline: 'Deadline',
      generate_period: 'Period', review_wip: 'Review WIP', fix_recurrence: 'Fix Recurrence',
      fix_missing_owner: 'Fix Owner', general_followup: 'Follow-up',
    };
    el.innerHTML = actions.map(function (a) {
      var canAct = a.action_status === 'open' || a.action_status === 'in_progress';
      var dimCls = a.action_status === 'completed' ? ' ai-completed' : (a.action_status === 'dismissed' ? ' ai-dismissed' : '');
      var typeLabel   = TYPE_LABELS[a.action_type] || a.action_type;
      var statusLabel = { open: 'Open', in_progress: 'In Progress', completed: 'Done', dismissed: 'Dismissed', cancelled: 'Cancelled' }[a.action_status] || a.action_status;
      var meta = [];
      if (a.assigned_to_name) meta.push('→ ' + a.assigned_to_name);
      if (a.due_date) meta.push('Due: ' + fmtDate(a.due_date));
      if (a.source_risk_label) meta.push('Risk: ' + a.source_risk_label);
      if (a.linked_task_id) meta.push('<a href="/practice/tasks.html" class="btn-link-plain" style="color:var(--accent)">Linked task #' + a.linked_task_id + '</a>');

      var btns = canAct
        ? '<button type="button" class="btn btn-xs btn-ghost" onclick="completeAction(' + a.id + ')">✓ Done</button>' +
          '<button type="button" class="btn btn-xs btn-ghost" onclick="dismissAction(' + a.id + ')">✕ Dismiss</button>'
        : '';

      return '<div class="action-list-item' + dimCls + '">' +
        '<div class="action-item-body">' +
          '<div class="action-item-title">' + esc(a.action_title) + '</div>' +
          '<div class="action-item-meta">' +
            '<span class="action-type-badge">' + esc(typeLabel) + '</span>' +
            '<span class="action-status-badge asb-' + a.action_status + '">' + esc(statusLabel) + '</span>' +
            (meta.length ? '<span>' + meta.join(' · ') + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="action-item-btns">' + btns + '</div>' +
      '</div>';
    }).join('');
  }

  // ─── Actions — form open/close ────────────────────────────────────────────────

  function openActionForm(riskCode, riskLabel) {
    var SUGGESTED = {
      create_task: 'create_task', assign_owner: 'assign_owner',
      open_deadline: 'open_deadline', generate_period: 'generate_period',
      review_wip: 'review_wip', fix_recurrence: 'fix_recurrence',
      fix_missing_owner: 'fix_missing_owner', general_followup: 'general_followup',
    };
    var RISK_TYPE_MAP = {
      overdue_deadlines: 'open_deadline', many_overdue_deadlines: 'open_deadline',
      review_backlog: 'create_task', unassigned_tasks: 'assign_owner',
      overdue_periods: 'generate_period', engagement_no_owner: 'fix_missing_owner',
      missing_recurrence: 'fix_recurrence', old_wip: 'review_wip',
      high_writeoff: 'review_wip', no_client_owner: 'assign_owner',
    };

    document.getElementById('hdActionRiskCode').value  = riskCode  || '';
    document.getElementById('hdActionRiskLabel').value = riskLabel || '';
    document.getElementById('hdActionTitle').value     = 'Follow up: ' + (riskLabel || riskCode);
    document.getElementById('hdActionDue').value       = '';
    document.getElementById('hdActionNotes').value     = '';
    document.getElementById('hdActionAssignee').innerHTML = buildAssigneeOptions(null);

    var suggestedType = RISK_TYPE_MAP[riskCode] || 'general_followup';
    var typeEl = document.getElementById('hdActionType');
    typeEl.value = suggestedType;

    hide('hdActionFormError');
    document.getElementById('hdActionForm').classList.remove('hidden');
    document.getElementById('hdActionTitle').focus();
  }

  function openManualActionForm() {
    openActionForm('', 'Manual follow-up');
    document.getElementById('hdActionType').value = 'general_followup';
    document.getElementById('hdActionTitle').value = '';
  }

  function cancelActionForm() {
    document.getElementById('hdActionForm').classList.add('hidden');
    hide('hdActionFormError');
    _actionSubmitting = false;
  }

  function submitActionForm() {
    if (_actionSubmitting) return;
    if (!_activeClientId) return;

    var title     = document.getElementById('hdActionTitle').value.trim();
    var type      = document.getElementById('hdActionType').value;
    var assignee  = document.getElementById('hdActionAssignee').value;
    var due       = document.getElementById('hdActionDue').value;
    var notes     = document.getElementById('hdActionNotes').value.trim();
    var riskCode  = document.getElementById('hdActionRiskCode').value;
    var riskLabel = document.getElementById('hdActionRiskLabel').value;

    if (!title) {
      showError('hdActionFormError', 'Action title is required');
      return;
    }

    _actionSubmitting = true;
    var btn = document.getElementById('hdActionSubmitBtn');
    btn.textContent = 'Creating…';
    btn.disabled    = true;

    var endpoint = '/api/practice/client-health/' + _activeClientId +
      (riskCode ? '/actions/from-risk' : '/actions');

    var body = riskCode
      ? { risk_code: riskCode, risk_label: riskLabel, preferred_action_type: type,
          action_title: title, assigned_team_member_id: assignee || null,
          due_date: due || null, notes: notes || null }
      : { action_type: type, action_title: title,
          assigned_team_member_id: assignee || null,
          due_date: due || null, notes: notes || null };

    PracticeAPI.fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    .then(function (d) {
      _actionSubmitting  = false;
      btn.textContent    = 'Create Action';
      btn.disabled       = false;
      cancelActionForm();
      loadClientActions(_activeClientId);
      // Show task link if one was created
      if (d.linked_task_id) {
        alert('Action created. Linked task #' + d.linked_task_id + ' has been added to Tasks.');
      }
    })
    .catch(function (err) {
      _actionSubmitting  = false;
      btn.textContent    = 'Create Action';
      btn.disabled       = false;
      showError('hdActionFormError', err.message || 'Failed to create action');
    });
  }

  // ─── Actions — complete / dismiss ────────────────────────────────────────────

  function completeAction(actionId) {
    PracticeAPI.fetch('/api/practice/client-health/actions/' + actionId + '/complete', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    })
    .then(function () { loadClientActions(_activeClientId); })
    .catch(function (err) { alert('Failed: ' + (err.message || 'Server error')); });
  }

  function dismissAction(actionId) {
    if (!confirm('Dismiss this action?')) return;
    PracticeAPI.fetch('/api/practice/client-health/actions/' + actionId + '/dismiss', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    })
    .then(function () { loadClientActions(_activeClientId); })
    .catch(function (err) { alert('Failed: ' + (err.message || 'Server error')); });
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  function show(id)  { var el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
  function hide(id)  { var el = document.getElementById(id); if (el) el.classList.add('hidden');    }
  function showError(id, msg) { var el = document.getElementById(id); if (!el) return; el.textContent = msg; el.classList.remove('hidden'); }
  function esc(str) {
    if (!str && str !== 0) return '';
    var d = document.createElement('div'); d.textContent = String(str); return d.innerHTML;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch(e) { return iso; }
  }

  // ─── Expose for inline handlers ──────────────────────────────────────────────
  window.loadAll            = loadAll;
  window.applyFilters       = applyFilters;
  window.filterByStatus     = filterByStatus;
  window.openHdModal        = openHdModal;
  window.closeHdModal       = closeHdModal;
  window.recalcAll          = recalcAll;
  window.recalcOne          = recalcOne;
  window.recalcSingle       = recalcSingle;
  window.openActionForm     = openActionForm;
  window.openManualActionForm = openManualActionForm;
  window.cancelActionForm   = cancelActionForm;
  window.submitActionForm   = submitActionForm;
  window.completeAction     = completeAction;
  window.dismissAction      = dismissAction;

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

})();
