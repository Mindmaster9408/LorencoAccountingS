/**
 * ============================================================================
 * Accounting Practice Management Module — Lorenco Practice
 * ============================================================================
 * Routes for managing client files, deadlines, tasks, time tracking,
 * and billing for an accounting practice.
 * All routes require authentication + company context from JWT.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');
const { requireCompany } = require('../../middleware/auth');
const workflowsRouter        = require('./workflows');
const billingRouter          = require('./billing');
const engagementsRouter      = require('./engagements');
const engagementPeriodsRouter = require('./engagement-periods');
const dashboardRouter        = require('./dashboard');
const capacityRouter         = require('./capacity');
const clientHealthRouter     = require('./client-health');
const remindersRouter        = require('./reminders');
const communicationsRouter   = require('./communications');
const documentRequestsRouter  = require('./document-requests');
const compliancePacksRouter   = require('./compliance-packs');
const taxpayerProfilesRouter  = require('./taxpayer-profiles');
const provisionalTaxRouter    = require('./provisional-tax');
const individualTaxRouter        = require('./individual-tax');
const individualTaxReviewPacksRouter = require('./individual-tax-review-packs');
const taxConfigRouter            = require('./tax-config');
const companyTaxRouter           = require('./company-tax');

const router = express.Router();

// Enum constants — must match DB CHECK constraints (see migrations 011, 058)
const TASK_TYPES = [
  'general','vat_return','tax_return','annual_financial','management_accounts',
  'payroll','audit','bookkeeping','secretarial','other'
];

// Legacy type values (original practice_deadlines.type column — backward compat)
const DEADLINE_TYPES = [
  'general','vat_return','tax_return','paye','uif','sdl',
  'annual_financial','provisional_tax_p1','provisional_tax_p2',
  'provisional_tax_top_up','cipc_annual_return','beneficial_ownership','other'
];

// Extended deadline_type column (migration 058) — precise SARS/CIPC document codes
const DEADLINE_TYPE_EXTENDED = [
  'vat201','emp201','emp501','irp6','itr12','itr14',
  'cipc_annual_return','beneficial_ownership','annual_financial_statements',
  'management_accounts','monthly_bookkeeping','payroll_month_end','custom'
];

// Compliance area — groups deadline types into broad categories
const COMPLIANCE_AREAS = [
  'vat','paye','emp501','provisional_tax','income_tax',
  'cipc','bo','annual_financials','bookkeeping','payroll','internal','other'
];

// Extended deadline statuses (migration 058 — validated at route level, not DB CHECK)
const DEADLINE_STATUSES = [
  'open','pending','in_progress','waiting_client','waiting_review',
  'submitted','completed','overdue','cancelled','missed'
];

const DEADLINE_PRIORITIES = ['low','normal','high','urgent'];

const COMPLIANCE_RULE_RECURRENCES = [
  'monthly','bi_monthly','quarterly','biannual','annual','once_off','custom'
];

const COMPLIANCE_RULE_OFFSET_BASIS = [
  'period_end','period_start','financial_year_end','tax_year_end','custom_anchor'
];

// ─── Health ──────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({ module: 'practice', status: 'active', version: '1.0.0' });
});

// All routes below require a company context in the JWT.
// /status is exempt (health check only — no data access).
router.use(requireCompany);

// Practice Management is gated at two levels:
// 1. companies.modules_enabled must include 'practice'
// 2. companies.account_holder_type must be 'accounting_practice'
// Super admins bypass both checks (needed for testing and support).
async function requirePracticeModule(req, res, next) {
  if (req.user?.isSuperAdmin) return next();
  if (!req.companyId) return next(); // requireCompany already handled
  try {
    const { data: co } = await supabase
      .from('companies')
      .select('modules_enabled, account_holder_type')
      .eq('id', req.companyId)
      .single();
    if (!co) {
      return res.status(403).json({ error: 'Company not found.', code: 'COMPANY_NOT_FOUND' });
    }
    if (!Array.isArray(co.modules_enabled) || !co.modules_enabled.includes('practice')) {
      return res.status(403).json({
        error: 'Practice Management is not enabled for your company.',
        code: 'PRACTICE_MODULE_NOT_ENABLED'
      });
    }
    if (co.account_holder_type !== 'accounting_practice') {
      return res.status(403).json({
        error: 'Practice Management is only available to accounting practices.',
        code: 'NOT_ACCOUNTING_PRACTICE'
      });
    }
    next();
  } catch (err) {
    console.error('[practice] requirePracticeModule error:', err.message);
    return res.status(500).json({ error: 'Failed to verify practice module access.' });
  }
}
router.use(requirePracticeModule);

// ─── KV Store (UI preferences only — not business data) ──────────────────────
router.get('/kv/:key', async (req, res) => {
  const kvKey = `practice_${req.companyId}_${req.params.key}`;
  const { data } = await supabase
    .from('payroll_kv_store_eco')
    .select('value')
    .eq('key', kvKey)
    .single();
  res.json({ value: data?.value ?? null });
});

router.put('/kv/:key', async (req, res) => {
  const kvKey = `practice_${req.companyId}_${req.params.key}`;
  const { error } = await supabase
    .from('payroll_kv_store_eco')
    .upsert({ key: kvKey, value: req.body.value }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── Company Users (for task assigned_to picker) ──────────────────────────────
router.get('/users', async (req, res) => {
  const { data, error } = await supabase
    .from('user_company_access')
    .select('users:user_id(id, first_name, last_name, email)')
    .eq('company_id', req.companyId)
    .eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });
  const users = (data || [])
    .map(r => r.users)
    .filter(Boolean)
    .sort((a, b) => (a.first_name || '').localeCompare(b.first_name || ''));
  res.json({ users });
});

// ═══ PRACTICE PROFILE ════════════════════════════════════════════════════════
// One row per company. The firm's own identity, not client data.

function sanitizeProfileBody(body) {
  const allowed = [
    'tax_practitioner_number', 'vat_registration_number', 'practice_type',
    'practice_email', 'practice_phone', 'practice_website',
    'address_line1', 'address_line2', 'address_city', 'address_province', 'address_postal_code',
    'default_hourly_rate', 'default_currency', 'fiscal_year_end_month', 'default_task_assignee_id',
    'primary_colour', 'logo_url', 'compliance_notes', 'settings'
  ];
  const out = {};
  for (const k of allowed) {
    if (k in body) out[k] = body[k];
  }
  return out;
}

router.get('/profile', async (req, res) => {
  const { data, error } = await supabase
    .from('practice_profiles')
    .select('*')
    .eq('company_id', req.companyId)
    .single();
  // PGRST116 = no rows returned — valid empty state
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json({ profile: data || null });
});

router.post('/profile', async (req, res) => {
  const body = sanitizeProfileBody(req.body);
  body.company_id = req.companyId;
  const { data, error } = await supabase
    .from('practice_profiles')
    .insert(body)
    .select()
    .single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Profile already exists. Use PUT to update.' });
    return res.status(500).json({ error: error.message });
  }
  await auditFromReq(req, 'CREATE', 'practice_profile', data.id, { module: 'practice' });
  res.status(201).json({ profile: data });
});

router.put('/profile', async (req, res) => {
  const body = sanitizeProfileBody(req.body);
  body.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_profiles')
    .update(body)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Profile not found. Use POST to create.' });
  await auditFromReq(req, 'UPDATE', 'practice_profile', data.id, { module: 'practice' });
  res.json({ profile: data });
});

// ─── Dashboard Stats ─────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const cid = req.companyId;
  try {
    const today = new Date().toISOString().split('T')[0];
    const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

    const [clients, openTasks, overdue, upcoming, timeThisMonth] = await Promise.all([
      supabase.from('practice_clients').select('id', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
      supabase.from('practice_tasks').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('status', ['open', 'in_progress']),
      supabase.from('practice_tasks').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('status', ['open', 'in_progress']).lt('due_date', today),
      supabase.from('practice_tasks').select('id', { count: 'exact', head: true }).eq('company_id', cid).in('status', ['open', 'in_progress']).gte('due_date', today).lte('due_date', nextMonth),
      supabase.from('practice_time_entries').select('hours').eq('company_id', cid).gte('date', today.slice(0, 7) + '-01'),
    ]);

    const totalHours = (timeThisMonth.data || []).reduce((s, r) => s + (r.hours || 0), 0);

    res.json({
      total_clients: clients.count || 0,
      open_tasks: openTasks.count || 0,
      overdue_tasks: overdue.count || 0,
      upcoming_deadlines: upcoming.count || 0,
      hours_this_month: Math.round(totalHours * 10) / 10,
    });
  } catch (err) {
    console.error('Practice dashboard error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══ PRACTICE TEAM MEMBERS ═══════════════════════════════════════════════════

const TEAM_ROLES = ['owner','partner','manager','senior','staff','admin','reviewer','viewer'];

function sanitizeTeamBody(body) {
  const allowed = [
    'user_id', 'display_name', 'email', 'phone', 'role', 'job_title', 'department',
    'default_hourly_rate', 'can_receive_tasks', 'can_review_work', 'can_approve_work',
    'is_active', 'notes', 'settings'
  ];
  const out = {};
  for (const k of allowed) {
    if (k in body) out[k] = body[k];
  }
  return out;
}

// A submitted user_id is never trusted as-is — the "Link to Login Account"
// picker is a <select> populated from /api/practice/users, but nothing
// previously stopped a raw/stale id from being accepted by this endpoint
// directly. Every user_id is now checked against an active
// user_company_access row for this company before being written.
//
// selfHealFromEmail (create only): if no user_id was submitted but the
// display email matches exactly one active ecosystem user for this
// company, auto-link it. This closes the actual gap behind the 2026-07-05
// Planning Board access incident — the 4 super-admin roster rows were
// created with the "Link to Login Account" picker left on "Not linked"
// (its /api/practice/users load can fail silently), leaving user_id NULL
// despite a matching login already existing.
async function _resolveTeamUserId(companyId, body, { selfHealFromEmail } = {}) {
  if (body.user_id !== undefined && body.user_id !== null && body.user_id !== '') {
    const uid = parseInt(body.user_id, 10);
    if (!Number.isInteger(uid)) throw new Error('user_id must be a valid integer.');
    const { data } = await supabase.from('user_company_access')
      .select('user_id').eq('company_id', companyId).eq('user_id', uid).eq('is_active', true).maybeSingle();
    if (!data) throw new Error('That login account is not an active member of this company. Pick a valid user from the list.');
    body.user_id = uid;
    return;
  }

  if (body.user_id === null || body.user_id === '') body.user_id = null;

  if (selfHealFromEmail && !body.user_id && body.email) {
    const { data: accessRows } = await supabase.from('user_company_access')
      .select('users:user_id(id, email)').eq('company_id', companyId).eq('is_active', true);
    const matches = (accessRows || []).map(r => r.users).filter(u => u && u.email && u.email.toLowerCase() === body.email.toLowerCase());
    if (matches.length === 1) body.user_id = matches[0].id;
  }
}

router.get('/team', async (req, res) => {
  const { active = 'true', role, search, page, limit } = req.query;
  let q = supabase
    .from('practice_team_members')
    .select('*')
    .eq('company_id', req.companyId)
    .order('display_name');

  if (active !== 'all') q = q.eq('is_active', active !== 'false');
  if (role && TEAM_ROLES.includes(role)) q = q.eq('role', role);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  let results = data || [];
  if (search) {
    const s = search.toLowerCase();
    results = results.filter(m =>
      (m.display_name && m.display_name.toLowerCase().includes(s)) ||
      (m.email && m.email.toLowerCase().includes(s)) ||
      (m.job_title && m.job_title.toLowerCase().includes(s))
    );
  }

  // Server-side pagination (optional — frontend may also paginate client-side)
  const total = results.length;
  if (page && limit) {
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit)));
    results = results.slice((p - 1) * l, p * l);
  }

  res.json({ members: results, total });
});

router.get('/team/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('practice_team_members')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Team member not found' });
  res.json({ member: data });
});

router.post('/team', async (req, res) => {
  const body = sanitizeTeamBody(req.body);
  if (!body.display_name) return res.status(400).json({ error: 'display_name is required' });
  if (body.role && !TEAM_ROLES.includes(body.role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    await _resolveTeamUserId(req.companyId, body, { selfHealFromEmail: true });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  body.company_id = req.companyId;
  if (req.userId) body.created_by = req.userId;

  const { data, error } = await supabase
    .from('practice_team_members')
    .insert(body)
    .select()
    .single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A team member with that email or user account already exists for this company.' });
    return res.status(500).json({ error: error.message });
  }
  await auditFromReq(req, 'CREATE', 'practice_team_member', data.id, { module: 'practice' });
  res.status(201).json({ member: data });
});

router.put('/team/:id', async (req, res) => {
  // Verify ownership before update
  const { data: existing } = await supabase
    .from('practice_team_members').select('id').eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!existing) return res.status(404).json({ error: 'Team member not found' });

  const body = sanitizeTeamBody(req.body);
  if (body.role && !TEAM_ROLES.includes(body.role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    // No email self-heal on edit: an explicitly blanked "Link to Login
    // Account" field means the admin is intentionally unlinking someone,
    // not a silent dropdown-load failure — that gap only exists on create.
    await _resolveTeamUserId(req.companyId, body, { selfHealFromEmail: false });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  body.updated_at = new Date().toISOString();
  if (req.userId) body.updated_by = req.userId;

  const { data, error } = await supabase
    .from('practice_team_members')
    .update(body)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A team member with that email or user account already exists for this company.' });
    return res.status(500).json({ error: error.message });
  }
  await auditFromReq(req, 'UPDATE', 'practice_team_member', data.id, { module: 'practice' });
  res.json({ member: data });
});

router.delete('/team/:id', async (req, res) => {
  // Soft delete only — set is_active = false
  const { data: existing } = await supabase
    .from('practice_team_members').select('id').eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!existing) return res.status(404).json({ error: 'Team member not found' });

  const updates = { is_active: false, updated_at: new Date().toISOString() };
  if (req.userId) updates.updated_by = req.userId;

  const { error } = await supabase
    .from('practice_team_members')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'DEACTIVATE', 'practice_team_member', parseInt(req.params.id), { module: 'practice' });
  res.json({ success: true });
});

router.put('/team/:id/reactivate', async (req, res) => {
  const { data: existing } = await supabase
    .from('practice_team_members').select('id').eq('id', req.params.id).eq('company_id', req.companyId).single();
  if (!existing) return res.status(404).json({ error: 'Team member not found' });

  const updates = { is_active: true, updated_at: new Date().toISOString() };
  if (req.userId) updates.updated_by = req.userId;

  const { error } = await supabase
    .from('practice_team_members')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'REACTIVATE', 'practice_team_member', parseInt(req.params.id), { module: 'practice' });
  res.json({ success: true });
});

// ── Update team member capacity settings ──────────────────────────────────────
// Separate endpoint (not part of PUT /team/:id) so capacity fields are always
// explicitly set through a dedicated workflow and don't get clobbered by
// general profile edits or vice-versa.

router.put('/team/:id/capacity', async (req, res) => {
  const { weekly_capacity_hours, daily_capacity_hours, capacity_notes, capacity_is_active } = req.body;

  // Verify member belongs to this company
  const { data: existing, error: fetchErr } = await supabase
    .from('practice_team_members')
    .select('id, company_id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (fetchErr || !existing) return res.status(404).json({ error: 'Team member not found' });

  // Validate hours
  if (weekly_capacity_hours !== undefined && weekly_capacity_hours !== null) {
    const wh = parseFloat(weekly_capacity_hours);
    if (isNaN(wh) || wh < 0) return res.status(400).json({ error: 'weekly_capacity_hours must be a positive number' });
  }
  if (daily_capacity_hours !== undefined && daily_capacity_hours !== null) {
    const dh = parseFloat(daily_capacity_hours);
    if (isNaN(dh) || dh < 0) return res.status(400).json({ error: 'daily_capacity_hours must be a positive number' });
  }

  const updates = { updated_at: new Date().toISOString() };
  if (weekly_capacity_hours !== undefined) updates.weekly_capacity_hours = weekly_capacity_hours != null ? parseFloat(weekly_capacity_hours) : null;
  if (daily_capacity_hours  !== undefined) updates.daily_capacity_hours  = daily_capacity_hours  != null ? parseFloat(daily_capacity_hours)  : null;
  if (capacity_notes        !== undefined) updates.capacity_notes        = capacity_notes || null;
  if (capacity_is_active    !== undefined) updates.capacity_is_active    = capacity_is_active === true || capacity_is_active === 'true';

  const { data, error } = await supabase
    .from('practice_team_members')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'practice_team_member', parseInt(req.params.id), {
    module: 'practice',
    action: 'team_capacity_updated',
    changed_fields: Object.keys(updates).filter(k => k !== 'updated_at')
  });
  res.json({ member: data });
});

// ─── Sync team members from ecosystem users ───────────────────────────────────
// Pulls all active user_company_access users for this company and creates
// practice_team_members rows for any not already linked. Default role: staff.
// Users already in the team (matched by user_id) are skipped — not overwritten.
router.post('/team/sync-from-users', async (req, res) => {
  try {
    const { data: companyUsers, error: cuErr } = await supabase
      .from('user_company_access')
      .select('users:user_id(id, full_name, email)')
      .eq('company_id', req.companyId)
      .eq('is_active', true);

    if (cuErr) return res.status(500).json({ error: cuErr.message });

    const users = (companyUsers || []).map(r => r.users).filter(Boolean);
    if (!users.length) {
      return res.json({ imported: 0, skipped: 0, message: 'No ecosystem users found for this company.' });
    }

    const { data: existingTeam } = await supabase
      .from('practice_team_members')
      .select('user_id')
      .eq('company_id', req.companyId)
      .not('user_id', 'is', null);

    const existingUserIds = new Set((existingTeam || []).map(m => m.user_id));
    const toImport = users.filter(u => u.id && !existingUserIds.has(u.id));

    if (!toImport.length) {
      return res.json({ imported: 0, skipped: users.length, message: 'All ecosystem users are already in the Practice team.' });
    }

    const rows = toImport.map(u => ({
      company_id:        req.companyId,
      user_id:           u.id,
      display_name:      u.full_name || u.email,
      email:             u.email || null,
      role:              'staff',
      can_receive_tasks: true,
      can_review_work:   false,
      can_approve_work:  false,
      is_active:         true,
      created_by:        req.userId || null
    }));

    const { data: inserted, error: insErr } = await supabase
      .from('practice_team_members')
      .insert(rows)
      .select('id, display_name, email');

    if (insErr) return res.status(500).json({ error: insErr.message });

    await auditFromReq(req, 'CREATE', 'practice_team_member', null, {
      module: 'practice',
      action: 'sync_from_users',
      imported_count: (inserted || []).length
    });

    return res.json({
      imported: (inserted || []).length,
      skipped:  existingUserIds.size,
      members:  inserted || []
    });
  } catch (err) {
    console.error('[practice] sync-from-users error:', err.message);
    return res.status(500).json({ error: 'Failed to sync team members from ecosystem users.' });
  }
});

// ═══ PRACTICE CLIENTS ════════════════════════════════════════════════════════

const CLIENT_TYPES = ['company','cc','trust','partnership','sole_proprietor','individual','other'];
const CLIENT_ONBOARDING_STATUSES = ['prospect','onboarding','active','on_hold','archived'];
const CLIENT_RISK_RATINGS = ['low','normal','medium','high','flagged'];

function sanitizeClientBody(body) {
  const allowed = [
    // Core
    'name', 'client_type', 'industry',
    // Contact
    'email', 'phone', 'secondary_phone', 'website',
    // Fiscal
    'fiscal_year_end', 'financial_year_end_month',
    // Individual taxpayer
    'id_number', 'passport_number', 'date_of_birth',
    // Registration
    'vat_number', 'registration_number',
    'income_tax_number', 'paye_reference_number', 'uif_reference_number', 'sdl_reference_number',
    // Compliance flags
    'vat_registered', 'paye_registered', 'provisional_taxpayer',
    'uif_registered', 'sdl_registered', 'coida_registered', 'cipc_registered',
    // VAT configuration
    'vat_payment_sequence', 'vat_last_submission_month', 'vat_bi_monthly_parity',
    // COIDA / Workmens Compensation
    'coida_registration_number', 'coida_due_month',
    // Physical address
    'address', 'address_line1', 'address_line2', 'address_city',
    'address_province', 'address_postal_code', 'address_country',
    // Postal address
    'postal_same_as_physical', 'postal_address_line1', 'postal_address_line2',
    'postal_city', 'postal_province', 'postal_postal_code', 'postal_country',
    // Practice ownership
    'responsible_team_member_id', 'reviewer_team_member_id', 'partner_team_member_id',
    // Workflow
    'onboarding_status', 'risk_rating',
    // Billing
    'billing_rate_override', 'billing_currency', 'payment_terms_days',
    // Notes
    'notes', 'internal_notes',
    // Settings + status
    'settings', 'is_active'
  ];
  const out = {};
  for (const k of allowed) { if (k in body) out[k] = body[k]; }
  return out;
}

// ─── Sync practice clients from eco_clients ───────────────────────────────────
// Pulls all active eco_clients for this practice company and creates
// practice_clients rows for any not already linked by eco_client_id.
// Existing practice_clients are never touched — only new rows are added.
router.post('/clients/sync-from-eco', async (req, res) => {
  try {
    const { data: ecoClients, error: ecErr } = await supabase
      .from('eco_clients')
      .select('id, name, email, phone, id_number, client_type, client_code')
      .eq('company_id', req.companyId)
      .eq('is_active', true);

    if (ecErr) return res.status(500).json({ error: ecErr.message });
    if (!ecoClients || !ecoClients.length) {
      return res.json({ imported: 0, skipped: 0, message: 'No active eco clients found for this practice.' });
    }

    const { data: existingLinks } = await supabase
      .from('practice_clients')
      .select('eco_client_id')
      .eq('company_id', req.companyId)
      .not('eco_client_id', 'is', null);

    const linkedIds = new Set((existingLinks || []).map(r => r.eco_client_id));
    const toImport  = ecoClients.filter(ec => !linkedIds.has(ec.id));

    if (!toImport.length) {
      return res.json({ imported: 0, skipped: ecoClients.length, message: 'All eco clients are already in Practice.' });
    }

    // eco_clients.client_type is 'individual' or 'business'.
    // Map 'business' → 'company' for practice_clients (most common SA entity type).
    // Individual clients stay as 'individual'.
    const rows = toImport.map(ec => ({
      company_id:    req.companyId,
      eco_client_id: ec.id,
      name:          ec.name,
      email:         ec.email  || null,
      phone:         ec.phone  || null,
      id_number:     ec.id_number || null,
      client_type:   ec.client_type === 'individual' ? 'individual' : 'company',
      is_active:     true,
      created_by:    req.userId || null
    }));

    const { data: inserted, error: insErr } = await supabase
      .from('practice_clients')
      .insert(rows)
      .select('id, name, eco_client_id');

    if (insErr) return res.status(500).json({ error: insErr.message });

    await auditFromReq(req, 'CREATE', 'practice_client', null, {
      module: 'practice',
      action: 'sync_from_eco',
      imported_count: (inserted || []).length
    });

    return res.json({
      imported: (inserted || []).length,
      skipped:  linkedIds.size,
      clients:  inserted || []
    });
  } catch (err) {
    console.error('[practice] sync-from-eco error:', err.message);
    return res.status(500).json({ error: 'Failed to sync clients from eco registry.' });
  }
});

router.get('/clients', async (req, res) => {
  const {
    search, is_active = 'true',
    client_type, onboarding_status, risk_rating,
    responsible_team_member_id, vat_registered, paye_registered, provisional_taxpayer
  } = req.query;

  let q = supabase
    .from('practice_clients')
    .select('*')
    .eq('company_id', req.companyId)
    .order('name');

  if (is_active !== 'all') q = q.eq('is_active', is_active === 'true');
  if (client_type) q = q.eq('client_type', client_type);
  if (onboarding_status) q = q.eq('onboarding_status', onboarding_status);
  if (risk_rating) q = q.eq('risk_rating', risk_rating);
  if (responsible_team_member_id) q = q.eq('responsible_team_member_id', parseInt(responsible_team_member_id));
  if (vat_registered !== undefined) q = q.eq('vat_registered', vat_registered === 'true');
  if (paye_registered !== undefined) q = q.eq('paye_registered', paye_registered === 'true');
  if (provisional_taxpayer !== undefined) q = q.eq('provisional_taxpayer', provisional_taxpayer === 'true');

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  let results = data || [];
  if (search) {
    const s = search.toLowerCase();
    results = results.filter(c =>
      (c.name && c.name.toLowerCase().includes(s)) ||
      (c.email && c.email.toLowerCase().includes(s)) ||
      (c.vat_number && c.vat_number.toLowerCase().includes(s)) ||
      (c.registration_number && c.registration_number.toLowerCase().includes(s)) ||
      (c.client_code && c.client_code.toLowerCase().includes(s))
    );
  }

  // Enrich with eco_client data (client_code, apps, is_active from central registry)
  const ecoIds = results.map(c => c.eco_client_id).filter(Boolean);
  if (ecoIds.length > 0) {
    const { data: ecoClients } = await supabase
      .from('eco_clients')
      .select('id, client_code, apps, is_active')
      .in('id', ecoIds);
    if (ecoClients) {
      const ecoMap = {};
      ecoClients.forEach(ec => { ecoMap[ec.id] = ec; });
      results = results.map(c => {
        const ec = c.eco_client_id ? ecoMap[c.eco_client_id] : null;
        return { ...c, client_code: ec?.client_code || null, eco_apps: ec?.apps || null };
      });
    }
  }

  res.json({ clients: results, total: results.length });
});

router.get('/clients/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('practice_clients')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Client not found' });

  // Enrich with central eco_client data (client_code, apps)
  let client = { ...data };
  if (data.eco_client_id) {
    const { data: ec } = await supabase
      .from('eco_clients')
      .select('id, client_code, apps, is_active, addons')
      .eq('id', data.eco_client_id)
      .single();
    if (ec) {
      client.client_code = ec.client_code;
      client.eco_apps    = ec.apps;
      client.eco_addons  = ec.addons;
    }
  }

  res.json({ client });
});

router.post('/clients', async (req, res) => {
  const body = sanitizeClientBody(req.body);
  if (!body.name) return res.status(400).json({ error: 'Client name is required' });
  if (body.client_type && !CLIENT_TYPES.includes(body.client_type))
    return res.status(400).json({ error: 'Invalid client_type' });
  if (body.onboarding_status && !CLIENT_ONBOARDING_STATUSES.includes(body.onboarding_status))
    return res.status(400).json({ error: 'Invalid onboarding_status' });
  if (body.risk_rating && !CLIENT_RISK_RATINGS.includes(body.risk_rating))
    return res.status(400).json({ error: 'Invalid risk_rating' });

  body.company_id = req.companyId;
  body.is_active = true;
  if (req.userId) body.created_by = req.userId;

  const idForLookup   = body.id_number || body.registration_number || null;
  const forceCreate   = !!req.body.force_create;    // user confirms they want a new record despite name match
  const linkEcoId     = req.body.link_eco_client_id ? parseInt(req.body.link_eco_client_id) : null;

  // ── Phase 1: resolve eco_client (link existing or create new) ─────────────
  // eco_client must exist BEFORE practice_client is inserted.
  // If eco_client cannot be created/found, we abort — no orphaned practice_client.
  let ecoClientId = null;
  let clientCode  = null;
  let ecoCreated  = false;   // true only when this request created the eco_client

  // CASE 0: Frontend explicitly selected which existing eco_client to link (after ambiguous name match)
  if (linkEcoId) {
    const { data: linkedEco } = await supabase
      .from('eco_clients')
      .select('id, client_code')
      .eq('id', linkEcoId)
      .eq('company_id', req.companyId)
      .single();
    if (!linkedEco) {
      return res.status(404).json({ error: 'Specified link_eco_client_id not found for this practice.', code: 'ECO_CLIENT_NOT_FOUND' });
    }
    // Check: is there already a practice_client for this eco_client?
    const { data: existingPcForLink } = await supabase
      .from('practice_clients')
      .select('id')
      .eq('company_id', req.companyId)
      .eq('eco_client_id', linkEcoId)
      .limit(1);
    if (existingPcForLink && existingPcForLink.length > 0) {
      return res.status(409).json({
        error: 'A Practice client file already exists for the selected client identity.',
        code: 'DUPLICATE_PRACTICE_CLIENT',
        existing_practice_client_id: existingPcForLink[0].id,
        existing_eco_client_id: linkEcoId,
        existing_client_code: linkedEco.client_code
      });
    }
    ecoClientId = linkedEco.id;
    clientCode  = linkedEco.client_code;
  }

  if (!ecoClientId && idForLookup) {
    const { data: existingEco } = await supabase
      .from('eco_clients')
      .select('id, client_code')
      .eq('company_id', req.companyId)
      .eq('id_number', idForLookup)
      .limit(1);

    if (existingEco && existingEco.length > 0) {
      // Eco_client already exists — check if there is already a practice_client linked to it
      const { data: existingPc } = await supabase
        .from('practice_clients')
        .select('id')
        .eq('company_id', req.companyId)
        .eq('eco_client_id', existingEco[0].id)
        .limit(1);

      if (existingPc && existingPc.length > 0) {
        return res.status(409).json({
          error: `A Practice client file already exists for ID/registration number "${idForLookup}".`,
          code: 'DUPLICATE_PRACTICE_CLIENT',
          existing_practice_client_id: existingPc[0].id,
          existing_eco_client_id:      existingEco[0].id,
          existing_client_code:        existingEco[0].client_code
        });
      }

      // Link to existing eco_client — do NOT modify eco_clients.apps
      ecoClientId = existingEco[0].id;
      clientCode  = existingEco[0].client_code;
    }
  }

  // CASE 2: No id_number and not a confirmed link — check for name-only matches.
  // Name-only is MEDIUM confidence: surface possible matches, require user decision.
  // If force_create is true the user has acknowledged the check and wants a new record.
  //
  // Uses normalized comparison (strips SA legal suffixes) so "Turkstra Bakkery" and
  // "Turkstra Bakkery (Pty) Ltd" are caught as the same entity before a duplicate is created.
  if (!ecoClientId && !idForLookup && !forceCreate) {
    function normalizePracticeName(n) {
      return (n || '').toLowerCase()
        .replace(/\(pty\)\s*ltd\.?/gi, '').replace(/\(pty\)/gi, '')
        .replace(/\bpty\s+ltd\.?\b/gi, '').replace(/\bpty\b/gi, '')
        .replace(/\bltd\.?\b/gi, '').replace(/\bcc\b/gi, '')
        .replace(/\bproprietary\s+limited\b/gi, '')
        .replace(/\binc\.?\b/gi, '').replace(/\btrust\b/gi, '')
        .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    }

    const incomingNorm = normalizePracticeName(body.name);

    const { data: allEco } = await supabase
      .from('eco_clients')
      .select('id, name, client_code, email, phone, id_number')
      .eq('company_id', req.companyId)
      .eq('is_active', true);

    const nameMatches = (allEco || []).filter(ec => {
      const existNorm = normalizePracticeName(ec.name);
      if (!existNorm || existNorm.length < 3) return false;
      return existNorm === incomingNorm ||
             incomingNorm.includes(existNorm) ||
             existNorm.includes(incomingNorm);
    });

    if (nameMatches.length > 0) {
      return res.status(409).json({
        error: `A client named "${body.name}" or a similar name already exists in the central client registry. Please review before creating a new record.`,
        code:            'POSSIBLE_DUPLICATE_NAME',
        possible_matches: nameMatches.map(m => ({
          eco_client_id: m.id,
          client_code:   m.client_code,
          name:          m.name,
          email:         m.email,
          phone:         m.phone,
          id_number:     m.id_number
        })),
        resolution: [
          'If this IS the same client: resend with link_eco_client_id = <eco_client_id> to link without creating a duplicate.',
          'If this is a DIFFERENT client with the same name: resend with force_create = true to create a new record.'
        ]
      });
    }
  }

  if (!ecoClientId) {
    // Create eco_client FIRST — identity record only, no app activation.
    // eco_clients.apps controls PCC billing; Practice visibility comes from practice_clients link.
    const { data: ec, error: ecErr } = await supabase
      .from('eco_clients')
      .insert({
        company_id:  req.companyId,
        name:        body.name,
        email:       body.email || null,
        phone:       body.phone || null,
        id_number:   idForLookup,
        client_type: body.client_type === 'individual' ? 'individual' : 'business',
        apps:        [],   // identity only — Practice visibility is NOT controlled by this field
        is_active:   true,
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString()
      })
      .select('id, client_code')
      .single();

    if (ecErr || !ec) {
      console.error('[practice] eco_client creation failed:', ecErr?.message);
      return res.status(500).json({
        error: 'Failed to create central client identity record. Practice client was NOT created.',
        code: 'ECO_CLIENT_CREATION_FAILED',
        detail: ecErr?.message
      });
    }

    ecoClientId = ec.id;
    clientCode  = ec.client_code;
    ecoCreated  = true;
  }

  // ── Phase 2: insert practice_client with eco_client_id already set ─────────
  body.eco_client_id = ecoClientId;

  const { data, error } = await supabase
    .from('practice_clients')
    .insert(body)
    .select()
    .single();

  if (error) {
    // Rollback: delete the eco_client we just created so there is no orphan
    if (ecoCreated) {
      await supabase.from('eco_clients').delete().eq('id', ecoClientId);
    }
    return res.status(500).json({ error: error.message });
  }

  await auditFromReq(req, 'CREATE', 'practice_client', data.id, { module: 'practice' });
  res.status(201).json({ client: { ...data, client_code: clientCode } });
});

router.put('/clients/:id', async (req, res) => {
  const { data: existing, error: fetchErr } = await supabase
    .from('practice_clients')
    .select('id, eco_client_id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (fetchErr || !existing) return res.status(404).json({ error: 'Client not found' });

  const body = sanitizeClientBody(req.body);
  if (body.client_type && !CLIENT_TYPES.includes(body.client_type))
    return res.status(400).json({ error: 'Invalid client_type' });
  if (body.onboarding_status && !CLIENT_ONBOARDING_STATUSES.includes(body.onboarding_status))
    return res.status(400).json({ error: 'Invalid onboarding_status' });
  if (body.risk_rating && !CLIENT_RISK_RATINGS.includes(body.risk_rating))
    return res.status(400).json({ error: 'Invalid risk_rating' });

  body.updated_at = new Date().toISOString();
  if (req.userId) body.updated_by = req.userId;

  const { data, error } = await supabase
    .from('practice_clients')
    .update(body)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Sync identity fields back to the central eco_client record.
  // Only push fields that are the eco_client's concern (name, email, phone, id_number).
  if (existing.eco_client_id) {
    try {
      const ecoUpdate = {};
      if (body.name      !== undefined) ecoUpdate.name      = body.name;
      if (body.email     !== undefined) ecoUpdate.email     = body.email;
      if (body.phone     !== undefined) ecoUpdate.phone     = body.phone;
      if (body.id_number !== undefined) ecoUpdate.id_number = body.id_number;
      if (Object.keys(ecoUpdate).length > 0) {
        ecoUpdate.updated_at = new Date().toISOString();
        await supabase
          .from('eco_clients')
          .update(ecoUpdate)
          .eq('id', existing.eco_client_id);
      }
    } catch (ecoSyncErr) {
      console.error('[practice] eco_client identity sync failed:', ecoSyncErr.message);
    }
  }

  await auditFromReq(req, 'UPDATE', 'practice_client', data.id, { module: 'practice' });
  res.json({ client: data });
});

router.delete('/clients/:id', async (req, res) => {
  const existing = await supabase
    .from('practice_clients')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing.data) return res.status(404).json({ error: 'Client not found' });

  const updates = {
    is_active: false,
    onboarding_status: 'archived',
    updated_at: new Date().toISOString()
  };
  if (req.userId) updates.updated_by = req.userId;

  const { error } = await supabase
    .from('practice_clients')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'ARCHIVE', 'practice_client', parseInt(req.params.id), { module: 'practice' });
  res.json({ success: true });
});

// ─── Client contacts ──────────────────────────────────────────────────────────

function sanitizeContactBody(body) {
  const allowed = [
    'contact_name', 'role', 'email', 'phone', 'mobile',
    'is_primary', 'receives_tax_correspondence', 'receives_billing',
    'receives_payroll', 'receives_cipc', 'notes', 'is_active'
  ];
  const out = {};
  for (const k of allowed) { if (k in body) out[k] = body[k]; }
  return out;
}

router.get('/clients/:id/contacts', async (req, res) => {
  const clientCheck = await supabase
    .from('practice_clients')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!clientCheck.data) return res.status(404).json({ error: 'Client not found' });

  const { data, error } = await supabase
    .from('practice_client_contacts')
    .select('*')
    .eq('client_id', req.params.id)
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('is_primary', { ascending: false })
    .order('contact_name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ contacts: data || [] });
});

router.post('/clients/:id/contacts', async (req, res) => {
  const clientCheck = await supabase
    .from('practice_clients')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!clientCheck.data) return res.status(404).json({ error: 'Client not found' });

  const body = sanitizeContactBody(req.body);
  if (!body.contact_name) return res.status(400).json({ error: 'Contact name is required' });

  body.client_id = parseInt(req.params.id);
  body.company_id = req.companyId;
  if (req.userId) body.created_by = req.userId;

  const { data, error } = await supabase.from('practice_client_contacts').insert(body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'practice_client_contact', data.id, { module: 'practice' });
  res.status(201).json({ contact: data });
});

router.put('/clients/:clientId/contacts/:contactId', async (req, res) => {
  const existing = await supabase
    .from('practice_client_contacts')
    .select('id')
    .eq('id', req.params.contactId)
    .eq('client_id', req.params.clientId)
    .eq('company_id', req.companyId)
    .single();
  if (!existing.data) return res.status(404).json({ error: 'Contact not found' });

  const body = sanitizeContactBody(req.body);
  body.updated_at = new Date().toISOString();
  if (req.userId) body.updated_by = req.userId;

  const { data, error } = await supabase
    .from('practice_client_contacts')
    .update(body)
    .eq('id', req.params.contactId)
    .eq('client_id', req.params.clientId)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'UPDATE', 'practice_client_contact', data.id, { module: 'practice' });
  res.json({ contact: data });
});

router.delete('/clients/:clientId/contacts/:contactId', async (req, res) => {
  const existing = await supabase
    .from('practice_client_contacts')
    .select('id')
    .eq('id', req.params.contactId)
    .eq('client_id', req.params.clientId)
    .eq('company_id', req.companyId)
    .single();
  if (!existing.data) return res.status(404).json({ error: 'Contact not found' });

  const updates = { is_active: false, updated_at: new Date().toISOString() };
  if (req.userId) updates.updated_by = req.userId;

  const { error } = await supabase
    .from('practice_client_contacts')
    .update(updates)
    .eq('id', req.params.contactId)
    .eq('client_id', req.params.clientId)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'DEACTIVATE', 'practice_client_contact', parseInt(req.params.contactId), { module: 'practice' });
  res.json({ success: true });
});

// ═══ TASKS ═══════════════════════════════════════════════════════════════════

// ── Review/Approval constants (validated at route level, not DB CHECK) ────────
const REVIEW_STATUSES   = ['not_required', 'pending', 'in_review', 'approved', 'rejected'];
const APPROVAL_STATUSES = ['not_required', 'pending', 'approved', 'rejected'];
const QA_STATUSES       = ['none', 'required', 'pending_review', 'rejected', 'approved', 'locked'];
const REVIEW_EVENT_TYPES = [
  'ready_for_review', 'review_started', 'review_approved', 'review_rejected',
  'approval_approved', 'approval_rejected', 'qa_locked', 'qa_unlocked',
  'review_fields_updated'
];

// ── Helpers ───────────────────────────────────────────────────────────────────

// Verify a team member belongs to the company. Returns true if memberId is null (null = unassigned is OK).
async function verifyTeamMember(companyId, memberId) {
  if (!memberId) return true;
  const { data } = await supabase
    .from('practice_team_members')
    .select('id')
    .eq('id', parseInt(memberId))
    .eq('company_id', companyId)
    .single();
  return !!data;
}

// Append a review event. Never throws — log failure is non-fatal.
async function logReviewEvent(companyId, taskId, eventType, opts = {}) {
  try {
    await supabase.from('practice_task_review_events').insert({
      company_id:          companyId,
      task_id:             taskId,
      event_type:          eventType,
      old_status:          opts.oldStatus          || null,
      new_status:          opts.newStatus          || null,
      old_review_status:   opts.oldReviewStatus    || null,
      new_review_status:   opts.newReviewStatus    || null,
      old_approval_status: opts.oldApprovalStatus  || null,
      new_approval_status: opts.newApprovalStatus  || null,
      actor_user_id:       opts.actorUserId        || null,
      actor_team_member_id: opts.actorTeamMemberId || null,
      notes:               opts.notes              || null,
      metadata:            opts.metadata           || {}
    });
  } catch (e) { /* non-fatal */ }
}

