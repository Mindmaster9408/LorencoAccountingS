/**
 * Link an existing company (Ruan, 2026-11-12).
 *
 * A practice asks a company that already uses the Eco (e.g. a self-registered
 * business like Warmbaths) for access to specific apps. The company's own
 * management answers yes/no PER APP. Only then is an eco_clients row created
 * under the practice — with access_link = true and apps = the approved apps.
 *
 * An access_link row is an access grant, never a subscription:
 *   - it never touches the company's modules_enabled or company details
 *     (eco-clients PUT refuses edits on it; it is inserted directly here, not
 *     through applyEcoClientUpdate, so no app sync runs);
 *   - it is never invoiced (ecoBilling skips it — the company pays itself);
 *   - sso-launch lets the practice into the approved apps only.
 *
 * Consent is the company's: a super admin can NOT approve on its behalf.
 */
'use strict';

const crypto = require('crypto');
const { supabase } = require('../../config/database');
const { MANAGEMENT_ROLES } = require('../../config/permissions');
const { sendEmail } = require('./email');

const LINKABLE_APPS = {
  pos: 'Checkout Charlie', payroll: 'Lorenco Paytime', accounting: 'Ledger Leo',
  inventory: 'Stockton', practice: 'Firmflow', sean: 'SEAN AI',
};
const APP_URL = () => process.env.APP_URL || 'https://app.lorencoecosystem.com';
const fail = (status, error, code) => ({ status, error, code });
const isAdmin = u => !!(u && (u.isSuperAdmin || u.role === 'super_admin'));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function safeSend(args) {
  try {
    const r = await sendEmail(args);
    if (!r || !r.success) console.warn('[link-requests] email not sent:', r && r.message);
  } catch (err) {
    console.error('[link-requests] email threw:', err.message);
  }
}
function mail(to, subject, lines, linkText) {
  if (!to || (Array.isArray(to) && !to.length)) return Promise.resolve();
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">` +
    lines.map(l => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('') +
    (linkText ? `<p style="margin-top:16px"><a href="${APP_URL()}/dashboard">${esc(linkText)}</a></p>` : '') + `</div>`;
  return safeSend({ to, subject, body: lines.join('\n') + (linkText ? `\n\n${APP_URL()}/dashboard` : ''), html, fromName: 'Lorenco Ecosystem' });
}

async function companyName(id) {
  const { data } = await supabase.from('companies').select('company_name, trading_name').eq('id', id).maybeSingle();
  return data ? (data.trading_name || data.company_name) : `company #${id}`;
}
async function userInfo(req) {
  const info = { id: req.user?.userId || null, name: null, email: req.user?.email || null };
  if (info.id) {
    const { data } = await supabase.from('users').select('full_name, username, email').eq('id', info.id).maybeSingle();
    if (data) { info.name = data.full_name || data.username || null; info.email = data.email || info.email; }
  }
  return info;
}

/** Real management membership at a company — no super-admin bypass (consent). */
async function managesCompany(userId, companyId) {
  if (!userId || !companyId) return false;
  const { data } = await supabase.from('user_company_access')
    .select('role').eq('user_id', userId).eq('company_id', companyId).eq('is_active', true).maybeSingle();
  return !!(data && MANAGEMENT_ROLES.includes(data.role));
}
/** May the caller request on behalf of practice `practiceId`? (super admin may) */
async function mayRequestFor(req, practiceId) {
  if (isAdmin(req.user)) return true;
  if (String(practiceId) === String(req.companyId) && MANAGEMENT_ROLES.includes(req.user.role)) return true;
  return managesCompany(req.user?.userId, practiceId);
}
async function managerEmails(companyId) {
  const { data: rows } = await supabase.from('user_company_access')
    .select('user_id, role').eq('company_id', companyId).eq('is_active', true);
  const ids = (rows || []).filter(r => MANAGEMENT_ROLES.includes(r.role) && r.role !== 'super_admin').map(r => r.user_id);
  if (!ids.length) return [];
  const { data: users } = await supabase.from('users').select('email, is_active').in('id', ids);
  return [...new Set((users || []).filter(u => u.email && u.is_active !== false).map(u => u.email))];
}

// ─── Practice side ──────────────────────────────────────────────────────────

/**
 * Find a company by its client code (CLT-…) or an email (company email or a
 * manager's login email). Exact match only — no browsing other companies.
 */
async function lookup(req, { query }) {
  const q = String(query || '').trim();
  if (q.length < 4) return fail(400, 'Enter the company\'s client code (CLT-…) or email address.');
  const practiceId = Number(req.companyId);
  if (!(await mayRequestFor(req, practiceId))) return fail(403, 'Only management can link companies.');

  let companyId = null;
  if (/^CLT-[0-9A-F]{8}$/i.test(q)) {
    const { data } = await supabase.from('eco_clients').select('client_company_id').eq('client_code', q.toUpperCase()).maybeSingle();
    companyId = data?.client_company_id || null;
  } else if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(q)) {
    // Strict pattern: the value goes into a PostgREST or() filter below.
    const email = q.toLowerCase();
    const { data: cos } = await supabase.from('companies').select('id').or(`email.ilike.${email},contact_email.ilike.${email}`).limit(2);
    if (cos && cos.length === 1) companyId = cos[0].id;
    if (!companyId) {
      const { data: u } = await supabase.from('users').select('id').ilike('email', email).maybeSingle();
      if (u) {
        const { data: acc } = await supabase.from('user_company_access')
          .select('company_id, role').eq('user_id', u.id).eq('is_active', true);
        const owned = (acc || []).filter(a => MANAGEMENT_ROLES.includes(a.role) && a.role !== 'super_admin');
        if (owned.length === 1) companyId = owned[0].company_id;
      }
    }
  }
  if (!companyId) return fail(404, 'No company found with that code or email. Ask the company for its client code — it is on its client card in ECO Hub.');
  if (Number(companyId) === practiceId) return fail(400, 'That is your own company.');

  const { data: existing } = await supabase.from('eco_clients')
    .select('id, is_active').eq('company_id', practiceId).eq('client_company_id', companyId).eq('is_active', true).maybeSingle();
  return {
    company_id: Number(companyId),
    name: await companyName(companyId),
    already_linked: !!existing,
    apps: Object.entries(LINKABLE_APPS).map(([key, label]) => ({ key, label })),
  };
}

