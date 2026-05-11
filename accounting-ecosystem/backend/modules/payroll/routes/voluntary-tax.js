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

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * POST /api/payroll/voluntary-tax/calculate-bonus-spread
 *
 * Given a bonus amount and number of spread periods, calculate:
 *   1. Base monthly PAYE for the employee (no bonus) — annualPAYE ÷ 12
 *   2. Monthly PAYE WITH the bonus added as once-off income — (annualPAYE+bonus) ÷ 12
 *   3. Incremental annual PAYE = monthly delta × 12  (recovers the true annual figure)
 *   4. Monthly spread = incremental annual PAYE ÷ num_periods
 *
 * Body: { employee_id, period_key, bonus_amount, num_periods }
 * Returns: { success, bonus_amount, num_periods, incremental_paye, monthly_spread_amount }
 */
router.post(
  '/calculate-bonus-spread',
  requirePermission('PAYROLL.VIEW'),
  async (req, res) => {
    try {
      const { employee_id, period_key, bonus_amount, num_periods } = req.body;

      if (!employee_id || !period_key || !bonus_amount || !num_periods) {
        return res.status(400).json({
          success: false,
          error: 'employee_id, period_key, bonus_amount, and num_periods are required'
        });
      }

      const bonusAmt = parseFloat(bonus_amount);
      const numPer   = parseInt(num_periods, 10);

      if (isNaN(bonusAmt) || bonusAmt <= 0) {
        return res.status(400).json({ success: false, error: 'bonus_amount must be a positive number' });
      }
      if (isNaN(numPer) || numPer < 1 || numPer > 60) {
        return res.status(400).json({ success: false, error: 'num_periods must be between 1 and 60' });
      }

      // Fetch normalized calculation inputs for this employee in the given period
      const normalizedInputs = await PayrollDataService.fetchCalculationInputs(
        req.companyId, parseInt(employee_id, 10), period_key, supabase
      );

      // Calculate base PAYE (without bonus)
      const baseResult = await PayrollCalculationService.calculate(normalizedInputs);
      const basePaye = baseResult.paye_base;

      // Deep copy + inject bonus as once-off taxable current income (never annualised)
      const inputsWithBonus = JSON.parse(JSON.stringify(normalizedInputs));
      inputsWithBonus.currentInputs = (inputsWithBonus.currentInputs || []).concat([{
        type: 'income',
        amount: bonusAmt,
        is_taxable: true
      }]);

      // Calculate PAYE with bonus
      const bonusResult = await PayrollCalculationService.calculate(inputsWithBonus);
      const bonusPaye = bonusResult.paye_base;

      // paye_base is monthly PAYE (= annualPAYE ÷ 12, computed with ytdData=null).
      // The delta of two monthly values is annualIncrementalPAYE ÷ 12 — not the annual figure.
      // Multiply by 12 to recover the true annual incremental tax caused by the bonus,
      // then divide by spread months to get the correct monthly deduction amount.
      // Without this ×12 the result would be annualIncremental ÷ (12 × numPer) — off by ×12.
      const incrementalAnnualPaye = Math.max(0, bonusPaye - basePaye) * 12;
      const monthlySpreadAmount   = incrementalAnnualPaye / numPer;

      res.json({
        success: true,
        bonus_amount:          bonusAmt,
        num_periods:           numPer,
        incremental_paye:      Math.round(incrementalAnnualPaye  * 100) / 100,
        monthly_spread_amount: Math.round(monthlySpreadAmount    * 100) / 100
      });
    } catch (err) {
      console.error('[voluntary-tax] calculate-bonus-spread error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

module.exports = router;