// ── List / single task ────────────────────────────────────────────────────────

router.get('/tasks', async (req, res) => {
  const {
    client_id, status, assigned_to, type, due_before, due_after,
    review_status, approval_status, qa_status,
    reviewer_id, preparer_id
  } = req.query;

  const page  = Math.max(1, parseInt(req.query.page  || 1));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || 25)));
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  let q = supabase
    .from('practice_tasks')
    .select(`*,
      practice_clients:client_id(name),
      preparer:preparer_team_member_id(id, display_name),
      reviewer:reviewer_team_member_id(id, display_name),
      approver:approver_team_member_id(id, display_name)`,
      { count: 'exact' })
    .eq('company_id', req.companyId)
    .order('due_date', { ascending: true, nullsFirst: false })
    .range(from, to);

  if (client_id)       q = q.eq('client_id',                   parseInt(client_id));
  if (status)          q = q.eq('status',                       status);
  if (assigned_to)     q = q.eq('assigned_to',                  parseInt(assigned_to));
  if (type)            q = q.eq('type',                         type);
  if (due_before)      q = q.lte('due_date',                    due_before);
  if (due_after)       q = q.gte('due_date',                    due_after);
  if (review_status)   q = q.eq('review_status',                review_status);
  if (approval_status) q = q.eq('approval_status',              approval_status);
  if (qa_status)       q = q.eq('qa_status',                    qa_status);
  if (reviewer_id)     q = q.eq('reviewer_team_member_id',      parseInt(reviewer_id));
  if (preparer_id)     q = q.eq('preparer_team_member_id',      parseInt(preparer_id));

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: data || [], total: count || 0 });
});

