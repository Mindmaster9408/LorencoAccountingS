/* ============================================================
   Lorenco Practice — Capacity Planning
   IIFE module. Auth-gated. All data from server API.
   No localStorage for business data (Rule D).
   ============================================================ */
(function () {

  // ─── State ───────────────────────────────────────────────────────────────────

  var _teamData    = [];  // cache for modal pre-fill
  var _saving      = false;

  // ─── Init ────────────────────────────────────────────────────────────────────

  function init() {
    var token = localStorage.getItem('practice_token') || localStorage.getItem('token');
    if (!token) { window.location.href = '/'; return; }

    LAYOUT.init('capacity');

    // All 3 data sections load in parallel — they are independent
    Promise.all([
      loadSummary(),
      loadTeam(),
      loadClients(),
    ]);
    loadRisks();
  }

  // ─── Summary KPIs ────────────────────────────────────────────────────────────

  function loadSummary() {
    return PracticeAPI.fetch('/api/practice/capacity/summary')
      .then(function (data) {
        setText('kv-total-cap', data.total_team_capacity_hours != null ? data.total_team_capacity_hours + ' hrs' : '— hrs');
        setText('kv-allocated', data.allocated_task_hours != null ? data.allocated_task_hours + ' hrs' : '—');
        setText('kv-util',      data.utilization_percentage != null ? data.utilization_percentage + '%' : '—');
        setText('kv-overloaded', data.overloaded_count != null ? data.overloaded_count : '—');
        setText('kv-underutil',  data.underutilized_count != null ? data.underutilized_count : '—');
        setText('kv-reviews',    data.review_task_count != null ? data.review_task_count : '—');
        setText('kv-overdue',    data.overdue_deadline_count != null ? data.overdue_deadline_count : '—');
        setText('kv-periods',    data.queued_period_count != null ? data.queued_period_count : '—');

        // Colour the KPI cards by severity
        colourKpi('kpi-overloaded', data.overloaded_count > 0   ? 'kpi-danger'  : '');
        colourKpi('kpi-util',       utilColour(data.utilization_percentage));
        colourKpi('kpi-overdue',    data.overdue_deadline_count > 0 ? 'kpi-warning' : '');
      })
      .catch(function (err) {
        showError('cap-summary-error', 'Failed to load summary: ' + (err.message || 'Server error'));
      });
  }

  function utilColour(pct) {
    if (pct == null) return '';
    if (pct > 100) return 'kpi-danger';
    if (pct > 85)  return 'kpi-warning';
    if (pct >= 50) return 'kpi-success';
    return 'kpi-info';
  }

  // ─── Team capacity table ──────────────────────────────────────────────────────

  function loadTeam() {
    return PracticeAPI.fetch('/api/practice/capacity/team')
      .then(function (data) {
        hide('cap-team-loading');
        var team = data.team || [];
        _teamData = team;

        setText('team-sub', '(' + team.length + ' active member' + (team.length !== 1 ? 's' : '') + ')');

        if (!team.length) {
          show('cap-team-empty');
          return;
        }

        var rows = team.map(function (m) {
          var statusClass = 's-' + (m.capacity_status || 'unknown');
          var capLabel    = m.weekly_capacity_hours != null ? m.weekly_capacity_hours + ' hrs' : '<span style="color:var(--muted)">Not set</span>';
          var barWidth    = m.utilization_percentage != null ? Math.min(m.utilization_percentage, 100) : 0;
          var pctLabel    = m.utilization_percentage != null ? m.utilization_percentage + '%' : 'Unknown';

          return '<tr>' +
            '<td class="td-name">' + esc(m.display_name) + '</td>' +
            '<td class="td-role">' + esc(m.role || '—') + '</td>' +
            '<td class="td-num">' + capLabel + '</td>' +
            '<td class="td-util">' +
              '<span class="cap-badge ' + statusClass + '">' + statusLabel(m.capacity_status) + '</span>' +
              '<div class="util-bar-wrap">' +
                '<div class="util-bar-track"><div class="util-bar-fill ' + statusClass + '" style="width:' + barWidth + '%"></div></div>' +
                '<div class="util-pct">' + pctLabel + ' — ' + m.estimated_task_hours + ' of ' + (m.weekly_capacity_hours || '?') + ' hrs allocated</div>' +
              '</div>' +
            '</td>' +
            '<td class="td-num">' + m.active_task_count + '</td>' +
            '<td class="td-num">' + (m.review_pending_count  || 0) + '</td>' +
            '<td class="td-num">' + (m.owned_deadlines_count || 0) + '</td>' +
            '<td class="td-num">' + (m.queued_periods_count  || 0) + '</td>' +
            '<td><button class="btn btn-xs btn-ghost" onclick="openCapModal(' + m.member_id + ')">Set Capacity</button></td>' +
          '</tr>';
        }).join('');

        document.getElementById('cap-team-tbody').innerHTML = rows;
        show('cap-team-table-wrap');
        document.getElementById('cap-team-table-wrap').style.display = '';
      })
      .catch(function (err) {
        hide('cap-team-loading');
        showError('cap-team-error', 'Failed to load team capacity: ' + (err.message || 'Server error'));
      });
  }

  function statusLabel(s) {
    var labels = {
      unknown:       'No Capacity Set',
      underutilized: 'Underutilised',
      normal:        'Normal',
      high:          'High Load',
      overloaded:    'Overloaded'
    };
    return labels[s] || s || '—';
  }

  // ─── Client workload table ────────────────────────────────────────────────────

  function loadClients() {
    return PracticeAPI.fetch('/api/practice/capacity/clients')
      .then(function (data) {
        hide('cap-clients-loading');
        var clients = data.clients || [];

        if (!clients.length) {
          show('cap-clients-empty');
          return;
        }

        var rows = clients.map(function (c) {
          var warnClass = c.overdue_deadlines > 0 ? 'style="color:var(--danger)"' : '';
          return '<tr>' +
            '<td class="td-name">' + esc(c.client_name) + '</td>' +
            '<td class="td-num">' + c.active_tasks + '</td>' +
            '<td class="td-num">' + (c.estimated_hours || 0) + '</td>' +
            '<td class="td-num">' + c.active_workflows + '</td>' +
            '<td class="td-num" ' + warnClass + '>' + c.overdue_deadlines + '</td>' +
            '<td class="td-num">' + c.queued_periods + '</td>' +
            '<td class="td-num">' + c.active_engagements + '</td>' +
          '</tr>';
        }).join('');

        document.getElementById('cap-clients-tbody').innerHTML = rows;
        document.getElementById('cap-clients-table-wrap').style.display = '';
      })
      .catch(function (err) {
        hide('cap-clients-loading');
        showError('cap-clients-error', 'Failed to load client workload: ' + (err.message || 'Server error'));
      });
  }

  // ─── Risk panels ─────────────────────────────────────────────────────────────

  function loadRisks() {
    PracticeAPI.fetch('/api/practice/capacity/risks')
      .then(function (d) {
        hide('cap-risks-loading');

        var panels = [
          riskPanel('Overloaded Staff',      d.overloaded_team_members || [],           'rc-danger',
            function (r) { return esc(r.display_name) + '<div class="risk-item-meta">' + r.utilization_percentage + '% utilised — ' + r.estimated_task_hours + ' hrs allocated</div>'; }),

          riskPanel('No Capacity Set',       d.members_no_capacity_set || [],           'rc-warning',
            function (r) { return esc(r.display_name) + '<div class="risk-item-meta">' + r.active_task_count + ' active task' + (r.active_task_count !== 1 ? 's' : '') + ' — capacity unknown</div>'; }),

          riskPanel('Unassigned Tasks',      d.clients_with_unassigned_work || [],      'rc-warning',
            function (r) { return esc(r.title) + '<div class="risk-item-meta">' + (r.client_name || 'No client') + (r.due_date ? ' · Due ' + fmtDate(r.due_date) : '') + '</div>'; }),

          riskPanel('Engagements No Owner',  d.engagements_without_owner || [],         'rc-muted',
            function (r) { return esc(r.engagement_name) + '<div class="risk-item-meta">' + (r.client_name || '—') + '</div>'; }),

          riskPanel('Deadlines No Owner',    d.deadlines_without_owner || [],           'rc-warning',
            function (r) { return esc(r.title) + '<div class="risk-item-meta">' + (r.client_name || '—') + (r.due_date ? ' · Due ' + fmtDate(r.due_date) : '') + '</div>'; }),

          riskPanel('Periods No Template',   d.queued_periods_without_template || [],   'rc-muted',
            function (r) { return esc(r.period_label || 'Period') + '<div class="risk-item-meta">' + (r.client_name || '—') + (r.engagement_name ? ' · ' + r.engagement_name : '') + '</div>'; }),

          riskPanel('Tasks Missing Estimate', d.tasks_without_estimated_hours || [],    'rc-muted',
            function (r) { return esc(r.title) + '<div class="risk-item-meta">' + (r.client_name || '—') + (r.preparer ? ' · ' + r.preparer : '') + '</div>'; }),
        ];

        var wrap = document.getElementById('cap-risk-panels');
        wrap.innerHTML = panels.join('');
        wrap.style.display = '';
      })
      .catch(function (err) {
        hide('cap-risks-loading');
        showError('cap-risks-error', 'Failed to load risk signals: ' + (err.message || 'Server error'));
      });
  }

  function riskPanel(title, items, countClass, renderItem) {
    var emptyMsg = items.length === 0
      ? '<div style="color:var(--muted);font-size:0.8rem;padding:8px 0">No items — all clear.</div>'
      : items.map(function (r) {
          return '<div class="risk-item"><div class="risk-item-main"><div class="risk-item-name">' + renderItem(r) + '</div></div></div>';
        }).join('');

    var cClass = items.length === 0 ? 'rc-ok' : countClass;
    return '<div class="risk-panel">' +
      '<div class="risk-panel-header">' +
        '<span class="risk-panel-title">' + esc(title) + '</span>' +
        '<span class="risk-count ' + cClass + '">' + items.length + '</span>' +
      '</div>' +
      emptyMsg +
    '</div>';
  }

  // ─── Capacity Settings Modal ──────────────────────────────────────────────────

  function openCapModal(memberId) {
    var m = _teamData.find(function (t) { return t.member_id === memberId; });
    if (!m) return;

    document.getElementById('capModalTitle').textContent = 'Set Capacity — ' + m.display_name;
    document.getElementById('capModalSub').textContent   = m.role || '';
    document.getElementById('capModalMemberId').value    = m.member_id;
    document.getElementById('capWeeklyHours').value      = m.weekly_capacity_hours != null ? m.weekly_capacity_hours : '';
    document.getElementById('capDailyHours').value       = m.daily_capacity_hours  != null ? m.daily_capacity_hours  : '';
    document.getElementById('capNotes').value            = m.capacity_notes || '';
    document.getElementById('capIsActive').checked       = m.capacity_is_active !== false;

    hideError('capModalError');
    document.getElementById('capModal').classList.remove('hidden');
  }

  function closeCapModal() {
    document.getElementById('capModal').classList.add('hidden');
    _saving = false;
    var btn = document.getElementById('capSaveBtn');
    btn.textContent = 'Save';
    btn.disabled = false;
  }

  function saveCapacity() {
    if (_saving) return;

    var memberId = document.getElementById('capModalMemberId').value;
    if (!memberId) return;

    var weeklyRaw = document.getElementById('capWeeklyHours').value.trim();
    var dailyRaw  = document.getElementById('capDailyHours').value.trim();

    if (weeklyRaw !== '' && (isNaN(parseFloat(weeklyRaw)) || parseFloat(weeklyRaw) < 0)) {
      showError('capModalError', 'Weekly capacity must be a positive number (or blank to clear).');
      return;
    }
    if (dailyRaw !== '' && (isNaN(parseFloat(dailyRaw)) || parseFloat(dailyRaw) < 0)) {
      showError('capModalError', 'Daily capacity must be a positive number (or blank to clear).');
      return;
    }

    var payload = {
      weekly_capacity_hours: weeklyRaw !== '' ? parseFloat(weeklyRaw) : null,
      daily_capacity_hours:  dailyRaw  !== '' ? parseFloat(dailyRaw)  : null,
      capacity_notes:        document.getElementById('capNotes').value.trim() || null,
      capacity_is_active:    document.getElementById('capIsActive').checked,
    };

    _saving = true;
    var btn = document.getElementById('capSaveBtn');
    btn.textContent = 'Saving…';
    btn.disabled    = true;
    hideError('capModalError');

    PracticeAPI.fetch('/api/practice/team/' + memberId + '/capacity', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
    .then(function () {
      closeCapModal();
      // Reload the team and summary sections to reflect saved data
      Promise.all([loadSummary(), loadTeam()]);
    })
    .catch(function (err) {
      _saving = false;
      btn.textContent = 'Save';
      btn.disabled    = false;
      showError('capModalError', err.message || 'Save failed. Please try again.');
    });
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  function show(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }
  function hide(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }
  function showError(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideError(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }
  function colourKpi(id, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('kpi-danger','kpi-warning','kpi-success','kpi-info','kpi-accent');
    if (cls) el.classList.add(cls);
  }
  function esc(str) {
    if (!str && str !== 0) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return iso; }
  }

  // ─── Expose for inline HTML handlers ─────────────────────────────────────────
  window.openCapModal   = openCapModal;
  window.closeCapModal  = closeCapModal;
  window.saveCapacity   = saveCapacity;

  // ─── Boot ─────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

})();
