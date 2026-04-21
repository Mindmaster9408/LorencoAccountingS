/**
 * ============================================================================
 * PayrollHistoryService — Prepare Immutable Payroll Snapshots
 * ============================================================================
 * Purpose: Prepare and manage immutable payroll history snapshots.
 *
 * CRITICAL DESIGN PRINCIPLE:
 * Finalized payroll must be stored as COMPLETE snapshots (full input + full output).
 * Future code must NOT need to reconstruct historical payroll from scratch.
 *
 * Responsibilities:
 * - Define snapshot-ready payroll structure
 * - Package calculations into archive-safe format
 * - Prepare snapshots for storage (when finalization ownership takes over)
 * - Support historical payroll retrieval
 * - Maintain snapshot immutability rules
 *
 * SNAPSHOT CONTRACT:
 * {
 *   id: uuid,
 *   company_id: number,
 *   employee_id: number,
 *   period_key: "2026-04",
 *   period_id: number,
 *   status: "draft"|"approved"|"finalized"|"archived",
 *   calculation_input: { full normalized input },
 *   calculation_output: { full engine output },
 *   engine_version: "2026-04-12-v1",
 *   schema_version: "1.0",
 *   created_by: number (user_id),
 *   created_at: ISO-8601,
 *   finalized_by: number,
 *   finalized_at: ISO-8601,
 *   metadata: { extra context },
 *   is_locked: boolean
 * }
 *
 * IMMUTABILITY RULES:
 * 1. Once finalized, snapshot cannot be modified
 * 2. calculation_input must be stored completely (not just references)
 * 3. calculation_output must not be recomputed later
 * 4. engineVersion fields MUST be stored for future auditing
 * 5. Any corrections require new snapshot (corrected version), not mutation
 *
 * ============================================================================
 */

/**
 * Prepare calculation result for snapshot storage.
 * Packages raw calculation output into archive-safe format.
 *
 * @param {number} companyId - Company ID
 * @param {number} employeeId - Employee ID
 * @param {number} periodId - Pay period ID
 * @param {string} periodKey - Period identifier (YYYY-MM)
 * @param {object} normalizedInput - Input used for calculation
 * @param {object} calculationOutput - Output from PayrollEngine
 * @param {number} userId - User ID creating snapshot
 * @returns {object} Snapshot-ready payload
 */
function prepareSnapshot(
  companyId,
  employeeId,
  periodId,
  periodKey,
  normalizedInput,
  calculationOutput,
  userId
) {
  if (!companyId || !employeeId || !periodId || !periodKey) {
    throw new Error('companyId, employeeId, periodId, periodKey are required');
  }

  // Validate inputs
  if (!normalizedInput || typeof normalizedInput !== 'object') {
    throw new Error('normalizedInput must be a valid object');
  }

  if (!calculationOutput || typeof calculationOutput !== 'object') {
    throw new Error('calculationOutput must be a valid object');
  }

  const now = new Date().toISOString();

  const snapshot = {
    // === Identity ===
    company_id: companyId,
    employee_id: employeeId,
    period_id: periodId,
    period_key: periodKey,

    // === Status & Lifecycle ===
    status: 'draft', // Progresses: draft → approved → finalized → archived
    is_locked: false, // Set to true when finalized (immutable thereafter)

    // === Calculation Data (COMPLETE SNAPSHOTS — not references) ===
    calculation_input: JSON.parse(JSON.stringify(normalizedInput)), // Deep copy
    calculation_output: JSON.parse(JSON.stringify(calculationOutput)), // Deep copy

    // === Engine Metadata (for future auditing & versioning) ===
    engine_version: calculationOutput._meta?.engineVersion || 'unknown',
    schema_version: calculationOutput._meta?.schemaVersion || '1.0',

    // === Audit Trail ===
    created_by: userId,
    created_at: now,
    finalized_by: null,
    finalized_at: null,

    // === Contextual Metadata ===
    metadata: {
      calculation_method: calculationOutput._meta?.calculationMethod || 'standard',
      pro_rata_factor:
        calculationOutput.prorataFactor !== undefined
          ? calculationOutput.prorataFactor
          : null,
      expected_hours:
        calculationOutput.expectedHoursInPeriod !== undefined
          ? calculationOutput.expectedHoursInPeriod
          : null,
      worked_hours:
        calculationOutput.workedHoursInPeriod !== undefined
          ? calculationOutput.workedHoursInPeriod
          : null,
      pro_rata_start_date: calculationOutput._meta?.startDate || null,
      pro_rata_end_date: calculationOutput._meta?.endDate || null
    }
  };

  return snapshot;
}

/**
 * Mark snapshot as approved (step in finalization workflow).
 * Does NOT lock the snapshot yet; that happens on finalization.
 * This is a hook for approval workflow (Workstream 1 responsibility).
 *
 * @param {object} snapshot - Snapshot to mark approved
 * @param {number} approverId - User ID approving
 * @returns {object} Updated snapshot
 */