router.get('/tasks/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('practice_tasks')
    .select(`*,
      practice_clients:client_id(name),
      preparer:preparer_team_member_id(id, display_name),
      reviewer:reviewer_team_member_id(id, display_name),
      approver:approver_team_member_id(id, display_name)`)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Task not found' });
  res.json({ task: data });
});

// ── Create task ───────────────────────────────────────────────────────────────

router.post('/tasks', async (req, res) => {
  const {
    client_id, title, description, type, priority, due_date, assigned_to, notes,
    preparer_team_member_id, reviewer_team_member_id, approver_team_member_id,
    review_required, approval_required, estimated_hours
  } = req.body;

  if (!title) return res.status(400).json({ error: 'Task title is required' });
  const resolvedType = type || 'general';
  if (!TASK_TYPES.includes(resolvedType)) {
    return res.status(400).json({ error: `Invalid task type. Must be one of: ${TASK_TYPES.join(', ')}` });
  }

  // Validate team member ownership
  const [prepOk, revOk, appOk] = await Promise.all([
    verifyTeamMember(req.companyId, preparer_team_member_id),
    verifyTeamMember(req.companyId, reviewer_team_member_id),
    verifyTeamMember(req.companyId, approver_team_member_id)
  ]);
  if (!prepOk)  return res.status(400).json({ error: 'preparer_team_member_id not found in this company' });
  if (!revOk)   return res.status(400).json({ error: 'reviewer_team_member_id not found in this company' });
  if (!appOk)   return res.status(400).json({ error: 'approver_team_member_id not found in this company' });

  const needsReview   = review_required   === true || review_required   === 'true';
  const needsApproval = approval_required === true || approval_required === 'true';

  const { data, error } = await supabase
    .from('practice_tasks')
    .insert({
      company_id:                 req.companyId,
      client_id:                  client_id   ? parseInt(client_id)   : null,
      title,
      description:                description || null,
      type:                       resolvedType,
      priority:                   priority || 'medium',
      due_date:                   due_date || null,
      assigned_to:                assigned_to ? parseInt(assigned_to) : null,
      notes:                      notes || null,
      status:                     'open',
      created_by:                 req.user.userId,
      // Review/approval assignment
      preparer_team_member_id:    preparer_team_member_id  ? parseInt(preparer_team_member_id)  : null,
      reviewer_team_member_id:    reviewer_team_member_id  ? parseInt(reviewer_team_member_id)  : null,
      approver_team_member_id:    approver_team_member_id  ? parseInt(approver_team_member_id)  : null,
      // Optional capacity field
      estimated_hours:            estimated_hours != null ? parseFloat(estimated_hours) : null,
      // Control flags
      review_required:            needsReview,
      approval_required:          needsApproval,
      // Initial states
      review_status:              'not_required',
      approval_status:            'not_required',
      qa_status:                  needsReview ? 'required' : 'none'
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'practice_task', data.id, { module: 'practice' });
  res.status(201).json({ task: data });
});

// ── Update task ───────────────────────────────────────────────────────────────

router.put('/tasks/:id', async (req, res) => {
  // Fetch current task to check ownership and qa_locked
  const { data: existing, error: fetchErr } = await supabase
    .from('practice_tasks')
    .select('id, company_id, qa_locked, review_status, approval_status, qa_status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (fetchErr || !existing) return res.status(404).json({ error: 'Task not found' });

  // QA-locked tasks cannot be edited via this general endpoint
  if (existing.qa_locked) {
    return res.status(400).json({
      error: 'This task is QA-locked and cannot be edited. Use the qa-unlock endpoint first.'
    });
  }

  if (req.body.type !== undefined && !TASK_TYPES.includes(req.body.type)) {
    return res.status(400).json({ error: `Invalid task type. Must be one of: ${TASK_TYPES.join(', ')}` });
  }

  // Validate any team member IDs supplied
  const { preparer_team_member_id, reviewer_team_member_id, approver_team_member_id } = req.body;
  if (preparer_team_member_id !== undefined) {
    if (!await verifyTeamMember(req.companyId, preparer_team_member_id))
      return res.status(400).json({ error: 'preparer_team_member_id not found in this company' });
  }
  if (reviewer_team_member_id !== undefined) {
    if (!await verifyTeamMember(req.companyId, reviewer_team_member_id))
      return res.status(400).json({ error: 'reviewer_team_member_id not found in this company' });
  }
  if (approver_team_member_id !== undefined) {
    if (!await verifyTeamMember(req.companyId, approver_team_member_id))
      return res.status(400).json({ error: 'approver_team_member_id not found in this company' });
  }

  const allowed = [
    'title', 'description', 'type', 'priority', 'status', 'due_date', 'assigned_to', 'notes', 'client_id',
    'preparer_team_member_id', 'reviewer_team_member_id', 'approver_team_member_id',
    'review_required', 'approval_required', 'review_notes', 'approval_notes',
    'estimated_hours'
  ];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (updates.client_id !== undefined)   updates.client_id   = updates.client_id   ? parseInt(updates.client_id)   : null;
  if (updates.assigned_to !== undefined) updates.assigned_to = updates.assigned_to ? parseInt(updates.assigned_to) : null;
  if (updates.preparer_team_member_id !== undefined)
    updates.preparer_team_member_id  = updates.preparer_team_member_id  ? parseInt(updates.preparer_team_member_id)  : null;
  if (updates.reviewer_team_member_id !== undefined)
    updates.reviewer_team_member_id  = updates.reviewer_team_member_id  ? parseInt(updates.reviewer_team_member_id)  : null;
  if (updates.approver_team_member_id !== undefined)
    updates.approver_team_member_id  = updates.approver_team_member_id  ? parseInt(updates.approver_team_member_id)  : null;

  if (req.body.status === 'completed') updates.completed_at = new Date().toISOString();

  // If review_required is being enabled and task hasn't been submitted yet, set qa_status = required
  if (updates.review_required === true && existing.review_status === 'not_required') {
    updates.qa_status = 'required';
  }
  // If review_required is being disabled, reset qa fields only if not yet in a review cycle
  if (updates.review_required === false && existing.review_status === 'not_required') {
    updates.qa_status = 'none';
  }

  const { data, error } = await supabase
    .from('practice_tasks')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Log field update event if review-related fields changed
  const reviewFieldsChanged = [
    'preparer_team_member_id','reviewer_team_member_id','approver_team_member_id',
    'review_required','approval_required'
  ].some(k => req.body[k] !== undefined);
  if (reviewFieldsChanged) {
    await logReviewEvent(req.companyId, data.id, 'review_fields_updated', {
      actorUserId: req.user ? req.user.userId : null,
      metadata: { changed_fields: Object.keys(updates).filter(k => k !== 'updated_at') }
    });
  }

  await auditFromReq(req, 'UPDATE', 'practice_task', data.id, { module: 'practice' });
  res.json({ task: data });
});

// ── Delete task ───────────────────────────────────────────────────────────────

router.delete('/tasks/:id', async (req, res) => {
  const { error } = await supabase
    .from('practice_tasks')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  // Note: practice_task_review_events.task_id has ON DELETE SET NULL — review history is preserved
  res.json({ success: true });
});

// ── Review event history ──────────────────────────────────────────────────────

router.get('/tasks/:id/review-events', async (req, res) => {
  // Verify task belongs to company
  const { data: task, error: tErr } = await supabase
    .from('practice_tasks')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !task) return res.status(404).json({ error: 'Task not found' });

  const { data, error } = await supabase
    .from('practice_task_review_events')
    .select('*')
    .eq('company_id', req.companyId)
    .eq('task_id', parseInt(req.params.id))
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data || [] });
});

