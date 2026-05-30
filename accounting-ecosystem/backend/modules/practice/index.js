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

const router = express.Router();

// Enum constants — must match DB CHECK constraints (see migration 011)
const TASK_TYPES = [
  'general','vat_return','tax_return','annual_financial','management_accounts',
  'payroll','audit','bookkeeping','secretarial','other'
];
const DEADLINE_TYPES = [
  'general','vat_return','tax_return','paye','uif','sdl',
  'annual_financial','provisional_tax_p1','provisional_tax_p2',
  'provisional_tax_top_up','cipc_annual_return','beneficial_ownership','other'
];
const DEADLINE_STATUSES = ['pending','submitted','completed','missed'];

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

router.get('/tasks', async (req, res) => {
  const { client_id, status, assigned_to, type, due_before, due_after } = req.query;
  let q = supabase
    .from('practice_tasks')
    .select('*, practice_clients:client_id(name)')
    .eq('company_id', req.companyId)
    .order('due_date', { ascending: true, nullsFirst: false });

  if (client_id) q = q.eq('client_id', parseInt(client_id));
  if (status) q = q.eq('status', status);
  if (assigned_to) q = q.eq('assigned_to', parseInt(assigned_to));
  if (type) q = q.eq('type', type);
  if (due_before) q = q.lte('due_date', due_before);
  if (due_after) q = q.gte('due_date', due_after);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: data || [], total: (data || []).length });
});

router.get('/tasks/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('practice_tasks')
    .select('*, practice_clients:client_id(name)')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Task not found' });
  res.json({ task: data });
});

router.post('/tasks', async (req, res) => {
  const { client_id, title, description, type, priority, due_date, assigned_to, notes } = req.body;
  if (!title) return res.status(400).json({ error: 'Task title is required' });
  const resolvedType = type || 'general';
  if (!TASK_TYPES.includes(resolvedType)) {
    return res.status(400).json({ error: `Invalid task type. Must be one of: ${TASK_TYPES.join(', ')}` });
  }
  const { data, error } = await supabase
    .from('practice_tasks')
    .insert({
      company_id: req.companyId,
      client_id: client_id ? parseInt(client_id) : null,
      title, description: description || null,
      type: resolvedType,
      priority: priority || 'medium',
      due_date: due_date || null,
      assigned_to: assigned_to ? parseInt(assigned_to) : null,
      notes: notes || null,
      status: 'open',
      created_by: req.user.userId
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'practice_task', data.id, { module: 'practice' });
  res.status(201).json({ task: data });
});

router.put('/tasks/:id', async (req, res) => {
  if (req.body.type !== undefined && !TASK_TYPES.includes(req.body.type)) {
    return res.status(400).json({ error: `Invalid task type. Must be one of: ${TASK_TYPES.join(', ')}` });
  }
  const allowed = ['title', 'description', 'type', 'priority', 'status', 'due_date', 'assigned_to', 'notes', 'client_id'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (updates.client_id !== undefined) updates.client_id = updates.client_id ? parseInt(updates.client_id) : null;
  if (updates.assigned_to !== undefined) updates.assigned_to = updates.assigned_to ? parseInt(updates.assigned_to) : null;
  if (req.body.status === 'completed' && !updates.completed_at) {
    updates.completed_at = new Date().toISOString();
  }
  const { data, error } = await supabase
    .from('practice_tasks')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ task: data });
});

