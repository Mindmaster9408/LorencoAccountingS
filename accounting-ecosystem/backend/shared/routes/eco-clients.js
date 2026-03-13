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
 * Uses client_company_id (the client's own isolated company) when available.
 * Returns { synced: [...], errors: [...] }
 */
async function syncToApps(ecoClient) {
  const synced = [];
  const errors = [];
  const apps = ecoClient.apps || [];
  // Data always goes into the client's OWN company — not the managing practice
  const dataCompanyId = ecoClient.client_company_id || ecoClient.company_id;

  // POS → customers table
  if (apps.includes('pos')) {
    try {
      const customerNumber = `EC-${Date.now().toString(36).toUpperCase()}`;
      const customerData = {
        company_id: dataCompanyId,
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
        company_id: dataCompanyId,
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
 * Push field-level updates to already-linked app records.
 * Called on PUT when name/email/phone/address/id_number changes.
 * Returns { updated: ['pos', 'payroll', ...], errors: [...] }
 */
async function syncUpdateToApps(ecoClient, changedFields) {
  const updated = [];
  const errors  = [];
  const apps = ecoClient.apps || [];

  const coreFields = ['name', 'email', 'phone', 'address', 'id_number'];
  const hasCoreChange = coreFields.some(f => changedFields.includes(f));
  if (!hasCoreChange) return { updated, errors };

  // POS → customers
  if (apps.includes('pos')) {
    try {
      const patch = {};
      if (changedFields.includes('name'))     patch.name = ecoClient.name;
      if (changedFields.includes('email'))    { patch.email = ecoClient.email || null; }
      if (changedFields.includes('phone'))    { patch.phone = ecoClient.phone || null; patch.contact_number = ecoClient.phone || null; }
      if (changedFields.includes('address'))  patch.address_line_1 = ecoClient.address || null;
      if (changedFields.includes('id_number')) patch.id_number = ecoClient.id_number || null;

      const { error } = await supabase
        .from('customers')
        .update(patch)
        .eq('eco_client_id', ecoClient.id);

      if (error) throw error;
      updated.push('POS');
    } catch (err) {
      console.error('syncUpdate → POS failed:', err.message);
      errors.push({ app: 'pos', error: err.message });
    }
  }

  // Payroll → employees
  if (apps.includes('payroll')) {
    try {
      const patch = {};
      if (changedFields.includes('name')) {
        patch.full_name = ecoClient.name;
        const parts = (ecoClient.name || '').trim().split(/\s+/);
        patch.first_name = parts[0] || ecoClient.name;
        patch.last_name  = parts.slice(1).join(' ') || '';
      }
      if (changedFields.includes('email'))    { patch.email = ecoClient.email || null; }
      if (changedFields.includes('phone'))    patch.phone = ecoClient.phone || null;
      if (changedFields.includes('id_number')) patch.id_number = ecoClient.id_number || null;

      const { error } = await supabase
        .from('employees')
        .update(patch)
        .eq('eco_client_id', ecoClient.id);

      if (error) throw error;
      updated.push('Payroll');
    } catch (err) {
      console.error('syncUpdate → Payroll failed:', err.message);
      errors.push({ app: 'payroll', error: err.message });
    }
  }

  return { updated, errors };
}

/**
 * GET /api/eco-clients
 * List all clients for user's companies (super_admin sees all).
 * Also returns clients shared with the user's company via eco_client_firm_access.
 * Shared clients are flagged with shared_access: true.
 */
router.get('/', async (req, res) => {
  try {
    const { company_id, app, search, client_type } = req.query;

    // Super admins can pass ?status=all to see inactive clients too (admin control panel)
    const showAll = req.query.status === 'all' && req.user.isSuperAdmin;

    // ── Resolve effective company filter ──────────────────────────────────────
    // For non-admins: if a company_id param is supplied, verify they actually
    // belong to that company — prevents enumeration of other firms' clients.
    let effectiveCompanyId = req.companyId; // default: company from JWT

    if (company_id) {
      const requestedId = parseInt(company_id);
      if (req.user.isSuperAdmin) {
        // Super admins can scope to any company
        effectiveCompanyId = requestedId;
      } else {
        // Regular users: verify they are a member of the requested company
        const { data: access } = await supabase
          .from('user_company_access')
          .select('id')
          .eq('user_id', req.user.userId)
          .eq('company_id', requestedId)
          .eq('is_active', true)
          .limit(1);

        if (!access || access.length === 0) {
          return res.status(403).json({ error: 'Access denied' });
        }
        effectiveCompanyId = requestedId;
      }
    }

    // ── 1. Fetch directly managed (owned) clients ──────────────────────────────
    let q = supabase
      .from('eco_clients')
      .select('*')
      .order('name');

    if (!showAll) {
      q = q.eq('is_active', true);
    }

    if (!req.user.isSuperAdmin || effectiveCompanyId) {
      if (req.user.isSuperAdmin && effectiveCompanyId) {
        // Super admin scoped to a specific company
        q = q.eq('company_id', effectiveCompanyId);
      } else if (!req.user.isSuperAdmin) {
        q = q.eq('company_id', effectiveCompanyId);
      }
      // Super admin with no company filter → returns all (no eq added)
    }

    if (client_type) {
      q = q.eq('client_type', client_type);
    }

    const { data: ownedClients, error } = await q;

    if (error) {
      console.error('eco-clients list error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch clients' });
    }

    let results = ownedClients || [];

    // ── 2. Fetch shared clients (via eco_client_firm_access) ───────────────────
    // Only for non-super-admin users who have a company context.
    // Super admins already see everything via the owned-clients query.
    if (!req.user.isSuperAdmin && req.companyId && !company_id) {
      const { data: sharedAccess } = await supabase
        .from('eco_client_firm_access')
        .select('eco_client_id')
        .eq('firm_company_id', req.companyId)
        .eq('is_active', true);

      if (sharedAccess && sharedAccess.length > 0) {
        const ownedIds = new Set(results.map(c => c.id));
        const newIds = sharedAccess
          .map(a => a.eco_client_id)
          .filter(id => !ownedIds.has(id));

        if (newIds.length > 0) {
          let sharedQ = supabase
            .from('eco_clients')
            .select('*')
            .in('id', newIds)
            .neq('company_id', effectiveCompanyId)  // defensive: never include own-firm clients via shared path
            .order('name');

          if (!showAll) sharedQ = sharedQ.eq('is_active', true);

          const { data: sharedClients } = await sharedQ;
          if (sharedClients) {
            // Mark shared clients so the UI can badge them differently
            results = [...results, ...sharedClients.map(c => ({ ...c, shared_access: true }))];
          }
        }
      }
    }

    // ── 3. Per-user client access filter ─────────────────────────────────────
    // If the user has ANY rows in user_client_access for (user_id, company_id),
    // filter to only those clients.  Zero rows = unrestricted (backward-compat).
    // Super admins and explicit company_id query params bypass this filter.
    if (!req.user.isSuperAdmin && req.user.userId && effectiveCompanyId && !company_id) {
      const { data: userClientRows } = await supabase
        .from('user_client_access')
        .select('eco_client_id')
        .eq('user_id', req.user.userId)
        .eq('company_id', effectiveCompanyId);

      if (userClientRows && userClientRows.length > 0) {
        const allowedIds = new Set(userClientRows.map(r => r.eco_client_id));
        results = results.filter(c => allowedIds.has(c.id));
      }
      // Zero rows: no restriction, all clients remain visible
    }

    let filtered = results;

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
 * GET /api/eco-clients/payroll-billing-summary
 * Returns per-client active employee count for the super-admin billing panel.
 *
 * Billing rule: ALL active employees on the system for that client.
 *
 * Resolution order (handles both new and legacy employee records):
 *   1. eco_client_id on the employee record  (set for employees created after migration 005)
 *   2. company_id → client_company_id lookup (fallback for employees created before migration 005)
 *
 * Returns:
 *   by_client_id  — { [eco_client_id]: N }             (authoritative — always correct)
 *   summary       — { [company_id]: { active_employees: N } }  (legacy, kept for compat)
 */
router.get('/payroll-billing-summary', async (req, res) => {
  try {
    // Fetch employees AND eco_clients in parallel
    const [empsResult, clientsResult] = await Promise.all([
      supabase.from('employees').select('company_id, eco_client_id, is_active'),
      supabase.from('eco_clients').select('id, client_company_id')
    ]);
    if (empsResult.error) throw empsResult.error;
    if (clientsResult.error) throw clientsResult.error;

    // Build reverse map: client_company_id → eco_client.id
    // Used to resolve employees that have company_id but no eco_client_id
    // (i.e. employees created before migration 005 added eco_client_id)
    const companyToClientId = {};
    (clientsResult.data || []).forEach(c => {
      if (c.client_company_id) companyToClientId[c.client_company_id] = c.id;
    });

    const byClientId = {};  // { [eco_client_id]: count }  — authoritative
    const summary    = {};  // { [company_id]: { active_employees: N } }  — legacy fallback

    (empsResult.data || []).forEach(e => {
      if (!e.is_active) return;

      // Resolve to eco_client_id — use direct column first, then company mapping
      const clientId = e.eco_client_id || companyToClientId[e.company_id];
      if (clientId) {
        byClientId[clientId] = (byClientId[clientId] || 0) + 1;
      }

      // Legacy company_id index (retained for backward compatibility)
      if (e.company_id) {
        if (!summary[e.company_id]) summary[e.company_id] = { active_employees: 0 };
        summary[e.company_id].active_employees++;
      }
    });

    res.json({ summary, by_client_id: byClientId });
  } catch (err) {
    console.error('payroll-billing-summary error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/eco-clients/employee-counts
 * Returns { [client_company_id]: activeCount } for payroll invoicing
 */
router.get('/employee-counts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('company_id, is_active');

    if (error) {
      console.error('employee-counts error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch employee counts' });
    }

    const counts = {};
    (data || []).forEach(e => {
      if (e.is_active) {
        counts[e.company_id] = (counts[e.company_id] || 0) + 1;
      }
    });

    res.json({ counts });
  } catch (err) {
    console.error('employee-counts error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/eco-clients/:id
 * Get a single client. Only accessible to users whose company manages this client
 * (or has shared access), or super admins.
 */
router.get('/:id', async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);

    const { data: client, error } = await supabase
      .from('eco_clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Verify ownership: super admin, direct owner, or shared access
    if (!req.user.isSuperAdmin) {
      const isOwner = client.company_id === req.companyId;

      let hasSharedAccess = false;
      if (!isOwner) {
        const { data: sharedRow } = await supabase
          .from('eco_client_firm_access')
          .select('id')
          .eq('eco_client_id', clientId)
          .eq('firm_company_id', req.companyId)
          .eq('is_active', true)
          .limit(1);
        hasSharedAccess = !!(sharedRow && sharedRow.length > 0);
      }

      if (!isOwner && !hasSharedAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
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
    const { name, email, phone, id_number, address, client_type, apps, company_id, client_company_id, notes } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Client name is required' });
    }

    // ── Resolve managing company (The Infinite Legacy / logged-in company) ──
    let resolvedCompanyId = parseInt(company_id) || req.companyId || null;

    if (!resolvedCompanyId) {
      const isSuperAdmin = req.user && req.user.isSuperAdmin;
      if (isSuperAdmin) {
        const { data: allCos } = await supabase
          .from('companies').select('id').eq('is_active', true).order('id').limit(1);
        if (allCos && allCos.length > 0) resolvedCompanyId = allCos[0].id;
      } else {
        const { data: accessList } = await supabase
          .from('user_company_access').select('company_id')
          .eq('user_id', req.user.userId).eq('is_active', true)
          .order('is_primary', { ascending: false }).limit(1);
        if (accessList && accessList.length > 0) resolvedCompanyId = accessList[0].company_id;
      }
    }

    if (!resolvedCompanyId) {
      const { data: anyCo } = await supabase.from('companies').select('id').limit(1);
      if (anyCo && anyCo.length > 0) resolvedCompanyId = anyCo[0].id;
    }

    if (!resolvedCompanyId) {
      return res.status(400).json({ error: 'No company exists in the system yet. Please create a company first.' });
    }

    // ── Resolve or auto-create the client's OWN company for data isolation ──
    let resolvedClientCompanyId = parseInt(client_company_id) || null;

    if (!resolvedClientCompanyId) {
      // Auto-create a dedicated company for this client
      const clientApps = Array.isArray(apps) ? apps : [];
      const { data: newCo, error: coErr } = await supabase
        .from('companies')
        .insert({
          company_name: name,
          trading_name: name,
          is_active: true,
          modules_enabled: clientApps.length > 0 ? clientApps : ['pos', 'payroll', 'accounting'],
          subscription_status: 'active'
        })
        .select()
        .single();

      if (coErr) {
        console.error('[eco-clients] Failed to auto-create client company:', coErr.message);
        // Fall back to managing company — data won't be isolated but won't fail
        resolvedClientCompanyId = resolvedCompanyId;
      } else {
        resolvedClientCompanyId = newCo.id;
        console.log(`[eco-clients] Auto-created company "${name}" (id=${newCo.id}) for client`);
      }
    }

    const newClient = {
      company_id: resolvedCompanyId,
      client_company_id: resolvedClientCompanyId,
      name,
      email: email || null,
      phone: phone || null,
      id_number: id_number || null,
      address: address || null,
      client_type: client_type || 'business',
      apps: Array.isArray(apps) ? apps : [],
      notes: notes || null,
      is_active: true,
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

    const allowed = ['name', 'email', 'phone', 'id_number', 'address', 'client_type', 'apps', 'addons',
                     'package_name', 'notes', 'is_active',
                     'last_billed_employees', 'last_billed_period', 'last_billed_date'];
    const updates = { updated_at: new Date().toISOString() };
    const changedFields = [];
    allowed.forEach(key => {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
        if (JSON.stringify(old[key]) !== JSON.stringify(req.body[key])) {
          changedFields.push(key);
        }
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

    // 1. Sync newly-added apps (create new records in POS/Payroll)
    let newRecordSync = { synced: [], errors: [] };
    const oldApps  = old.apps || [];
    const newApps  = updated.apps || [];
    const addedApps = newApps.filter(a => !oldApps.includes(a));
    if (addedApps.length > 0) {
      newRecordSync = await syncToApps({ ...updated, apps: addedApps });
    }

    // 2. Push field-level updates to already-linked app records
    const fieldSync = await syncUpdateToApps(updated, changedFields);

    // 3. Sync Sean addon toggle → companies.modules_enabled for this client's company
    if (changedFields.includes('addons') && updated.client_company_id) {
      try {
        const newAddons = updated.addons || [];
        const oldAddons = old.addons || [];
        const seanAdded   = newAddons.includes('sean') && !oldAddons.includes('sean');
        const seanRemoved = !newAddons.includes('sean') && oldAddons.includes('sean');
        if (seanAdded || seanRemoved) {
          const { data: coData } = await supabase
            .from('companies')
            .select('modules_enabled')
            .eq('id', updated.client_company_id)
            .single();
          if (coData) {
            let mods = coData.modules_enabled || [];
            if (seanAdded   && !mods.includes('sean')) mods = [...mods, 'sean'];
            if (seanRemoved) mods = mods.filter(m => m !== 'sean');
            await supabase
              .from('companies')
              .update({ modules_enabled: mods })
              .eq('id', updated.client_company_id);
          }
        }
      } catch (syncErr) {
        console.error('[eco-clients] Sean addon sync to companies failed:', syncErr.message);
      }
    }

    const syncResult = {
      synced:  newRecordSync.synced,
      updated: fieldSync.updated,
      errors:  [...newRecordSync.errors, ...fieldSync.errors],
    };

    await auditFromReq(req, 'UPDATE', 'eco_client', clientId, {
      module: 'ecosystem',
      metadata: { old_apps: old.apps, new_apps: updated.apps, changedFields, synced: syncResult.synced, updated: syncResult.updated }
    });

    res.json({ ...updated, sync: syncResult });
  } catch (err) {
    console.error('eco-clients PUT /:id error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Firm Access Routes ──────────────────────────────────────────────────────

/**
 * GET /api/eco-clients/:id/firm-access
 * List all accounting firms that have been granted visibility of this client.
 * Includes firm company name for display.
 */
router.get('/:id/firm-access', async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);

    // Verify the client exists
    const { data: client, error: clientErr } = await supabase
      .from('eco_clients')
      .select('id, name, company_id')
      .eq('id', clientId)
      .single();

    if (clientErr || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Fetch all active firm-access records for this client
    const { data: rows, error } = await supabase
      .from('eco_client_firm_access')
      .select('*')
      .eq('eco_client_id', clientId)
      .eq('is_active', true)
      .order('granted_at');

    if (error) {
      console.error('eco-clients firm-access GET error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch firm access' });
    }

    // Enrich with firm company names
    const firmIds = (rows || []).map(r => r.firm_company_id);
    let firmMap = {};
    if (firmIds.length > 0) {
      const { data: firms } = await supabase
        .from('companies')
        .select('id, company_name, trading_name')
        .in('id', firmIds);
      if (firms) {
        firms.forEach(f => { firmMap[f.id] = f.trading_name || f.company_name; });
      }
    }

    const enriched = (rows || []).map(r => ({
      ...r,
      firm_name: firmMap[r.firm_company_id] || 'Unknown Firm'
    }));

    res.json({ client_id: clientId, firm_access: enriched });
  } catch (err) {
    console.error('eco-clients firm-access GET /:id error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/eco-clients/:id/firm-access
 * Grant an accounting firm visibility of this client.
 * Body: { firm_company_id }
 * Only the managing company or super admin can grant access.
 */
router.post('/:id/firm-access', async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { firm_company_id } = req.body;

    if (!firm_company_id) {
      return res.status(400).json({ error: 'firm_company_id is required' });
    }

    // Verify client exists
    const { data: client, error: clientErr } = await supabase
      .from('eco_clients')
      .select('id, name, company_id')
      .eq('id', clientId)
      .single();

    if (clientErr || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Only the managing company or super admin can grant access
    if (!req.user.isSuperAdmin && client.company_id !== req.companyId) {
      return res.status(403).json({ error: 'Only the managing firm can grant access' });
    }

    // Cannot grant access to the managing company itself (they already own it)
    if (parseInt(firm_company_id) === client.company_id) {
      return res.status(400).json({ error: 'Managing company already has full access' });
    }

    // Verify the target firm exists and is active
    const { data: firm, error: firmErr } = await supabase
      .from('companies')
      .select('id, company_name, trading_name')
      .eq('id', parseInt(firm_company_id))
      .eq('is_active', true)
      .single();

    if (firmErr || !firm) {
      return res.status(404).json({ error: 'Accounting firm not found or inactive' });
    }

    // Upsert — if a previous revoked record exists, reactivate it
    const { data: existing } = await supabase
      .from('eco_client_firm_access')
      .select('id, is_active')
      .eq('eco_client_id', clientId)
      .eq('firm_company_id', parseInt(firm_company_id))
      .maybeSingle();

    let result;
    if (existing) {
      if (existing.is_active) {
        return res.status(409).json({ error: `${firm.trading_name || firm.company_name} already has access` });
      }
      // Reactivate
      const { data: updated, error: updErr } = await supabase
        .from('eco_client_firm_access')
        .update({ is_active: true, granted_at: new Date().toISOString(), granted_by_company_id: req.companyId })
        .eq('id', existing.id)
        .select()
        .single();
      if (updErr) throw updErr;
      result = updated;
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('eco_client_firm_access')
        .insert({
          eco_client_id: clientId,
          firm_company_id: parseInt(firm_company_id),
          granted_by_company_id: req.companyId || null,
          is_active: true
        })
        .select()
        .single();
      if (insErr) throw insErr;
      result = inserted;
    }

    await auditFromReq(req, 'CREATE', 'eco_client_firm_access', clientId, {
      module: 'ecosystem',
      metadata: { firm_company_id, firm_name: firm.trading_name || firm.company_name }
    });

    res.status(201).json({
      ...result,
      firm_name: firm.trading_name || firm.company_name,
      message: `${firm.trading_name || firm.company_name} can now view "${client.name}"`
    });
  } catch (err) {
    console.error('eco-clients firm-access POST /:id error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/eco-clients/:id/firm-access/:firmId
 * Revoke a firm's access to this client (soft delete).
 * Only the managing company or super admin can revoke.
 */
router.delete('/:id/firm-access/:firmId', async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const firmId = parseInt(req.params.firmId);

    // Verify client exists
    const { data: client, error: clientErr } = await supabase
      .from('eco_clients')
      .select('id, name, company_id')
      .eq('id', clientId)
      .single();

    if (clientErr || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Only the managing company or super admin can revoke
    if (!req.user.isSuperAdmin && client.company_id !== req.companyId) {
      return res.status(403).json({ error: 'Only the managing firm can revoke access' });
    }

    const { data: updated, error } = await supabase
      .from('eco_client_firm_access')
      .update({ is_active: false })
      .eq('eco_client_id', clientId)
      .eq('firm_company_id', firmId)
      .select()
      .single();

    if (error || !updated) {
      return res.status(404).json({ error: 'Firm access record not found' });
    }

    await auditFromReq(req, 'DELETE', 'eco_client_firm_access', clientId, {
      module: 'ecosystem',
      metadata: { firm_company_id: firmId }
    });

    res.json({ success: true, message: 'Firm access revoked' });
  } catch (err) {
    console.error('eco-clients firm-access DELETE /:id/:firmId error:', err.message);
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