// ── Submit for review ─────────────────────────────────────────────────────────

router.put('/tasks/:id/submit-review', async (req, res) => {
  const { data: task, error: tErr } = await supabase
    .from('practice_tasks')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (!task.review_required) {
    return res.status(400).json({ error: 'This task does not require review. Enable review_required first.' });
  }
  if (['approved', 'in_review'].includes(task.review_status)) {
    return res.status(400).json({ error: `Cannot submit for review — current review_status is "${task.review_status}"` });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_tasks')
    .update({
      review_status:       'pending',
      qa_status:           'pending_review',
      ready_for_review_at: now,
      updated_at:          now
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logReviewEvent(req.companyId, data.id, 'ready_for_review', {
    oldReviewStatus: task.review_status,
    newReviewStatus: 'pending',
    actorUserId: req.user ? req.user.userId : null
  });
  await auditFromReq(req, 'UPDATE', 'practice_task', data.id, { module: 'practice', action: 'submit_review' });
  res.json({ task: data });
});

// ── Start review ──────────────────────────────────────────────────────────────

router.put('/tasks/:id/start-review', async (req, res) => {
  const { data: task, error: tErr } = await supabase
    .from('practice_tasks')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (task.review_status !== 'pending') {
    return res.status(400).json({ error: `Cannot start review — review_status must be "pending", got "${task.review_status}"` });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_tasks')
    .update({ review_status: 'in_review', updated_at: now })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logReviewEvent(req.companyId, data.id, 'review_started', {
    oldReviewStatus: 'pending',
    newReviewStatus: 'in_review',
    actorUserId: req.user ? req.user.userId : null
  });
  await auditFromReq(req, 'UPDATE', 'practice_task', data.id, { module: 'practice', action: 'start_review' });
  res.json({ task: data });
});

// ── Approve review ────────────────────────────────────────────────────────────

router.put('/tasks/:id/approve-review', async (req, res) => {
  const { notes } = req.body;
  const { data: task, error: tErr } = await supabase
    .from('practice_tasks')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (!['pending', 'in_review'].includes(task.review_status)) {
    return res.status(400).json({ error: `Cannot approve review — review_status must be "pending" or "in_review", got "${task.review_status}"` });
  }

  const actorId   = req.user ? req.user.userId : null;
  const now       = new Date().toISOString();
  const needsApproval = task.approval_required;
  const updates   = {
    review_status:  'approved',
    reviewed_at:    now,
    reviewed_by:    actorId,
    review_notes:   notes || task.review_notes || null,
    qa_status:      needsApproval ? 'required' : 'approved',
    approval_status: needsApproval ? 'pending' : task.approval_status,
    updated_at:     now
  };

  const { data, error } = await supabase
    .from('practice_tasks')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logReviewEvent(req.companyId, data.id, 'review_approved', {
    oldReviewStatus:    task.review_status,
    newReviewStatus:    'approved',
    oldApprovalStatus:  task.approval_status,
    newApprovalStatus:  needsApproval ? 'pending' : task.approval_status,
    actorUserId:        actorId,
    notes:              notes || null
  });
  await auditFromReq(req, 'UPDATE', 'practice_task', data.id, { module: 'practice', action: 'approve_review' });
  res.json({ task: data });
});

// ── Reject review ─────────────────────────────────────────────────────────────

router.put('/tasks/:id/reject-review', async (req, res) => {
  const { rejection_reason } = req.body;
  if (!rejection_reason || !rejection_reason.trim()) {
    return res.status(400).json({ error: 'rejection_reason is required' });
  }
  const { data: task, error: tErr } = await supabase
    .from('practice_tasks')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (!['pending', 'in_review'].includes(task.review_status)) {
    return res.status(400).json({ error: `Cannot reject review — review_status must be "pending" or "in_review", got "${task.review_status}"` });
  }

  const actorId = req.user ? req.user.userId : null;
  const now     = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_tasks')
    .update({
      review_status:    'rejected',
      rejected_at:      now,
      rejected_by:      actorId,
      rejection_reason: rejection_reason.trim(),
      qa_status:        'rejected',
      // Reset task status to in_progress so preparer is prompted to fix
      status:           task.status === 'review' ? 'in_progress' : task.status,
      updated_at:       now
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logReviewEvent(req.companyId, data.id, 'review_rejected', {
    oldReviewStatus: task.review_status,
    newReviewStatus: 'rejected',
    actorUserId:     actorId,
    notes:           rejection_reason.trim()
  });
  await auditFromReq(req, 'UPDATE', 'practice_task', data.id, { module: 'practice', action: 'reject_review' });
  res.json({ task: data });
});

// ── Final approve (approver sign-off) ─────────────────────────────────────────

router.put('/tasks/:id/approve-final', async (req, res) => {
  const { notes } = req.body;
  const { data: task, error: tErr } = await supabase
    .from('practice_tasks')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (!task.approval_required) {
    return res.status(400).json({ error: 'This task does not require final approval.' });
  }
  // If review is required it must be approved first
  if (task.review_required && task.review_status !== 'approved') {
    return res.status(400).json({
      error: `Cannot approve: review_status must be "approved" first, got "${task.review_status}"`
    });
  }
  if (task.approval_status !== 'pending') {
    return res.status(400).json({ error: `Cannot approve: approval_status must be "pending", got "${task.approval_status}"` });
  }

  const actorId = req.user ? req.user.userId : null;
  const now     = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_tasks')
    .update({
      approval_status: 'approved',
      approved_at:     now,
      approved_by:     actorId,
      approval_notes:  notes || task.approval_notes || null,
      qa_status:       'approved',
      updated_at:      now
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logReviewEvent(req.companyId, data.id, 'approval_approved', {
    oldApprovalStatus: task.approval_status,
    newApprovalStatus: 'approved',
    actorUserId:       actorId,
    notes:             notes || null
  });
  await auditFromReq(req, 'UPDATE', 'practice_task', data.id, { module: 'practice', action: 'approve_final' });
  res.json({ task: data });
});

// ── Final reject (approver sends back) ───────────────────────────────────────

router.put('/tasks/:id/reject-final', async (req, res) => {
  const { rejection_reason } = req.body;
  if (!rejection_reason || !rejection_reason.trim()) {
    return res.status(400).json({ error: 'rejection_reason is required' });
  }
  const { data: task, error: tErr } = await supabase
    .from('practice_tasks')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (!task.approval_required) {
    return res.status(400).json({ error: 'This task does not require final approval.' });
  }
  if (task.approval_status !== 'pending') {
    return res.status(400).json({ error: `Cannot reject: approval_status must be "pending", got "${task.approval_status}"` });
  }

  const actorId = req.user ? req.user.userId : null;
  const now     = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_tasks')
    .update({
      approval_status:  'rejected',
      rejected_at:      now,
      rejected_by:      actorId,
      rejection_reason: rejection_reason.trim(),
      qa_status:        'rejected',
      // Reset review_status so the cycle can restart
      review_status:    task.review_required ? 'not_required' : task.review_status,
      updated_at:       now
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logReviewEvent(req.companyId, data.id, 'approval_rejected', {
    oldApprovalStatus: task.approval_status,
    newApprovalStatus: 'rejected',
    actorUserId:       actorId,
    notes:             rejection_reason.trim()
  });
  await auditFromReq(req, 'UPDATE', 'practice_task', data.id, { module: 'practice', action: 'reject_final' });
  res.json({ task: data });
});

// ── QA lock / unlock ──────────────────────────────────────────────────────────

router.put('/tasks/:id/qa-lock', async (req, res) => {
  const { data: task, error: tErr } = await supabase
    .from('practice_tasks')
    .select('id, qa_status, qa_locked, company_id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (task.qa_locked) return res.status(400).json({ error: 'Task is already QA-locked' });
  if (task.qa_status !== 'approved') {
    return res.status(400).json({ error: `QA lock requires qa_status = "approved", got "${task.qa_status}"` });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_tasks')
    .update({ qa_locked: true, qa_status: 'locked', updated_at: now })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logReviewEvent(req.companyId, data.id, 'qa_locked', {
    actorUserId: req.user ? req.user.userId : null
  });
  await auditFromReq(req, 'UPDATE', 'practice_task', data.id, { module: 'practice', action: 'qa_lock' });
  res.json({ task: data });
});

router.put('/tasks/:id/qa-unlock', async (req, res) => {
  const { data: task, error: tErr } = await supabase
    .from('practice_tasks')
    .select('id, qa_locked, company_id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (tErr || !task) return res.status(404).json({ error: 'Task not found' });
  if (!task.qa_locked) return res.status(400).json({ error: 'Task is not QA-locked' });

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_tasks')
    .update({ qa_locked: false, qa_status: 'approved', updated_at: now })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logReviewEvent(req.companyId, data.id, 'qa_unlocked', {
    actorUserId: req.user ? req.user.userId : null
  });
  await auditFromReq(req, 'UPDATE', 'practice_task', data.id, { module: 'practice', action: 'qa_unlock' });
  res.json({ task: data });
});

// ═══ TIME ENTRIES ═════════════════════════════════════════════════════════════

const TIME_TYPES      = ['billable', 'non_billable', 'internal', 'admin'];
const BILLING_STATUSES = ['unbilled', 'pending_review', 'approved', 'rejected', 'billed', 'written_off'];

// Compute effective_rate and recoverable_value from rate inputs.
// Priority: override_rate > legacy_rate (old 'rate' field) > standard_rate
function computeTimeRates(hours, standardRate, overrideRate, legacyRate) {
  const std = standardRate != null ? parseFloat(standardRate) : null;
  const ovr = overrideRate != null ? parseFloat(overrideRate)
    : (legacyRate != null ? parseFloat(legacyRate) : null);
  const effective = ovr != null ? ovr : std;
  const recoverable = (effective != null && hours != null)
    ? Math.round(parseFloat(hours) * effective * 100) / 100
    : null;
  return { effectiveRate: effective, recoverableValue: recoverable, resolvedOverrideRate: ovr };
}

// Derive time_type from the old billable boolean when time_type is not explicitly sent.
function deriveTimeType(timeType, billable) {
  if (timeType && TIME_TYPES.includes(timeType)) return timeType;
  return (billable === false || billable === 'false') ? 'non_billable' : 'billable';
}

// Verify a client belongs to this company.
async function verifyClientBelongsToCompany(companyId, clientId) {
  if (!clientId) return true;
  const { data } = await supabase
    .from('practice_clients')
    .select('id').eq('id', parseInt(clientId)).eq('company_id', companyId).single();
  return !!data;
}

// Verify a task belongs to this company.
async function verifyTaskBelongsToCompany(companyId, taskId) {
  if (!taskId) return true;
  const { data } = await supabase
    .from('practice_tasks')
    .select('id').eq('id', parseInt(taskId)).eq('company_id', companyId).single();
  return !!data;
}

// Verify a workflow run belongs to this company.
async function verifyWorkflowRunBelongsToCompany(companyId, runId) {
  if (!runId) return true;
  const { data } = await supabase
    .from('practice_workflow_runs')
    .select('id').eq('id', parseInt(runId)).eq('company_id', companyId).single();
  return !!data;
}

// ── WIP Report ────────────────────────────────────────────────────────────────
// Must be defined before :id routes to prevent 'wip'/'summary' matching as :id

router.get('/time-entries/wip', async (req, res) => {
  const { client_id, user_id, workflow_run_id, date_from, date_to } = req.query;

  let q = supabase
    .from('practice_time_entries')
    .select('hours, billing_status, time_type, recoverable_value, billed_value, writeoff_value')
    .eq('company_id', req.companyId)
    .in('time_type', ['billable']);

  if (client_id)      q = q.eq('client_id',      parseInt(client_id));
  if (user_id)        q = q.eq('user_id',         parseInt(user_id));
  if (workflow_run_id) q = q.eq('workflow_run_id', parseInt(workflow_run_id));
  if (date_from)      q = q.gte('date', date_from);
  if (date_to)        q = q.lte('date', date_to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  const summary = {
    unbilled:        { hours: 0, recoverable_value: 0 },
    pending_review:  { hours: 0, recoverable_value: 0 },
    approved:        { hours: 0, recoverable_value: 0 },
    rejected:        { hours: 0, recoverable_value: 0 },
    billed:          { hours: 0, billed_value: 0 },
    written_off:     { hours: 0, writeoff_value: 0 }
  };

  rows.forEach(r => {
    const h  = parseFloat(r.hours || 0);
    const rv = parseFloat(r.recoverable_value || 0);
    const bv = parseFloat(r.billed_value     || 0);
    const wv = parseFloat(r.writeoff_value   || 0);
    const s  = r.billing_status || 'unbilled';
    if (summary[s]) {
      summary[s].hours = Math.round((summary[s].hours + h) * 100) / 100;
      if (s === 'billed')      summary[s].billed_value   = Math.round((summary[s].billed_value   + bv) * 100) / 100;
      else if (s === 'written_off') summary[s].writeoff_value = Math.round((summary[s].writeoff_value + wv) * 100) / 100;
      else                     summary[s].recoverable_value = Math.round((summary[s].recoverable_value + rv) * 100) / 100;
    }
  });

  const totalUnbilledHours    = summary.unbilled.hours + summary.pending_review.hours + summary.rejected.hours;
  const totalRecoverable      = summary.unbilled.recoverable_value + summary.pending_review.recoverable_value + summary.approved.recoverable_value;

  res.json({
    by_status: summary,
    total_unbilled_hours: Math.round(totalUnbilledHours * 100) / 100,
    total_recoverable:    Math.round(totalRecoverable   * 100) / 100
  });
});

// ── Time Summary (utilization reporting) ─────────────────────────────────────

router.get('/time-entries/summary', async (req, res) => {
  const { client_id, user_id, date_from, date_to } = req.query;

  let q = supabase
    .from('practice_time_entries')
    .select('hours, time_type, billable, recoverable_value')
    .eq('company_id', req.companyId);

  if (client_id) q = q.eq('client_id', parseInt(client_id));
  if (user_id)   q = q.eq('user_id',   parseInt(user_id));
  if (date_from) q = q.gte('date', date_from);
  if (date_to)   q = q.lte('date', date_to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  let billable_hours = 0, non_billable_hours = 0, internal_hours = 0, admin_hours = 0, recoverable = 0;

  rows.forEach(r => {
    const h = parseFloat(r.hours || 0);
    const t = r.time_type || (r.billable ? 'billable' : 'non_billable');
    if (t === 'billable')      { billable_hours     += h; recoverable += parseFloat(r.recoverable_value || 0); }
    else if (t === 'non_billable') non_billable_hours += h;
    else if (t === 'internal')     internal_hours     += h;
    else if (t === 'admin')        admin_hours         += h;
  });

  const total_hours     = billable_hours + non_billable_hours + internal_hours + admin_hours;
  const utilization_pct = total_hours > 0
    ? Math.round((billable_hours / total_hours) * 1000) / 10
    : 0;

  res.json({
    billable_hours:     Math.round(billable_hours     * 100) / 100,
    non_billable_hours: Math.round(non_billable_hours * 100) / 100,
    internal_hours:     Math.round(internal_hours     * 100) / 100,
    admin_hours:        Math.round(admin_hours        * 100) / 100,
    total_hours:        Math.round(total_hours        * 100) / 100,
    utilization_pct,
    recoverable_value:  Math.round(recoverable        * 100) / 100
  });
});

// ── List time entries ─────────────────────────────────────────────────────────

router.get('/time-entries', async (req, res) => {
  const { client_id, task_id, user_id, date_from, date_to, billing_status, time_type, workflow_run_id } = req.query;

  const page  = Math.max(1, parseInt(req.query.page  || 1));
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || 50)));
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  let q = supabase
    .from('practice_time_entries')
    .select(`*, practice_clients:client_id(name), practice_tasks:task_id(title)`, { count: 'exact' })
    .eq('company_id', req.companyId)
    .order('date', { ascending: false })
    .range(from, to);

  if (client_id)      q = q.eq('client_id',      parseInt(client_id));
  if (task_id)        q = q.eq('task_id',         parseInt(task_id));
  if (user_id)        q = q.eq('user_id',         parseInt(user_id));
  if (date_from)      q = q.gte('date', date_from);
  if (date_to)        q = q.lte('date', date_to);
  if (billing_status) q = q.eq('billing_status',  billing_status);
  if (time_type)      q = q.eq('time_type',        time_type);
  if (workflow_run_id) q = q.eq('workflow_run_id', parseInt(workflow_run_id));

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const totalHours = (data || []).reduce((s, r) => s + (r.hours || 0), 0);
  res.json({
    time_entries: data || [],
    total_hours:  Math.round(totalHours * 100) / 100,
    total:        count || 0
  });
});

// ── Create time entry ─────────────────────────────────────────────────────────

router.post('/time-entries', async (req, res) => {
  const {
    client_id, task_id, workflow_run_id,
    hours, description, date, billable,
    time_type: rawTimeType,
    standard_rate, override_rate, rate,
    billing_notes, internal_notes
  } = req.body;

  if (!hours || hours <= 0) return res.status(400).json({ error: 'hours must be a positive number' });
  if (!date)                return res.status(400).json({ error: 'date is required' });

  // Validate ownership
  const [clientOk, taskOk, runOk] = await Promise.all([
    verifyClientBelongsToCompany(req.companyId, client_id),
    verifyTaskBelongsToCompany(req.companyId, task_id),
    verifyWorkflowRunBelongsToCompany(req.companyId, workflow_run_id)
  ]);
  if (!clientOk)  return res.status(400).json({ error: 'client_id not found in this company' });
  if (!taskOk)    return res.status(400).json({ error: 'task_id not found in this company' });
  if (!runOk)     return res.status(400).json({ error: 'workflow_run_id not found in this company' });

  const resolvedTimeType = deriveTimeType(rawTimeType, billable);
  const parsedHours      = parseFloat(hours);
  const { effectiveRate, recoverableValue, resolvedOverrideRate } =
    computeTimeRates(parsedHours, standard_rate, override_rate, rate);

  const isBillable = resolvedTimeType === 'billable';

  const { data, error } = await supabase
    .from('practice_time_entries')
    .insert({
      company_id:        req.companyId,
      user_id:           req.user.userId,
      client_id:         client_id       ? parseInt(client_id)       : null,
      task_id:           task_id         ? parseInt(task_id)         : null,
      workflow_run_id:   workflow_run_id ? parseInt(workflow_run_id) : null,
      hours:             parsedHours,
      description:       description     || null,
      date,
      billable:          isBillable,
      time_type:         resolvedTimeType,
      rate:              effectiveRate,              // backward compat
      standard_rate:     standard_rate ? parseFloat(standard_rate) : null,
      override_rate:     resolvedOverrideRate,
      effective_rate:    effectiveRate,
      recoverable_value: isBillable ? recoverableValue : null,
      billing_status:    'unbilled',
      billing_notes:     billing_notes  || null,
      internal_notes:    internal_notes || null
    })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'CREATE', 'practice_time_entry', data.id, {
    module: 'practice',
    client_id: data.client_id,
    workflow_run_id: data.workflow_run_id
  });

  res.status(201).json({ time_entry: data });
});

// ── Update time entry ─────────────────────────────────────────────────────────

router.put('/time-entries/:id', async (req, res) => {
  // Fetch current entry first to check company and billing_status
  const { data: existing, error: fetchErr } = await supabase
    .from('practice_time_entries')
    .select('id, company_id, billing_status, hours, standard_rate, override_rate, effective_rate, time_type, billable')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (fetchErr || !existing) return res.status(404).json({ error: 'Time entry not found' });

  // Block edits on finalized entries
  if (['billed', 'written_off'].includes(existing.billing_status)) {
    return res.status(400).json({ error: `Cannot edit a time entry with status '${existing.billing_status}'` });
  }

  const ALLOWED = [
    'client_id', 'task_id', 'workflow_run_id', 'hours', 'description', 'date', 'billable',
    'time_type', 'standard_rate', 'override_rate', 'rate',
    'billing_notes', 'internal_notes'
  ];
  const updates = { updated_at: new Date().toISOString() };
  ALLOWED.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  // Validate time_type if supplied
  if (updates.time_type && !TIME_TYPES.includes(updates.time_type)) {
    return res.status(400).json({ error: `Invalid time_type. Must be one of: ${TIME_TYPES.join(', ')}` });
  }

  // Recompute effective_rate and recoverable_value whenever any rate or hours changes
  const newHours    = updates.hours         != null ? parseFloat(updates.hours)         : parseFloat(existing.hours);
  const newStdRate  = updates.standard_rate != null ? parseFloat(updates.standard_rate) : existing.standard_rate;
  const newOvrRate  = updates.override_rate != null ? parseFloat(updates.override_rate)
    : (updates.rate != null ? parseFloat(updates.rate) : existing.override_rate);
  const newTimeType = updates.time_type || existing.time_type || (existing.billable ? 'billable' : 'non_billable');
  const isBillable  = newTimeType === 'billable';

  const { effectiveRate, recoverableValue } = computeTimeRates(newHours, newStdRate, newOvrRate, null);
  updates.effective_rate    = effectiveRate;
  updates.recoverable_value = isBillable ? recoverableValue : null;
  updates.billable          = isBillable;
  if (updates.rate == null && effectiveRate != null) updates.rate = effectiveRate; // keep legacy field in sync

  const { data, error } = await supabase
    .from('practice_time_entries')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'practice_time_entry', data.id, { module: 'practice' });

  res.json({ time_entry: data });
});

// ── Delete time entry ─────────────────────────────────────────────────────────

router.delete('/time-entries/:id', async (req, res) => {
  // Fetch to check status before deleting
  const { data: existing } = await supabase
    .from('practice_time_entries')
    .select('billing_status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();

  if (existing && ['billed', 'written_off'].includes(existing.billing_status)) {
    return res.status(400).json({ error: `Cannot delete a time entry with status '${existing.billing_status}'` });
  }

  const { error } = await supabase
    .from('practice_time_entries')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Submit for billing review ─────────────────────────────────────────────────

router.put('/time-entries/:id/submit-review', async (req, res) => {
  const { data: existing, error: fetchErr } = await supabase
    .from('practice_time_entries')
    .select('id, billing_status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (fetchErr || !existing) return res.status(404).json({ error: 'Time entry not found' });

  if (!['unbilled', 'rejected'].includes(existing.billing_status)) {
    return res.status(400).json({ error: `Cannot submit entry with status '${existing.billing_status}' for review` });
  }

  const { data, error } = await supabase
    .from('practice_time_entries')
    .update({
      billing_status:          'pending_review',
      submitted_for_review_at: new Date().toISOString(),
      updated_at:              new Date().toISOString()
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'time_submitted_review', 'practice_time_entry', data.id, { module: 'practice' });
  res.json({ time_entry: data });
});

// ── Approve time entry for billing ───────────────────────────────────────────

router.put('/time-entries/:id/approve', async (req, res) => {
  const { data: existing, error: fetchErr } = await supabase
    .from('practice_time_entries')
    .select('id, billing_status')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (fetchErr || !existing) return res.status(404).json({ error: 'Time entry not found' });

  if (existing.billing_status !== 'pending_review') {
    return res.status(400).json({ error: `Entry must be in 'pending_review' status to approve (current: '${existing.billing_status}')` });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('practice_time_entries')
    .update({
      billing_status: 'approved',
      approved_at:    now,
      approved_by:    req.user.userId,
      updated_at:     now
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'time_approved', 'practice_time_entry', data.id, { module: 'practice' });
  res.json({ time_entry: data });
});

// ── Reject time entry ─────────────────────────────────────────────────────────

router.put('/time-entries/:id/reject', async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'rejection reason is required' });
  }

  const { data: existing, error: fetchErr } = await supabase
    .from('practice_time_entries')
    .select('id, billing_status, billing_notes')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (fetchErr || !existing) return res.status(404).json({ error: 'Time entry not found' });

  if (!['pending_review', 'approved'].includes(existing.billing_status)) {
    return res.status(400).json({ error: `Cannot reject entry with status '${existing.billing_status}'` });
  }

  const { data, error } = await supabase
    .from('practice_time_entries')
    .update({
      billing_status: 'rejected',
      billing_notes:  reason.trim(),
      updated_at:     new Date().toISOString()
    })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'time_rejected', 'practice_time_entry', data.id, { module: 'practice' });
  res.json({ time_entry: data });
});

// ═══ DEADLINES ═══════════════════════════════════════════════════════════════

function sanitizeDeadlineBody(body) {
  const allowed = [
    'client_id', 'title', 'type', 'compliance_area', 'deadline_type',
    'due_date', 'period_start', 'period_end', 'reminder_date',
    'status', 'priority', 'notes', 'internal_notes',
    'responsible_team_member_id', 'reviewer_team_member_id',
    'submission_reference', 'workflow_run_id', 'task_id', 'settings'
  ];
  const out = {};
  for (const k of allowed) { if (k in body) out[k] = body[k]; }
  return out;
}

async function logDeadlineEvent(companyId, deadlineId, eventType, opts = {}) {
  await supabase.from('practice_deadline_events').insert({
    company_id: companyId,
    deadline_id: deadlineId,
    event_type: eventType,
    event_note: opts.note || null,
    old_status: opts.oldStatus || null,
    new_status: opts.newStatus || null,
    actor_user_id: opts.actorUserId || null,
    metadata: opts.metadata || {}
  });
}

router.get('/deadlines', async (req, res) => {
  const {
    client_id, status, compliance_area, deadline_type,
    responsible_team_member_id, date_from, date_to,
    search, page, limit, include_cancelled
  } = req.query;

  let q = supabase
    .from('practice_deadlines')
    .select('*, practice_clients:client_id(name), practice_team_members!responsible_team_member_id(display_name)')
    .eq('company_id', req.companyId)
    .order('due_date', { ascending: true });

  // By default exclude cancelled/soft-deleted deadlines
  if (include_cancelled !== 'true') q = q.eq('is_active', true);

  if (client_id) q = q.eq('client_id', parseInt(client_id));
  if (status) q = q.eq('status', status);
  if (compliance_area && COMPLIANCE_AREAS.includes(compliance_area)) q = q.eq('compliance_area', compliance_area);
  if (deadline_type) q = q.eq('deadline_type', deadline_type);
  if (responsible_team_member_id) q = q.eq('responsible_team_member_id', parseInt(responsible_team_member_id));
  if (date_from) q = q.gte('due_date', date_from);
  if (date_to) q = q.lte('due_date', date_to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  let results = data || [];
  if (search) {
    const s = search.toLowerCase();
    results = results.filter(d =>
      (d.title && d.title.toLowerCase().includes(s)) ||
      (d.practice_clients?.name && d.practice_clients.name.toLowerCase().includes(s))
    );
  }

  const total = results.length;
  if (page && limit) {
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit)));
    results = results.slice((p - 1) * l, p * l);
  }

  res.json({ deadlines: results, total });
});

router.get('/deadlines/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('practice_deadlines')
    .select('*, practice_clients:client_id(name), practice_team_members!responsible_team_member_id(display_name)')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Deadline not found' });
  res.json({ deadline: data });
});

router.post('/deadlines', async (req, res) => {
  const body = sanitizeDeadlineBody(req.body);
  if (!body.title || !body.due_date) return res.status(400).json({ error: 'title and due_date are required' });

  const resolvedType = body.type || 'general';
  if (!DEADLINE_TYPES.includes(resolvedType)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${DEADLINE_TYPES.join(', ')}` });
  }
  if (body.compliance_area && !COMPLIANCE_AREAS.includes(body.compliance_area)) {
    return res.status(400).json({ error: `Invalid compliance_area. Must be one of: ${COMPLIANCE_AREAS.join(', ')}` });
  }
  if (body.deadline_type && !DEADLINE_TYPE_EXTENDED.includes(body.deadline_type)) {
    return res.status(400).json({ error: `Invalid deadline_type. Must be one of: ${DEADLINE_TYPE_EXTENDED.join(', ')}` });
  }
  if (body.priority && !DEADLINE_PRIORITIES.includes(body.priority)) {
    return res.status(400).json({ error: `Invalid priority. Must be one of: ${DEADLINE_PRIORITIES.join(', ')}` });
  }
  if (body.period_start && body.period_end && body.period_start > body.period_end) {
    return res.status(400).json({ error: 'period_start must be on or before period_end' });
  }

  // Verify client belongs to this company
  if (body.client_id) {
    const cc = await supabase.from('practice_clients').select('id').eq('id', body.client_id).eq('company_id', req.companyId).single();
    if (!cc.data) return res.status(400).json({ error: 'Client not found in this company' });
  }
  // Verify team member belongs to this company
  if (body.responsible_team_member_id) {
    const tm = await supabase.from('practice_team_members').select('id').eq('id', body.responsible_team_member_id).eq('company_id', req.companyId).single();
    if (!tm.data) return res.status(400).json({ error: 'Responsible team member not found in this company' });
  }

  body.type = resolvedType;
  body.company_id = req.companyId;
  body.status = body.status || 'open';
  body.priority = body.priority || 'normal';
  body.is_active = true;
  if (req.user?.userId) body.created_by = req.user.userId;
  if (body.client_id) body.client_id = parseInt(body.client_id);
  if (body.responsible_team_member_id) body.responsible_team_member_id = parseInt(body.responsible_team_member_id);
  if (body.reviewer_team_member_id) body.reviewer_team_member_id = parseInt(body.reviewer_team_member_id);

  const { data, error } = await supabase
    .from('practice_deadlines')
    .insert(body)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'CREATE', 'practice_deadline', data.id, { module: 'practice' });
  await logDeadlineEvent(req.companyId, data.id, 'created', {
    newStatus: data.status,
    actorUserId: req.user?.userId,
    metadata: { title: data.title, due_date: data.due_date }
  });

  res.status(201).json({ deadline: data });
});

router.put('/deadlines/:id', async (req, res) => {
  // Verify ownership
  const { data: existing } = await supabase
    .from('practice_deadlines')
    .select('id, status, is_active')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing) return res.status(404).json({ error: 'Deadline not found' });
  if (!existing.is_active) return res.status(400).json({ error: 'Cannot edit a cancelled deadline' });

  const body = sanitizeDeadlineBody(req.body);

  if (body.type !== undefined && !DEADLINE_TYPES.includes(body.type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${DEADLINE_TYPES.join(', ')}` });
  }
  if (body.status !== undefined && !DEADLINE_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${DEADLINE_STATUSES.join(', ')}` });
  }
  if (body.compliance_area !== undefined && body.compliance_area && !COMPLIANCE_AREAS.includes(body.compliance_area)) {
    return res.status(400).json({ error: `Invalid compliance_area. Must be one of: ${COMPLIANCE_AREAS.join(', ')}` });
  }
  if (body.deadline_type !== undefined && body.deadline_type && !DEADLINE_TYPE_EXTENDED.includes(body.deadline_type)) {
    return res.status(400).json({ error: `Invalid deadline_type. Must be one of: ${DEADLINE_TYPE_EXTENDED.join(', ')}` });
  }
  if (body.priority !== undefined && body.priority && !DEADLINE_PRIORITIES.includes(body.priority)) {
    return res.status(400).json({ error: `Invalid priority. Must be one of: ${DEADLINE_PRIORITIES.join(', ')}` });
  }
  if (body.period_start && body.period_end && body.period_start > body.period_end) {
    return res.status(400).json({ error: 'period_start must be on or before period_end' });
  }

  // Verify foreign keys
  if (body.client_id) {
    const cc = await supabase.from('practice_clients').select('id').eq('id', body.client_id).eq('company_id', req.companyId).single();
    if (!cc.data) return res.status(400).json({ error: 'Client not found in this company' });
    body.client_id = parseInt(body.client_id);
  }
  if (body.responsible_team_member_id) {
    const tm = await supabase.from('practice_team_members').select('id').eq('id', body.responsible_team_member_id).eq('company_id', req.companyId).single();
    if (!tm.data) return res.status(400).json({ error: 'Responsible team member not found in this company' });
    body.responsible_team_member_id = parseInt(body.responsible_team_member_id);
  }
  if (body.reviewer_team_member_id) {
    body.reviewer_team_member_id = parseInt(body.reviewer_team_member_id);
  }

  const oldStatus = existing.status;
  body.updated_at = new Date().toISOString();
  if (req.user?.userId) body.updated_by = req.user.userId;

  // Auto-set timestamps on status transitions
  if (body.status === 'submitted' && !body.submitted_at) {
    body.submitted_at = new Date().toISOString();
  }
  if (body.status === 'completed' && !body.completed_at) {
    body.completed_at = new Date().toISOString();
    if (req.user?.userId) body.completed_by = req.user.userId;
  }

  const { data, error } = await supabase
    .from('practice_deadlines')
    .update(body)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'practice_deadline', data.id, { module: 'practice' });

  if (body.status && body.status !== oldStatus) {
    await logDeadlineEvent(req.companyId, data.id, 'status_changed', {
      oldStatus,
      newStatus: body.status,
      actorUserId: req.user?.userId
    });
  }

  res.json({ deadline: data });
});

// Dedicated status-only transition endpoint — safer for quick status updates
router.put('/deadlines/:id/status', async (req, res) => {
  const { status, submission_reference, event_note } = req.body;
  if (!status || !DEADLINE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${DEADLINE_STATUSES.join(', ')}` });
  }

  const { data: existing } = await supabase
    .from('practice_deadlines')
    .select('id, status, is_active')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing) return res.status(404).json({ error: 'Deadline not found' });
  if (!existing.is_active) return res.status(400).json({ error: 'Cannot update a cancelled deadline' });

  const oldStatus = existing.status;
  const updates = {
    status,
    updated_at: new Date().toISOString()
  };
  if (req.user?.userId) updates.updated_by = req.user.userId;
  if (status === 'submitted') {
    updates.submitted_at = new Date().toISOString();
    if (submission_reference) updates.submission_reference = submission_reference;
  }
  if (status === 'completed') {
    updates.completed_at = new Date().toISOString();
    if (req.user?.userId) updates.completed_by = req.user.userId;
  }

  const { data, error } = await supabase
    .from('practice_deadlines')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'practice_deadline', data.id, { module: 'practice', action_detail: `status: ${oldStatus} → ${status}` });
  await logDeadlineEvent(req.companyId, data.id, 'status_changed', {
    oldStatus,
    newStatus: status,
    note: event_note || null,
    actorUserId: req.user?.userId,
    metadata: { submission_reference: submission_reference || null }
  });

  res.json({ deadline: data });
});

// Soft-cancel (replaces hard delete — compliance records must not be physically destroyed)
router.delete('/deadlines/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('practice_deadlines')
    .select('id, status, is_active')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing) return res.status(404).json({ error: 'Deadline not found' });

  const updates = {
    is_active: false,
    status: 'cancelled',
    updated_at: new Date().toISOString()
  };
  if (req.user?.userId) updates.updated_by = req.user.userId;

  const { error } = await supabase
    .from('practice_deadlines')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'CANCEL', 'practice_deadline', parseInt(req.params.id), { module: 'practice' });
  await logDeadlineEvent(req.companyId, parseInt(req.params.id), 'cancelled', {
    oldStatus: existing.status,
    newStatus: 'cancelled',
    actorUserId: req.user?.userId
  });

  res.json({ success: true });
});