router.delete('/tasks/:id', async (req, res) => {
  const { error } = await supabase
    .from('practice_tasks')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ═══ TIME ENTRIES ═════════════════════════════════════════════════════════════

router.get('/time-entries', async (req, res) => {
  const { client_id, task_id, user_id, date_from, date_to } = req.query;
  let q = supabase
    .from('practice_time_entries')
    .select('*, practice_clients:client_id(name), practice_tasks:task_id(title)')
    .eq('company_id', req.companyId)
    .order('date', { ascending: false });

  if (client_id) q = q.eq('client_id', parseInt(client_id));
  if (task_id) q = q.eq('task_id', parseInt(task_id));
  if (user_id) q = q.eq('user_id', parseInt(user_id));
  if (date_from) q = q.gte('date', date_from);
  if (date_to) q = q.lte('date', date_to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const totalHours = (data || []).reduce((s, r) => s + (r.hours || 0), 0);
  res.json({ time_entries: data || [], total_hours: Math.round(totalHours * 100) / 100 });
});

router.post('/time-entries', async (req, res) => {
  const { client_id, task_id, hours, description, date, billable, rate } = req.body;
  if (!hours || !date) return res.status(400).json({ error: 'hours and date are required' });
  const { data, error } = await supabase
    .from('practice_time_entries')
    .insert({
      company_id: req.companyId,
      user_id: req.user.userId,
      client_id: client_id ? parseInt(client_id) : null,
      task_id: task_id ? parseInt(task_id) : null,
      hours: parseFloat(hours),
      description: description || null,
      date,
      billable: billable !== false,
      rate: rate ? parseFloat(rate) : null
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ time_entry: data });
});

router.put('/time-entries/:id', async (req, res) => {
  const allowed = ['hours', 'description', 'date', 'billable', 'rate', 'client_id', 'task_id'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabase
    .from('practice_time_entries')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ time_entry: data });
});

router.delete('/time-entries/:id', async (req, res) => {
  const { error } = await supabase
    .from('practice_time_entries')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ═══ DEADLINES ═══════════════════════════════════════════════════════════════

router.get('/deadlines', async (req, res) => {
  const { client_id, status, date_from, date_to } = req.query;
  let q = supabase
    .from('practice_deadlines')
    .select('*, practice_clients:client_id(name)')
    .eq('company_id', req.companyId)
    .order('due_date', { ascending: true });

  if (client_id) q = q.eq('client_id', parseInt(client_id));
  if (status) q = q.eq('status', status);
  if (date_from) q = q.gte('due_date', date_from);
  if (date_to) q = q.lte('due_date', date_to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deadlines: data || [] });
});

router.post('/deadlines', async (req, res) => {
  const { client_id, title, type, due_date, notes } = req.body;
  if (!title || !due_date) return res.status(400).json({ error: 'title and due_date are required' });
  const resolvedType = type || 'general';
  if (!DEADLINE_TYPES.includes(resolvedType)) {
    return res.status(400).json({ error: `Invalid deadline type. Must be one of: ${DEADLINE_TYPES.join(', ')}` });
  }
  const { data, error } = await supabase
    .from('practice_deadlines')
    .insert({
      company_id: req.companyId,
      client_id: client_id ? parseInt(client_id) : null,
      title, type: resolvedType,
      due_date, notes: notes || null,
      status: 'pending'
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ deadline: data });
});

router.put('/deadlines/:id', async (req, res) => {
  if (req.body.type !== undefined && !DEADLINE_TYPES.includes(req.body.type)) {
    return res.status(400).json({ error: `Invalid deadline type. Must be one of: ${DEADLINE_TYPES.join(', ')}` });
  }
  if (req.body.status !== undefined && !DEADLINE_STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: `Invalid deadline status. Must be one of: ${DEADLINE_STATUSES.join(', ')}` });
  }
  const allowed = ['title', 'type', 'due_date', 'notes', 'status', 'client_id'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (updates.client_id !== undefined) updates.client_id = updates.client_id ? parseInt(updates.client_id) : null;
  if (req.body.status === 'submitted' && !updates.submitted_at) {
    updates.submitted_at = new Date().toISOString();
  }
  const { data, error } = await supabase
    .from('practice_deadlines')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deadline: data });
});

router.delete('/deadlines/:id', async (req, res) => {
  const { error } = await supabase
    .from('practice_deadlines')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'DELETE', 'practice_deadline', req.params.id, { module: 'practice' });
  res.json({ success: true });
});

// Workflows: templates, runs, and generation
router.use('/workflows', workflowsRouter);

module.exports = router;
