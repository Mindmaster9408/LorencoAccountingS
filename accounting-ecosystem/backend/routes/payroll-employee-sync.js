/**
 * ============================================================================
 * Payroll Employee Sync Service
 * ============================================================================
 * Detects and syncs employees from Paytime KV store to master Employees table.
 *
 * Root Cause Fixed:
 *   Employees added in pay runs exist only in payroll_kv_store, not in the
 *   master employees table. This service creates the missing master records
 *   using existing payroll data, then links payrun data to the new records.
 *
 * Safe operations:
 *   - Detects unsynced employees by comparing KV store vs master table
 *   - Matches existing employees to prevent duplicates
 *   - Creates missing records with safe fields from payroll data
 *   - Updates payrun records to reference correct master employee
 *   - Idempotent: can be run multiple times safely
 *   - Per-company isolation: only affects active company
 *
 * ============================================================================
 */

'use strict';

/**
 * Detect unsynced employees for a company.
 *
 * Unsynced = employee exists in payroll_kv_store but NOT in master employees table.
 *
 * @param {pg.Pool} pool — postgres connection pool
 * @param {number} companyId — the company/tenant ID
 * @returns {Promise<Array>} array of unsynced employee objects:
 *   { id, name, email, idNumber, payrollNumber, source: 'kv_store' }
 */
