/**
 * ============================================================================
 * PAYE Reconciliation Routes — Payroll Module
 * ============================================================================
 * Provides backend-driven aggregation of payroll data for PAYE reconciliation.
 * Replaces the localStorage-based ReconService.buildPayrollTotals() approach.
 *
 * Data sources (in priority order):
 *   1. payroll_transactions — for finalized payroll runs processed through Paytime
 *   2. payroll_historical   — for imported historical data (mid-year starts, migrations)
 *
 * Both are aggregated per period and merged so the reconciliation page sees a
 * unified view regardless of whether data came from live payroll or CSV import.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

// ─── SA Tax Year Helpers ─────────────────────────────────────────────────────

/**
 * Given 'YYYY/YYYY' tax year label, return { startPeriod, endPeriod } as 'YYYY-MM'.
 * SA tax year: March (03) of first year → February (02) of second year.
 * e.g. '2025/2026' → { startPeriod: '2025-03', endPeriod: '2026-02' }
 */
function taxYearToDateRange(taxYear) {
  const [y1, y2] = taxYear.split('/').map(Number);
  if (!y1 || !y2) throw new Error('Invalid tax year format. Use YYYY/YYYY');
  return {
    startDate: `${y1}-03-01`,
    endDate:   `${y2}-02-28`
  };
}

/**
 * Derives 'YYYY/YYYY' tax year label from a period string 'YYYY-MM'.
 */
function taxYearForPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m >= 3 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

/**
 * Returns sorted list of unique 'YYYY-MM' periods between startDate and endDate.
 */
