/* billing.js — Lorenco Practice Management — Billing Preparation + WIP Management */

var _allClients      = [];
var _wipEntries      = [];     // raw entries from GET /billing/wip
var _selectedIds     = new Set();  // selected entry IDs for pack creation
var _currentPackId   = null;  // pack open in detail modal
var _writeoffLineId  = null;  // line open in write-off modal

var esc = PracticeAPI.escHtml;

var PACK_STATUS_LABELS = {
  draft:     'Draft',
  reviewed:  'Reviewed',
  approved:  'Approved',
  locked:    'Locked',
  cancelled: 'Cancelled'
};

var LINE_STATUS_LABELS = {
  included:    'Included',
  written_off: 'Written Off',
  excluded:    'Excluded'
};

var EVENT_TYPE_LABELS = {
  pack_created:          'Pack Created',
  pack_updated:          'Pack Updated',
  pack_recalculated:     'Totals Recalculated',
  pack_approved:         'Pack Approved',
  pack_locked:           'Pack Locked',
  pack_cancelled:        'Pack Cancelled',
  pack_number_assigned:  'Pack Number Assigned',
  pack_line_written_off: 'Entry Written Off',
  pack_line_excluded:    'Entry Excluded'
};

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  if (!AUTH.requireAuth()) return;
  LAYOUT.init('billing');

  await loadClients();
  await Promise.all([loadWip(), loadPacks(), loadBillingStats()]);
}

// ── Load clients (populates all client selects) ───────────────────────────────

async function loadClients() {
  try {
    var res = await PracticeAPI.fetch('/api/practice/clients?is_active=true');
    _allClients = (res.clients || []).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    _allClients = [];
  }

  var opts = _allClients.map(c =>
    '<option value="' + c.id + '">' + esc(c.name) + '</option>'
  ).join('');

  var allOpt = '<option value="">All Clients</option>';

  document.getElementById('wipClientFilter').innerHTML  = allOpt + opts;
  document.getElementById('packClientFilter').innerHTML = allOpt + opts;
  document.getElementById('cpClient').innerHTML =
    '<option value="">Select client…</option>' + opts;
}

// ── WIP Dashboard Stats ───────────────────────────────────────────────────────

async function loadBillingStats() {
  try {
    var wipRes = await PracticeAPI.fetch('/api/practice/billing/wip');

    document.getElementById('statWipRecoverable').textContent =
      formatMoney(wipRes.grand_total_recoverable || 0);
    document.getElementById('statWipHours').textContent =
      (wipRes.grand_total_hours || 0).toFixed(1) + ' hrs — ready to pack';

    // Open packs: fetch non-cancelled/non-locked packs
    var packsRes = await PracticeAPI.fetch('/api/practice/billing/packs?limit=200');
    var openPacks = (packsRes.packs || []).filter(p =>
      !['cancelled', 'locked'].includes(p.status)
    );
    var openValue = openPacks.reduce((s, p) => s + parseFloat(p.billable_value || 0), 0);
    document.getElementById('statOpenPacks').textContent = formatMoney(openValue);
    document.getElementById('statOpenPackCount').textContent =
      openPacks.length + ' open pack' + (openPacks.length !== 1 ? 's' : '');

    // Billed: locked packs (simplistic — sum billable_value of locked packs)
    var lockedPacks = (packsRes.packs || []).filter(p => p.status === 'locked');
    var lockedValue = lockedPacks.reduce((s, p) => s + parseFloat(p.billable_value || 0), 0);
    document.getElementById('statBilledMonth').textContent = formatMoney(lockedValue);

    // Written off: sum writeoff_value across all packs
    var writtenOff = (packsRes.packs || []).reduce((s, p) => s + parseFloat(p.writeoff_value || 0), 0);
    document.getElementById('statWrittenOff').textContent = formatMoney(writtenOff);

    document.getElementById('wipStatGrid').classList.remove('hidden');
  } catch (e) {
    console.error('Billing stats error:', e);
  }
}

// ── WIP List ──────────────────────────────────────────────────────────────────

