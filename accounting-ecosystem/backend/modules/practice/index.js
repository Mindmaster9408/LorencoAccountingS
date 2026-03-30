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

const router = express.Router();

// ─── Health ──────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({ module: 'practice', status: 'active', version: '1.0.0' });
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

// ═══ PRACTICE CLIENTS ════════════════════════════════════════════════════════

router.get('/clients', async (req, res) => {
  const { search, is_active = 'true' } = req.query;
  let q = supabase
    .from('practice_clients')
    .select('*')
    .eq('company_id', req.companyId)
    .order('name');
  if (is_active !== 'all') q = q.eq('is_active', is_active === 'true');

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  let results = data || [];
  if (search) {
    const s = search.toLowerCase();
    results = results.filter(c =>
      (c.name && c.name.toLowerCase().includes(s)) ||
      (c.email && c.email.toLowerCase().includes(s))
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
  const { name, email, phone, industry, vat_number, registration_number, fiscal_year_end, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const { data, error } = await supabase
    .from('practice_clients')
    .insert({
      company_id: req.companyId, name,
      email: email || null, phone: phone || null,
      industry: industry || null, vat_number: vat_number || null,
      registration_number: registration_number || null,
      fiscal_year_end: fiscal_year_end || null,
      address: address || null, notes: notes || null,
      is_active: true
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await auditFromReq(req, 'CREATE', 'practice_client', data.id, { module: 'practice' });
  res.status(201).json({ client: data });
});

router.put('/clients/:id', async (req, res) => {
  const allowed = ['name', 'email', 'phone', 'industry', 'vat_number', 'registration_number', 'fiscal_year_end', 'address', 'notes', 'is_active'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabase
    .from('practice_clients')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ client: data });
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
  const { data, error } = await supabase
    .from('practice_tasks')
    .insert({
      company_id: req.companyId,
      client_id: client_id ? parseInt(client_id) : null,
      title, description: description || null,
      type: type || 'general',
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
  const allowed = ['title', 'description', 'type', 'priority', 'status', 'due_date', 'assigned_to', 'notes', 'client_id'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
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
  const { data, error } = await supabase
    .from('practice_deadlines')
    .insert({
      company_id: req.companyId,
      client_id: client_id ? parseInt(client_id) : null,
      title, type: type || 'general',
      due_date, notes: notes || null,
      status: 'pending'
    })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ deadline: data });
});

router.put('/deadlines/:id', async (req, res) => {
  const allowed = ['title', 'type', 'due_date', 'notes', 'status', 'client_id'];
  const updates = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabase
    .from('practice_deadlines')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deadline: data });
});

module.exports = router;
