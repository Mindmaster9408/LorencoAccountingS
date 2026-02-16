/**
 * ============================================================================
 * Ecosystem Client Routes — Supabase
 * ============================================================================
 * CRUD for cross-app ecosystem clients (eco_clients table).
 * When a client is created with selected apps, this route automatically
 * syncs the client to the relevant app tables (customers, employees, etc.).
 * All routes are prefixed with /api/eco-clients and require authentication.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../config/database');
const { auditFromReq } = require('../../middleware/audit');

const router = express.Router();

// ─── Cross-App Sync Helper ──────────────────────────────────────────────────

/**
 * Sync an eco_client to the selected app tables.
 * Returns { synced: [...], errors: [...] }
 */
async function syncToApps(ecoClient) {
  const synced = [];
  const errors = [];
  const apps = ecoClient.apps || [];

  // POS → customers table
  if (apps.includes('pos')) {
    try {
      const customerNumber = `EC-${Date.now().toString(36).toUpperCase()}`;
      const customerData = {
        company_id: ecoClient.company_id,
        name: ecoClient.name,
        email: ecoClient.email || null,
        phone: ecoClient.phone || null,
        contact_number: ecoClient.phone || null,
        address_line_1: ecoClient.address || null,
        id_number: ecoClient.id_number || null,
        customer_number: customerNumber,
        customer_group: 'retail',
        loyalty_points: 0,
        current_balance: 0,
        is_active: true,
        eco_client_id: ecoClient.id
      };

      let { data: customer, error } = await supabase
        .from('customers')
        .insert(customerData)
        .select()
        .single();

      // If eco_client_id column doesn't exist yet, retry without it
      if (error && error.message && error.message.includes('eco_client_id')) {
        delete customerData.eco_client_id;
        ({ data: customer, error } = await supabase
          .from('customers')
          .insert(customerData)
          .select()
          .single());
      }

      if (error) throw error;
      synced.push({ app: 'pos', table: 'customers', id: customer.id });
    } catch (err) {
      console.error('Eco-client sync to POS failed:', err.message);
      errors.push({ app: 'pos', error: err.message });
    }
  }

  // Payroll → employees table
  if (apps.includes('payroll')) {
    try {
      const empCode = `EMP-${Date.now().toString(36).toUpperCase()}`;
      const nameParts = (ecoClient.name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || ecoClient.name;
      const lastName = nameParts.slice(1).join(' ') || '';

      const employeeData = {
        company_id: ecoClient.company_id,
        full_name: ecoClient.name,
        first_name: firstName,
        last_name: lastName,
        employee_code: empCode,
        email: ecoClient.email || null,
        phone: ecoClient.phone || null,
        id_number: ecoClient.id_number || null,
        is_active: true,
        eco_client_id: ecoClient.id
      };

      let { data: employee, error } = await supabase
        .from('employees')
        .insert(employeeData)
        .select()
        .single();

      // If eco_client_id column doesn't exist yet, retry without it
      if (error && error.message && error.message.includes('eco_client_id')) {
        delete employeeData.eco_client_id;
        ({ data: employee, error } = await supabase
          .from('employees')
          .insert(employeeData)
          .select()
          .single());
      }

      if (error) throw error;
      synced.push({ app: 'payroll', table: 'employees', id: employee.id });
    } catch (err) {
      console.error('Eco-client sync to Payroll failed:', err.message);
      errors.push({ app: 'payroll', error: err.message });
    }
  }

  // Accounting — uses same employees table, no separate client table
  if (apps.includes('accounting')) {
    synced.push({ app: 'accounting', note: 'Linked via ecosystem' });
  }

  // SEAN — AI module, no client table
  if (apps.includes('sean')) {
    synced.push({ app: 'sean', note: 'Linked via ecosystem' });
  }

  return { synced, errors };
}

/**
 * GET /api/eco-clients
 * List all clients for user's companies (super_admin sees all)
 */
router.get('/', async (req, res) => {
  try {
    const { company_id, app, search, client_type } = req.query;

    let q = supabase
      .from('eco_clients')
      .select('*')
      .eq('is_active', true)
      .order('name');

    if (company_id) {
      q = q.eq('company_id', parseInt(company_id));
    } else if (!req.user.isSuperAdmin) {
      q = q.eq('company_id', req.companyId);
    }

    if (client_type) {
      q = q.eq('client_type', client_type);
    }

    const { data: results, error } = await q;

    if (error) {
      console.error('eco-clients list error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch clients' });
    }

    let filtered = results || [];

    // Filter by app (apps is a jsonb array)
    if (app) {
      filtered = filtered.filter(c => Array.isArray(c.apps) && c.apps.includes(app));
    }

    // Search by name, email, or id_number
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(c =>
        (c.name && c.name.toLowerCase().includes(s)) ||
        (c.email && c.email.toLowerCase().includes(s)) ||
        (c.id_number && c.id_number.includes(s))
      );
    }

    res.json({ clients: filtered, total: filtered.length });
  } catch (err) {
    console.error('eco-clients GET / error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/eco-clients/:id
 * Get a single client
 */
router.get('/:id', async (req, res) => {
  try {
    const { data: client, error } = await supabase
      .from('eco_clients')
      .select('*')
      .eq('id', parseInt(req.params.id))
      .single();

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Fetch company name
    const { data: company } = await supabase
      .from('companies')
      .select('company_name, trading_name')
      .eq('id', client.company_id)
      .single();

    res.json({
      ...client,
      company_name: company ? (company.trading_name || company.company_name) : 'Unknown'
    });
  } catch (err) {
    console.error('eco-clients GET /:id error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/eco-clients
 * Create a new ecosystem client and sync to selected apps
 */
router.post('/', async (req, res) => {
  try {
    const { name, email, phone, id_number, address, client_type, apps, company_id, notes } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Client name is required' });
    }

    const newClient = {
      company_id: company_id || req.companyId,
      name,
      email: email || null,
      phone: phone || null,
      id_number: id_number || null,
      address: address || null,
      client_type: client_type || 'business',
      apps: apps || [],
      notes: notes || null,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: inserted, error } = await supabase
      .from('eco_clients')
      .insert(newClient)
      .select()
      .single();

    if (error) {
      console.error('eco-clients create error:', error.message);
      return res.status(500).json({ error: 'Failed to create client: ' + error.message });
    }

    // Sync to selected apps (POS → customers, Payroll → employees, etc.)
    const syncResult = await syncToApps(inserted);

    await auditFromReq(req, 'CREATE', 'eco_client', inserted.id, {
      module: 'ecosystem',
      metadata: { apps: inserted.apps, synced: syncResult.synced, syncErrors: syncResult.errors }
    });

    res.status(201).json({
      ...inserted,
      sync: syncResult
    });
  } catch (err) {
    console.error('eco-clients POST / error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/eco-clients/:id
 * Update a client
 */
router.put('/:id', async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);

    // Fetch current version for audit
    const { data: old, error: fetchError } = await supabase
      .from('eco_clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (fetchError || !old) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const allowed = ['name', 'email', 'phone', 'id_number', 'address', 'client_type', 'apps', 'notes', 'is_active'];
    const updates = { updated_at: new Date().toISOString() };
    allowed.forEach(key => {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    });

    const { data: updated, error } = await supabase
      .from('eco_clients')
      .update(updates)
      .eq('id', clientId)
      .select()
      .single();

    if (error) {
      console.error('eco-clients update error:', error.message);
      return res.status(500).json({ error: 'Failed to update client' });
    }

    // If apps changed, sync newly added apps
    let syncResult = { synced: [], errors: [] };
    const oldApps = old.apps || [];
    const newApps = updated.apps || [];
    const addedApps = newApps.filter(a => !oldApps.includes(a));
    if (addedApps.length > 0) {
      syncResult = await syncToApps({ ...updated, apps: addedApps });
    }

    await auditFromReq(req, 'UPDATE', 'eco_client', clientId, {
      module: 'ecosystem',
      metadata: { old_apps: old.apps, new_apps: updated.apps, synced: syncResult.synced }
    });

    res.json({ ...updated, sync: syncResult });
  } catch (err) {
    console.error('eco-clients PUT /:id error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/eco-clients/:id
 * Soft delete (set is_active = false)
 */
router.delete('/:id', async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);

    const { data: updated, error } = await supabase
      .from('eco_clients')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', clientId)
      .select()
      .single();

    if (error || !updated) {
      return res.status(404).json({ error: 'Client not found' });
    }

    await auditFromReq(req, 'DELETE', 'eco_client', clientId, { module: 'ecosystem' });

    res.json({ success: true, message: 'Client deactivated' });
  } catch (err) {
    console.error('eco-clients DELETE /:id error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