async function loadWip() {
  var clientId = document.getElementById('wipClientFilter').value;
  var container = document.getElementById('wipList');
  container.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading WIP…</p></div>';

  try {
    var qs = clientId ? '?client_id=' + clientId : '';
    var res = await PracticeAPI.fetch('/api/practice/billing/wip' + qs);
    _wipEntries = res.entries || [];
    renderWip(res.by_client || [], res.entries || []);
  } catch (e) {
    container.innerHTML = '<div class="error-banner">Failed to load WIP: ' + esc(e.message) + '</div>';
  }
}

function renderWip(byClient, entries) {
  var container = document.getElementById('wipList');

  if (!entries.length) {
    container.innerHTML = '<div class="empty-state">No approved unbilled time. Approve time entries on the Time page first.</div>';
    return;
  }

  // Map entries by client for lookup
  var entriesByClient = {};
  entries.forEach(e => {
    var clientId = (e.practice_clients && e.practice_clients.id) ? e.practice_clients.id : 'none';
    if (!entriesByClient[clientId]) entriesByClient[clientId] = [];
    entriesByClient[clientId].push(e);
  });

  var html = '';

  byClient.forEach(function(c) {
    var key        = c.client_id || 'none';
    var cEntries   = entriesByClient[key] || [];
    var sectionId  = 'wip-section-' + key;

    html += '<div class="wip-client-card">';
    html += '<div class="wip-client-header" onclick="toggleWipSection(\'' + sectionId + '\')">';
    html += '<div>';
    html += '<div class="wip-client-name">' + esc(c.client_name) + '</div>';
    html += '<div class="wip-client-meta">' + c.entry_count + ' entr' + (c.entry_count !== 1 ? 'ies' : 'y') + '</div>';
    html += '</div>';
    html += '<div class="wip-client-stats">';
    html += '<div class="wip-client-stat"><div class="wip-client-stat-val">' + c.total_hours.toFixed(1) + '</div><div class="wip-client-stat-lbl">Hrs</div></div>';
    html += '<div class="wip-client-stat"><div class="wip-client-stat-val">' + formatMoney(c.total_recoverable) + '</div><div class="wip-client-stat-lbl">Recoverable</div></div>';
    html += '<span style="color:var(--text-muted);font-size:12px;">▼</span>';
    html += '</div>';
    html += '</div>';

    html += '<div class="wip-entry-table hidden" id="' + sectionId + '">';
    html += '<table class="data-table"><thead><tr>';
    html += '<th class="wip-checkbox-col"><input type="checkbox" onchange="toggleClientEntries(event, \'' + esc(c.client_id || '') + '\')" title="Select all for this client"></th>';
    html += '<th>Date</th><th>Description</th><th>Hrs</th><th>Rate</th><th>Recoverable</th>';
    html += '</tr></thead><tbody>';

    cEntries.forEach(function(e) {
      var checked = _selectedIds.has(e.id) ? 'checked' : '';
      html += '<tr>';
      html += '<td class="wip-checkbox-col"><input type="checkbox" data-entry-id="' + e.id +
              '" data-client-id="' + (e.practice_clients && e.practice_clients.id ? e.practice_clients.id : '') +
              '" ' + checked + ' onchange="toggleEntrySelection(event)"></td>';
      html += '<td>' + esc(e.date || '–') + '</td>';
      html += '<td>' + esc((e.description || '–').substring(0, 60)) + '</td>';
      html += '<td>' + parseFloat(e.hours || 0).toFixed(2) + '</td>';
      html += '<td>' + (e.effective_rate ? 'R' + parseFloat(e.effective_rate).toFixed(0) : '–') + '</td>';
      html += '<td>' + formatMoney(e.recoverable_value || 0) + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';

    // Selection action bar
    html += '<div class="wip-select-bar">';
    html += '<span class="selected-count" id="sel-count-' + key + '">0 selected</span>';
    html += '</div>';
    html += '</div>'; // .wip-entry-table

    html += '</div>'; // .wip-client-card
  });

  container.innerHTML = html;
  updateSelectedCount();
}

function toggleWipSection(sectionId) {
  var el = document.getElementById(sectionId);
  if (el) el.classList.toggle('hidden');
}

function toggleEntrySelection(event) {
  var cb        = event.target;
  var entryId   = parseInt(cb.dataset.entryId);
  var clientId  = cb.dataset.clientId;

  if (cb.checked) {
    // Enforce single-client constraint
    if (_selectedIds.size > 0) {
      var firstEntry = _wipEntries.find(e => _selectedIds.has(e.id));
      var firstClientId = firstEntry && firstEntry.practice_clients
        ? String(firstEntry.practice_clients.id) : '';
      if (firstClientId && firstClientId !== clientId) {
        cb.checked = false;
        showToast('All selected entries must belong to the same client.', 'error');
        return;
      }
    }
    _selectedIds.add(entryId);
    // Auto-populate client in create form
    if (clientId) document.getElementById('cpClient').value = clientId;
  } else {
    _selectedIds.delete(entryId);
    if (_selectedIds.size === 0) document.getElementById('cpClient').value = '';
  }

  updateSelectedCount();
}

function toggleClientEntries(event, clientId) {
  var checked    = event.target.checked;
  var section    = event.target.closest('.wip-client-card').querySelector('.wip-entry-table');
  var checkboxes = section.querySelectorAll('input[type=checkbox][data-entry-id]');

  checkboxes.forEach(function(cb) {
    if (checked) {
      var entryId = parseInt(cb.dataset.entryId);
      if (_selectedIds.size > 0) {
        var firstEntry = _wipEntries.find(e => _selectedIds.has(e.id));
        var firstClientId = firstEntry && firstEntry.practice_clients
          ? String(firstEntry.practice_clients.id) : '';
        if (firstClientId && firstClientId !== cb.dataset.clientId) {
          event.target.checked = false;
          showToast('Cannot mix clients. Deselect current selection first.', 'error');
          return;
        }
      }
      _selectedIds.add(entryId);
      cb.checked = true;
      if (clientId) document.getElementById('cpClient').value = clientId;
    } else {
      _selectedIds.delete(parseInt(cb.dataset.entryId));
      cb.checked = false;
    }
  });

  if (_selectedIds.size === 0) document.getElementById('cpClient').value = '';
  updateSelectedCount();
}

function filterWipByCreateClient() {
  var clientId = document.getElementById('cpClient').value;
  document.getElementById('wipClientFilter').value = clientId;
  loadWip();
}

function updateSelectedCount() {
  var count   = _selectedIds.size;
  var msg     = count > 0
    ? count + ' entr' + (count !== 1 ? 'ies' : 'y') + ' selected'
    : 'Select entries from the left panel to include in this pack.';
  var el = document.getElementById('selectedCountMsg');
  if (el) el.textContent = msg;

  var btn = document.getElementById('createPackBtn');
  if (btn) btn.disabled = count === 0;

  // Update per-client counts
  var byClient = {};
  _wipEntries.forEach(function(e) {
    var cid = e.practice_clients && e.practice_clients.id ? e.practice_clients.id : 'none';
    if (!byClient[cid]) byClient[cid] = 0;
    if (_selectedIds.has(e.id)) byClient[cid]++;
  });

  Object.keys(byClient).forEach(function(key) {
    var el2 = document.getElementById('sel-count-' + key);
    if (el2) {
      var n = byClient[key];
      el2.textContent = n > 0 ? n + ' selected' : '0 selected';
    }
  });
}

// ── Create Billing Pack ───────────────────────────────────────────────────────

async function createPack() {
  var clientId = document.getElementById('cpClient').value;
  var packName = document.getElementById('cpName').value.trim();
  var start    = document.getElementById('cpStart').value;
  var end      = document.getElementById('cpEnd').value;
  var notes    = document.getElementById('cpNotes').value.trim();

  if (!clientId) { showToast('Select a client', 'error'); return; }
  if (!packName) { showToast('Enter a pack name', 'error'); return; }
  if (_selectedIds.size === 0) { showToast('Select at least one time entry', 'error'); return; }

  var btn = document.getElementById('createPackBtn');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    var res = await PracticeAPI.fetch('/api/practice/billing/packs', {
      method: 'POST',
      body: JSON.stringify({
        client_id:       parseInt(clientId),
        pack_name:       packName,
        period_start:    start || null,
        period_end:      end   || null,
        notes:           notes || null,
        time_entry_ids:  Array.from(_selectedIds)
      })
    });

    showToast('Billing pack created: ' + res.pack.pack_name);

    // Reset
    _selectedIds.clear();
    document.getElementById('cpName').value  = '';
    document.getElementById('cpStart').value = '';
    document.getElementById('cpEnd').value   = '';
    document.getElementById('cpNotes').value = '';
    document.getElementById('cpClient').value = '';

    await Promise.all([loadWip(), loadPacks(), loadBillingStats()]);

    // Auto-open the new pack for immediate review
    if (res.pack && res.pack.id) openPackDetail(res.pack.id);

  } catch (e) {
    showToast(e.message || 'Failed to create pack', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Pack';
  }
}

// ── Billing Packs List ────────────────────────────────────────────────────────

async function loadPacks() {
  var clientId = document.getElementById('packClientFilter').value;
  var status   = document.getElementById('packStatusFilter').value;
  var container = document.getElementById('packsWrap');
  container.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading packs…</p></div>';

  try {
    var qs = [];
    if (clientId) qs.push('client_id=' + clientId);
    if (status)   qs.push('status=' + status);
    qs.push('limit=100');

    var res = await PracticeAPI.fetch('/api/practice/billing/packs?' + qs.join('&'));
    renderPacks(res.packs || []);
  } catch (e) {
    container.innerHTML = '<div class="error-banner">Failed to load packs: ' + esc(e.message) + '</div>';
  }
}

function renderPacks(packs) {
  var container = document.getElementById('packsWrap');

  if (!packs.length) {
    container.innerHTML = '<div class="empty-state">No billing packs yet. Select approved time entries and create a pack above.</div>';
    return;
  }

  var html = '<div class="packs-table-wrap"><table class="data-table">';
  html += '<thead><tr><th>Ref</th><th>Pack Name</th><th>Client</th><th>Period</th>';
  html += '<th>Hrs</th><th>Recoverable</th><th>Write-Off</th><th>Billable</th>';
  html += '<th>Status</th><th></th></tr></thead><tbody>';

  packs.forEach(function(p) {
    var clientName = p.practice_clients ? p.practice_clients.name : '–';
    var period = '';
    if (p.period_start || p.period_end) {
      period = (p.period_start || '') + (p.period_start && p.period_end ? ' – ' : '') + (p.period_end || '');
    }

    html += '<tr>';
    html += '<td style="font-size:11px;white-space:nowrap;color:var(--text-muted);">' + esc(p.pack_number || '–') + '</td>';
    html += '<td><strong>' + esc(p.pack_name) + '</strong></td>';
    html += '<td>' + esc(clientName) + '</td>';
    html += '<td style="font-size:11px;">' + esc(period) + '</td>';
    html += '<td>' + parseFloat(p.billable_hours || 0).toFixed(1) + '</td>';
    html += '<td>' + formatMoney(p.recoverable_value || 0) + '</td>';
    html += '<td>' + (p.writeoff_value > 0 ? '<span style="color:#fbbf24;">' + formatMoney(p.writeoff_value) + '</span>' : '–') + '</td>';
    html += '<td><strong>' + formatMoney(p.billable_value || 0) + '</strong></td>';
    html += '<td><span class="badge badge-pack-' + esc(p.status) + '">' + (PACK_STATUS_LABELS[p.status] || p.status) + '</span></td>';
    html += '<td><button class="btn btn-ghost btn-sm" onclick="openPackDetail(' + p.id + ')">Open</button></td>';
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

// ── Pack Detail Modal ─────────────────────────────────────────────────────────

async function openPackDetail(packId) {
  _currentPackId = packId;

  var titleEl    = document.getElementById('packDetailTitle');
  var subtitleEl = document.getElementById('packDetailSubtitle');
  var summaryEl  = document.getElementById('packDetailSummary');
  var linesEl    = document.getElementById('packLinesBody');

  titleEl.textContent    = 'Loading…';
  subtitleEl.textContent = '';
  summaryEl.innerHTML    = '';
  linesEl.innerHTML      = '<tr><td colspan="8"><div class="loading" style="padding:20px"><div class="loading-spinner"></div></div></td></tr>';

  document.getElementById('packDetailModal').classList.add('show');

  try {
    var res  = await PracticeAPI.fetch('/api/practice/billing/packs/' + packId);
    var pack = res.pack;
    var lines = res.lines || [];

    renderPackDetail(pack, lines);
  } catch (e) {
    linesEl.innerHTML = '<tr><td colspan="8"><div class="error-banner">Failed to load pack: ' + esc(e.message) + '</div></td></tr>';
  }
}

function renderPackDetail(pack, lines) {
  var titleEl    = document.getElementById('packDetailTitle');
  var subtitleEl = document.getElementById('packDetailSubtitle');
  var summaryEl  = document.getElementById('packDetailSummary');
  var linesEl    = document.getElementById('packLinesBody');

  var clientName = pack.practice_clients ? pack.practice_clients.name : '–';
  titleEl.textContent    = pack.pack_name;
  subtitleEl.textContent = [
    pack.pack_number  || null,
    clientName,
    PACK_STATUS_LABELS[pack.status] || pack.status
  ].filter(Boolean).join(' · ');

  // Status banner
  var bannerEl = document.getElementById('packStatusBanner');
  if (bannerEl) {
    var fmtDate = function(dt) { return dt ? new Date(dt).toLocaleDateString('en-ZA') : ''; };
    var bannerMessages = {
      draft:     '● Draft — this pack is editable',
      reviewed:  '● Reviewed — this pack is editable',
      approved:  '✓ Approved' + (pack.approved_at ? ' ' + fmtDate(pack.approved_at) : '') + ' — ready to lock',
      locked:    '🔒 Locked' + (pack.locked_at ? ' ' + fmtDate(pack.locked_at) : '') + ' — time entries marked as billed',
      cancelled: '✕ Cancelled' + (pack.cancelled_at ? ' ' + fmtDate(pack.cancelled_at) : '')
    };
    bannerEl.className   = 'pack-status-banner banner-' + pack.status;
    bannerEl.textContent = bannerMessages[pack.status] || pack.status;
  }

  // Summary stats
  var rv = parseFloat(pack.recoverable_value || 0);
  var bv = parseFloat(pack.billable_value    || 0);
  var realizPct = rv > 0 ? Math.round((bv / rv) * 1000) / 10 : (bv > 0 ? 100 : 0);
  var realizCls = realizPct >= 90 ? 'realization-good' : realizPct >= 70 ? 'realization-ok' : 'realization-low';
  var writeoffPct = rv > 0 ? Math.round((parseFloat(pack.writeoff_value || 0) / rv) * 1000) / 10 : 0;

  summaryEl.innerHTML =
    stat(formatMoney(pack.recoverable_value),  'Recoverable') +
    stat(formatMoney(pack.writeoff_value),     'Written Off', pack.writeoff_value > 0 ? '#fbbf24' : null) +
    stat(formatMoney(pack.billable_value),     'Billable Value') +
    stat(pack.billable_hours ? pack.billable_hours.toFixed(1) + 'h' : '–', 'Billable Hours') +
    statCls(realizPct.toFixed(1) + '%', 'Realization', realizCls) +
    stat(
      pack.proposed_invoice_value ? formatMoney(pack.proposed_invoice_value) : '–',
      'Proposed Invoice',
      pack.proposed_invoice_value ? 'var(--accent)' : null
    );

  // Pre-fill edit fields
  document.getElementById('pdProposedValue').value = pack.proposed_invoice_value || '';
  document.getElementById('pdNotes').value          = pack.notes || '';

  // Determine editability
  var canEdit  = ['draft', 'reviewed'].includes(pack.status);
  var canApprove = ['draft', 'reviewed'].includes(pack.status);
  var canLock  = pack.status === 'approved';
  var isLocked = pack.status === 'locked';
  var isCancelled = pack.status === 'cancelled';

  // Show/hide action buttons
  document.getElementById('pdEditFields').style.display = (canEdit || canApprove) ? '' : 'none';
  document.getElementById('pdSaveBtn').style.display    = canEdit ? '' : 'none';
  document.getElementById('pdRecalcBtn').style.display  = canEdit ? '' : 'none';
  document.getElementById('pdApproveBtn').style.display = canApprove ? '' : 'none';
  document.getElementById('pdLockBtn').classList.toggle('hidden', !canLock);
  document.getElementById('pdCancelBtn').style.display  = (!isLocked && !isCancelled) ? '' : 'none';

  // Pack lines
  if (!lines.length) {
    linesEl.innerHTML = '<tr><td colspan="8"><div class="empty-state" style="padding:16px;">No lines in this pack.</div></td></tr>';
    return;
  }

  var html = '';
  lines.forEach(function(l) {
    var te        = l.practice_time_entries || {};
    var canActOn  = canEdit && l.line_status === 'included';
    var lineColor = l.line_status === 'written_off' ? 'color:#fbbf24;'
                  : l.line_status === 'excluded'    ? 'color:var(--text-muted);opacity:0.5;'
                  : '';

    html += '<tr style="' + lineColor + '">';
    html += '<td style="font-size:11px;">' + esc(te.date || '–') + '</td>';
    html += '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(te.description || '') + '">' + esc((te.description || '–').substring(0, 50)) + '</td>';
    html += '<td>' + parseFloat(l.hours || 0).toFixed(2) + '</td>';
    html += '<td>' + (te.effective_rate ? 'R' + parseFloat(te.effective_rate).toFixed(0) : '–') + '</td>';
    html += '<td>' + formatMoney(l.recoverable_value || 0) + '</td>';
    html += '<td>' + (l.line_status === 'written_off' ? '<span style="color:#fbbf24;">' + formatMoney(l.writeoff_value || 0) + '</span>' : formatMoney(l.billable_value || 0)) + '</td>';
    html += '<td><span class="badge badge-line-' + esc(l.line_status) + '">' + (LINE_STATUS_LABELS[l.line_status] || l.line_status) + '</span></td>';
    html += '<td>';
    if (canActOn) {
      html += '<button class="btn btn-ghost btn-sm" style="margin-right:4px;" onclick="openWriteoffModal(' + l.id + ')" title="Write off this entry">Write Off</button>';
      html += '<button class="btn btn-ghost btn-sm" onclick="excludeLine(' + l.id + ')" title="Exclude from billing">Exclude</button>';
    }
    html += '</td>';
    html += '</tr>';
  });

  linesEl.innerHTML = html;
}

function stat(value, label, color) {
  var colorStyle = color ? 'color:' + color + ';' : '';
  return '<div class="pack-detail-stat">' +
    '<div class="pack-detail-stat-val" style="' + colorStyle + '">' + value + '</div>' +
    '<div class="pack-detail-stat-lbl">' + label + '</div>' +
    '</div>';
}

function statCls(value, label, cls) {
  return '<div class="pack-detail-stat">' +
    '<div class="pack-detail-stat-val ' + (cls || '') + '">' + value + '</div>' +
    '<div class="pack-detail-stat-lbl">' + label + '</div>' +
    '</div>';
}

// ── Pack actions ──────────────────────────────────────────────────────────────

async function savePackNotes() {
  if (!_currentPackId) return;
  var proposed = document.getElementById('pdProposedValue').value;
  var notes    = document.getElementById('pdNotes').value.trim();

  try {
    await PracticeAPI.fetch('/api/practice/billing/packs/' + _currentPackId, {
      method: 'PUT',
      body: JSON.stringify({
        proposed_invoice_value: proposed ? parseFloat(proposed) : null,
        notes: notes || null
      })
    });
    showToast('Notes saved');
    await refreshPackDetail();
  } catch (e) {
    showToast(e.message || 'Failed to save', 'error');
  }
}

async function recalculatePack() {
  if (!_currentPackId) return;
  try {
    await PracticeAPI.fetch('/api/practice/billing/packs/' + _currentPackId + '/recalculate', {
      method: 'PUT', body: '{}'
    });
    showToast('Totals recalculated');
    await refreshPackDetail();
    loadBillingStats();
  } catch (e) {
    showToast(e.message || 'Recalculate failed', 'error');
  }
}

async function approvePack() {
  if (!_currentPackId) return;
  if (!confirm('Approve this billing pack? The partner has reviewed all entries.')) return;
  try {
    await PracticeAPI.fetch('/api/practice/billing/packs/' + _currentPackId + '/approve', {
      method: 'PUT', body: '{}'
    });
    showToast('Pack approved');
    await Promise.all([refreshPackDetail(), loadPacks(), loadBillingStats()]);
  } catch (e) {
    showToast(e.message || 'Approve failed', 'error');
  }
}

async function lockPack() {
  if (!_currentPackId) return;
  if (!confirm('Lock this billing pack? This will mark all included time entries as BILLED. This cannot be undone.')) return;
  try {
    await PracticeAPI.fetch('/api/practice/billing/packs/' + _currentPackId + '/lock', {
      method: 'PUT', body: '{}'
    });
    showToast('Pack locked — entries marked as billed');
    await Promise.all([refreshPackDetail(), loadPacks(), loadWip(), loadBillingStats()]);
  } catch (e) {
    showToast(e.message || 'Lock failed', 'error');
  }
}

async function cancelPack() {
  if (!_currentPackId) return;
  if (!confirm('Cancel this billing pack? Time entries will be returned to Approved status and can be re-packed.')) return;
  try {
    await PracticeAPI.fetch('/api/practice/billing/packs/' + _currentPackId, {
      method: 'DELETE'
    });
    showToast('Pack cancelled — entries returned to approved');
    closeModal('packDetailModal');
    await Promise.all([loadPacks(), loadWip(), loadBillingStats()]);
  } catch (e) {
    showToast(e.message || 'Cancel failed', 'error');
  }
}

async function refreshPackDetail() {
  if (!_currentPackId) return;
  var res   = await PracticeAPI.fetch('/api/practice/billing/packs/' + _currentPackId);
  renderPackDetail(res.pack, res.lines || []);
}

// ── Line actions ──────────────────────────────────────────────────────────────

function openWriteoffModal(lineId) {
  _writeoffLineId = lineId;
  document.getElementById('writeoffReason').value = '';
  document.getElementById('writeoffModal').classList.add('show');
}

async function submitWriteoff() {
  var reason = document.getElementById('writeoffReason').value.trim();
  if (!reason) { showToast('Reason is required', 'error'); return; }
  if (!_currentPackId || !_writeoffLineId) return;

  var btn = document.querySelector('#writeoffModal .btn-danger');
  btn.disabled = true; btn.textContent = 'Writing off…';

  try {
    await PracticeAPI.fetch(
      '/api/practice/billing/packs/' + _currentPackId + '/lines/' + _writeoffLineId + '/writeoff',
      { method: 'PUT', body: JSON.stringify({ reason }) }
    );
    showToast('Entry written off');
    closeModal('writeoffModal');
    await Promise.all([refreshPackDetail(), loadBillingStats()]);
  } catch (e) {
    showToast(e.message || 'Write-off failed', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Write Off';
  }
}

async function excludeLine(lineId) {
  if (!_currentPackId) return;
  if (!confirm('Exclude this entry? It will be removed from billing totals and returned to approved status so it can be added to another pack.')) return;

  try {
    await PracticeAPI.fetch(
      '/api/practice/billing/packs/' + _currentPackId + '/lines/' + lineId + '/exclude',
      { method: 'PUT', body: '{}' }
    );
    showToast('Entry excluded from pack');
    await Promise.all([refreshPackDetail(), loadWip(), loadBillingStats()]);
  } catch (e) {
    showToast(e.message || 'Exclude failed', 'error');
  }
}

// ── History modal ─────────────────────────────────────────────────────────────

async function openHistoryModal() {
  if (!_currentPackId) return;
  var listEl = document.getElementById('historyList');
  listEl.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading history…</p></div>';
  document.getElementById('historyModal').classList.add('show');

  try {
    var res = await PracticeAPI.fetch('/api/practice/billing/packs/' + _currentPackId + '/history');
    renderPackHistory(res.events || []);
  } catch (e) {
    listEl.innerHTML = '<div class="error-banner">Failed to load history: ' + esc(e.message) + '</div>';
  }
}

function renderPackHistory(events) {
  var listEl = document.getElementById('historyList');
  if (!events.length) {
    listEl.innerHTML = '<div class="empty-state">No history events recorded yet.</div>';
    return;
  }

  var html = '';
  events.forEach(function(ev) {
    var label      = EVENT_TYPE_LABELS[ev.event_type] || ev.event_type;
    var ts         = new Date(ev.created_at).toLocaleString('en-ZA');
    var statusChg  = ev.old_status && ev.new_status ? ev.old_status + ' → ' + ev.new_status : (ev.new_status || '');

    html += '<div class="history-event">';
    html += '<div class="history-event-type">' + esc(label) + '</div>';
    if (statusChg)  html += '<div class="history-event-status">' + esc(statusChg) + '</div>';
    if (ev.notes)   html += '<div class="history-event-meta">' + esc(ev.notes) + '</div>';
    html += '<div class="history-event-meta">' + esc(ts);
    if (ev.actor_user_id) html += ' · User ' + esc(String(ev.actor_user_id));
    html += '</div>';
    html += '</div>';
  });

  listEl.innerHTML = html;
}

// ── Report actions ────────────────────────────────────────────────────────────

async function viewReport() {
  if (!_currentPackId) return;
  var btn = document.getElementById('pdViewReportBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  try {
    var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
    var resp = await fetch('/api/practice/billing/packs/' + _currentPackId + '/report-html', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!resp.ok) {
      var err = await resp.json().catch(function() { return { error: resp.statusText }; });
      throw new Error(err.error || 'Report failed');
    }
    var html = await resp.text();
    var win = window.open('', '_blank');
    if (!win) {
      showToast('Pop-up blocked — allow pop-ups for this site', 'error');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    showToast('Report opened in new tab');
  } catch (e) {
    showToast(e.message || 'Failed to load report', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'View Report'; }
  }
}

async function downloadPdf() {
  if (!_currentPackId) return;
  var btn = document.getElementById('pdDownloadPdfBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    var token = localStorage.getItem('token') || localStorage.getItem('practice_token');
    var resp = await fetch('/api/practice/billing/packs/' + _currentPackId + '/report-pdf', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!resp.ok) {
      var err = await resp.json().catch(function() { return { error: resp.statusText }; });
      throw new Error(err.error || 'PDF generation failed');
    }
    var blob = await resp.blob();
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    a.download = 'billing-pack-' + _currentPackId + '.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 15000);
    showToast('PDF downloaded');
  } catch (e) {
    showToast(e.message || 'Failed to generate PDF', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Download PDF'; }
  }
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
  if (id === 'packDetailModal') _currentPackId = null;
  if (id === 'writeoffModal')   _writeoffLineId = null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatMoney(n) {
  if (n == null || isNaN(n)) return 'R0';
  return 'R' + parseFloat(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showToast(msg, type) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'toast' + (type === 'error' ? ' toast-error' : '') + ' show';
  setTimeout(function() { el.classList.remove('show'); }, 3500);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
