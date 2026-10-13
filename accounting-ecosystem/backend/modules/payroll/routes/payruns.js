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
// Month-order rules (UF-04 / UF-09) — shared with routes/calculate.js.
const {
  taxYearPeriodKeys,
  findPeriodSequenceViolations,
  describeLaterLocked,
  describeOpenEarlier,
  describeCalculationBlocks,
  isStrictPeriodOrder,
  loadEmployeesAndLocked,
  getCalculationBlocks
} = require('../services/periodSequence');
const { getTaxConfigForPeriod } = require('../services/taxTables');
const { payrollEligibility } = require('../services/payrollEligibility');

const router = express.Router();

// ─── Pure helper — exported for unit testing ──────────────────────────────────
/**
 * Returns true when an employee row should be included in the payroll run.
 * Active employees always pass. Inactive employees pass only when their
 * termination_date falls within the pay period (final pro-rata month).
 *
 * @param {object|null} empRow      - { is_active, termination_date } or null if not found
 * @param {string}      periodStart - period start date string "YYYY-MM-DD"
 * @param {string}      periodEnd   - period end date string "YYYY-MM-DD"
 */
function isEligibleForPayroll(empRow, periodStart, periodEnd) {
  // Fase 5: one shared rule (services/payrollEligibility.js) — also blocks a hire date
  // after the period (WN-10) and a termination before it (UF-02).
  return payrollEligibility(empRow, periodStart, periodEnd).eligible;
}

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

      // NOTE: The period-level finalization guard was removed.
      // The per-employee guard below already skips employees with locked snapshots,
      // so supplemental runs (adding employees missed in the original run) are allowed.
      // The finalize endpoint still prevents double-finalizing a specific run_id.

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
      // Auto-create if missing — period dates are fully derivable from period_key.
      let period;
      try {
        period = await PayrollDataService.fetchPeriod(req.companyId, period_key, supabase);
      } catch (err) {
        period = null;
      }
      if (!period) {
        // Auto-create the period from period_key (YYYY-MM)
        const [pyear, pmonth] = period_key.split('-').map(Number);
        if (!pyear || !pmonth || pmonth < 1 || pmonth > 12) {
          return res.status(400).json({ success: false, error: `Invalid period_key format: ${period_key}` });
        }
        const startDate = `${pyear}-${String(pmonth).padStart(2,'0')}-01`;
        const lastDay   = new Date(pyear, pmonth, 0).getDate();
        const endDate   = `${pyear}-${String(pmonth).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
        const payDate   = `${pyear}-${String(pmonth).padStart(2,'0')}-25`;
        const taxYear   = pmonth >= 3 ? `${pyear}/${pyear+1}` : `${pyear-1}/${pyear}`;
        try {
          const monthName = new Date(pyear, pmonth - 1, 1).toLocaleString('en-ZA', { month: 'long', year: 'numeric' });
          const periodInsert = {
            company_id:  req.companyId,
            period_key,
            start_date:  startDate,
            end_date:    endDate,
            period_name: monthName,
          };
          const { data: newPeriod, error: pErr } = await supabase
            .from('payroll_periods')
            .insert(periodInsert)
            .select('id, start_date, end_date, period_key')
            .single();
          if (pErr) throw pErr;
          period = newPeriod;
          console.log(`[payruns] Auto-created period ${period_key} for company ${req.companyId}`);
        } catch (autoErr) {
          return res.status(500).json({
            success: false,
            error: `Period ${period_key} not found and could not be auto-created: ${autoErr.message}`
          });
        }
      }

      // ── Tax tables of this period's tax year (spec 02, Fase 1) ────────────
      // Loaded BEFORE the run header is created, so a missing / unconfirmed year
      // stops the run cleanly instead of leaving an empty run behind.
      let batchTaxConfig;
      try {
        batchTaxConfig = await getTaxConfigForPeriod(supabase, req.companyId, period_key);
      } catch (ttErr) {
        if (ttErr.code === 'TAX_TABLES_MISSING') {
          return res.status(422).json({ success: false, code: ttErr.code, error: ttErr.message });
        }
        throw ttErr;
      }

      // ── Create payroll_run header ─────────────────────────────────────────
      const run = await PayrollHistoryService.createPayrollRun(
        supabase, req.companyId, period_key, visibleIds.length, req.user.userId
      );

      // ── Month-order guard for strict companies (UF-04, migration 026) ─────
      // An employee whose previous month is not finalized cannot be calculated —
      // their PAYE year-to-date would be built on incomplete data.
      let calcBlocks = [];
      try {
        calcBlocks = await getCalculationBlocks(supabase, req.companyId, visibleIds, period_key);
      } catch (blkErr) {
        return res.status(500).json({ success: false, error: 'Could not verify previous months: ' + blkErr.message });
      }
      const blockedIds = new Set(calcBlocks.map(b => String(b.employee_id)));

      // ── Process each employee ─────────────────────────────────────────────
      const processed = [];
      const errors    = [];

      for (const b of calcBlocks) {
        errors.push({ employee_id: b.employee_id, code: 'PREVIOUS_MONTH_OPEN', error: describeCalculationBlocks(period_key, [b]) });
      }

      // Seed errors for denied employees
      for (const id of deniedIds) {
        errors.push({ employee_id: id, error: 'Access denied to this employee' });
      }

      for (const empId of visibleIds) {
        if (blockedIds.has(String(empId))) continue;
        try {
          // Guard: verify employee belongs to this company and is eligible for payroll.
          // Active employees pass. Inactive employees pass only when their termination_date
          // falls within the pay period (final pro-rata month). This prevents processing
          // terminated employees even if their IDs are passed directly in the request body.
          const { data: empRow } = await supabase
            .from('employees')
            .select('is_active, hire_date, termination_date, first_name, last_name')
            .eq('id', empId)
            .eq('company_id', req.companyId)
            .single();

          const elig = payrollEligibility(empRow, period.start_date, period.end_date);
          if (!elig.eligible) {
            errors.push({ employee_id: empId, code: elig.code, error: elig.message });
            continue;
          }

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

          // Inject voluntary tax config if provided in the request payload.
          // Accepts array (multi-entry) or legacy single object — both handled by the engine.
          const volConfig = voluntary_configs && (voluntary_configs[String(empId)] || voluntary_configs[empId]);
          const hasVolConfig = volConfig && (
            Array.isArray(volConfig) ? volConfig.length > 0 : !!volConfig.type
          );
          if (hasVolConfig) {
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

          // Pro-rata is only meaningful when the hire/leave date falls WITHIN the period.
          // If hire_date is after the period end (e.g. employee added retroactively), skip
          // auto-proration — the user explicitly selected them, treat as full-month.
          const autoNeedsProRata =
            (empStartDate && periodStart && periodEnd &&
              empStartDate > periodStart && empStartDate <= periodEnd) ||
            (empEndDate   && periodStart && periodEnd &&
              empEndDate   < periodEnd   && empEndDate  >= periodStart);

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

      // ── Fase 6 / UF-06: older draft runs of this month whose payslips all moved
      // into this run are marked 'superseded' (cannot be finalized any more).
      const supersededRunIds = await PayrollHistoryService.markSupersededRuns(
        supabase, req.companyId, period_key, run.id
      );

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
        superseded_run_ids: supersededRunIds,
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

      // Fase 6 / UF-06: a replaced or reversed run can never be finalized.
      if (run.status === 'superseded') {
        return res.status(409).json({
          success: false,
          code:    'RUN_SUPERSEDED',
          error:   `This pay run was replaced by a newer run for ${period_key}. Finalize the newest run instead.`,
          superseded_by_run_id: run.superseded_by_run_id || null
        });
      }
      if (run.status === 'reversed') {
        return res.status(409).json({ success: false, error: `Payroll run ${run_id} was reversed` });
      }

      // Month-order guard (UF-04): refuse — and lock nothing — if finalizing this month
      // would lock it on incomplete year-to-date data.
      let openEarlier = [];
      const { data: runSnaps, error: rsErr } = await supabase
        .from('payroll_snapshots')
        .select('employee_id')
        .eq('company_id', req.companyId)
        .eq('payroll_run_id', run_id)
        .eq('is_locked', false);
      if (rsErr) throw rsErr;
      const runEmpIds = [...new Set((runSnaps || []).map(s => s.employee_id))];
      // Fase 6 / UF-06: a run that no longer owns any open payslip was replaced by a
      // newer run (its employees were recalculated there) — finalizing it would lock nothing
      // and mark stale totals as final.
      if (runEmpIds.length === 0) {
        return res.status(409).json({
          success: false,
          code:    'RUN_SUPERSEDED',
          error:   'This pay run has no open payslips left — they were recalculated in a newer run for ' + period_key + '. Finalize the newest run instead.'
        });
      }
      {
        const { employees: empRows, lockedRows } =
          await loadEmployeesAndLocked(supabase, req.companyId, runEmpIds, period_key);
        const violations = findPeriodSequenceViolations(period_key, empRows, lockedRows);
        const laterLocked = violations.filter(v => v.type === 'later_locked');
        if (laterLocked.length > 0) {
          return res.status(422).json({
            success:    false,
            code:       'PERIOD_SEQUENCE',
            error:      describeLaterLocked(period_key, laterLocked),
            violations: laterLocked
          });
        }
        openEarlier = violations.filter(v => v.type === 'missing_previous');
        // Strict companies (migration 026): open earlier months are a hard block, no confirmation.
        if (openEarlier.length > 0 && await isStrictPeriodOrder(supabase, req.companyId)) {
          return res.status(422).json({
            success:    false,
            code:       'PERIOD_SEQUENCE',
            error:      describeCalculationBlocks(period_key, openEarlier),
            violations: openEarlier
          });
        }
        if (openEarlier.length > 0 && req.body.acknowledge_open_months !== true) {
          return res.status(422).json({
            success:               false,
            code:                  'OPEN_EARLIER_MONTHS',
            requires_confirmation: true,
            error:                 describeOpenEarlier(period_key, openEarlier),
            violations:            openEarlier
          });
        }
      }

      // Lock all draft snapshots in this run
      let locked;
      try {
        locked = await PayrollHistoryService.lockSnapshotsForPeriod(
          supabase, req.companyId, period_key, req.user.userId, run_id
        );
      } catch (lockErr) {
        console.error('[finalize] lockSnapshotsForPeriod failed:', lockErr);
        return res.status(500).json({ success: false, error: 'Failed to lock snapshots', detail: lockErr.message });
      }

      // Mark the run as finalized
      try {
        await PayrollHistoryService.finalizePayrollRun(
          supabase, run_id, req.user.userId
        );
      } catch (finalErr) {
        console.error('[finalize] finalizePayrollRun failed:', finalErr);
        return res.status(500).json({ success: false, error: 'Failed to finalize run', detail: finalErr.message });
      }

      // Audit log
      try {
        await auditFromReq(req, 'PAYROLL_FINALIZE', 'payroll_runs', run_id, {
          period_key,
          locked_count: locked.length,
          // Who confirmed finalizing despite open earlier months (UF-04, option a).
          ...(openEarlier.length > 0 && {
            acknowledged_open_months: openEarlier.map(v => ({ employee_id: v.employee_id, periods: v.periods }))
          })
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
        detail: err.message
      });
    }
  }
);


// ─── POST /api/payroll/reverse ────────────────────────────────────────────────
/**
 * Reverse a finalized payroll run.
 *
 * Sets the run status to 'reversed' and all its snapshots to 'reversed' +
 * is_locked=false. This allows a corrected re-run + re-finalization for the
 * same period. Reversed rows are NEVER deleted — full audit trail is preserved.
 *
 * Request Body:
 * {
 *   run_id:    uuid    (required — must be a finalized run for this company),
 *   period_key: "2026-04" (required — for verification),
 *   reason:    string  (required — mandatory audit trail entry)
 * }
 *
 * Response:
 * {
 *   success: true,
 *   run_id: uuid,
 *   period_key: "2026-04",
 *   reversed_count: number,
 *   timestamp: ISO-8601
 * }
 */
router.post(
  '/reverse',
  requirePermission('PAYROLL.APPROVE'),
  requirePaytimeModule('payroll'),
  async (req, res) => {
    try {
      const { run_id, period_key, reason } = req.body;

      if (!run_id || !period_key) {
        return res.status(400).json({ success: false, error: 'run_id and period_key are required' });
      }
      if (!reason || !reason.trim()) {
        return res.status(400).json({ success: false, error: 'reason is required for reversal audit trail' });
      }

      // Verify the run belongs to this company, matches the period, and is finalized
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

      if (run.status === 'reversed') {
        return res.status(409).json({
          success: false,
          error: `Payroll run ${run_id} is already reversed`
        });
      }

      if (run.status !== 'finalized') {
        return res.status(400).json({
          success: false,
          error: `Only finalized pay runs can be reversed (current status: ${run.status})`
        });
      }

      // Reverse all snapshots in this run (unlock them for correction)
      let reversedSnapshots;
      try {
        reversedSnapshots = await PayrollHistoryService.reverseSnapshotsForRun(
          supabase, run_id, req.companyId, req.user.userId
        );
      } catch (snapErr) {
        console.error('[reverse] reverseSnapshotsForRun failed:', snapErr);
        return res.status(500).json({ success: false, error: 'Failed to reverse snapshots', detail: snapErr.message });
      }

      // Reverse the run header
      try {
        await PayrollHistoryService.reversePayrollRun(
          supabase, run_id, req.companyId, req.user.userId, reason.trim()
        );
      } catch (runReverseErr) {
        console.error('[reverse] reversePayrollRun failed:', runReverseErr);
        return res.status(500).json({ success: false, error: 'Failed to reverse run header', detail: runReverseErr.message });
      }

      // UF-09: later months in the same tax year that are still locked were calculated on
      // this month's (now reversed) figures. Never blocks — reported so the user can decide
      // whether to reverse them too. Best-effort: a lookup failure must not fail the reversal.
      let laterPeriodsLocked = [];
      try {
        const revEmpIds = [...new Set((reversedSnapshots || []).map(s => s.employee_id))];
        const laterKeys = taxYearPeriodKeys(period_key).filter(p => p > period_key);
        if (revEmpIds.length && laterKeys.length) {
          const { data: laterRows } = await supabase
            .from('payroll_snapshots')
            .select('employee_id, period_key')
            .eq('company_id', req.companyId)
            .eq('is_locked', true)
            .in('employee_id', revEmpIds)
            .in('period_key', laterKeys);
          laterPeriodsLocked = [...new Set((laterRows || []).map(r => r.period_key))].sort();
        }
      } catch (laterErr) {
        console.warn('[reverse] later-period check failed (non-fatal):', laterErr.message);
      }

      // Audit log
      try {
        await auditFromReq(req, 'PAYROLL_REVERSE', 'payroll_runs', run_id, {
          period_key,
          reason:          reason.trim(),
          reversed_count:  reversedSnapshots.length
        });
      } catch (auditErr) {
        console.warn('Audit log failed for reversal:', auditErr.message);
      }

      res.json({
        success:         true,
        run_id,
        period_key,
        reversed_count:  reversedSnapshots.length,
        later_periods_locked: laterPeriodsLocked,
        timestamp:       new Date().toISOString()
      });

    } catch (err) {
      console.error('Payroll reverse error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error during pay run reversal',
        detail: err.message
      });
    }
  }
);


// ─── GET /api/payroll/history ─────────────────────────────────────────────────
/**
 * Retrieve historical payroll snapshots.
 *
 * Query Parameters:
 *   period_key       (required)  — "2026-04"
 *   employee_id      (optional)  — filter to single employee
 *   status           (optional)  — 'draft' | 'finalized' | 'reversed'
 *   include_reversed (optional)  — 'true' to include reversed snapshots
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
      const { period_key, employee_id, status, include_reversed } = req.query;

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

      if (status && !['draft', 'finalized', 'reversed'].includes(status)) {
        return res.status(400).json({ success: false, error: 'status must be draft, finalized, or reversed' });
      }
      if (status) opts.status = status;
      if (include_reversed === 'true') opts.includeReversed = true;

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

router.isEligibleForPayroll = isEligibleForPayroll;
module.exports = router;
