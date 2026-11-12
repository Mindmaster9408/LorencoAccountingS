/**
 * ============================================================================
 * App subscriptions — clients request apps, Lorenco approves (2026-11-11)
 * ============================================================================
 * Ruan: a client could tick an app in ECO Hub "+ Add" and it went live without
 * Lorenco knowing — so nobody discussed pricing and nobody invoiced it.
 *
 *   Switch ON  → request (kind 'add', status 'pending'). Ruan + Anton are
 *                emailed at once; a super admin approves/declines in the
 *                Platform Control panel. Only approval switches the app on.
 *   Switch OFF → in the client's own hands (kind 'cancel', status
 *                'scheduled'). Billed a month in advance, so the app stays on
 *                until the client's next billing date (eco_clients.billing_day)
 *                and is switched off by the hourly runner. Undo is allowed
 *                until then. Switching off never deletes data.
 *   Super admins keep switching apps directly (CLAUDE.md Rule F1) via the
 *   ordinary PUT /api/eco-clients/:id.
 *
 * Every actual on/off goes through eco-clients.applyEcoClientUpdate — the one
 * place the app sync (modules_enabled, stub records, audit) lives.
 * Table: app_subscription_requests (migration 179).
 * ============================================================================
 */

const { supabase } = require('../../config/database');
const { sendEmail } = require('./email');
const { priceFor } = require('../../config/app-pricing');

// Lazy — eco-clients.js requires this module too (create flow).
const ecoClients = () => require('../routes/eco-clients');

const APP_LABELS = {
  pos: 'Checkout Charlie',
  payroll: 'Lorenco Paytime',
  accounting: 'Ledger Leo',
  inventory: 'Stockton',
  practice: 'Firmflow',
  sean: 'SEAN AI',
};
const REQUESTABLE_APPS = Object.keys(APP_LABELS);

const OPEN_STATUSES = ['pending', 'scheduled', 'applying'];

const DEFAULT_NOTIFY = 'ruanvlog@lorenco.co.za,antonjvr@lorenco.co.za';
function notifyRecipients() {
  return String(process.env.APP_REQUEST_NOTIFY_EMAILS || DEFAULT_NOTIFY)
    .split(',').map(s => s.trim()).filter(Boolean);
}
const APP_URL = () => process.env.APP_URL || 'https://app.lorencoecosystem.com';

const label = key => APP_LABELS[key] || key;

// ─── Dates (South African calendar days) ────────────────────────────────────

function todaySA(now = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(now);
}

function pad(n) { return String(n).padStart(2, '0'); }

function lastDayOfMonth(y, m0) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }

/**
 * The client's next billing date strictly AFTER `today` (YYYY-MM-DD).
 * A billing day past the end of a short month falls on that month's last day
 * (31 → 28 Feb). Today itself counts as already billed.
 */
function nextBillingDate(billingDay, today) {
  const [y, m, d] = today.split('-').map(Number);
  let yy = y, mm = m - 1;
  let day = Math.min(billingDay, lastDayOfMonth(yy, mm));
  if (day <= d) {
    mm += 1;
    if (mm > 11) { mm = 0; yy += 1; }
    day = Math.min(billingDay, lastDayOfMonth(yy, mm));
  }
  return `${yy}-${pad(mm + 1)}-${pad(day)}`;
}

function addDays(dateStr, n) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Which billing day to use for a client: the one Lorenco set, else the day of
 * the month the client was created (documented fallback — the cancellation
 * email to Ruan/Anton says so, so they can correct it).
 */
function effectiveBillingDay(client) {
  if (client.billing_day) return { day: Number(client.billing_day), assumed: false };
  if (client.created_at) {
    const d = Number(todaySA(new Date(client.created_at)).slice(8, 10));
    if (d >= 1 && d <= 31) return { day: d, assumed: true };
  }
  return { day: 1, assumed: true };
}

