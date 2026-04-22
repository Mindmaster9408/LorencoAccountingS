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

      // STEP 3: Fetch admin-configured tax tables from Supabase KV.
      // The backend engine cannot use localStorage, so we load the tax_config
      // stored by the Tax Configuration UI and pass it directly to the engine.
      //
      // Lookup order:
      //   1. Company-specific config (company_id = req.companyId)
      //   2. Global ecosystem default (company_id = '__global__') — set by super admin
      //      in Infinite Legacy / managing practice account.
      let taxConfig = null;
      try {
        const { data: kvRow } = await supabase
          .from('payroll_kv_store_eco')
          .select('value')
          .eq('company_id', req.companyId)
          .eq('key', 'tax_config')
          .maybeSingle();
        if (kvRow && kvRow.value) {
          taxConfig = typeof kvRow.value === 'string' ? JSON.parse(kvRow.value) : kvRow.value;
        }
        // Fallback: if this company has no custom tax_config, use the global standard
        // set by the super admin (stored with sentinel company_id = '__global__').
        if (!taxConfig) {
          const { data: globalKvRow } = await supabase
            .from('payroll_kv_store_eco')
            .select('value')
            .eq('company_id', '__global__')
            .eq('key', 'tax_config')
            .maybeSingle();
          if (globalKvRow && globalKvRow.value) {
            taxConfig = typeof globalKvRow.value === 'string'
              ? JSON.parse(globalKvRow.value)
              : globalKvRow.value;
            console.log('[payroll/calculate] Using global tax_config (no company-specific override).');
          }
        }
      } catch (kvErr) {
        console.warn('[payroll/calculate] Could not load tax_config from KV:', kvErr.message);
        // Non-fatal — engine falls back to hardcoded defaults
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
        return res.status(404).json({
          success: false,
          error: `No payroll snapshot found for employee ${empId} in period ${period_key}`
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