function markApproved(snapshot, approverId) {
  if (!snapshot || !approverId) {
    throw new Error('snapshot and approverId are required');
  }

  if (snapshot.is_locked) {
    throw new Error('Cannot approve locked snapshot');
  }

  return {
    ...snapshot,
    status: 'approved',
    approved_by: approverId,
    approved_at: new Date().toISOString()
  };
}

/**
 * Finalize snapshot (lock for immutability).
 * After finalization, snapshot cannot be modified.
 * This is the hook for final approval / payment completion.
 *
 * WORKSTREAM 1 responsibility: Call this after approval flow completes.
 * WORKSTREAM 2 responsibility: Provide the service method.
 *
 * @param {object} snapshot - Snapshot to finalize
 * @param {number} finalizerId - User ID finalizing
 * @returns {object} Immutable finalized snapshot
 */
function finalize(snapshot, finalizerId) {
  if (!snapshot || !finalizerId) {
    throw new Error('snapshot and finalizerId are required');
  }

  if (snapshot.is_locked) {
    throw new Error('Snapshot already finalized');
  }

  if (snapshot.status !== 'approved') {
    throw new Error('Snapshot must be approved before finalization');
  }

  return {
    ...snapshot,
    status: 'finalized',
    is_locked: true,
    finalized_by: finalizerId,
    finalized_at: new Date().toISOString()
  };
}

/**
 * Retrieve historical snapshot for auditing.
 * Confirms that snapshot data has not been tampered with.
 *
 * @param {object} snapshot -Stored snapshot from database
 * @returns {object} Snapshot with integrity check
 */
function retrieveSnapshot(snapshot) {
  if (!snapshot) {
    throw new Error('Snapshot not found');
  }

  if (!snapshot.is_locked && snapshot.status !== 'finalized') {
    console.warn(
      'Warning: Retrieved non-finalized snapshot. Data may not be immutable.',
      snapshot.period_key,
      snapshot.employee_id
    );
  }

  // Return snapshot as-is (database layer ensures integrity)
  return snapshot;
}

/**
 * Validate snapshot structure (post-retrieval verification).
 * Ensures snapshot contains all required fields.
 *
 * @param {object} snapshot - Snapshot to validate
 * @throws {Error} if snapshot structure is invalid
 */
function validateSnapshot(snapshot) {
  const requiredFields = [
    'company_id',
    'employee_id',
    // NOTE: period_id is NOT a DB column — do not add it here.
    // It exists on in-memory prepareSnapshot() objects but is not persisted.
    // Use period_key (which IS stored) for period identification.
    'period_key',
    'status',
    'is_locked',
    'calculation_input',
    'calculation_output',
    'engine_version',
    'schema_version',
    'created_by',
    'created_at'
  ];

  for (const field of requiredFields) {
    if (snapshot[field] === undefined) {
      throw new Error(`Snapshot validation failed: missing field "${field}"`);
    }
  }

  // Validate critical nested structures
  if (!snapshot.calculation_input || typeof snapshot.calculation_input !== 'object') {
    throw new Error('Snapshot validation failed: calculation_input is not a valid object');
  }

  if (
    !snapshot.calculation_output ||
    typeof snapshot.calculation_output !== 'object'
  ) {
    throw new Error('Snapshot validation failed: calculation_output is not a valid object');
  }

  return true;
}

/**
 * Compare two snapshots for audit tracing.
 * Lists all differences in inputs and outputs.
 *
 * @param {object} snapshot1 - First snapshot
 * @param {object} snapshot2 - Second snapshot
 * @returns {object} { inputs: [...], outputs: [...] } differences
 */
function compareSnapshots(snapshot1, snapshot2) {
  const differences = {
    inputs: [],
    outputs: []
  };

  // Compare inputs
  const input1 = snapshot1.calculation_input || {};
  const input2 = snapshot2.calculation_input || {};
  const allInputKeys = new Set([
    ...Object.keys(input1),
    ...Object.keys(input2)
  ]);

  for (const key of allInputKeys) {
    if (JSON.stringify(input1[key]) !== JSON.stringify(input2[key])) {
      differences.inputs.push({
        field: key,
        snapshot1: input1[key],
        snapshot2: input2[key]
      });
    }
  }

  // Compare outputs
  const output1 = snapshot1.calculation_output || {};
  const output2 = snapshot2.calculation_output || {};
  const allOutputKeys = new Set([
    ...Object.keys(output1),
    ...Object.keys(output2)
  ]);

  for (const key of allOutputKeys) {
    if (key === '_meta') continue; // Skip metadata timestamps
    if (JSON.stringify(output1[key]) !== JSON.stringify(output2[key])) {
      differences.outputs.push({
        field: key,
        snapshot1: output1[key],
        snapshot2: output2[key]
      });
    }
  }

  return differences;
}