function formatDateZA(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// ─── Eligibility ────────────────────────────────────────────────────────────

/**
 * Apps this client could have at all, with a reason when not. Mirrors the
 * business rules in eco-clients.validateAppAdditions (backend-enforced too)
 * plus the SEAN-for-individuals rule the modal always applied.
 */
async function eligibility(client) {
  const out = {};
  const { data: managing } = await supabase
    .from('companies').select('company_name, trading_name').eq('id', client.company_id).maybeSingle();
  const isTIL = !!managing && (managing.company_name === 'The Infinite Legacy' || managing.trading_name === 'The Infinite Legacy');
  let holderType = null;
  if (client.client_company_id) {
    const { data: own } = await supabase
      .from('companies').select('account_holder_type').eq('id', client.client_company_id).maybeSingle();
    holderType = own ? own.account_holder_type : null;
  }
  const isIndividual = String(client.client_type || '').toLowerCase() === 'individual';

  for (const key of REQUESTABLE_APPS) {
    let reason = null;
    if (key === 'inventory' && !isTIL) reason = 'Stockton is only available for clients of The Infinite Legacy.';
    if (key === 'practice' && holderType !== 'accounting_practice') reason = 'Firmflow is only for accounting practices.';
    if (key === 'sean' && !isIndividual) reason = 'SEAN AI is only for individual clients.';
    out[key] = { eligible: !reason, reason };
  }
  return out;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

async function openRequestsFor(clientId) {
  const { data } = await supabase
    .from('app_subscription_requests')
    .select('*')
    .eq('eco_client_id', clientId)
    .in('status', OPEN_STATUSES);
  return data || [];
}

/**
 * Per-app state for the "Manage apps" modal:
 *   active | active_cancelling (with active_until) | pending | available | unavailable
 */
async function clientState(client) {
  const apps = client.apps || [];
  const open = await openRequestsFor(client.id);
  const elig = await eligibility(client);
  const today = todaySA();

  const rows = REQUESTABLE_APPS.map(key => {
    const req = open.find(r => r.app_key === key);
    const base = { app_key: key, label: label(key), price: priceFor(key) };
    if (apps.includes(key)) {
      if (req && req.kind === 'cancel') {
        return { ...base, state: 'active_cancelling', request_id: req.id,
                 switches_off_on: req.effective_date,
                 active_until: addDays(String(req.effective_date).slice(0, 10), -1) };
      }
      const { day } = effectiveBillingDay(client);
      const off = nextBillingDate(day, today);
      return { ...base, state: 'active', cancel_would_switch_off_on: off, cancel_active_until: addDays(off, -1) };
    }
    if (req && req.kind === 'add') {
      return { ...base, state: 'pending', request_id: req.id, requested_at: req.requested_at };
    }
    if (!elig[key].eligible) return { ...base, state: 'unavailable', reason: elig[key].reason };
    return { ...base, state: 'available' };
  });

  return { client_id: client.id, client_name: client.name, billing_day: client.billing_day || null, apps: rows };
}

// ─── Notifications (never throw — email trouble must not break the action) ──

async function safeSend(args) {
  try {
    const r = await sendEmail(args);
    if (!r || !r.success) console.warn('[app-subscriptions] email not sent:', r && r.message);
    return !!(r && r.success);
  } catch (err) {
    console.error('[app-subscriptions] email threw:', err.message);
    return false;
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function practiceName(companyId) {
  const { data } = await supabase.from('companies').select('company_name, trading_name').eq('id', companyId).maybeSingle();
  return data ? (data.trading_name || data.company_name) : `company #${companyId}`;
}

async function notifyAdmins(subject, lines) {
  const body = lines.join('\n') + `\n\nOpen Platform Control: ${APP_URL()}/admin`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">` +
    lines.map(l => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('') +
    `<p style="margin-top:16px"><a href="${APP_URL()}/admin">Open Platform Control</a></p></div>`;
  return safeSend({ to: notifyRecipients(), subject, body, html, fromName: 'Lorenco Ecosystem' });
}

async function notifyRequester(request, subject, lines) {
  if (!request.requested_by_email) return false;
  const body = lines.join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">` +
    lines.map(l => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('') + `</div>`;
  return safeSend({ to: request.requested_by_email, subject, body, html, fromName: 'Lorenco Ecosystem' });
}

// ─── Who is asking ──────────────────────────────────────────────────────────

async function requesterInfo(req) {
  const info = { id: (req.user && req.user.userId) || null, name: null, email: (req.user && req.user.email) || null };
  if (info.id) {
    const { data } = await supabase.from('users').select('full_name, username, email').eq('id', info.id).maybeSingle();
    if (data) {
      info.name = data.full_name || data.username || null;
      info.email = data.email || info.email;
    }
  }
  return info;
}

// ─── Client actions ─────────────────────────────────────────────────────────

/** Errors carry an HTTP status so routes can pass them straight through. */
function fail(status, error, code) { return { status, error, code }; }

async function requestAdd(req, client, appKey, { acceptedTerms } = {}) {
  if (!REQUESTABLE_APPS.includes(appKey)) return fail(400, 'Unknown app');
  if ((client.apps || []).includes(appKey)) return fail(409, `${label(appKey)} is already active for this client.`);
  if (!acceptedTerms) return fail(400, 'Please accept the pricing terms first.', 'TERMS_NOT_ACCEPTED');

  const elig = (await eligibility(client))[appKey];
  if (!elig.eligible) return fail(403, elig.reason);

  const open = (await openRequestsFor(client.id)).find(r => r.app_key === appKey);
  if (open) return fail(409, `${label(appKey)} has already been requested — Lorenco will be in touch.`);

  const who = await requesterInfo(req);
  const price = priceFor(appKey);
  const { data: row, error } = await supabase
    .from('app_subscription_requests')
    .insert({
      eco_client_id: client.id,
      app_key: appKey,
      kind: 'add',
      status: 'pending',
      requested_by: who.id,
      requested_by_name: who.name,
      requested_by_email: who.email,
      price_shown: price ? `${price.text} (${price.billing})` : 'Price to be confirmed by Lorenco before activation',
    })
    .select()
    .single();
  if (error) {
    // Unique index race: someone requested the same app a moment ago.
    if (/uq_app_sub_requests_open|duplicate/i.test(error.message)) {
      return fail(409, `${label(appKey)} has already been requested — Lorenco will be in touch.`);
    }
    console.error('[app-subscriptions] insert add request failed:', error.message);
    return fail(500, 'Could not save the request');
  }

  const practice = await practiceName(client.company_id);
  await notifyAdmins(`App request: ${client.name} wants ${label(appKey)}`, [
    `${client.name} (managed under ${practice}) has requested ${label(appKey)}.`,
    `Requested by: ${who.name || 'unknown'}${who.email ? ` <${who.email}>` : ''}`,
    `Price shown: ${row.price_shown}`,
    'The app is NOT active yet. Approve or decline it in Platform Control → App requests, and invoice the client once approved.',
  ]);

  await audit(req, 'APP_REQUESTED', client, { request_id: row.id, app_key: appKey });
  return { request: row };
}

/** Called by POST /api/eco-clients for apps a non-admin ticked on a new client. */
async function createAddRequestsForNewClient(req, client, appKeys) {
  const out = [];
  for (const key of appKeys) {
    try {
      const r = await requestAdd(req, client, key, { acceptedTerms: true });
      out.push(r.request ? { app_key: key, status: 'pending' } : { app_key: key, status: 'not_requested', error: r.error });
    } catch (err) {
      console.error('[app-subscriptions] new-client request failed:', err.message);
      out.push({ app_key: key, status: 'not_requested', error: 'Could not save the request' });
    }
  }
  return out;
}

async function scheduleCancel(req, client, appKey) {
  if (!(client.apps || []).includes(appKey)) return fail(409, `${label(appKey)} is not active for this client.`);
  const open = (await openRequestsFor(client.id)).find(r => r.app_key === appKey);
  if (open) return fail(409, `${label(appKey)} is already being cancelled.`);

  const { day, assumed } = effectiveBillingDay(client);
  const effective = nextBillingDate(day, todaySA());
  const activeUntil = addDays(effective, -1);
  const who = await requesterInfo(req);

  const { data: row, error } = await supabase
    .from('app_subscription_requests')
    .insert({
      eco_client_id: client.id,
      app_key: appKey,
      kind: 'cancel',
      status: 'scheduled',
      requested_by: who.id,
      requested_by_name: who.name,
      requested_by_email: who.email,
      effective_date: effective,
    })
    .select()
    .single();
  if (error) {
    if (/uq_app_sub_requests_open|duplicate/i.test(error.message)) return fail(409, `${label(appKey)} is already being cancelled.`);
    console.error('[app-subscriptions] insert cancel failed:', error.message);
    return fail(500, 'Could not save the cancellation');
  }

  const practice = await practiceName(client.company_id);
  await notifyAdmins(`Cancellation: ${client.name} cancels ${label(appKey)}`, [
    `${client.name} (managed under ${practice}) has cancelled ${label(appKey)}.`,
    `Cancelled by: ${who.name || 'unknown'}${who.email ? ` <${who.email}>` : ''}`,
    `The app stays active until ${formatDateZA(activeUntil)} and switches off automatically on ${formatDateZA(effective)}.`,
    'Do not invoice this app for the next period.',
    assumed
      ? `NOTE: no billing day is set for this client — day ${day} was assumed (the day the client was created). Set the billing day in Platform Control if that is wrong.`
      : `Billing day: ${day}.`,
    'The client can still undo this before that date — you will get another email if they do.',
  ]);

  await audit(req, 'APP_CANCEL_SCHEDULED', client, { request_id: row.id, app_key: appKey, effective_date: effective });
  return { request: row, active_until: activeUntil };
}

/** Client withdraws a pending request, or undoes a scheduled cancellation. */
async function withdraw(req, client, requestId) {
  const { data: row } = await supabase
    .from('app_subscription_requests').select('*').eq('id', requestId).maybeSingle();
  if (!row || row.eco_client_id !== client.id) return fail(404, 'Request not found');

  const next = row.kind === 'add' && row.status === 'pending' ? 'withdrawn'
             : row.kind === 'cancel' && row.status === 'scheduled' ? 'undone' : null;
  if (!next) return fail(409, 'This request can no longer be changed.');

  // Conditional on the current status → safe against the runner picking it up.
  const { data: changed } = await supabase
    .from('app_subscription_requests')
    .update({ status: next, decided_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', row.status)
    .select();
  if (!changed || changed.length === 0) return fail(409, 'This request can no longer be changed.');

  const who = await requesterInfo(req);
  await notifyAdmins(
    next === 'undone'
      ? `Cancellation undone: ${client.name} keeps ${label(row.app_key)}`
      : `Request withdrawn: ${client.name} — ${label(row.app_key)}`,
    [
      next === 'undone'
        ? `${client.name} has undone the cancellation of ${label(row.app_key)}. The app stays active — keep invoicing it as normal.`
        : `${client.name} has withdrawn the request for ${label(row.app_key)}. Nothing needs to be done.`,
      `By: ${who.name || 'unknown'}${who.email ? ` <${who.email}>` : ''}`,
    ]);

  await audit(req, next === 'undone' ? 'APP_CANCEL_UNDONE' : 'APP_REQUEST_WITHDRAWN', client, { request_id: row.id, app_key: row.app_key });
  return { request: { ...row, status: next } };
}

// ─── Lorenco (super admin) actions ──────────────────────────────────────────

async function loadClient(id) {
  const { data } = await supabase.from('eco_clients').select('*').eq('id', id).maybeSingle();
  return data;
}

async function listQueue() {
  const { data: open } = await supabase
    .from('app_subscription_requests').select('*').in('status', OPEN_STATUSES).order('requested_at', { ascending: true });
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: recentAll } = await supabase
    .from('app_subscription_requests').select('*')
    .in('status', ['approved', 'declined', 'withdrawn', 'applied', 'undone'])
    .order('requested_at', { ascending: false }).limit(200);
  const recent = (recentAll || []).filter(r => (r.decided_at || r.applied_at || r.requested_at) >= since).slice(0, 50);

  const all = [...(open || []), ...recent];
  const ids = [...new Set(all.map(r => r.eco_client_id))];
  const clients = {};
  if (ids.length) {
    const { data } = await supabase.from('eco_clients').select('id, name, company_id, apps, billing_day, created_at').in('id', ids);
    (data || []).forEach(c => { clients[c.id] = c; });
  }
  const practiceIds = [...new Set(Object.values(clients).map(c => c.company_id))];
  const practices = {};
  if (practiceIds.length) {
    const { data } = await supabase.from('companies').select('id, company_name, trading_name').in('id', practiceIds);
    (data || []).forEach(p => { practices[p.id] = p.trading_name || p.company_name; });
  }
  const decorate = r => {
    const c = clients[r.eco_client_id] || {};
    return {
      ...r,
      app_label: label(r.app_key),
      client_name: c.name || `client #${r.eco_client_id}`,
      practice_name: practices[c.company_id] || null,
      billing_day: c.billing_day || null,
      already_active: (c.apps || []).includes(r.app_key),
    };
  };
  return {
    pending: (open || []).filter(r => r.kind === 'add').map(decorate),
    cancellations: (open || []).filter(r => r.kind === 'cancel').map(decorate),
    recent: recent.map(decorate),
  };
}

async function approve(req, requestId, { billingDay } = {}) {
  const { data: row } = await supabase
    .from('app_subscription_requests').select('*').eq('id', requestId).maybeSingle();
  if (!row || row.kind !== 'add') return fail(404, 'Request not found');
  if (row.status !== 'pending') return fail(409, `This request is already ${row.status}.`);

  const client = await loadClient(row.eco_client_id);
  if (!client) return fail(404, 'Client not found');

  let bd = billingDay !== undefined && billingDay !== null && billingDay !== '' ? parseInt(billingDay, 10) : null;
  if (bd !== null && !(bd >= 1 && bd <= 31)) return fail(400, 'Billing day must be between 1 and 31');
  if (bd === null && !client.billing_day) bd = Number(todaySA().slice(8, 10)); // first approval sets it

  // Claim first so a double click cannot run the activation twice.
  const { data: claimed } = await supabase
    .from('app_subscription_requests')
    .update({ status: 'approved', decided_by: req.user.userId || null, decided_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'pending').select();
  if (!claimed || claimed.length === 0) return fail(409, 'This request was already handled.');

  const { applyEcoClientUpdate, validateAppAdditions } = ecoClients();
  const apps = client.apps || [];
  const body = {};
  if (!apps.includes(row.app_key)) body.apps = [...apps, row.app_key];
  if (bd !== null) body.billing_day = bd;

  if (body.apps) {
    const invalid = await validateAppAdditions(client, body.apps);
    if (invalid) {
      await supabase.from('app_subscription_requests')
        .update({ status: 'pending', decided_by: null, decided_at: null, last_error: invalid.error }).eq('id', row.id);
      return fail(invalid.status, invalid.error);
    }
  }
  if (Object.keys(body).length) {
    const result = await applyEcoClientUpdate(req, client, body);
    if (result.error) {
      await supabase.from('app_subscription_requests')
        .update({ status: 'pending', decided_by: null, decided_at: null, last_error: result.error }).eq('id', row.id);
      return fail(result.status, result.error);
    }
  }
  await supabase.from('app_subscription_requests').update({ applied_at: new Date().toISOString(), last_error: null }).eq('id', row.id);

  await notifyRequester(row, `${label(row.app_key)} is now active for ${client.name}`, [
    `Good news — ${label(row.app_key)} has been activated for ${client.name}.`,
    'You can open it from your Lorenco Ecosystem dashboard. Lorenco will send the invoice as agreed.',
    `${APP_URL()}/dashboard`,
  ]);
  await audit(req, 'APP_REQUEST_APPROVED', client, { request_id: row.id, app_key: row.app_key, billing_day: body.billing_day || client.billing_day });
  return { request: { ...row, status: 'approved' } };
}

async function decline(req, requestId, { reason } = {}) {
  const { data: row } = await supabase
    .from('app_subscription_requests').select('*').eq('id', requestId).maybeSingle();
  if (!row || row.kind !== 'add') return fail(404, 'Request not found');
  if (row.status !== 'pending') return fail(409, `This request is already ${row.status}.`);
  const note = reason ? String(reason).trim().slice(0, 2000) : null;

  const { data: changed } = await supabase
    .from('app_subscription_requests')
    .update({ status: 'declined', decided_by: req.user.userId || null, decided_at: new Date().toISOString(), decision_note: note })
    .eq('id', row.id).eq('status', 'pending').select();
  if (!changed || changed.length === 0) return fail(409, 'This request was already handled.');

  const client = await loadClient(row.eco_client_id);
  const name = client ? client.name : 'your company';
  await notifyRequester(row, `Your request for ${label(row.app_key)}`, [
    `Your request for ${label(row.app_key)} for ${name} was not approved at this time.`,
    note ? `Reason: ${note}` : 'Lorenco will contact you to discuss it.',
  ]);
  if (client) await audit(req, 'APP_REQUEST_DECLINED', client, { request_id: row.id, app_key: row.app_key, reason: note });
  return { request: { ...row, status: 'declined', decision_note: note } };
}

async function setBillingDay(req, client, billingDay) {
  const bd = billingDay === null || billingDay === '' ? null : parseInt(billingDay, 10);
  if (bd !== null && !(bd >= 1 && bd <= 31)) return fail(400, 'Billing day must be between 1 and 31');
  const result = await ecoClients().applyEcoClientUpdate(req, client, { billing_day: bd });
  if (result.error) return fail(result.status, result.error);
  return { client: result.updated };
}

// ─── Runner: switch off cancelled apps on their effective date ──────────────

const SYSTEM_REQ = companyId => ({
  user: { userId: null, email: 'system:app-subscriptions', role: 'system', isSuperAdmin: false },
  companyId: companyId || null,
  path: '/api/app-subscriptions/runner',
  headers: {},
  ip: null,
});

async function runDueCancellations({ today = todaySA() } = {}) {
  const { data: due } = await supabase
    .from('app_subscription_requests')
    .select('*')
    .eq('kind', 'cancel')
    .eq('status', 'scheduled')
    .lte('effective_date', today);

  let applied = 0, failed = 0;
  for (const row of due || []) {
    // Claim — a second server instance (or the client's Undo) cannot also act on it.
    const { data: claimed } = await supabase
      .from('app_subscription_requests')
      .update({ status: 'applying' })
      .eq('id', row.id).eq('status', 'scheduled').select();
    if (!claimed || claimed.length === 0) continue;

    try {
      const client = await loadClient(row.eco_client_id);
      if (client && (client.apps || []).includes(row.app_key)) {
        const result = await ecoClients().applyEcoClientUpdate(
          SYSTEM_REQ(client.company_id), client,
          { apps: (client.apps || []).filter(a => a !== row.app_key) });
        if (result.error) throw new Error(result.error);
      }
      await supabase.from('app_subscription_requests')
        .update({ status: 'applied', applied_at: new Date().toISOString(), last_error: null }).eq('id', row.id);
      applied++;
      if (client) {
        await notifyRequester(row, `${label(row.app_key)} has been switched off for ${client.name}`, [
          `As requested, ${label(row.app_key)} has now been switched off for ${client.name}.`,
          'Your data has not been deleted. If you want the app back later, request it again from "Manage apps".',
        ]);
      }
    } catch (err) {
      failed++;
      console.error(`[app-subscriptions] switching off request ${row.id} failed:`, err.message);
      // Back to scheduled → retried next run; the error is visible in the queue.
      await supabase.from('app_subscription_requests')
        .update({ status: 'scheduled', last_error: String(err.message).slice(0, 500) }).eq('id', row.id);
    }
  }
  return { due: (due || []).length, applied, failed };
}

const RUN_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
let _timer = null;

function startAppSubscriptionScheduler() {
  if (_timer || process.env.APP_SUBSCRIPTION_SCHEDULER === 'off') return;
  const tick = () => runDueCancellations()
    .then(r => { if (r.due) console.log(`[app-subscriptions] cancellations due: ${r.due}, switched off: ${r.applied}, failed: ${r.failed}`); })
    .catch(err => console.error('[app-subscriptions] runner failed:', err.message));
  const first = setTimeout(tick, FIRST_RUN_DELAY_MS);
  if (first.unref) first.unref();
  _timer = setInterval(tick, RUN_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  console.log('🔁 App subscription scheduler started (hourly)');
}

// ─── Audit ──────────────────────────────────────────────────────────────────

async function audit(req, action, client, metadata) {
  try {
    const { auditFromReq } = require('../../middleware/audit');
    await auditFromReq(req, action, 'eco_client', client.id, { module: 'ecosystem', metadata });
  } catch (err) {
    console.warn('[app-subscriptions] audit failed:', err.message);
  }
}

module.exports = {
  // client
  clientState, requestAdd, createAddRequestsForNewClient, scheduleCancel, withdraw,
  // lorenco
  listQueue, approve, decline, setBillingDay,
  // runner
  runDueCancellations, startAppSubscriptionScheduler,
  // pure helpers (tests)
  todaySA, nextBillingDate, addDays, effectiveBillingDay, REQUESTABLE_APPS, APP_LABELS,
};