async function createRequest(req, { target_company_id, apps, message }) {
  const practiceId = Number(req.companyId);
  const targetId = Number(target_company_id);
  if (!targetId || targetId === practiceId) return fail(400, 'Choose a company to link.');
  if (!(await mayRequestFor(req, practiceId))) return fail(403, 'Only management can link companies.');
  const wanted = [...new Set((apps || []).filter(a => LINKABLE_APPS[a]))];
  if (!wanted.length) return fail(400, 'Choose at least one app you want access to.');

  const { data: target } = await supabase.from('companies').select('id, is_active').eq('id', targetId).maybeSingle();
  if (!target) return fail(404, 'Company not found.');
  const { data: existing } = await supabase.from('eco_clients')
    .select('id').eq('company_id', practiceId).eq('client_company_id', targetId).eq('is_active', true).maybeSingle();
  if (existing) return fail(409, 'This company is already one of your clients.', 'ALREADY_LINKED');
  // The partial unique index is the real guarantee; this gives a clean message.
  const { data: open } = await supabase.from('company_link_requests')
    .select('id').eq('practice_company_id', practiceId).eq('target_company_id', targetId).eq('status', 'pending').maybeSingle();
  if (open) return fail(409, 'You already have an open request for this company.', 'ALREADY_REQUESTED');

  const who = await userInfo(req);
  const { data: row, error } = await supabase.from('company_link_requests').insert({
    practice_company_id: practiceId, target_company_id: targetId, requested_apps: wanted,
    status: 'pending', requested_at: new Date().toISOString(),
    message: message ? String(message).slice(0, 500) : null,
    requested_by: who.id, requested_by_name: who.name, requested_by_email: who.email,
  }).select().single();
  if (error) {
    if (/uq_company_link_requests_open|duplicate key/i.test(error.message)) return fail(409, 'You already have an open request for this company.', 'ALREADY_REQUESTED');
    throw new Error(error.message);
  }

  const [pName, tName, to] = await Promise.all([companyName(practiceId), companyName(targetId), managerEmails(targetId)]);
  await mail(to, `${pName} asks for access to ${tName} on Lorenco Ecosystem`, [
    `${pName}${who.name ? ` (${who.name})` : ''} asks for access to ${tName}'s data in: ${wanted.map(a => LINKABLE_APPS[a]).join(', ')}.`,
    row.message ? `Message: ${row.message}` : null,
    'Nothing is shared until you approve. You can say yes or no for each app on your ECO Hub dashboard.',
  ].filter(Boolean), 'Open ECO Hub');
  return { request: row };
}