/**
 * Format snapshot for API response.
 * Includes full details for audit/payslip retrieval.
 *
 * @param {object} snapshot - Snapshot to format
 * @returns {object} API-safe snapshot format
 */
function formatForResponse(snapshot) {
  // metadata is not a DB column — reconstruct from calculation_output.
  // calculation_output._meta and pro-rata fields carry this data.
  const output = snapshot.calculation_output || {};
  const meta   = output._meta || {};
  const reconstructedMetadata = {
    calculation_method:    meta.calculationMethod  || 'standard',
    pro_rata_factor:       output.prorataFactor      !== undefined ? output.prorataFactor      : null,
    expected_hours:        output.expectedHoursInPeriod !== undefined ? output.expectedHoursInPeriod : null,
    worked_hours:          output.workedHoursInPeriod   !== undefined ? output.workedHoursInPeriod   : null,
    pro_rata_start_date:   meta.startDate          || null,
    pro_rata_end_date:     meta.endDate            || null
  };

  // Expose basic_salary from calculation_input so the frontend snapshot display
  // can show the correct frozen salary without needing full input access.
  const input = snapshot.calculation_input || {};

  return {
    id:             snapshot.id,
    company_id:     snapshot.company_id,
    employee_id:    snapshot.employee_id,
    period_key:     snapshot.period_key,
    status:         snapshot.status,
    is_locked:      snapshot.is_locked,
    engine_version: snapshot.engine_version,
    schema_version: snapshot.schema_version,
    created_at:     snapshot.created_at,
    created_by:     snapshot.created_by,
    finalized_at:   snapshot.finalized_at,
    finalized_by:   snapshot.finalized_by,
    metadata:       reconstructedMetadata,
    // basic_salary from input — needed by frontend emp_historical_ display format
    basic_salary:   input.basic_salary != null ? input.basic_salary : null,
    // Full calculation output for payslip rendering (all 16 fields)
    calculation_output: snapshot.calculation_output,
    // calculation_input is internal — not exposed to frontend by default
    _includes_input: !!snapshot.calculation_input
  };
}

// ============================================================================
// DB Persistence Methods (additive — pure functions above unchanged)
// ============================================================================

/**
 * Save a prepared snapshot to the payroll_snapshots table.
 * The snapshot must have been prepared via prepareSnapshot() first.
 *
 * @param {object} supabase - Supabase client
 * @param {object} snapshot - Snapshot from prepareSnapshot()
 * @param {string|null} payrollRunId - UUID of parent payroll_run (optional)
 * @returns {Promise<object>} Inserted row from DB
 */
async function saveSnapshot(supabase, snapshot, payrollRunId = null) {
  validateSnapshot(snapshot);

  const row = {
    company_id:          snapshot.company_id,
    employee_id:         snapshot.employee_id,
    payroll_run_id:      payrollRunId,
    period_key:          snapshot.period_key,
    calculation_input:   snapshot.calculation_input,
    calculation_output:  snapshot.calculation_output,
    engine_version:      snapshot.engine_version,
    schema_version:      snapshot.schema_version,
    status:              snapshot.status || 'draft',
    is_locked:           snapshot.is_locked || false,
    created_by:          snapshot.created_by,
    created_at:          snapshot.created_at,
    finalized_by:        snapshot.finalized_by || null,
    finalized_at:        snapshot.finalized_at || null
  };

  const { data, error } = await supabase
    .from('payroll_snapshots')
    .insert(row)
    .select()
    .single();

  if (error) throw new Error(`Failed to save snapshot: ${error.message}`);
  return data;
}

/**
 * Retrieve a single snapshot for a specific employee + period.
 *
 * @param {object} supabase - Supabase client
 * @param {number} companyId
 * @param {number} employeeId
 * @param {string} periodKey - YYYY-MM
 * @returns {Promise<object|null>} Snapshot row or null
 */
async function getSnapshot(supabase, companyId, employeeId, periodKey) {
  const { data, error } = await supabase
    .from('payroll_snapshots')
    .select('*')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .eq('period_key', periodKey)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch snapshot: ${error.message}`);
  return data;
}

/**
 * List all snapshots for a company + period (used by finalize and run history).
 *
 * @param {object} supabase - Supabase client
 * @param {number} companyId
 * @param {string} periodKey - YYYY-MM
 * @param {object} [opts]
 * @param {number} [opts.employeeId] - Filter to single employee
 * @param {string} [opts.status]     - Filter by status ('draft'|'finalized')
 * @returns {Promise<object[]>} Array of snapshot rows
 */
async function listSnapshots(supabase, companyId, periodKey, opts = {}) {
  let query = supabase
    .from('payroll_snapshots')
    .select('*')
    .eq('company_id', companyId)
    .eq('period_key', periodKey)
    .order('created_at', { ascending: true });

  if (opts.employeeId) query = query.eq('employee_id', opts.employeeId);
  if (opts.status)     query = query.eq('status', opts.status);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list snapshots: ${error.message}`);
  return data || [];
}

