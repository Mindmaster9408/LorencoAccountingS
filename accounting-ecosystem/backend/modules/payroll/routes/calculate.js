/**
 * ============================================================================
 * Payroll Calculation API Endpoint - /api/payroll/calculate
 * ============================================================================
 * Purpose: Expose the unified payroll calculation through a clean backend API.
 *
 * This endpoint:
 * 1. Accepts calculation request (employee, period, optional overrides)
 * 2. Fetches normalized inputs via PayrollDataService
 * 3. Executes calculation via PayrollCalculationService
 * 4. Prepares snapshot via PayrollHistoryService
 * 5. Returns stable, auditable result
 *
 * Single source of truth for payroll calculations (backend authority).
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
const { getCalculationBlocks, describeCalculationBlocks } = require('../services/periodSequence');
const { getTaxConfigForPeriod } = require('../services/taxTables');
const { payrollEligibility } = require('../services/payrollEligibility');

const { supabase } = require('../../../config/database');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * POST /api/payroll/calculate
 *
 * Calculate payroll for an employee in a specific period.
 *
 * Request Body:
 * {
 *   employee_id: number (required),
 *   period_key: "2026-04" (required),
 *   start_date: "2026-04-10" (optional, for pro-rata),
 *   end_date: "2026-04-30" (optional, for pro-rata),
 *   include_snapshot: boolean (default: true)
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   data: {
 *     // Locked calculation fields (13)
 *     gross, taxableGross, paye, ...,
 *     // Pro-rata fields (if applicable)
 *     prorataFactor, expectedHoursInPeriod, workedHoursInPeriod,
 *     // Metadata
 *     _meta: { calculatedAt, engineVersion, ... }
 *   },
 *   snapshot: { },  // full snapshot if include_snapshot: true
 *   timestamp: ISO-8601
 * }
 *
 * Errors:
 * - 400: Invalid request (missing employee_id or period_key)
 * - 403: Permission denied or employee not visible to user
 * - 404: Employee or period not found
 * - 500: Calculation failed
 */