async function listOutgoing(req) {
  const practiceId = Number(req.companyId);
  if (!(await mayRequestFor(req, practiceId))) return fail(403, 'Access denied');
  const { data, error } = await supabase.from('company_link_requests')
    .select('*').eq('practice_company_id', practiceId).order('requested_at', { ascending: false }).limit(50);
  if (error) throw new Error(error.message);
  const names = {};
  for (const r of data || []) names[r.target_company_id] = names[r.target_company_id] || await companyName(r.target_company_id);
  return { requests: (data || []).map(r => ({ ...r, target_name: names[r.target_company_id] })) };
}

async function withdraw(req, requestId) {
  const { data: r } = await supabase.from('company_link_requests').select('*').eq('id', requestId).maybeSingle();
  if (!r) return fail(404, 'Request not found');
  if (!(await mayRequestFor(req, r.practice_company_id))) return fail(403, 'Access denied');
  const { data: upd } = await supabase.from('company_link_requests')
    .update({ status: 'withdrawn', decided_at: new Date().toISOString() })
    .eq('id', requestId).eq('status', 'pending').select('id');
  if (!upd || !upd.length) return fail(409, 'This request is no longer open.');
  return { ok: true };
}

// ─── Company side ───────────────────────────────────────────────────────────

/** Open requests for every company the caller manages (by real membership). */
async function listIncoming(req) {
  const userId = req.user?.userId;
  if (!userId) return { requests: [] };
  const { data: acc } = await supabase.from('user_company_access')
    .select('company_id, role').eq('user_id', userId).eq('is_active', true);
  const ids = (acc || []).filter(a => MANAGEMENT_ROLES.includes(a.role)).map(a => a.company_id);
  if (!ids.length) return { requests: [] };
  const { data, error } = await supabase.from('company_link_requests')
    .select('*').in('target_company_id', ids).eq('status', 'pending').order('requested_at');
  if (error) throw new Error(error.message);
  const out = [];
  for (const r of data || []) {
    out.push({
      ...r,
      practice_name: await companyName(r.practice_company_id),
      target_name: await companyName(r.target_company_id),
      apps: r.requested_apps.map(k => ({ key: k, label: LINKABLE_APPS[k] || k })),
    });
  }
  return { requests: out };
}

/**
 * The company answers per app. approved_apps ⊆ requested_apps; empty = decline.
 */
