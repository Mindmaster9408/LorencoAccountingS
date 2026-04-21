/**
 * ============================================================================
 * Payroll Run Routes — /api/payroll/run, /finalize, /history
 * ============================================================================
 * Purpose: Batch payroll execution, period finalization, and history retrieval.
 *
 * Endpoints:
 *   POST   /api/payroll/run        — Run payroll for multiple employees
 *   POST   /api/payroll/finalize   — Lock all snapshots for a period
 *   GET    /api/payroll/history    — Retrieve historical snapshot records
 *
 * Design rules:
 * - NEVER modifies PayrollEngine or calculation logic
 * - Delegates calculation to PayrollCalculationService (existing)
 * - Delegates data fetch to PayrollDataService (existing)
 * - Delegates snapshot persistence to PayrollHistoryService (new DB methods)
 * - Respects company_id isolation on every query
 * - Respects employee visibility scoping (paytimeAccess)
 * - Preserves all 16 engine output fields in snapshots
 * - Decimal hours are preserved throughout (no rounding)
 * ============================================================================
 */

const express = require('express');
const {
  authenticateToken,
  requireCompany,
  requirePermission
} = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const {
  getEmployeeFilter,
  requirePaytimeModule
} = require('../services/paytimeAccess');

const PayrollDataService        = require('../services/PayrollDataService');
const PayrollCalculationService = require('../services/PayrollCalculationService');
const PayrollHistoryService     = require('../services/PayrollHistoryService');

const { supabase } = require('../../../config/database');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

// ─── POST /api/payroll/run ────────────────────────────────────────────────────
/**
 * Run payroll for one or more employees in a period.
 *
 * Creates a payroll_run header record, calculates payroll for each requested
 * employee, and persists an immutable payroll_snapshot per employee.
 *
 * If a draft snapshot already exists for an employee in this period it is
 * replaced (upsert). If a FINALIZED snapshot exists, that employee is skipped
 * and reported in the errors list.
 *
 * Request Body:
 * {
 *   period_key:   "2026-04"  (required),
 *   employee_ids: [1, 2, 3]  (required, 1-200),
 *   start_date?:  "2026-04-10",
 *   end_date?:    "2026-04-30"
 * }
 *
 * Response:
 * {
 *   success: true,
 *   run_id: uuid,
 *   period_key: "2026-04",
 *   processed: [{ employee_id, snapshot_id, gross, net, paye, uif, sdl }],
 *   errors:    [{ employee_id, error }],
 *   totals:    { gross, net, paye, uif, sdl },
 *   timestamp: ISO-8601
 * }
 */