// ═══ SA WORKING-DAY HELPERS (server-side mirror of frontend deadline-utils.js) ═

function _easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}

const _saHolCache = {};
function _saHolidays(y) {
  if (_saHolCache[y]) return _saHolCache[y];
  const set = new Set();
  const p = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const add = d => { set.add(fmt(d)); if (d.getDay() === 0) { const m = new Date(d); m.setDate(d.getDate() + 1); set.add(fmt(m)); } };
  [[1,1],[3,21],[4,27],[5,1],[6,16],[8,9],[9,24],[12,16],[12,25],[12,26]].forEach(f => add(new Date(y, f[0] - 1, f[1])));
  const easter = _easterSunday(y);
  const goodFriday = new Date(easter); goodFriday.setDate(easter.getDate() - 2);
  const familyDay  = new Date(easter); familyDay.setDate(easter.getDate() + 1);
  add(goodFriday); add(familyDay);
  _saHolCache[y] = set;
  return set;
}

function _isWorkDay(d) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const p = n => String(n).padStart(2, '0');
  return !_saHolidays(d.getFullYear()).has(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
}

// month is 1-indexed; returns last working day of that month
function _lastWorkDay(year, month) {
  const d = new Date(year, month, 0);
  while (!_isWorkDay(d)) d.setDate(d.getDate() - 1);
  return d;
}