router.post(
  '/',
  requirePermission('PAYROLL.VIEW'),
  requirePaytimeModule('payroll'),
  async (req, res) => {
    try {
      const {
        employee_id,
        period_key,
        start_date,
        end_date,
        include_snapshot
      } = req.body;

      // Validate required fields
      if (!employee_id || !period_key) {
        return res.status(400).json({
          success: false,
          error: 'employee_id and period_key are required'
        });
      }

      // Parse employee_id as integer
      const empId = parseInt(employee_id);
      if (isNaN(empId)) {
        return res.status(400).json({
          success: false,
          error: 'employee_id must be an integer'
        });
      }

      // STEP 1: Check employee visibility (permission scope)
      const filter = await getEmployeeFilter(
        req.user.role,
        req.user.userId,
        req.companyId
      );

      let canAccess = false;
      if (filter.type === 'none') {
        canAccess = true;
      } else if (filter.type === 'ids') {
        canAccess = filter.ids.includes(empId);
      } else if (filter.type === 'classification') {
        // Need to check employee's classification
        const { data: emp } = await supabase
          .from('employees')
          .select('classification')
          .eq('company_id', req.companyId)
          .eq('id', empId)
          .maybeSingle();
        canAccess = emp && emp.classification === 'public';
      }

      if (!canAccess) {
        return res.status(403).json({
          success: false,
          error: 'Access denied to this employee'
        });
      }

      // STEP 1b: Finalization guard.
      // If a locked snapshot already exists for this employee + period, return it
      // directly without recalculating. Finalized payslips are immutable by design.
      const existingSnapshot = await PayrollHistoryService.getSnapshot(
        supabase, req.companyId, empId, period_key
      );
      if (existingSnapshot && existingSnapshot.is_locked) {
        const formatted = PayrollHistoryService.formatForResponse(existingSnapshot);
        return res.json({
          success:   true,
          data:      formatted.calculation_output || {},
          snapshot:  formatted,
          locked:    true,
          timestamp: new Date().toISOString()
        });
      }

      // STEP 1c: Month-order guard (UF-04, strict companies only — migration 026).
      // A finalized month is still returned above; an open month can only be
      // calculated once the previous month is finalized, because PAYE year-to-date
      // is built from the finalized months.
      let calcBlocks;
      try {
        calcBlocks = await getCalculationBlocks(supabase, req.companyId, [empId], period_key);
      } catch (blkErr) {
        return res.status(500).json({ success: false, error: 'Could not verify previous months: ' + blkErr.message });
      }
      if (calcBlocks.length > 0) {
        return res.status(422).json({
          success: false,
          code:    'PREVIOUS_MONTH_OPEN',
          error:   describeCalculationBlocks(period_key, calcBlocks),
          blocked: calcBlocks
        });
      }

      // STEP 1d: Eligibility (Fase 5 — WN-10 / UF-02): no payslip for a month before the
      // employee starts or after they left. Same rule as Execute Payroll.
      if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period_key))) {
        const [py, pm] = period_key.split('-').map(Number);
        const pStart = `${period_key}-01`;
        const pEnd   = `${period_key}-${String(new Date(Date.UTC(py, pm, 0)).getUTCDate()).padStart(2, '0')}`;
        const { data: empRow } = await supabase
          .from('employees')
          .select('is_active, hire_date, termination_date, first_name, last_name')
          .eq('company_id', req.companyId)
          .eq('id', empId)
          .maybeSingle();
        const elig = payrollEligibility(empRow, pStart, pEnd);
        if (!elig.eligible) {
          return res.status(elig.code === 'NOT_FOUND' ? 404 : 422).json({
            success: false, code: elig.code, error: elig.message
          });
        }
      }

      // STEP 2: Fetch and normalize calculation inputs
      let normalizedInputs;
      try {
        normalizedInputs = await PayrollDataService.fetchCalculationInputs(
          req.companyId,
          empId,
          period_key,
          supabase
        );
      } catch (err) {
        if (err.message.includes('Period not found')) {
          return res.status(404).json({
            success: false,
            error: `Period ${period_key} not found`
          });
        }
        if (err.message.includes('Employee not found')) {
          return res.status(404).json({
            success: false,
            error: `Employee ${empId} not found`
          });
        }
        throw err;
      }

      // STEP 3: Tax tables of THIS period's tax year (spec 02, Fase 1 — services/taxTables.js).
      // A missing / unconfirmed year stops the calculation with a clear message.
      let taxConfig;
      try {
        taxConfig = await getTaxConfigForPeriod(supabase, req.companyId, period_key);
      } catch (ttErr) {
        if (ttErr.code === 'TAX_TABLES_MISSING') {
          return res.status(422).json({ success: false, code: ttErr.code, error: ttErr.message });
        }
        throw ttErr;
      }

      // STEP 4: Execute calculation
      // Auto-detect per-employee proration from employee's own start/termination dates.
      // Explicit start_date/end_date from the request body take precedence.
      const empStartDate = normalizedInputs.start_date;
      const empEndDate   = normalizedInputs.end_date;
      const periodStart  = normalizedInputs.period_start_date;
      const periodEnd    = normalizedInputs.period_end_date;

      const autoNeedsProRata =
        (empStartDate && periodStart && empStartDate > periodStart) ||
        (empEndDate   && periodEnd   && empEndDate   < periodEnd);

      const effectiveStartDate = start_date  || (autoNeedsProRata ? empStartDate  : null);
      const effectiveEndDate   = end_date    || (autoNeedsProRata ? empEndDate    : null);
      const useProRata         = !!(effectiveStartDate || effectiveEndDate);

      let calculationResult;
      try {
        calculationResult = await PayrollCalculationService.calculate(
          normalizedInputs,
          {
            startDate:  effectiveStartDate,
            endDate:    effectiveEndDate,
            useProRata,
            taxConfig
          }
        );
      } catch (err) {
        return res.status(500).json(
          PayrollCalculationService.formatError(err)
        );
      }

      // STEP 5: Validate output
      try {
        PayrollCalculationService.validateOutput(calculationResult);
      } catch (err) {
        console.error('Calculation output validation failed:', err);
        return res.status(500).json({
          success: false,
          error: 'Calculation output validation failed'
        });
      }

      // STEP 6: Prepare snapshot if requested
      let snapshot = null;
      if (include_snapshot !== false) {
        try {
          const period = await PayrollDataService.fetchPeriod(
            req.companyId,
            period_key,
            supabase
          );

          snapshot = PayrollHistoryService.prepareSnapshot(
            req.companyId,
            empId,
            period.id,
            period_key,
            normalizedInputs,
            calculationResult,
            req.user.userId
          );

          PayrollHistoryService.validateSnapshot(snapshot);
        } catch (err) {
          console.error('Snapshot preparation failed:', err);
          // Don't fail the calculation if snapshot prep fails
          // Just omit it from response
          snapshot = null;
        }
      }

      // STEP 7: Format and return response
      const response = {
        success: true,
        data: PayrollCalculationService.formatForResponse(calculationResult).data,
        ...(snapshot && { snapshot }),
        timestamp: new Date().toISOString()
      };

      // STEP 8: Audit log (if auditing is configured)
      try {
        await auditFromReq(req, 'CALCULATE', 'payroll_calculation', empId, {
          module: 'payroll',
          period_key,
          start_date,
          end_date,
          gross: calculationResult.gross,
          net: calculationResult.net
        });
      } catch (auditErr) {
        console.warn('Audit logging failed:', auditErr.message);
        // Don't fail the response if audit fails
      }

      res.json(response);
    } catch (err) {
      console.error('Payroll calculation endpoint error:', err);
      res.status(500).json({
        success: false,
        error: 'Internal server error during payroll calculation',
        message:
          process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  }
);

/**
 * POST /api/payroll/calculate/net-to-gross   (Fase 9, spec 11 NG-01/02)
 *
 * Body: { target_net, period_key?, age?, medical_members?, tax_directive?, search_limit?,
 *         items: [{ description, type: 'taxable'|'nontaxable'|'deduction', amount, once_off?, pre_tax? }] }
 * Allowances are recurring unless once_off is true. Uses the period's tax tables (default:
 * the current month). Pure calculation — nothing is saved.
 */
router.post(
  '/net-to-gross',
  requirePermission('PAYROLL.VIEW'),
  requirePaytimeModule('payroll'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const targetNet = parseFloat(b.target_net);
      if (!(targetNet > 0)) return res.status(400).json({ success: false, error: 'target_net must be greater than zero' });
      const periodKey = /^\d{4}-(0[1-9]|1[0-2])$/.test(b.period_key || '')
        ? b.period_key : new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 7);

      let taxConfig;
      try {
        taxConfig = await getTaxConfigForPeriod(supabase, req.companyId, periodKey);
      } catch (ttErr) {
        if (ttErr.code === 'TAX_TABLES_MISSING') return res.status(422).json({ success: false, code: ttErr.code, error: ttErr.message });
        throw ttErr;
      }

      const regularItems = [], onceOffItems = [];
      (Array.isArray(b.items) ? b.items : []).forEach(i => {
        const amount = parseFloat(i.amount) || 0;
        if (!amount) return;
        const isDed = i.type === 'deduction';
        const item = {
          description: String(i.description || (isDed ? 'Deduction' : 'Allowance')).slice(0, 100),
          type: isDed ? 'deduction' : 'allowance',
          amount,
          is_taxable: !isDed && i.type !== 'nontaxable',
          tax_treatment: isDed && i.pre_tax ? 'pre_tax' : 'net_only'
        };
        if (i.once_off) onceOffItems.push(Object.assign(item, { type: isDed ? 'deduction' : 'income', paye_projection_type: 'ONCE_OFF' }));
        else regularItems.push(item);
      });

      const employeeOptions = {};
      if (parseInt(b.age, 10) > 0) employeeOptions.age = parseInt(b.age, 10);
      if (parseInt(b.medical_members, 10) > 0) employeeOptions.medicalMembers = parseInt(b.medical_members, 10);
      if (parseFloat(b.tax_directive) > 0) employeeOptions.taxDirective = parseFloat(b.tax_directive);

      const result = PayrollCalculationService.netToGross({
        targetNet, regularItems, onceOffItems, employeeOptions, period: periodKey,
        basicSalaryHi: parseFloat(b.search_limit) > 0 ? Math.min(parseFloat(b.search_limit), 5000000) : 500000
      }, { taxConfig });

      res.status(result.success ? 200 : 422).json(Object.assign({ period_key: periodKey }, result));
    } catch (err) {
      console.error('[net-to-gross] error:', err);
      res.status(500).json({ success: false, error: 'Server error: ' + err.message });
    }
  }
);

