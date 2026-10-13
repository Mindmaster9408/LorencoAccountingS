/**
 * ============================================================================
 * Voluntary Tax Routes — Payroll Module
 * ============================================================================
 * Backend-authoritative calculation for voluntary tax over-deduction entries.
 *
 * POST /api/payroll/voluntary-tax/calculate-bonus-spread
 *   Calculates the incremental monthly PAYE needed to spread a bonus's tax
 *   liability across N periods. Frontend never calculates this — engine only.
 * ============================================================================
 */

'use strict';

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const PayrollDataService       = require('../services/PayrollDataService');
const PayrollCalculationService = require('../services/PayrollCalculationService');
const { taxYearPeriodKeys } = require('../services/periodSequence');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

const { getTaxConfigForPeriod } = require('../services/taxTables');

function addMonths(periodKey, n) {
  const [y, m] = periodKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * POST /api/payroll/voluntary-tax/calculate-bonus-spread
 * Spec: docs/paytime/spec/06_BEREKENINGSENJIN.md §E.4 (VPA-11, VPA-12, VPA-17)
 *
 *   X       = extra statutory PAYE the bonus causes in its own payment month
 *             (PAYE with the bonus as once-off income − PAYE without it, same month,
 *              same year-to-date, same tax tables as Execute Payroll)
 *   monthly = X ÷ num_periods
 *
 * The spread runs num_periods months from start_period and must end by February of the
 * bonus month's tax year. Months after the bonus month (option B) are allowed but
 * reported as `months_after_bonus` so the screen can warn before saving.
 *
 * Body:    { employee_id, bonus_period, bonus_amount, start_period, num_periods }
 *          (period_key is accepted as a legacy alias for start_period; bonus_period
 *           defaults to start_period when omitted)
 * Returns: { success, bonus_amount, bonus_period, start_period, end_period, num_periods,
 *            incremental_paye, monthly_spread_amount, months_after_bonus }
 */
router.post(
  '/calculate-bonus-spread',
  requirePermission('PAYROLL.VIEW'),
  async (req, res) => {
    try {
      const { employee_id, bonus_amount, num_periods } = req.body;
      const startPeriod = req.body.start_period || req.body.period_key;
      const bonusPeriod = req.body.bonus_period || startPeriod;

      if (!employee_id || !startPeriod || !bonus_amount || !num_periods) {
        return res.status(400).json({
          success: false,
          error: 'employee_id, start_period, bonus_amount, and num_periods are required'
        });
      }
      const periodRe = /^\d{4}-(0[1-9]|1[0-2])$/;
      if (!periodRe.test(startPeriod) || !periodRe.test(bonusPeriod)) {
        return res.status(400).json({ success: false, error: 'start_period and bonus_period must be YYYY-MM' });
      }

      const bonusAmt = parseFloat(bonus_amount);
      const numPer   = parseInt(num_periods, 10);
      if (isNaN(bonusAmt) || bonusAmt <= 0) {
        return res.status(400).json({ success: false, error: 'bonus_amount must be a positive number' });
      }
      if (isNaN(numPer) || numPer < 1 || numPer > 12) {
        return res.status(400).json({ success: false, error: 'num_periods must be between 1 and 12' });
      }

      // VPA-12: the whole spread lies inside the bonus month's tax year (ends by February).
      const yearKeys  = taxYearPeriodKeys(bonusPeriod);
      const endPeriod = addMonths(startPeriod, numPer - 1);
      if (!yearKeys.includes(startPeriod) || !yearKeys.includes(endPeriod)) {
        return res.status(400).json({
          success: false,
          error: `The spread (${startPeriod} to ${endPeriod}) must fall inside the bonus month's tax year ` +
                 `(${yearKeys[0]} to ${yearKeys[11]}) and be paid by ${yearKeys[11]}.`
        });
      }

      const empId = parseInt(employee_id, 10);
      // Tax tables of the BONUS month's tax year (spec 02, Fase 1).
      let taxConfig;
      try {
        taxConfig = await getTaxConfigForPeriod(supabase, req.companyId, bonusPeriod);
      } catch (ttErr) {
        if (ttErr.code === 'TAX_TABLES_MISSING') return res.status(422).json({ success: false, error: ttErr.message });
        throw ttErr;
      }

      // Bonus tax X in the bonus month itself (same YTD and tables as Execute Payroll).
      const normalizedInputs = await PayrollDataService.fetchCalculationInputs(
        req.companyId, empId, bonusPeriod, supabase
      );
      const baseResult = await PayrollCalculationService.calculate(normalizedInputs, { taxConfig });

      const inputsWithBonus = JSON.parse(JSON.stringify(normalizedInputs));
      inputsWithBonus.currentInputs = (inputsWithBonus.currentInputs || []).concat([{
        type: 'income', amount: bonusAmt, is_taxable: true, paye_projection_type: 'ONCE_OFF'
      }]);
      const bonusResult = await PayrollCalculationService.calculate(inputsWithBonus, { taxConfig });

      // paye_base already contains the FULL incremental tax of once-off income in its month
      // (since the 2026-09-03 bonus fix) — no ×12 (that was finding K5: 12× too high).
      const incremental = Math.max(0, bonusResult.paye_base - baseResult.paye_base);
      const monthly     = incremental / numPer;
      const monthsAfterBonus = Math.max(0, yearKeys.indexOf(endPeriod) - yearKeys.indexOf(bonusPeriod));

      res.json({
        success:               true,
        bonus_amount:          bonusAmt,
        bonus_period:          bonusPeriod,
        start_period:          startPeriod,
        end_period:            endPeriod,
        num_periods:           numPer,
        incremental_paye:      Math.round(incremental * 100) / 100,
        monthly_spread_amount: Math.round(monthly * 100) / 100,
        months_after_bonus:    monthsAfterBonus
      });
    } catch (err) {
      console.error('[voluntary-tax] calculate-bonus-spread error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

module.exports = router;