// month is 1-indexed; returns the working day on or before targetDay of that month
function _workDayOnOrBefore(year, month, targetDay) {
  const d = new Date(year, month - 1, targetDay);
  while (!_isWorkDay(d)) d.setDate(d.getDate() - 1);
  return d;
}

function _applyOffset(date, offsetDays) {
  const d = new Date(date);
  let remaining = Math.max(0, Math.round(offsetDays || 0));
  while (remaining > 0) { d.setDate(d.getDate() - 1); if (_isWorkDay(d)) remaining--; }
  return d;
}

function _isoDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ═══ DEADLINE SETTINGS ═══════════════════════════════════════════════════════

// Obligation types that support statutory deadline computation.
// label and statutory_rule are returned to the frontend for display.
const STATUTORY_OBLIGATION_DEFS = [
  { type: 'vat_return',         label: 'VAT Return (Monthly)',         statutory_rule: 'Last working day of the month following the tax period' },
  { type: 'paye',               label: 'PAYE / EMP201',                statutory_rule: '7th of the month following the payroll period (or last working day before)' },
  { type: 'uif',                label: 'UIF',                          statutory_rule: '7th of the month following the payroll period (or last working day before)' },
  { type: 'sdl',                label: 'SDL',                          statutory_rule: '7th of the month following the payroll period (or last working day before)' },
  { type: 'provisional_tax_p1', label: 'Provisional Tax — 1st Period', statutory_rule: 'Last working day of the 6th month of the tax year' },
  { type: 'provisional_tax_p2', label: 'Provisional Tax — 2nd Period', statutory_rule: 'Last working day of the last month of the tax year' },
  { type: 'tax_return',         label: 'Income Tax Return (ITR12)',     statutory_rule: '31 January of the year following the assessment year (eFiling)' },
];
const STATUTORY_TYPES = STATUTORY_OBLIGATION_DEFS.map(d => d.type);

router.get('/deadline-settings', async (req, res) => {
  const cid = req.companyId;
  const { data, error } = await supabase
    .from('practice_deadline_settings')
    .select('obligation_type, offset_days, notes')
    .eq('company_id', cid);
  if (error) return res.status(500).json({ error: error.message });

  const saved = {};
  (data || []).forEach(r => { saved[r.obligation_type] = r; });

  const settings = STATUTORY_OBLIGATION_DEFS.map(def => ({
    obligation_type: def.type,
    label:           def.label,
    statutory_rule:  def.statutory_rule,
    offset_days:     saved[def.type] ? saved[def.type].offset_days : 0,
    notes:           saved[def.type] ? saved[def.type].notes : null
  }));

  res.json({ settings });
});

router.put('/deadline-settings', async (req, res) => {
  const cid = req.companyId;
  const { settings } = req.body;
  if (!Array.isArray(settings) || !settings.length)
    return res.status(400).json({ error: 'settings must be a non-empty array' });

  const rows = settings
    .filter(s => STATUTORY_TYPES.includes(s.obligation_type) &&
                 typeof s.offset_days === 'number' && s.offset_days >= 0 && s.offset_days <= 30)
    .map(s => ({
      company_id:      cid,
      obligation_type: s.obligation_type,
      offset_days:     Math.round(s.offset_days),
      notes:           s.notes || null,
      updated_at:      new Date().toISOString()
    }));

  if (!rows.length) return res.status(400).json({ error: 'No valid settings provided' });

  const { error } = await supabase
    .from('practice_deadline_settings')
    .upsert(rows, { onConflict: 'company_id,obligation_type' });

  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'UPDATE', 'practice_deadline_settings', null, { module: 'practice', count: rows.length });
  res.json({ saved: rows.length });
});

// Auto-generate deadlines for all active clients for a given period, based on
// each client's compliance configuration (VAT sequence, PAYE/UIF/SDL registration).
// Skips any client+type combination that already has a deadline for that period_end.
router.post('/deadlines/generate', async (req, res) => {
  const cid = req.companyId;
  const { period, types } = req.body; // period = 'YYYY-MM'; types = ['vat','paye'] or omitted = all
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  }

  const [yearStr, monthStr] = period.split('-');
  const year  = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10); // 1-indexed
  const periodEndDate = new Date(year, month, 0); // last calendar day of selected month
  const periodEndStr  = _isoDate(periodEndDate);

  const { data: clients, error: cliErr } = await supabase
    .from('practice_clients')
    .select('id, name, vat_payment_sequence, vat_bi_monthly_parity, paye_registered, uif_registered, sdl_registered')
    .eq('company_id', cid)
    .eq('is_active', true);
  if (cliErr) return res.status(500).json({ error: cliErr.message });

  const { data: settingsData } = await supabase
    .from('practice_deadline_settings')
    .select('obligation_type, offset_days')
    .eq('company_id', cid);
  const offsets = {};
  (settingsData || []).forEach(s => { offsets[s.obligation_type] = s.offset_days || 0; });

  const { data: existing } = await supabase
    .from('practice_deadlines')
    .select('client_id, type')
    .eq('company_id', cid)
    .eq('period_end', periodEndStr)
    .eq('is_active', true);
  const existingKeys = new Set((existing || []).map(e => `${e.client_id}|${e.type}`));

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear  = month === 12 ? year + 1 : year;

  const includeVat  = !types || types.includes('vat');
  const includePaye = !types || types.includes('paye');

  const toCreate = [];

  for (const c of (clients || [])) {
    if (includeVat && c.vat_payment_sequence) {
      let fileThisMonth = false;
      if (c.vat_payment_sequence === 'monthly') {
        fileThisMonth = true;
      } else if (c.vat_payment_sequence === 'bi_monthly') {
        const parity = c.vat_bi_monthly_parity;
        if (parity === 'odd')  fileThisMonth = (month % 2 === 1);
        else if (parity === 'even') fileThisMonth = (month % 2 === 0);
        else fileThisMonth = true; // parity not yet configured — generate anyway, flag via title
      }
      // quarterly/annual VAT sequences are too client-specific to auto-generate safely — skipped

      if (fileThisMonth && !existingKeys.has(`${c.id}|vat_return`)) {
        const statutory = _lastWorkDay(nextYear, nextMonth);
        const due = _applyOffset(statutory, offsets['vat_return']);
        toCreate.push({
          company_id: cid, client_id: c.id,
          title: `VAT Return — ${c.name} (${period})`,
          type: 'vat_return', status: 'pending', priority: 'normal',
          period_end: periodEndStr, due_date: _isoDate(due), is_active: true
        });
      }
    }

    if (includePaye) {
      const statutory = _workDayOnOrBefore(nextYear, nextMonth, 7);

      if (c.paye_registered && !existingKeys.has(`${c.id}|paye`)) {
        toCreate.push({
          company_id: cid, client_id: c.id,
          title: `PAYE / EMP201 — ${c.name} (${period})`,
          type: 'paye', status: 'pending', priority: 'normal',
          period_end: periodEndStr, due_date: _isoDate(_applyOffset(statutory, offsets['paye'])), is_active: true
        });
      }
      if (c.uif_registered && !existingKeys.has(`${c.id}|uif`)) {
        toCreate.push({
          company_id: cid, client_id: c.id,
          title: `UIF — ${c.name} (${period})`,
          type: 'uif', status: 'pending', priority: 'normal',
          period_end: periodEndStr, due_date: _isoDate(_applyOffset(statutory, offsets['uif'])), is_active: true
        });
      }
      if (c.sdl_registered && !existingKeys.has(`${c.id}|sdl`)) {
        toCreate.push({
          company_id: cid, client_id: c.id,
          title: `SDL — ${c.name} (${period})`,
          type: 'sdl', status: 'pending', priority: 'normal',
          period_end: periodEndStr, due_date: _isoDate(_applyOffset(statutory, offsets['sdl'])), is_active: true
        });
      }
    }
  }

  let created = 0;
  if (toCreate.length) {
    const { data: inserted, error: insErr } = await supabase
      .from('practice_deadlines')
      .insert(toCreate)
      .select('id');
    if (insErr) return res.status(500).json({ error: insErr.message });
    created = inserted ? inserted.length : toCreate.length;
  }

  await auditFromReq(req, 'GENERATE', 'practice_deadlines', null, { module: 'practice', period, created, skipped: existingKeys.size });
  res.json({ created, skipped: existingKeys.size, period });
});