/**
 * POST /api/payroll/calculate/batch
 *
 * Alias for POST /api/payroll/run — use that endpoint for batch payroll runs.
 * This stub is kept for backwards compatibility and discoverability.
 */
router.post('/batch', requirePermission('PAYROLL.APPROVE'), (req, res) => {
  res.status(308).json({
    success: false,
    error: 'Use POST /api/payroll/run for batch payroll execution',
    redirect: '/api/payroll/run'
  });
});

/**
 * GET /api/payroll/calculate/history/:employee_id/:period_key
 *
 * Retrieve finalized payroll snapshot for an employee in a period.
 *
 * Response:
 * {
 *   success: boolean,
 *   snapshot: { },  // full snapshot if include_snapshot: true
 *   timestamp: ISO-8601
 * }
 */
router.get(
  '/history/:employee_id/:period_key',
  requirePermission('PAYROLL.VIEW'),
  requirePaytimeModule('payroll'),
  async (req, res) => {
    try {
      const empId = parseInt(req.params.employee_id);
      const { period_key } = req.params;

      if (isNaN(empId) || !period_key) {
        return res.status(400).json({
          success: false,
          error: 'Invalid employee_id or period_key'
        });
      }

      // Check employee visibility
      const filter = await getEmployeeFilter(
        req.user.role,
        req.user.userId,
        req.companyId
      );

      let canAccess = false;
      if (filter.type === 'none') {
        canAccess = true;
      } else if (filter.type === 'ids') {
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
        return res.status(403).json({
          success: false,
          error: 'Access denied'
        });
      }

      // Fetch snapshot from payroll_snapshots table
      const snapshot = await PayrollHistoryService.getSnapshot(
        supabase, req.companyId, empId, period_key
      );

      if (!snapshot) {
        return res.status(200).json({
          success: false,
          snapshot: null,
          error: null
        });
      }

      res.json({
        success:   true,
        snapshot:  PayrollHistoryService.formatForResponse(snapshot),
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: 'Server error'
      });
    }
  }
);

module.exports = router;