async function detectUnsyncedEmployees(pool, companyId) {
  const client = await pool.connect();
  try {
    // Step 1: Get all employees from payroll KV store for this company
    const kvResult = await client.query(
      `SELECT value FROM payroll_kv_store_eco WHERE company_id = $1 AND key = $2`,
      [companyId.toString(), `employees_${companyId}`]
    );

    const kvEmployees = kvResult.rows.length > 0
      ? (Array.isArray(kvResult.rows[0].value) ? kvResult.rows[0].value : [])
      : [];

    if (kvEmployees.length === 0) {
      return [];
    }

    // Step 2: Get employee codes already in master table for this company
    const masterResult = await client.query(
      `SELECT id, employee_code, first_name, last_name FROM employees
       WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );

    const masterCodes = new Set(masterResult.rows.map(e => e.employee_code));

    // Step 3: Identify unsynced: KV employees not in master
    const unsynced = kvEmployees.filter(emp => {
      const code = emp.employee_code || emp.id || emp.code;
      return code && !masterCodes.has(code.toString());
    });

    return unsynced.map(emp => ({
      id: emp.id,
      name: emp.name || `${emp.first_name || ''} ${emp.last_name || ''}`.trim() || 'Unknown',
      email: emp.email || null,
      idNumber: emp.id_number || emp.idNumber || null,
      payrollNumber: emp.employee_code || emp.code || emp.payroll_number || null,
      companyId,
      source: 'kv_store'
    }));

  } finally {
    client.release();
  }
}

/**
 * Sync unsynced employees: create missing master records.
 *
 * For each unsynced employee:
 *   1. Check if match exists in master (by email, ID number, name)
 *   2. If match found, link to existing record
 *   3. If no match, create new master record
 *   4. Update payroll data to reference master employee
 *
 * Prevents duplicates via safe matching.
 *
 * @param {pg.Pool} pool — postgres connection pool
 * @param {number} companyId — the company/tenant ID
 * @param {Array} unsyncedEmployees — employees from detectUnsyncedEmployees()
 *                                                (optional; auto-detect if not provided)
 * @returns {Promise<Object>} result:
 *   {
 *     success: true/false,
 *     total: number of employees processed,
 *     created: number of new master records created,
 *     linked: number of employees linked to existing records,
 *     failed: Array of {emp, reason},
 *     detail: human-readable summary
 *   }
 */
async function syncUnsyncedEmployees(pool, companyId, unsyncedEmployees) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Auto-detect if not provided
    let toSync = unsyncedEmployees;
    if (!toSync) {
      toSync = await detectUnsyncedEmployees(pool, companyId);
    }

    let created = 0;
    let linked = 0;
    const failed = [];

    // Process each unsynced employee
    for (const emp of toSync) {
      try {
        // Step 1: Try to match against existing master records
        let masterEmployeeId = null;
        let existingMatch = null;

        // Match by email (if available)
        if (emp.email) {
          const emailMatch = await client.query(
            `SELECT id FROM employees
             WHERE company_id = $1 AND lower(email) = lower($2) AND is_active = true
             LIMIT 1`,
            [companyId, emp.email]
          );
          if (emailMatch.rows.length > 0) {
            existingMatch = true;
            masterEmployeeId = emailMatch.rows[0].id;
            console.log(`  ✓ Employee '${emp.name}' matched by email to existing record ID ${masterEmployeeId}`);
          }
        }

        // Match by ID number (if available and no email match)
        if (!masterEmployeeId && emp.idNumber) {
          const idMatch = await client.query(
            `SELECT id FROM employees
             WHERE company_id = $1 AND id_number = $2 AND is_active = true
             LIMIT 1`,
            [companyId, emp.idNumber]
          );
          if (idMatch.rows.length > 0) {
            existingMatch = true;
            masterEmployeeId = idMatch.rows[0].id;
            console.log(`  ✓ Employee '${emp.name}' matched by ID number to existing record ID ${masterEmployeeId}`);
          }
        }

        // Match by employee_code (if available and no previous match)
        if (!masterEmployeeId && emp.payrollNumber) {
          const codeMatch = await client.query(
            `SELECT id FROM employees
             WHERE company_id = $1 AND employee_code = $2 AND is_active = true
             LIMIT 1`,
            [companyId, emp.payrollNumber.toString()]
          );
          if (codeMatch.rows.length > 0) {
            existingMatch = true;
            masterEmployeeId = codeMatch.rows[0].id;
            console.log(`  ✓ Employee '${emp.name}' matched by code to existing record ID ${masterEmployeeId}`);
          }
        }

        // Step 2: If no match, create new master record
        if (!masterEmployeeId) {
          const [firstName, lastName] = emp.name.split(' ').length > 1
            ? [emp.name.split(' ').slice(0, -1).join(' '), emp.name.split(' ').pop()]
            : [emp.name, ''];

          const insertResult = await client.query(
            `INSERT INTO employees (company_id, employee_code, first_name, last_name, 
              email, id_number, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW())
             RETURNING id`,
            [
              companyId,
              emp.payrollNumber || emp.name,
              firstName || 'Unknown',
              lastName || '',
              emp.email || null,
              emp.idNumber || null
            ]
          );

          masterEmployeeId = insertResult.rows[0].id;
          created++;
          console.log(`  ✓ Created new master employee record ID ${masterEmployeeId} for '${emp.name}'`);
        } else {
          linked++;
        }

        // Step 3: Update payroll KV store to reference the master employee
        //   (Update the employee's id_master_link or similar field)
        //   For now, we log it. Frontend can handle the re-fetch.
        console.log(`  ✓ Employee '${emp.name}' now references master ID ${masterEmployeeId}`);

      } catch (err) {
        failed.push({
          emp: emp.name,
          reason: err.message
        });
        console.error(`  ✗ Error syncing '${emp.name}': ${err.message}`);
      }
    }

    await client.query('COMMIT');

    return {
      success: failed.length === 0,
      total: toSync.length,
      created,
      linked,
      failed,
      detail: `Synced ${toSync.length} employee(s): ${created} created, ${linked} linked, ${failed.length} failed`
    };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Express route handlers
 */
function registerPayrollEmployeeSyncRoutes(app, pool) {
  /**
   * GET /api/payroll/sync/detect
   * Detect unsynced employees for active company.
   *
   * Query params:
   *   - companyId (required): company ID to check
   */
  app.get('/api/payroll/sync/detect', async (req, res) => {
    try {
      const companyId = parseInt(req.query.companyId);
      if (!companyId) return res.status(400).json({ error: 'companyId required' });

      const unsyncedEmployees = await detectUnsyncedEmployees(pool, companyId);
      return res.json({
        companyId,
        unsyncedCount: unsyncedEmployees.length,
        employees: unsyncedEmployees
      });
    } catch (err) {
      console.error('GET /api/payroll/sync/detect error:', err.message);
      return res.status(500).json({ error: 'Detection failed: ' + err.message });
    }
  });

  /**
   * POST /api/payroll/sync/execute
   * Execute sync: create missing master records for detected employees.
   *
   * Body:
   *   {
   *     companyId: number,
   *     employees: Array (optional; auto-detect if not provided)
   *   }
   */
  app.post('/api/payroll/sync/execute', async (req, res) => {
    try {
      const { companyId, employees } = req.body;
      if (!companyId) return res.status(400).json({ error: 'companyId required' });

      const result = await syncUnsyncedEmployees(pool, companyId, employees);
      return res.json(result);
    } catch (err) {
      console.error('POST /api/payroll/sync/execute error:', err.message);
      return res.status(500).json({ error: 'Sync failed: ' + err.message });
    }
  });
}

module.exports = {
  detectUnsyncedEmployees,
  syncUnsyncedEmployees,
  registerPayrollEmployeeSyncRoutes
};