// ═══ COMPLIANCE CALENDAR ═════════════════════════════════════════════════════

// Calendar view — returns deadlines in a date range, enriched for calendar rendering
router.get('/compliance/calendar', async (req, res) => {
  const {
    start, end, client_id, compliance_area,
    deadline_type, status, responsible_team_member_id
  } = req.query;

  let q = supabase
    .from('practice_deadlines')
    .select('id, title, due_date, status, priority, compliance_area, deadline_type, type, client_id, responsible_team_member_id, practice_clients:client_id(name), practice_team_members!responsible_team_member_id(display_name)')
    .eq('company_id', req.companyId)
    .eq('is_active', true)
    .order('due_date', { ascending: true });

  if (start) q = q.gte('due_date', start);
  if (end) q = q.lte('due_date', end);
  if (client_id) q = q.eq('client_id', parseInt(client_id));
  if (compliance_area && COMPLIANCE_AREAS.includes(compliance_area)) q = q.eq('compliance_area', compliance_area);
  if (deadline_type) q = q.eq('deadline_type', deadline_type);
  if (status) q = q.eq('status', status);
  if (responsible_team_member_id) q = q.eq('responsible_team_member_id', parseInt(responsible_team_member_id));

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const today = new Date().toISOString().split('T')[0];
  const events = (data || []).map(d => ({
    id: d.id,
    title: d.title,
    client_name: d.practice_clients?.name || null,
    due_date: d.due_date,
    status: d.status,
    priority: d.priority,
    compliance_area: d.compliance_area,
    deadline_type: d.deadline_type || d.type,
    responsible_name: d.practice_team_members?.display_name || null,
    is_overdue: d.due_date < today && !['completed','submitted','cancelled'].includes(d.status)
  }));

  res.json({ events, total: events.length });
});

// ═══ COMPLIANCE RULES ════════════════════════════════════════════════════════

function sanitizeRuleBody(body) {
  const allowed = [
    'rule_name', 'compliance_area', 'deadline_type', 'client_type',
    'applies_when', 'due_day', 'due_month', 'due_offset_days', 'due_offset_basis',
    'recurrence_type', 'is_active', 'notes', 'settings'
  ];
  const out = {};
  for (const k of allowed) { if (k in body) out[k] = body[k]; }
  return out;
}

router.get('/compliance/rules', async (req, res) => {
  const { compliance_area, deadline_type, is_active = 'true' } = req.query;
  let q = supabase
    .from('practice_compliance_rules')
    .select('*')
    .eq('company_id', req.companyId)
    .order('compliance_area')
    .order('rule_name');

  if (is_active !== 'all') q = q.eq('is_active', is_active !== 'false');
  if (compliance_area) q = q.eq('compliance_area', compliance_area);
  if (deadline_type) q = q.eq('deadline_type', deadline_type);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rules: data || [], total: (data || []).length });
});

router.post('/compliance/rules', async (req, res) => {
  const body = sanitizeRuleBody(req.body);
  if (!body.rule_name) return res.status(400).json({ error: 'rule_name is required' });
  if (!body.compliance_area || !COMPLIANCE_AREAS.includes(body.compliance_area)) {
    return res.status(400).json({ error: `compliance_area must be one of: ${COMPLIANCE_AREAS.join(', ')}` });
  }
  if (!body.deadline_type || !DEADLINE_TYPE_EXTENDED.includes(body.deadline_type)) {
    return res.status(400).json({ error: `deadline_type must be one of: ${DEADLINE_TYPE_EXTENDED.join(', ')}` });
  }
  if (body.recurrence_type && !COMPLIANCE_RULE_RECURRENCES.includes(body.recurrence_type)) {
    return res.status(400).json({ error: `recurrence_type must be one of: ${COMPLIANCE_RULE_RECURRENCES.join(', ')}` });
  }
  if (body.due_offset_basis && !COMPLIANCE_RULE_OFFSET_BASIS.includes(body.due_offset_basis)) {
    return res.status(400).json({ error: `due_offset_basis must be one of: ${COMPLIANCE_RULE_OFFSET_BASIS.join(', ')}` });
  }

  body.company_id = req.companyId;
  if (req.user?.userId) body.created_by = req.user.userId;

  const { data, error } = await supabase
    .from('practice_compliance_rules')
    .insert(body)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'CREATE', 'practice_compliance_rule', data.id, { module: 'practice' });
  res.status(201).json({ rule: data });
});

router.put('/compliance/rules/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('practice_compliance_rules')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing) return res.status(404).json({ error: 'Compliance rule not found' });

  const body = sanitizeRuleBody(req.body);
  if (body.compliance_area && !COMPLIANCE_AREAS.includes(body.compliance_area)) {
    return res.status(400).json({ error: `compliance_area must be one of: ${COMPLIANCE_AREAS.join(', ')}` });
  }
  if (body.deadline_type && !DEADLINE_TYPE_EXTENDED.includes(body.deadline_type)) {
    return res.status(400).json({ error: `deadline_type must be one of: ${DEADLINE_TYPE_EXTENDED.join(', ')}` });
  }
  if (body.recurrence_type && !COMPLIANCE_RULE_RECURRENCES.includes(body.recurrence_type)) {
    return res.status(400).json({ error: `recurrence_type must be one of: ${COMPLIANCE_RULE_RECURRENCES.join(', ')}` });
  }

  body.updated_at = new Date().toISOString();
  if (req.user?.userId) body.updated_by = req.user.userId;

  const { data, error } = await supabase
    .from('practice_compliance_rules')
    .update(body)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'practice_compliance_rule', data.id, { module: 'practice' });
  res.json({ rule: data });
});

// Soft-deactivate only — compliance rules must not be hard-deleted
router.delete('/compliance/rules/:id', async (req, res) => {
  const { data: existing } = await supabase
    .from('practice_compliance_rules')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing) return res.status(404).json({ error: 'Compliance rule not found' });

  const updates = { is_active: false, updated_at: new Date().toISOString() };
  if (req.user?.userId) updates.updated_by = req.user.userId;

  const { error } = await supabase
    .from('practice_compliance_rules')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'DEACTIVATE', 'practice_compliance_rule', parseInt(req.params.id), { module: 'practice' });
  res.json({ success: true });
});

// ═══ COMPLIANCE SUGGESTIONS ══════════════════════════════════════════════════
//
// Inspects a client's compliance flags and returns suggested deadline items.
// Does NOT auto-create deadlines — the user must explicitly confirm each one.

router.get('/compliance/suggestions/client/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId);

  const { data: client, error: clientErr } = await supabase
    .from('practice_clients')
    .select('*')
    .eq('id', clientId)
    .eq('company_id', req.companyId)
    .single();
  if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });

  const suggestions = [];

  if (client.vat_registered) {
    suggestions.push({
      key: 'vat201',
      title: 'VAT201 Return',
      compliance_area: 'vat',
      deadline_type: 'vat201',
      type: 'vat_return',
      priority: 'high',
      reason: 'Client is VAT registered',
      suggested_recurrence: 'monthly',
      note: 'VAT201 is due by the 25th of the month following the tax period. Bi-monthly filers are due by the 25th of the month following the 2-month period.'
    });
  }

  if (client.paye_registered) {
    suggestions.push({
      key: 'emp201',
      title: 'EMP201 Monthly PAYE Return',
      compliance_area: 'paye',
      deadline_type: 'emp201',
      type: 'paye',
      priority: 'high',
      reason: 'Client is PAYE registered',
      suggested_recurrence: 'monthly',
      note: 'EMP201 is due by the 7th of the following month. Late payment attracts 10% penalty.'
    });
    suggestions.push({
      key: 'emp501',
      title: 'EMP501 Employer Reconciliation',
      compliance_area: 'emp501',
      deadline_type: 'emp501',
      type: 'paye',
      priority: 'high',
      reason: 'Client is PAYE registered — annual IRP5 reconciliation required',
      suggested_recurrence: 'biannual',
      note: 'Interim reconciliation due August/September. Annual reconciliation due May/June. Exact dates set by SARS each year.'
    });
  }

  if (client.provisional_taxpayer) {
    suggestions.push({
      key: 'irp6_p1',
      title: 'IRP6 First Provisional Tax Payment',
      compliance_area: 'provisional_tax',
      deadline_type: 'irp6',
      type: 'provisional_tax_p1',
      priority: 'high',
      reason: 'Client is a provisional taxpayer',
      suggested_recurrence: 'annual',
      note: 'First payment (P1) due 6 months into the tax year. Based on estimated taxable income.'
    });
    suggestions.push({
      key: 'irp6_p2',
      title: 'IRP6 Second Provisional Tax Payment',
      compliance_area: 'provisional_tax',
      deadline_type: 'irp6',
      type: 'provisional_tax_p2',
      priority: 'high',
      reason: 'Client is a provisional taxpayer',
      suggested_recurrence: 'annual',
      note: 'Second payment (P2) due at financial year end. Top-up (P3) due 6 months after year end where applicable.'
    });
  }

  if (client.client_type === 'individual') {
    suggestions.push({
      key: 'itr12',
      title: 'ITR12 Individual Income Tax Return',
      compliance_area: 'income_tax',
      deadline_type: 'itr12',
      type: 'tax_return',
      priority: 'normal',
      reason: 'Client is an individual taxpayer',
      suggested_recurrence: 'annual',
      note: 'Filing season dates announced annually by SARS. Typically July–November for non-provisional individuals.'
    });
  }

  if (['company','cc','trust','partnership'].includes(client.client_type)) {
    suggestions.push({
      key: 'itr14',
      title: 'ITR14 Company Income Tax Return',
      compliance_area: 'income_tax',
      deadline_type: 'itr14',
      type: 'tax_return',
      priority: 'normal',
      reason: `Client is a ${client.client_type}`,
      suggested_recurrence: 'annual',
      note: 'Due 12 months after financial year end (or as per SARS notice). Assessment issued after filing.'
    });
    suggestions.push({
      key: 'annual_financial_statements',
      title: 'Annual Financial Statements',
      compliance_area: 'annual_financials',
      deadline_type: 'annual_financial_statements',
      type: 'annual_financial',
      priority: 'normal',
      reason: `Client is a ${client.client_type} — AFS required`,
      suggested_recurrence: 'annual',
      note: client.financial_year_end_month
        ? `Financial year end: month ${client.financial_year_end_month}. AFS typically prepared within 6 months of year end.`
        : 'Set the client financial year end month on the client profile to refine this suggestion.'
    });
  }

  if (client.cipc_registered) {
    suggestions.push({
      key: 'cipc_annual_return',
      title: 'CIPC Annual Return',
      compliance_area: 'cipc',
      deadline_type: 'cipc_annual_return',
      type: 'cipc_annual_return',
      priority: 'high',
      reason: 'Client has CIPC annual return requirement',
      suggested_recurrence: 'annual',
      note: 'CIPC annual return due annually within the anniversary month of incorporation. Failure to file leads to deregistration.'
    });
  }

  // BO flag is a separate field — 'bo_required' not currently in schema, use cipc_registered as proxy
  // or add 'bo_required' to clients in a future migration. For now, suggest BO alongside CIPC.
  if (client.cipc_registered) {
    suggestions.push({
      key: 'beneficial_ownership',
      title: 'Beneficial Ownership Register',
      compliance_area: 'bo',
      deadline_type: 'beneficial_ownership',
      type: 'beneficial_ownership',
      priority: 'high',
      reason: 'CIPC-registered entities must maintain and file a Beneficial Ownership register',
      suggested_recurrence: 'annual',
      note: 'Required under the General Laws (Anti-Money Laundering and Combating Terrorism Financing) Amendment Act. Must be filed with CIPC.'
    });
  }

  if (client.uif_registered || client.paye_registered) {
    suggestions.push({
      key: 'payroll_month_end',
      title: 'Monthly Payroll Processing',
      compliance_area: 'payroll',
      deadline_type: 'payroll_month_end',
      type: 'paye',
      priority: 'normal',
      reason: 'Client has payroll obligations (PAYE/UIF registered)',
      suggested_recurrence: 'monthly',
      note: 'Monthly payroll must be processed, payslips issued, and EMP201 prepared before the 7th of the following month.'
    });
  }

  res.json({
    client_id: client.id,
    client_name: client.name,
    suggestions,
    total: suggestions.length
  });
});

// ─── Deadline Events (read-only — events are written internally) ──────────────
router.get('/deadlines/:id/events', async (req, res) => {
  const { data: deadline } = await supabase
    .from('practice_deadlines')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!deadline) return res.status(404).json({ error: 'Deadline not found' });

  const { data, error } = await supabase
    .from('practice_deadline_events')
    .select('*')
    .eq('deadline_id', req.params.id)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data || [] });
});

// Capacity Planning (Codebox 18)
router.use('/capacity', capacityRouter);

// Client Health Scoring (Codebox 19)
// Must mount BEFORE the generic /clients routes so /client-health/* is never
// ambiguously matched. (They are different path prefixes so there is no conflict,
// but mounting early is good hygiene.)
router.use('/client-health', clientHealthRouter);

// Reminder Center (Codebox 21)
router.use('/reminders', remindersRouter);

// Client Communication Log (Codebox 22)
router.use('/communications', communicationsRouter);

// Document Request Tracker (Codebox 23)
router.use('/document-requests', documentRequestsRouter);

// Compliance Pack Readiness Tracker (Codebox 24)
router.use('/compliance-packs', compliancePacksRouter);

// Taxpayer Profile Foundation (Codebox 25)
router.use('/taxpayer-profiles', taxpayerProfilesRouter);

// Provisional Tax Planning (Codebox 26)
router.use('/provisional-tax', provisionalTaxRouter);

// Individual Income Tax Data Capture (Codebox 27)
router.use('/individual-tax', individualTaxRouter);

// Individual Income Tax Draft Calculations (Codebox 28)
// Mounted at same /individual-tax path — Express tries individualTaxRouter first,
// then falls through to individualTaxCalcRouter for unmatched routes.
const individualTaxCalcRouter = require('./individual-tax-calculations');
router.use('/individual-tax', individualTaxCalcRouter);

// Individual Tax Review Pack + Draft PDF (Codebox 30)
// Mounted last — handles /review-packs/* routes not matched above.
router.use('/individual-tax', individualTaxReviewPacksRouter);

