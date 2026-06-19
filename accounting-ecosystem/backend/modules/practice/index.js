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
const workflowsRouter = require('./workflows');
const billingRouter   = require('./billing');

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
      (c.registration_number && c.registration_number.toLowerCase().includes(s))
    );
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
  res.json({ client: data });
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

  const { data, error } = await supabase.from('practice_clients').insert(body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'practice_client', data.id, { module: 'practice' });
  res.status(201).json({ client: data });
});

router.put('/clients/:id', async (req, res) => {
  const existing = await supabase
    .from('practice_clients')
    .select('id')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (!existing.data) return res.status(404).json({ error: 'Client not found' });

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
    review_required, approval_required
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
    'review_required', 'approval_required', 'review_notes', 'approval_notes'
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

// Workflows: templates, runs, and generation
router.use('/workflows', workflowsRouter);

// Billing: WIP management and billing pack preparation
router.use('/billing', billingRouter);

module.exports = router;