function generatePeriods(startDate, endDate) {
  const periods = [];
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    periods.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return periods;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/payroll/recon/tax-years
 * Returns a list of tax years for which this company has payroll data.
 * Used to populate the tax year selector on the reconciliation page.
 */
router.get('/tax-years', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const companyId = req.companyId;

    // Get distinct periods from payroll_historical
    const { data: histRows } = await supabase
      .from('payroll_historical')
      .select('period_key')
      .eq('company_id', companyId);

    // Get distinct periods from payroll_transactions (via payroll_periods join)
    const { data: txRows } = await supabase
      .from('payroll_transactions')
      .select('payroll_periods(period_key)')
      .eq('company_id', companyId);

    const seen = new Set();
    (histRows || []).forEach(r => { if (r.period_key) seen.add(taxYearForPeriod(r.period_key)); });
    (txRows || []).forEach(r => {
      const pk = r.payroll_periods?.period_key;
      if (pk) seen.add(taxYearForPeriod(pk));
    });

    // Always include the current tax year even if no data yet
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const currentTY = currentMonth >= 3 ? `${currentYear}/${currentYear + 1}` : `${currentYear - 1}/${currentYear}`;
    seen.add(currentTY);

    const taxYears = Array.from(seen).sort().reverse();
    res.json({ taxYears, currentTaxYear: currentTY });
  } catch (err) {
    console.error('PAYE recon tax-years error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/payroll/recon/summary?taxYear=YYYY/YYYY
 *
 * Returns per-period PAYE/UIF/SDL aggregates for the given tax year.
 * Merges data from both payroll_transactions (live payroll) and
 * payroll_historical (imported data).
 *
 * Response:
 * {
 *   taxYear: '2025/2026',
 *   periods: ['2025-03', '2025-04', ...],
 *   totals: {
 *     'YYYY-MM': { gross, paye, uif, sdl, net, employeeCount, source }
 *   },
 *   employees: [
 *     { employee_id, full_name, periods: { 'YYYY-MM': { gross, paye, uif, sdl, net } } }
 *   ],
 *   annualTotals: { gross, paye, uif, sdl, net }
 * }
 */
router.get('/summary', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { taxYear } = req.query;
    if (!taxYear) return res.status(400).json({ error: 'taxYear is required (format: YYYY/YYYY)' });

    const companyId = req.companyId;
    let startDate, endDate;
    try {
      ({ startDate, endDate } = taxYearToDateRange(taxYear));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const periods = generatePeriods(startDate, endDate);

    // ── 1. Aggregate from payroll_historical (imported data) ─────────────────
    const { data: histData, error: hErr } = await supabase
      .from('payroll_historical')
      .select('employee_id, period_key, gross, paye, uif, net, employees(first_name, last_name)')
      .eq('company_id', companyId)
      .in('period_key', periods);

    if (hErr) throw new Error(hErr.message);

    // ── 2. Aggregate from payroll_transactions (live payroll runs) ───────────
    // First get the relevant payroll_periods for this tax year date range
    const { data: payPeriods, error: ppErr } = await supabase
      .from('payroll_periods')
      .select('id, period_key')
      .eq('company_id', companyId)
      .gte('start_date', startDate)
      .lte('end_date', endDate);

    if (ppErr) throw new Error(ppErr.message);

    let txData = [];
    if (payPeriods && payPeriods.length > 0) {
      const periodIds = payPeriods.map(p => p.id);
      const periodKeyMap = {}; // period_id → period_key
      payPeriods.forEach(p => { periodKeyMap[p.id] = p.period_key; });

      const { data: txRows, error: txErr } = await supabase
        .from('payroll_transactions')
        .select('employee_id, period_id, gross_income, taxable_income, paye, uif_employee, sdl, net_pay, employees(first_name, last_name)')
        .eq('company_id', companyId)
        .in('period_id', periodIds);

      if (txErr) throw new Error(txErr.message);
      txData = (txRows || []).map(t => ({
        ...t,
        period_key: periodKeyMap[t.period_id] || null
      })).filter(t => t.period_key);
    }

    // ── 3. Build merged per-period, per-employee map ─────────────────────────
    // Structure: empMap[empId] = { name, periods: { 'YYYY-MM': { gross, paye, uif, sdl, net } } }
    const empMap = {};

    function ensureEmp(id, nameObj) {
      if (!empMap[id]) {
        const name = nameObj
          ? `${nameObj.first_name || ''} ${nameObj.last_name || ''}`.trim()
          : `Employee ${id}`;
        empMap[id] = { employee_id: id, full_name: name, periods: {} };
      }
    }

    function addToPeriod(empId, periodKey, gross, paye, uif, sdl, net) {
      if (!empMap[empId].periods[periodKey]) {
        empMap[empId].periods[periodKey] = { gross: 0, paye: 0, uif: 0, sdl: 0, net: 0 };
      }
      const p = empMap[empId].periods[periodKey];
      p.gross += parseFloat(gross) || 0;
      p.paye  += parseFloat(paye)  || 0;
      p.uif   += parseFloat(uif)   || 0;
      p.sdl   += parseFloat(sdl)   || 0;
      p.net   += parseFloat(net)   || 0;
    }

    // From historical imports
    for (const h of (histData || [])) {
      ensureEmp(h.employee_id, h.employees);
      addToPeriod(h.employee_id, h.period_key, h.gross, h.paye, h.uif, 0, h.net);
    }

    // From live payroll transactions (takes precedence for same period)
    for (const t of txData) {
      ensureEmp(t.employee_id, t.employees);
      addToPeriod(t.employee_id, t.period_key, t.gross_income, t.paye, t.uif_employee, t.sdl, t.net_pay);
    }

    // ── 4. Build period-level totals ─────────────────────────────────────────
    const totals = {};
    periods.forEach(p => {
      totals[p] = { gross: 0, paye: 0, uif: 0, sdl: 0, net: 0, employeeCount: 0 };
    });

    const employees = Object.values(empMap);
    for (const emp of employees) {
      for (const [period, vals] of Object.entries(emp.periods)) {
        if (!totals[period]) totals[period] = { gross: 0, paye: 0, uif: 0, sdl: 0, net: 0, employeeCount: 0 };
        totals[period].gross  += vals.gross;
        totals[period].paye   += vals.paye;
        totals[period].uif    += vals.uif;
        totals[period].sdl    += vals.sdl;
        totals[period].net    += vals.net;
        totals[period].employeeCount++;
      }
    }

    // Round all period totals
    for (const p of Object.keys(totals)) {
      const t = totals[p];
      t.gross = Math.round(t.gross * 100) / 100;
      t.paye  = Math.round(t.paye  * 100) / 100;
      t.uif   = Math.round(t.uif   * 100) / 100;
      t.sdl   = Math.round(t.sdl   * 100) / 100;
      t.net   = Math.round(t.net   * 100) / 100;
      t.total = Math.round((t.paye + t.uif + t.sdl) * 100) / 100;
    }

    // Round employee period values
    for (const emp of employees) {
      for (const [, vals] of Object.entries(emp.periods)) {
        vals.gross = Math.round(vals.gross * 100) / 100;
        vals.paye  = Math.round(vals.paye  * 100) / 100;
        vals.uif   = Math.round(vals.uif   * 100) / 100;
        vals.sdl   = Math.round(vals.sdl   * 100) / 100;
        vals.net   = Math.round(vals.net   * 100) / 100;
      }
    }

    // ── 5. Annual totals ─────────────────────────────────────────────────────
    const annualTotals = { gross: 0, paye: 0, uif: 0, sdl: 0, net: 0 };
    for (const t of Object.values(totals)) {
      annualTotals.gross += t.gross;
      annualTotals.paye  += t.paye;
      annualTotals.uif   += t.uif;
      annualTotals.sdl   += t.sdl;
      annualTotals.net   += t.net;
    }
    annualTotals.gross = Math.round(annualTotals.gross * 100) / 100;
    annualTotals.paye  = Math.round(annualTotals.paye  * 100) / 100;
    annualTotals.uif   = Math.round(annualTotals.uif   * 100) / 100;
    annualTotals.sdl   = Math.round(annualTotals.sdl   * 100) / 100;
    annualTotals.net   = Math.round(annualTotals.net   * 100) / 100;
    annualTotals.total = Math.round((annualTotals.paye + annualTotals.uif + annualTotals.sdl) * 100) / 100;

    res.json({ taxYear, periods, totals, employees, annualTotals });
  } catch (err) {
    console.error('PAYE recon summary error:', err);
    res.status(500).json({ error: 'Failed to generate PAYE reconciliation summary' });
  }
});

/**
 * GET /api/payroll/recon/emp501?taxYear=YYYY/YYYY
 *
 * EMP501 / IRP5 annual reconciliation foundation.
 * Returns per-employee annual aggregates with IRP5 code breakdowns.
 *
 * This is the FOUNDATION for IRP5 certificate generation. It does NOT produce
 * a SARS-submission-ready file — that requires additional formatting work
 * (see FOLLOW-UP NOTE below).
 *
 * FOLLOW-UP NOTE
 * - Area: EMP501 / IRP5 Submission
 * - What is done now: per-employee annual aggregate with IRP5 code assignments
 * - What still needs: SARS-specified XML/EMP501 file format for e@syFile submission
 * - Risk if not done: Manual reconciliation only, no digital submission to SARS
 * - Recommended next step: Build IRP5 PDF certificate per employee + EMP501 XML export
 */
router.get('/emp501', requirePermission('PAYROLL.VIEW'), async (req, res) => {
  try {
    const { taxYear } = req.query;
    if (!taxYear) return res.status(400).json({ error: 'taxYear is required (format: YYYY/YYYY)' });

    const companyId = req.companyId;
    let startDate, endDate;
    try {
      ({ startDate, endDate } = taxYearToDateRange(taxYear));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const periods = generatePeriods(startDate, endDate);

    // Get payroll_transactions for the tax year with their payslip_items (IRP5 code breakdowns)
    const { data: payPeriods } = await supabase
      .from('payroll_periods')
      .select('id, period_key')
      .eq('company_id', companyId)
      .gte('start_date', startDate)
      .lte('end_date', endDate);

    let emp501Records = [];

    if (payPeriods && payPeriods.length > 0) {
      const periodIds = payPeriods.map(p => p.id);

      const { data: txRows, error: txErr } = await supabase
        .from('payroll_transactions')
        .select(`
          id, employee_id, period_id, gross_income, taxable_income,
          paye, uif_employee, uif_employer, sdl, medical_credit, net_pay,
          employees(id, first_name, last_name, id_number, tax_number, email),
          payslip_items(item_type, description, amount, is_taxable,
            payroll_items_master(item_name, irp5_code, item_type, category))
        `)
        .eq('company_id', companyId)
        .in('period_id', periodIds);

      if (txErr) throw new Error(txErr.message);

      const periodKeyMap = {};
      payPeriods.forEach(p => { periodKeyMap[p.id] = p.period_key; });

      // Aggregate per employee
      const empAgg = {};
      for (const tx of (txRows || [])) {
        const eid = tx.employee_id;
        if (!empAgg[eid]) {
          empAgg[eid] = {
            employee_id: eid,
            employee: tx.employees || {},
            gross_income: 0, taxable_income: 0,
            paye: 0, uif_employee: 0, uif_employer: 0,
            sdl: 0, medical_credit: 0, net_pay: 0,
            irp5_codes: {} // { code: { description, amount } }
          };
        }
        const agg = empAgg[eid];
        agg.gross_income    += parseFloat(tx.gross_income)    || 0;
        agg.taxable_income  += parseFloat(tx.taxable_income)  || 0;
        agg.paye            += parseFloat(tx.paye)            || 0;
        agg.uif_employee    += parseFloat(tx.uif_employee)    || 0;
        agg.uif_employer    += parseFloat(tx.uif_employer)    || 0;
        agg.sdl             += parseFloat(tx.sdl)             || 0;
        agg.medical_credit  += parseFloat(tx.medical_credit)  || 0;
        agg.net_pay         += parseFloat(tx.net_pay)         || 0;

        // Aggregate by IRP5 code
        for (const item of (tx.payslip_items || [])) {
          const master = item.payroll_items_master;
          const irp5Code = master?.irp5_code || null;
          const amount = parseFloat(item.amount) || 0;
          if (irp5Code && amount !== 0) {
            if (!agg.irp5_codes[irp5Code]) {
              agg.irp5_codes[irp5Code] = { code: irp5Code, description: master?.item_name || item.description, amount: 0 };
            }
            agg.irp5_codes[irp5Code].amount += amount;
          }
        }
      }

      // Round and build output
      emp501Records = Object.values(empAgg).map(agg => {
        const r2 = n => Math.round(n * 100) / 100;
        return {
          employee_id:   agg.employee_id,
          id_number:     agg.employee.id_number    || null,
          tax_number:    agg.employee.tax_number   || null,
          full_name:     `${agg.employee.first_name || ''} ${agg.employee.last_name || ''}`.trim(),
          email:         agg.employee.email        || null,
          gross_income:  r2(agg.gross_income),
          taxable_income: r2(agg.taxable_income),
          paye:          r2(agg.paye),
          uif_employee:  r2(agg.uif_employee),
          uif_employer:  r2(agg.uif_employer),
          sdl:           r2(agg.sdl),
          medical_credit: r2(agg.medical_credit),
          net_pay:       r2(agg.net_pay),
          irp5_codes:    Object.values(agg.irp5_codes).map(c => ({ ...c, amount: r2(c.amount) }))
        };
      });
    }

    // Also include historical import data as a separate list (no IRP5 breakdown available)
    const { data: histData } = await supabase
      .from('payroll_historical')
      .select('employee_id, gross, paye, uif, net, employees(first_name, last_name, id_number, tax_number)')
      .eq('company_id', companyId)
      .in('period_key', periods);

    const histAgg = {};
    for (const h of (histData || [])) {
      const eid = h.employee_id;
      if (!histAgg[eid]) {
        histAgg[eid] = {
          employee_id: eid,
          full_name: `${h.employees?.first_name || ''} ${h.employees?.last_name || ''}`.trim(),
          id_number: h.employees?.id_number || null,
          tax_number: h.employees?.tax_number || null,
          gross: 0, paye: 0, uif: 0, net: 0
        };
      }
      histAgg[eid].gross += parseFloat(h.gross) || 0;
      histAgg[eid].paye  += parseFloat(h.paye)  || 0;
      histAgg[eid].uif   += parseFloat(h.uif)   || 0;
      histAgg[eid].net   += parseFloat(h.net)   || 0;
    }

    const r2 = n => Math.round(n * 100) / 100;
    const historicalSummary = Object.values(histAgg).map(h => ({
      ...h,
      gross: r2(h.gross), paye: r2(h.paye), uif: r2(h.uif), net: r2(h.net)
    }));

    res.json({
      taxYear,
      complianceNote: 'This is a reporting foundation only. Full SARS EMP501/IRP5 XML submission format is not yet implemented. Use this data as the basis for manual IRP5 certificate preparation.',
      livePayroll: emp501Records,
      historicalImports: historicalSummary
    });
  } catch (err) {
    console.error('EMP501 reconciliation error:', err);
    res.status(500).json({ error: 'Failed to generate EMP501 data' });
  }
});

module.exports = router;