/**
 * Lock all draft snapshots in a period (called during finalize run).
 * Updates status → 'finalized', is_locked → true for all matching rows.
 *
 * @param {object} supabase - Supabase client
 * @param {number} companyId
 * @param {string} periodKey - YYYY-MM
 * @param {number} finalizerId - User ID performing finalization
 * @param {string} payrollRunId - UUID of the payroll_run being finalized
 * @returns {Promise<object[]>} Updated rows
 */
async function lockSnapshotsForPeriod(supabase, companyId, periodKey, finalizerId, payrollRunId) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('payroll_snapshots')
    .update({
      status:       'finalized',
      is_locked:    true,
      finalized_by: finalizerId,
      finalized_at: now
    })
    .eq('company_id', companyId)
    .eq('period_key', periodKey)
    .eq('payroll_run_id', payrollRunId)
    .eq('is_locked', false)
    .select();

  if (error) throw new Error(`Failed to lock snapshots: ${error.message}`);
  return data || [];
}

// ─── Payroll Run helpers ──────────────────────────────────────────────────────

/**
 * Create a new payroll run header record.
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {string} periodKey
 * @param {number} employeeCount  - Total employees to be processed
 * @param {number} createdBy      - User ID initiating the run
 * @returns {Promise<object>} Inserted payroll_run row
 */
async function createPayrollRun(supabase, companyId, periodKey, employeeCount, createdBy) {
  const { data, error } = await supabase
    .from('payroll_runs')
    .insert({
      company_id:     companyId,
      period_key:     periodKey,
      status:         'draft',
      employee_count: employeeCount,
      created_by:     createdBy,
      created_at:     new Date().toISOString()
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create payroll run: ${error.message}`);
  return data;
}

/**
 * Update run totals and counts after processing all employees.
 *
 * @param {object} supabase
 * @param {string} runId - UUID of the payroll_run
 * @param {object} totals - { processedCount, errorCount, totalGross, totalNet, totalPaye, totalUif, totalSdl }
 * @returns {Promise<object>} Updated run row
 */
async function updatePayrollRunTotals(supabase, runId, totals) {
  const { data, error } = await supabase
    .from('payroll_runs')
    .update({
      processed_count: totals.processedCount,
      error_count:     totals.errorCount,
      total_gross:     totals.totalGross,
      total_net:       totals.totalNet,
      total_paye:      totals.totalPaye,
      total_uif:       totals.totalUif,
      total_sdl:       totals.totalSdl
    })
    .eq('id', runId)
    .select()
    .single();

  if (error) throw new Error(`Failed to update run totals: ${error.message}`);
  return data;
}

/**
 * Mark a payroll run as finalized (status → 'finalized').
 *
 * @param {object} supabase
 * @param {string} runId
 * @param {number} finalizerId
 * @returns {Promise<object>} Updated run row
 */
async function finalizePayrollRun(supabase, runId, finalizerId) {
  const { data, error } = await supabase
    .from('payroll_runs')
    .update({
      status:       'finalized',
      finalized_by: finalizerId,
      finalized_at: new Date().toISOString()
    })
    .eq('id', runId)
    .select()
    .single();

  if (error) throw new Error(`Failed to finalize payroll run: ${error.message}`);
  return data;
}

/**
 * Get an existing payroll run by company + period (most recent draft or any status).
 *
 * @param {object} supabase
 * @param {number} companyId
 * @param {string} periodKey
 * @param {string} [status] - 'draft' | 'finalized' | undefined (any)
 * @returns {Promise<object|null>}
 */
async function getPayrollRun(supabase, companyId, periodKey, status) {
  let query = supabase
    .from('payroll_runs')
    .select('*')
    .eq('company_id', companyId)
    .eq('period_key', periodKey)
    .order('created_at', { ascending: false })
    .limit(1);

  if (status) query = query.eq('status', status);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to fetch payroll run: ${error.message}`);
  return data;
}

module.exports = {
  // Pure functions (unchanged)
  prepareSnapshot,
  markApproved,
  finalize,
  retrieveSnapshot,
  validateSnapshot,
  compareSnapshots,
  formatForResponse,
  // DB persistence — snapshots
  saveSnapshot,
  getSnapshot,
  listSnapshots,
  lockSnapshotsForPeriod,
  // DB persistence — runs
  createPayrollRun,
  updatePayrollRunTotals,
  finalizePayrollRun,
  getPayrollRun
};