async function decide(req, requestId, { approved_apps, note }) {
  const { data: r } = await supabase.from('company_link_requests').select('*').eq('id', requestId).maybeSingle();
  if (!r) return fail(404, 'Request not found');
  if (!(await managesCompany(req.user?.userId, r.target_company_id))) {
    return fail(403, 'Only the company\'s own management can answer this request.');
  }
  if (r.status !== 'pending') return fail(409, 'This request has already been answered.');
  const approved = [...new Set((approved_apps || []).filter(a => r.requested_apps.includes(a)))];
  const status = approved.length ? 'approved' : 'declined';
  const who = await userInfo(req);

  // Claim it first so a double click can't create two links.
  const { data: claimed } = await supabase.from('company_link_requests').update({
    status, approved_apps: approved, decided_by: who.id, decided_by_name: who.name,
    decided_at: new Date().toISOString(), decision_note: note ? String(note).slice(0, 500) : null,
  }).eq('id', requestId).eq('status', 'pending').select().maybeSingle();
  if (!claimed) return fail(409, 'This request has already been answered.');

  let ecoClientId = null;
  if (status === 'approved') {
    try {
      ecoClientId = await grantAccess(r.practice_company_id, r.target_company_id, approved);
      await supabase.from('company_link_requests').update({ eco_client_id: ecoClientId }).eq('id', requestId);
    } catch (err) {
      // Put the request back so it can be answered again.
      await supabase.from('company_link_requests').update({
        status: 'pending', approved_apps: null, decided_by: null, decided_by_name: null, decided_at: null, decision_note: null,
      }).eq('id', requestId);
      throw err;
    }
  }

  const [pName, tName] = await Promise.all([companyName(r.practice_company_id), companyName(r.target_company_id)]);
  const refused = r.requested_apps.filter(a => !approved.includes(a));
  await mail(r.requested_by_email,
    status === 'approved' ? `${tName} approved your access request` : `${tName} declined your access request`,
    [
      status === 'approved'
        ? `${tName} approved access to: ${approved.map(a => LINKABLE_APPS[a]).join(', ')}. It now shows under ${pName}'s clients in ECO Hub.`
        : `${tName} declined your request for access.`,
      refused.length && status === 'approved' ? `Not approved: ${refused.map(a => LINKABLE_APPS[a]).join(', ')}.` : null,
      claimed.decision_note ? `Note: ${claimed.decision_note}` : null,
    ].filter(Boolean), 'Open ECO Hub');
  return { status, approved_apps: approved, eco_client_id: ecoClientId };
}

/**
 * Creates (or re-activates) the practice's access_link row. Inserted directly
 * — never through applyEcoClientUpdate — so the company's modules_enabled and
 * details are not touched.
 */
async function grantAccess(practiceId, targetId, apps) {
  const { data: rows } = await supabase.from('eco_clients')
    .select('id, is_active, access_link').eq('company_id', practiceId).eq('client_company_id', targetId);
  const active = (rows || []).find(x => x.is_active);
  if (active && !active.access_link) return active.id; // already a full client — nothing to grant
  const reuse = active || (rows || []).find(x => x.access_link);
  if (reuse) {
    const { error } = await supabase.from('eco_clients')
      .update({ apps, is_active: true, access_link: true, updated_at: new Date().toISOString() }).eq('id', reuse.id);
    if (error) throw new Error(error.message);
    return reuse.id;
  }
  const { data: co } = await supabase.from('companies')
    .select('company_name, trading_name, email, contact_email, phone, contact_phone, account_holder_type').eq('id', targetId).maybeSingle();
  const { data: ins, error } = await supabase.from('eco_clients').insert({
    company_id: practiceId,
    client_company_id: targetId,
    name: co?.company_name || co?.trading_name || `Company ${targetId}`,
    email: co?.email || co?.contact_email || null,
    phone: co?.phone || co?.contact_phone || null,
    client_type: co?.account_holder_type === 'individual' ? 'individual' : 'business',
    apps, addons: [], is_active: true, access_link: true,
    import_source: 'link_request',
    client_code: 'CLT-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
  }).select('id').single();
  if (error) throw new Error(error.message);
  return ins.id;
}

module.exports = { lookup, createRequest, listOutgoing, withdraw, listIncoming, decide, LINKABLE_APPS };