// Tax Year Configuration (Codebox 29)
router.use('/tax-configs', taxConfigRouter);

// Company Tax Data Capture Foundation (Codebox 31)
router.use('/company-tax', companyTaxRouter);

// Company Tax Draft Calculation Engine (Codebox 32)
// Mounted at same /company-tax path — Express tries companyTaxRouter first,
// then falls through to companyTaxCalcRouter for unmatched routes.
const companyTaxCalcRouter = require('./company-tax-calculations');
router.use('/company-tax', companyTaxCalcRouter);

// Company Tax Review Pack + Draft PDF (Codebox 33)
// Mounted last — handles /review-packs/* routes not matched above.
const companyTaxReviewPacksRouter = require('./company-tax-review-packs');
router.use('/company-tax', companyTaxReviewPacksRouter);

// Tax Dashboard: Tax Season Command Center (Codebox 34)
// Aggregates individual/company/provisional tax data into 5 read-only endpoints.
const taxDashboardRouter = require('./tax-dashboard');
router.use('/tax-dashboard', taxDashboardRouter);

// Tax Work Actions + Review Queue (Codebox 35)
// Follow-up action tracking, review queue controls, action execution helpers.
const taxActionsRouter = require('./tax-actions');
router.use('/tax-actions', taxActionsRouter);

// Tax Checklist Templates (Codebox 36)
// Reusable tax document checklist templates with controlled apply.
const taxChecklistsRouter = require('./tax-checklists');
router.use('/tax-checklists', taxChecklistsRouter);

// Tax Bulk Operations (Codebox 37)
// User-triggered bulk preparation for tax season.
const taxBulkOperationsRouter = require('./tax-bulk-operations');
router.use('/tax-bulk-operations', taxBulkOperationsRouter);

// Tax Season Progress Reports (Codebox 38)
// Read-only reporting: progress, status, documents, reviews, partner summary, risk.
const taxReportsRouter = require('./tax-reports');
router.use('/tax-reports', taxReportsRouter);

// Tax Filing Pipeline (Codebox 40)
// Unified filing lifecycle across individual/company returns + provisional plans.
const taxPipelineRouter = require('./tax-pipeline');
router.use('/tax-pipeline', taxPipelineRouter);

// Tax Submission Register (Codebox 41)
// Manual submission register + evidence tracking across all tax entity types.
const taxSubmissionsRouter = require('./tax-submissions');
router.use('/tax-submissions', taxSubmissionsRouter);

// Tax Payment Tracking (Codebox 42)
// Manual payment register linked to Tax Submissions. No SARS integration,
// no bank reconciliation, no auto-import — everything is manually captured.
const taxPaymentsRouter = require('./tax-payments');
router.use('/tax-payments', taxPaymentsRouter);

// SARS Statement Reconciliation (Codebox 43)
// Manual statement-line register and reconciliation against the payment ledger.
// No SARS API. No bank feed. No automatic import.
const sarsReconRouter = require('./sars-statement-recon');
router.use('/sars-recon', sarsReconRouter);

// Tax Dispute / Correction / Objection Tracker (Codebox 44)
// Manual internal tracking for corrections, objections, NOO, ADR, Tax Court escalation.
// No SARS API. No eFiling integration. All data manually entered by practice staff.
const taxDisputesRouter = require('./tax-disputes');
router.use('/tax-disputes', taxDisputesRouter);

// Tax Compliance Finalization + Completion Evidence Pack (Codebox 45)
// Internal quality-control and partner sign-off gate before a tax matter is complete.
// Enforces checklist completion, payment status, SARS recon parity, and open dispute checks.
const taxCompletionRouter = require('./tax-completion');
router.use('/tax-completion', taxCompletionRouter);

// Practice Knowledge Base + Technical Opinion Library (Codebox 46)
// Human-controlled knowledge library: SARS interpretations, internal policies,
// technical opinions, SOPs, working paper notes. NOT AI-generated. NOT Sean AI.
const knowledgeBaseRouter = require('./knowledge-base');
router.use('/knowledge', knowledgeBaseRouter);

// Practice SOP Templates + Workflow Instruction Library (Codebox 47)
// The practice's operational instruction manual — HOW work must be performed.
// NOT AI. NOT document management. NOT workflow execution.
const practiceSopRouter = require('./practice-sop');
router.use('/sop', practiceSopRouter);

// Practice Quality Management System — QMS (Codebox 48)
// Quality reviews, non-conformance findings, and CAPA tracking.
// NOT AI. NOT a disciplinary workflow. NOT Sean AI.
const qualityManagementRouter = require('./quality-management');
router.use('/qms', qualityManagementRouter);

// Practice Risk Register + Internal Control Matrix (Codebox 49)
// Internal practice governance — risks, controls, periodic reviews.
// NOT enterprise risk software.
const riskRegisterRouter = require('./risk-register');
router.use('/risk-register', riskRegisterRouter);

// Practice Alert Rules Engine + Manual Alert Configuration (Codebox 53)
// Central, database-driven thresholds consumed by management-dashboard.js
// via getRule()/getRules(). NOT AI. NOT automatic threshold tuning.
const alertRulesRouter = require('./alert-rules');
router.use('/alert-rules', alertRulesRouter);

// Practice Notification Centre + Internal Notification Routing (Codebox 54)
// Assigned, actionable internal inbox. NOT email/SMS/push/Teams/Sean AI.
const notificationsRouter = require('./notifications');
router.use('/notifications', notificationsRouter);

// Practice Work Queue + Personal Work Hub (Codebox 55)
// "What must I work on next?" — live-aggregated, deterministic, per team
// member. NOT AI. NOT auto-assignment. Aggregates, never replaces, source modules.
const workQueueRouter = require('./work-queue');
router.use('/work-queue', workQueueRouter);

// Practice Planning Board + Weekly Planning Centre (Codebox 56)
// Manager workload/planning view — reuses capacity.js + work-queue.js
// in-process. NOT AI. NOT automatic task movement. NOT automatic balancing.
const planningBoardRouter = require('./planning-board');
router.use('/planning-board', planningBoardRouter);

// Practice Resource Forecasting + Future Capacity Planning (Codebox 57)
// Deterministic forward-looking capacity projection — reuses capacity.js +
// planning-board.js in-process. NOT AI. NOT automatic scheduling.
const resourceForecastingRouter = require('./resource-forecasting');
router.use('/resource-forecasting', resourceForecastingRouter);

// Practice Delegation + Work Reassignment Controls (Codebox 58)
// Auditable, reversible ownership transfer via changeOwnership() — reuses
// notifications.js + work-queue.js + planning-board.js in-process.
// NOT AI. NOT automatic reassignment.
const delegationRouter = require('./delegation');
router.use('/delegation', delegationRouter);

// Practice Skills Matrix + Competency Framework (Codebox 59)
// Manager-controlled skill/competency/certification tracking. Advisory
// only — getCompetency() is exported for Delegation/Planning
// Board/Resource Forecast to reuse. NOT AI. NOT auto-delegation.
const skillsMatrixRouter = require('./skills-matrix');
router.use('/skills-matrix', skillsMatrixRouter);

// Practice Learning, Development & Training Centre (Codebox 60)
// Manager-controlled development plans, goals, activities, CPD tracking.
// Complements the Skills Matrix. NOT AI coaching. NOT an LMS.
const learningCentreRouter = require('./learning-centre');
router.use('/learning-centre', learningCentreRouter);

// Practice Client Success & Relationship Management (Codebox 61)
// Relationship health, success activities, opportunities, contacts,
// communication cadence, meeting history. NOT a CRM/sales pipeline.
const clientSuccessRouter = require('./client-success');
router.use('/client-success', clientSuccessRouter);

// Practice Secretarial Foundation (Codebox 62)
// Corporate profile, director/shareholder registers, annual returns, timeline.
// NOT CIPC API integration. NOT statutory change workflows (Codebox 63).
const secretarialRouter = require('./secretarial');
router.use('/secretarial', secretarialRouter);

// Practice Secretarial Workflows + Statutory Change Management (Codebox 63)
// Controlled change cases (approval, checklist, effective date) — the only
// path that mutates the Codebox 62 registers. NOT CIPC API. NOT auto-filing.
const secretarialWorkflowsRouter = require('./secretarial-workflows');
router.use('/secretarial-workflows', secretarialWorkflowsRouter);

// Secretarial Resolutions + Minutes Register Foundation (Codebox 64)
// Governance evidence — resolutions, meetings, attendees, decisions —
// optionally linked to Codebox 63 statutory change cases. NOT PDF
// generation. NOT e-signature. NOT CIPC submission.
const secretarialGovernanceRouter = require('./secretarial-governance');
router.use('/secretarial-governance', secretarialGovernanceRouter);

// Secretarial Beneficial Ownership + Ownership Chain Foundation (Codebox 65)
// Beneficial owner register, ownership chains, BO readiness tracking.
// NOT CIPC API. NOT automatic filing. NOT legal advice.
const beneficialOwnershipRouter = require('./beneficial-ownership');
router.use('/beneficial-ownership', beneficialOwnershipRouter);

// Secretarial Document Checklist + Governance Evidence Requests (Codebox 66)
// Evidence templates/checklists/items linking to existing Document Requests.
// NOT document storage. NOT file uploads. NEVER a duplicate document system.
const secretarialEvidenceRouter = require('./secretarial-evidence');
router.use('/secretarial-evidence', secretarialEvidenceRouter);

// Secretarial Statutory Calendar + Compliance Scheduler (Codebox 67)
// Statutory obligation register, recurrence, deadline synchronisation.
// NOT another Deadlines module — links to practice_deadlines, never duplicates.
const secretarialCalendarRouter = require('./secretarial-calendar');
router.use('/secretarial-calendar', secretarialCalendarRouter);

// Practice Secretarial Entity Lifecycle Management (Codebox 68)
// Lifecycle profile, controlled stage transitions, checklists. NOT CIPC API.
// NOT automatic deregistration/restoration/liquidation. Manual control only.
const entityLifecycleRouter = require('./entity-lifecycle');
router.use('/entity-lifecycle', entityLifecycleRouter);

// Secretarial Register Integrity Audit + Statutory Data Quality Review (Codebox 69)
// Detects, classifies, and reports data-quality issues across the Secretarial
// suite. NOT data correction. NOT automatic repair. NOT CIPC validation.
const secretarialIntegrityRouter = require('./secretarial-integrity');
router.use('/secretarial-integrity', secretarialIntegrityRouter);

// Practice Client Onboarding + Entity Formation Foundation (Codebox 70)
// Onboarding workspace over an existing client — initializes the Secretarial
// suite's per-client profiles. NOT CIPC incorporation. NOT SARS registration.
// NOT banking integration. NOT a client portal.
const clientOnboardingRouter = require('./client-onboarding');
router.use('/client-onboarding', clientOnboardingRouter);

// Practice Engagement Management + Engagement Letter Foundation (Codebox 71)
// ENHANCEMENT LAYER over the existing engagements.js/engagement-periods.js
// (Codebox 15/16) — mounted at its OWN dedicated prefix (not root '/') so it
// never collides with those routers' existing /engagements/:id path space.
// NOT document generation. NOT e-signature. NOT automatic proposal acceptance.
const engagementManagementRouter = require('./engagement-management');
router.use('/engagement-management', engagementManagementRouter);

// Practice Engagement Scope Control + Work Authorization Gate (Codebox 72)
// "Are we allowed to do this work under the current engagement?" Warns and
// records — never hard-blocks. NOT legal advice. NOT billing automation.
const workAuthorizationRouter = require('./work-authorization');
router.use('/work-authorization', workAuthorizationRouter);

// Practice Client Profitability + Service Margin Foundation (Codebox 73)
// "Where are we making or losing money?" Analyzes existing Time/Billing/
// Engagement data — NOT accounting, NOT a ledger, NOT invoicing automation.
const profitabilityRouter = require('./profitability');
router.use('/profitability', profitabilityRouter);

// Practice Pricing Review + Fee Adjustment Workflow (Codebox 74)
// Governs the DECISION to change a fee/scope — never modifies invoices,
// accounting, billing, or engagements itself. Never recommends a specific
// fee amount. "Implemented" means the commercial decision was accepted;
// a future codebox may consume that to actually update an engagement.
const pricingReviewRouter = require('./pricing-review');
router.use('/pricing-review', pricingReviewRouter);

// Practice Partner Performance + Practice Scorecards (Codebox 75)
// Executive operational reporting — aggregates existing KPIs (Profitability,
// Quality, Risk, Capacity, Client Success, Engagement, Learning, Planning,
// Notifications) into partner/manager/team/practice scorecards. NOT HR.
// NOT payroll performance. NOT employee ranking. NOT disciplinary management.
const partnerScorecardsRouter = require('./partner-scorecards');
router.use('/partner-scorecards', partnerScorecardsRouter);

// Practice Strategic Planning + Objectives Management (Codebox 76)
// "Where are we going?" NOT project management. NOT task management. NOT HR
// performance. Strategic objectives/initiatives/KPI links reference (never
// duplicate) the KPI engines already built above.
const strategicPlanningRouter = require('./strategic-planning');
router.use('/strategic-planning', strategicPlanningRouter);

// Management Dashboard — Executive Command Centre (Codebox 50)
// Read-only aggregator for partners. NOT an operational page.
const managementDashboardRouter = require('./management-dashboard');
router.use('/management-dashboard', managementDashboardRouter);

// Practice KPI Engine + Historical Trend Analytics (Codebox 51)
// Deterministic KPI history — snapshots of the Management Dashboard over time.
// NOT AI. NOT forecasting. NOT predictive analytics.
const kpiHistoryRouter = require('./kpi-history');
router.use('/kpi-history', kpiHistoryRouter);

// Practice Partner Monthly Review Pack (Codebox 52)
// Deterministic management reporting and partner sign-off, built from the
// Management Dashboard and KPI History. NOT AI. NOT forecasting.
const partnerReviewPacksRouter = require('./partner-review-packs');
router.use('/partner-review-packs', partnerReviewPacksRouter);

// Practice Executive Reporting + Board Pack Foundation (Codebox 77)
// "What decisions do we need to make today?" NOT Business Intelligence. NOT
// Power BI. NOT AI reporting. Assembles existing engines into a frozen,
// approvable board pack — never a duplicate KPI/scoring engine.
const executiveReportingRouter = require('./executive-reporting');
router.use('/executive-reporting', executiveReportingRouter);

// Practice Automation Foundation + Workflow Orchestration (Codebox 78)
// The nervous system of Practice Management — safe, deterministic,
// manager-controlled rules. NOT AI. NOT autonomous decision making. Manual
// test-run/run-now execution only; no existing module is wired to
// auto-fire a trigger yet (see automation.js's own scope note).
const automationRouter = require('./automation');
router.use('/automation', automationRouter);

// Practice Operational Health Centre + System Readiness Monitor (Codebox 79)
// "Is the platform ready?" Read-only monitor over every other Practice
// module — never mutates anything outside its own two tables.
const operationalHealthRouter = require('./operational-health');
router.use('/operational-health', operationalHealthRouter);

// Dashboard: operational command centre sub-routes (summary, workload, risk, activity)
// Mounted before the inline /dashboard GET so /dashboard/summary is matched here.
router.use('/dashboard', dashboardRouter);

// Workflows: templates, runs, and generation
router.use('/workflows', workflowsRouter);

// Billing: WIP management and billing pack preparation
router.use('/billing', billingRouter);

// Engagement period queue (Codebox 16)
router.use('/', engagementPeriodsRouter);

// Service Catalog + Client Engagements
// Must be mounted after engagementPeriodsRouter so the period sub-routes on
// /engagements/:id/periods/* are matched by engagementPeriodsRouter first.
router.use('/', engagementsRouter);

module.exports = router;