router.post(
  '/run',
  requirePermission('PAYROLL.APPROVE'),
  requirePaytimeModule('payroll'),
  async (req, res) => {
    try {
      const { period_key, employee_ids, start_date, end_date, voluntary_configs } = req.body;

      // ── Input validation ──────────────────────────────────────────────────
      if (!period_key) {
        return res.status(400).json({ success: false, error: 'period_key is required' });
      }
      if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
        return res.status(400).json({ success: false, error: 'employee_ids must be a non-empty array' });
      }
      if (employee_ids.length > 200) {
        return res.status(400).json({ success: false, error: 'Maximum 200 employees per run' });
      }

      const parsedIds = [...new Set(
        employee_ids.map(id => parseInt(id)).filter(id => !isNaN(id))
      )];
      if (parsedIds.length !== employee_ids.length) {
        // Either non-integer values present, or duplicates were silently removed
        // Re-check for non-integer specifically
        const nonInt = employee_ids.some(id => isNaN(parseInt(id)));
        if (nonInt) {
          return res.status(400).json({ success: false, error: 'All employee_ids must be integers' });
        }
        // Duplicates were removed — proceed with deduplicated list (no error)
      }

      // ── Guard: no re-run if period already finalized ──────────────────────
      const existingFinalizedRun = await PayrollHistoryService.getPayrollRun(
        supabase, req.companyId, period_key, 'finalized'
      );
      if (existingFinalizedRun) {
        return res.status(409).json({
          success: false,
          error: `Period ${period_key} is already finalized. Cannot re-run a finalized period.`,
          run_id: existingFinalizedRun.id
        });
      }

      // ── Employee visibility filter ────────────────────────────────────────
      const filter = await getEmployeeFilter(
        req.user.role, req.user.userId, req.companyId
      );

      let visibleIds = parsedIds;
      if (filter.type === 'ids') {
        visibleIds = parsedIds.filter(id => filter.ids.includes(id));
      } else if (filter.type === 'classification') {
        const { data: publicEmps } = await supabase
          .from('employees')
          .select('id')
          .eq('company_id', req.companyId)
          .eq('classification', 'public')
          .in('id', parsedIds);
        visibleIds = (publicEmps || []).map(e => e.id);
      }

      const deniedIds = parsedIds.filter(id => !visibleIds.includes(id));

      // ── Fetch period record once (used by every employee snapshot) ────────
      // Hoisted out of the per-employee loop — constant for all employees.
      let period;
      try {
        period = await PayrollDataService.fetchPeriod(req.companyId, period_key, supabase);
      } catch (err) {
        period = null;
      }
      if (!period) {
        return res.status(404).json({
          success: false,
          error: `Period ${period_key} not found for this company`
        });
      }

      // ── Create payroll_run header ─────────────────────────────────────────
      const run = await PayrollHistoryService.createPayrollRun(
        supabase, req.companyId, period_key, visibleIds.length, req.user.userId
      );

      // ── Load admin-configured tax tables from KV (once, shared across all employees) ──
      // Backend engine cannot use localStorage — load tax_config from Supabase KV.
      let batchTaxConfig = null;
      try {
        const { data: kvRow } = await supabase
          .from('payroll_kv_store_eco')
          .select('value')
          .eq('company_id', req.companyId)
          .eq('key', 'tax_config')
          .maybeSingle();
        if (kvRow && kvRow.value) {
          batchTaxConfig = typeof kvRow.value === 'string' ? JSON.parse(kvRow.value) : kvRow.value;
        }
      } catch (kvErr) {
        console.warn('[payruns] Could not load tax_config from KV:', kvErr.message);
      }

      // ── Process each employee ─────────────────────────────────────────────
      const processed = [];
      const errors    = [];

      // Seed errors for denied employees
      for (const id of deniedIds) {
        errors.push({ employee_id: id, error: 'Access denied to this employee' });
      }

      for (const empId of visibleIds) {
        try {
          // Check if a finalized snapshot already exists for this employee
          const existingSnap = await PayrollHistoryService.getSnapshot(
            supabase, req.companyId, empId, period_key
          );
          if (existingSnap && existingSnap.is_locked) {
            errors.push({
              employee_id: empId,
              error: `Snapshot already finalized for ${period_key} — skipped`
            });
            continue;
          }

          // Fetch normalized inputs
          const normalizedInputs = await PayrollDataService.fetchCalculationInputs(
            req.companyId, empId, period_key, supabase
          );

          // Inject voluntary tax config if provided in the request payload
          const volConfig = voluntary_configs && (voluntary_configs[String(empId)] || voluntary_configs[empId]);
          if (volConfig && volConfig.type) {
            normalizedInputs.employeeOptions = normalizedInputs.employeeOptions || {};
            normalizedInputs.employeeOptions.voluntaryTaxConfig = volConfig;
          }

          // Auto-detect per-employee proration from employee's own start/termination dates.
          // An employee hired after period start, or terminated before period end, must be
          // pro-rated for that period. Caller-explicit (global) dates take precedence.
          const empStartDate = normalizedInputs.start_date;        // from hire_date
          const empEndDate   = normalizedInputs.end_date;          // from termination_date
          const periodStart  = normalizedInputs.period_start_date;
          const periodEnd    = normalizedInputs.period_end_date;

          const autoNeedsProRata =
            (empStartDate && periodStart && empStartDate > periodStart) ||
            (empEndDate   && periodEnd   && empEndDate   < periodEnd);

          // Caller-explicit global dates override auto-detected employee dates
          const effectiveStartDate = start_date  || (autoNeedsProRata ? empStartDate  : null);
          const effectiveEndDate   = end_date    || (autoNeedsProRata ? empEndDate    : null);
          const useProRata         = !!(effectiveStartDate || effectiveEndDate);

          // Run calculation
          const calcResult = await PayrollCalculationService.calculate(
            normalizedInputs,
            {
              startDate:   effectiveStartDate,
              endDate:     effectiveEndDate,
              useProRata,
              taxConfig:   batchTaxConfig
            }
          );

          PayrollCalculationService.validateOutput(calcResult);

          // Prepare snapshot (pure function, no DB)
          // `period` was fetched once before the loop — reuse it here.
          const snapshot = PayrollHistoryService.prepareSnapshot(
            req.companyId, empId, period.id, period_key,
            normalizedInputs, calcResult, req.user.userId
          );

          // Persist — delete existing draft first if present, then insert
          if (existingSnap && !existingSnap.is_locked) {
            await supabase
              .from('payroll_snapshots')
              .delete()
              .eq('id', existingSnap.id);
          }

          const saved = await PayrollHistoryService.saveSnapshot(
            supabase, snapshot, run.id
          );

          processed.push({
            employee_id:   empId,
            snapshot_id:   saved.id,
            gross:         calcResult.gross,
            net:           calcResult.net,
            paye:          calcResult.paye,
            uif:           calcResult.uif,
            sdl:           calcResult.sdl,
            prorataFactor: calcResult.prorataFactor !== undefined ? calcResult.prorataFactor : null
          });

        } catch (empErr) {
          errors.push({
            employee_id: empId,
            error: empErr.message || 'Calculation failed'
          });
        }
      }

      // ── Compute run totals ────────────────────────────────────────────────
      const totals = processed.reduce(
        (acc, r) => {
          acc.totalGross += r.gross  || 0;
          acc.totalNet   += r.net    || 0;
          acc.totalPaye  += r.paye   || 0;
          acc.totalUif   += r.uif    || 0;
          acc.totalSdl   += r.sdl    || 0;
          return acc;
        },
        { totalGross: 0, totalNet: 0, totalPaye: 0, totalUif: 0, totalSdl: 0 }
      );

      // Round totals to 2dp
      for (const k of Object.keys(totals)) {
        totals[k] = Math.round(totals[k] * 100) / 100;
      }

      // ── Update run header with totals ─────────────────────────────────────
      await PayrollHistoryService.updatePayrollRunTotals(supabase, run.id, {
        processedCount: processed.length,
        errorCount:     errors.length,
        ...totals
      });

      // ── Audit log ─────────────────────────────────────────────────────────
      try {
        await auditFromReq(req, 'PAYROLL_RUN', 'payroll_runs', run.id, {
          period_key,
          employee_count: visibleIds.length,
          processed_count: processed.length,
          error_count: errors.length,
          total_gross: totals.totalGross,
          total_net:   totals.totalNet
        });
      } catch (auditErr) {
        console.warn('Audit log failed for payroll run:', auditErr.message);
      }

      res.json({
        success:    true,
        run_id:     run.id,
        period_key,
        processed,
        errors,
        totals: {
          gross: totals.totalGross,
          net:   totals.totalNet,
          paye:  totals.totalPaye,
          uif:   totals.totalUif,
          sdl:   totals.totalSdl
        },
        timestamp: new Date().toISOString()
      });

    } catch (err) {
      console.error('Payroll run error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error during payroll run',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  }
);


// ─── POST /api/payroll/finalize ───────────────────────────────────────────────
/**
 * Finalize (lock) all snapshots for a period.
 *
 * Once finalized:
 * - All draft snapshots for the period are marked is_locked = true
 * - The payroll_run header is marked status = 'finalized'
 * - No further recalculation is allowed for this period
 * - Corrections require a new snapshot (history service design principle)
 *
 * Request Body:
 * {
 *   period_key: "2026-04"  (required),
 *   run_id:     uuid       (required — must be the draft run to finalize)
 * }
 *
 * Response:
 * {
 *   success: true,
 *   run_id: uuid,
 *   period_key: "2026-04",
 *   locked_count: number,
 *   timestamp: ISO-8601
 * }
 */
router.post(
  '/finalize',   // POST /api/payroll/finalize
  requirePermission('PAYROLL.APPROVE'),
  requirePaytimeModule('payroll'),
  async (req, res) => {
    try {
      const { period_key, run_id } = req.body;

      if (!period_key || !run_id) {
        return res.status(400).json({
          success: false,
          error: 'period_key and run_id are required'
        });
      }

      // Verify run belongs to this company and is still draft
      const { data: run, error: runErr } = await supabase
        .from('payroll_runs')
        .select('*')
        .eq('id', run_id)
        .eq('company_id', req.companyId)
        .eq('period_key', period_key)
        .maybeSingle();

      if (runErr) throw runErr;

      if (!run) {
        return res.status(404).json({
          success: false,
          error: `Payroll run ${run_id} not found for period ${period_key}`
        });
      }

      if (run.status === 'finalized') {
        return res.status(409).json({
          success: false,
          error: `Payroll run ${run_id} is already finalized`
        });
      }

      // Lock all draft snapshots in this run
      const locked = await PayrollHistoryService.lockSnapshotsForPeriod(
        supabase, req.companyId, period_key, req.user.userId, run_id
      );

      // Mark the run as finalized
      await PayrollHistoryService.finalizePayrollRun(
        supabase, run_id, req.user.userId
      );

      // Audit log
      try {
        await auditFromReq(req, 'PAYROLL_FINALIZE', 'payroll_runs', run_id, {
          period_key,
          locked_count: locked.length
        });
      } catch (auditErr) {
        console.warn('Audit log failed for finalize:', auditErr.message);
      }

      res.json({
        success:      true,
        run_id,
        period_key,
        locked_count: locked.length,
        timestamp:    new Date().toISOString()
      });

    } catch (err) {
      console.error('Payroll finalize error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error during payroll finalization',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  }
);


// ─── GET /api/payroll/history ─────────────────────────────────────────────────
/**
 * Retrieve historical payroll snapshots.
 *
 * Query Parameters:
 *   period_key    (required)  — "2026-04"
 *   employee_id   (optional)  — filter to single employee
 *   status        (optional)  — 'draft' | 'finalized'
 *
 * Response:
 * {
 *   success: true,
 *   period_key: "2026-04",
 *   count: number,
 *   snapshots: [{ id, employee_id, period_key, status, is_locked,
 *                 engine_version, schema_version, created_at, finalized_at,
 *                 calculation_output, _includes_input }],
 *   timestamp: ISO-8601
 * }
 */
router.get(
  '/history',   // GET /api/payroll/history
  requirePermission('PAYROLL.VIEW'),
  requirePaytimeModule('payroll'),
  async (req, res) => {
    try {
      const { period_key, employee_id, status } = req.query;

      if (!period_key) {
        return res.status(400).json({
          success: false,
          error: 'period_key query parameter is required'
        });
      }

      const opts = {};
      if (employee_id) {
        const empId = parseInt(employee_id);
        if (isNaN(empId)) {
          return res.status(400).json({ success: false, error: 'employee_id must be an integer' });
        }

        // Visibility check for single-employee queries
        const filter = await getEmployeeFilter(
          req.user.role, req.user.userId, req.companyId
        );

        let canAccess = filter.type === 'none';
        if (filter.type === 'ids') {
          canAccess = filter.ids.includes(empId);
        } else if (filter.type === 'classification') {
          const { data: emp } = await supabase
            .from('employees')
            .select('classification')
            .eq('company_id', req.companyId)
            .eq('id', empId)
            .maybeSingle();
          canAccess = emp && emp.classification === 'public';
        }

        if (!canAccess) {
          return res.status(403).json({ success: false, error: 'Access denied to this employee' });
        }

        opts.employeeId = empId;
      }

      if (status && !['draft', 'finalized'].includes(status)) {
        return res.status(400).json({ success: false, error: 'status must be draft or finalized' });
      }
      if (status) opts.status = status;

      const snapshots = await PayrollHistoryService.listSnapshots(
        supabase, req.companyId, period_key, opts
      );

      res.json({
        success:    true,
        period_key,
        count:      snapshots.length,
        snapshots:  snapshots.map(PayrollHistoryService.formatForResponse),
        timestamp:  new Date().toISOString()
      });

    } catch (err) {
      console.error('Payroll history error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error fetching payroll history',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  }
);


// ─── GET /api/payroll/history/run/:run_id ─────────────────────────────────────
/**
 * Retrieve the payroll_run header for a specific run.
 *
 * Response: { success, run: { ...payroll_run fields }, timestamp }
 */
router.get(
  '/history/run/:run_id',  // GET /api/payroll/history/run/:run_id
  requirePermission('PAYROLL.VIEW'),
  requirePaytimeModule('payroll'),
  async (req, res) => {
    try {
      const { run_id } = req.params;

      const { data: run, error } = await supabase
        .from('payroll_runs')
        .select('*')
        .eq('id', run_id)
        .eq('company_id', req.companyId)
        .maybeSingle();

      if (error) throw error;

      if (!run) {
        return res.status(404).json({ success: false, error: `Run ${run_id} not found` });
      }

      res.json({ success: true, run, timestamp: new Date().toISOString() });

    } catch (err) {
      res.status(500).json({ success: false, error: 'Server error' });
    }
  }
);

module.exports = router;
