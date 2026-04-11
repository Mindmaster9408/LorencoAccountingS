/**
 * ============================================================================
 * Payroll Employee Sync Service — Supabase Version
 * ============================================================================
 * Detects and syncs unsynced employees between:
 *   - payroll_kv_store_eco (where employees_{companyId} stores employee arrays)
 *   - employees table (master employee records)
 *
 * SAFE DESIGN:
 *   - Per-company isolation
 *   - Duplicate prevention via email/ID/code matching
 *   - Idempotent (re-run detection doesn't sync already-synced employees)
 *   - Error handling per employee (one failure doesn't abort all)
 *   - Preserves payroll history
 *
 * Used by Payroll/server.js to provide:
 *   GET  /api/payroll/sync/detect?companyId={id}
 *   POST /api/payroll/sync/execute
 * ============================================================================
 */

'use strict';

/**
 * Detect employees in KV store but not in master table
 */
async function detectUnsyncedEmployees(supabase, companyId) {
  try {
    // Get employees from KV store
    const { data: kvData, error: kvError } = await supabase
      .from('payroll_kv_store_eco')
      .select('value')
      .eq('company_id', companyId)
      .eq('key', `employees_${companyId}`)
      .maybeSingle();

    if (kvError) throw kvError;

    const kvEmployees = kvData?.value || [];
    if (!Array.isArray(kvEmployees)) {
      console.warn(`KV store employees_${companyId} is not an array, initializing empty`);
      return [];
    }

    // Get active employees from master table (by company_id)
    const { data: masterEmployees, error: masterError } = await supabase
      .from('employees')
      .select('id, employee_code, email, id_number')
      .eq('company_id', companyId)
      .eq('is_active', true);

    if (masterError) throw masterError;

    // Build set of existing master employee codes for quick lookup
    const masterCodes = new Set(masterEmployees?.map(e => e.employee_code) || []);
    const masterEmails = new Set(masterEmployees?.map(e => e.email?.toLowerCase()).filter(Boolean) || []);
    const masterIdNumbers = new Set(masterEmployees?.map(e => e.id_number?.toLowerCase()).filter(Boolean) || []);

    // Filter KV employees not yet in master
    const unsynced = kvEmployees
      .filter(emp => {
        const empCode = emp.payrollNumber || emp.employee_code || '';
        const empEmail = emp.email?.toLowerCase() || '';
        const empIdNum = emp.id_number?.toLowerCase() || '';

        // Check if already in master by any of these
        const alreadyInMaster = 
          masterCodes.has(empCode) ||
          (empEmail && masterEmails.has(empEmail)) ||
          (empIdNum && masterIdNumbers.has(empIdNum));

        return !alreadyInMaster;
      })
      .map(emp => ({
        name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || 'Unknown',
        email: emp.email || null,
        idNumber: emp.id_number || null,
        payrollNumber: emp.payrollNumber || emp.employee_code || null,
        originalData: emp
      }));

    return unsynced;

  } catch (err) {
    console.error('detectUnsyncedEmployees error:', err);
    throw err;
  }
}

/**
 * Sync unsynced employees into master table
 */
async function syncUnsyncedEmployees(supabase, companyId, unsyncedEmployees) {
  if (!unsyncedEmployees?.length) {
    return { success: true, total: 0, created: 0, linked: 0, failed: [], detail: 'No unsynced employees' };
  }

  const result = {
    success: false,
    total: unsyncedEmployees.length,
    created: 0,
    linked: 0,
    failed: [],
    detail: null
  };

  // Process each unsynced employee
  for (const emp of unsyncedEmployees) {
    try {
      // Try to match existing master employee by email, ID, or code
      let existingEmployee = null;

      // Match 1: By email (most reliable)
      if (emp.email) {
        const { data, error } = await supabase
          .from('employees')
          .select('id')
          .eq('company_id', companyId)
          .eq('email', emp.email)
          .maybeSingle();

        if (error) throw error;
        existingEmployee = data;
      }

      // Match 2: By ID number
      if (!existingEmployee && emp.idNumber) {
        const { data, error } = await supabase
          .from('employees')
          .select('id')
          .eq('company_id', companyId)
          .eq('id_number', emp.idNumber)
          .maybeSingle();

        if (error) throw error;
        existingEmployee = data;
      }

      // Match 3: By employee code
      if (!existingEmployee && emp.payrollNumber) {
        const { data, error } = await supabase
          .from('employees')
          .select('id')
          .eq('company_id', companyId)
          .eq('employee_code', emp.payrollNumber)
          .maybeSingle();

        if (error) throw error;
        existingEmployee = data;
      }

      if (existingEmployee) {
        // Link: employee already exists, just count it
        result.linked++;
        continue;
      }

      // Create new master employee record
      const [firstName, ...lastNameParts] = emp.name.split(' ');
      const lastName = lastNameParts.join(' ') || '';

      const { error: insertError } = await supabase
        .from('employees')
        .insert({
          company_id: companyId,
          first_name: firstName || 'Unknown',
          last_name: lastName || '',
          email: emp.email || null,
          id_number: emp.idNumber || null,
          employee_code: emp.payrollNumber || null,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      if (insertError) throw insertError;

      result.created++;

    } catch (err) {
      console.error(`syncUnsyncedEmployees: Failed to sync ${emp.name}:`, err);
      result.failed.push({
        emp: emp.name,
        reason: err.message || 'Unknown error'
      });
    }
  }

  result.success = result.failed.length === 0;
  result.detail = `Created ${result.created}, linked ${result.linked}`;

  return result;
}

/**
 * Register Express routes for sync API
 */
function registerPayrollEmployeeSyncRoutes(app, supabase) {
  /**
   * GET /api/payroll/sync/detect?companyId={id}
   * Detect unsynced employees
   */
  app.get('/api/payroll/sync/detect', async (req, res) => {
    try {
      const { companyId } = req.query;

      if (!companyId) {
        return res.status(400).json({ error: 'companyId required' });
      }

      const employees = await detectUnsyncedEmployees(supabase, companyId);

      res.json({
        unsyncedCount: employees.length,
        employees: employees
      });

    } catch (err) {
      console.error('GET /api/payroll/sync/detect error:', err.message);
      res.status(500).json({ error: err.message || 'Detection failed' });
    }
  });

  /**
   * POST /api/payroll/sync/execute
   * Execute sync of unsynced employees
   * Body: { companyId, employees? }
   */
  app.post('/api/payroll/sync/execute', async (req, res) => {
    try {
      const { companyId, employees: preSyncedEmployees } = req.body;

      if (!companyId) {
        return res.status(400).json({ error: 'companyId required' });
      }

      // If employees provided, use them; otherwise auto-detect
      let employeesToSync = preSyncedEmployees;

      if (!employeesToSync) {
        employeesToSync = await detectUnsyncedEmployees(supabase, companyId);
      }

      // Execute sync
      const result = await syncUnsyncedEmployees(supabase, companyId, employeesToSync);

      res.json(result);

    } catch (err) {
      console.error('POST /api/payroll/sync/execute error:', err.message);
      res.status(500).json({ error: err.message || 'Sync failed' });
    }
  });
}

// Exports for use in Payroll/server.js
module.exports = {
  detectUnsyncedEmployees,
  syncUnsyncedEmployees,
  registerPayrollEmployeeSyncRoutes
};
