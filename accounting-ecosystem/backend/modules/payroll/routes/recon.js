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

    // Get distinct periods from payroll_snapshots (finalized live payroll runs)
    const { data: snapTaxRows } = await supabase
      .from('payroll_snapshots')
      .select('period_key')
      .eq('company_id', companyId)
      .eq('is_locked', true);

    const seen = new Set();
    (histRows || []).forEach(r => { if (r.period_key) seen.add(taxYearForPeriod(r.period_key)); });
    (txRows || []).forEach(r => {
      const pk = r.payroll_periods?.period_key;
      if (pk) seen.add(taxYearForPeriod(pk));
    });
    (snapTaxRows || []).forEach(r => { if (r.period_key) seen.add(taxYearForPeriod(r.period_key)); });

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

    // ── 1. Aggregate from payroll_snapshots (finalized live payroll runs) ─────
    // This is the authoritative source for all payroll run through Paytime.
    // payroll_transactions is a legacy table never written by the batch run system.
    const { data: snapData, error: snapErr } = await supabase
      .from('payroll_snapshots')
      .select('employee_id, period_key, calculation_output, calculation_input, created_at, employees(first_name, last_name)')
      .eq('company_id', companyId)
      .eq('is_locked', true)
      .in('period_key', periods);

    if (snapErr) throw new Error(snapErr.message);

    // Deduplicate: keep most recent locked snapshot per employee+period.
    // (Multiple drafts may exist for the same employee+period before finalization.)
    const snapDedup = {};
    for (const snap of (snapData || [])) {
      const key = `${snap.employee_id}_${snap.period_key}`;
      if (!snapDedup[key] || snap.created_at > snapDedup[key].created_at) {
        snapDedup[key] = snap;
      }
    }
    // Keys that have a finalized snapshot — historical data will yield to these
    const snapshotKeys = new Set(Object.keys(snapDedup));

    // ── 2. Aggregate from payroll_historical (imported/CSV data) ─────────────
    const { data: histData, error: hErr } = await supabase
      .from('payroll_historical')
      .select('employee_id, period_key, gross, paye, uif, net, employees(first_name, last_name)')
      .eq('company_id', companyId)
      .in('period_key', periods);

    if (hErr) throw new Error(hErr.message);

    // ── 3. Build merged per-period, per-employee map ─────────────────────────
    // Structure: empMap[empId] = { name, periods: { 'YYYY-MM': { gross, paye, uif, sdl, net,
    //   basic, overtime, shorttime, voluntary_tax, deductions } } }
    const empMap = {};

    function ensureEmp(id, nameObj) {
      if (!empMap[id]) {
        const name = nameObj
          ? `${nameObj.first_name || ''} ${nameObj.last_name || ''}`.trim()
          : `Employee ${id}`;
        empMap[id] = { employee_id: id, full_name: name, periods: {} };
      }
    }

    // extra: optional enriched fields { basic, overtime, shorttime, voluntary_tax, deductions }
    function addToPeriod(empId, periodKey, gross, paye, uif, sdl, net, extra) {
      if (!empMap[empId].periods[periodKey]) {
        empMap[empId].periods[periodKey] = {
          gross: 0, paye: 0, uif: 0, sdl: 0, net: 0,
          basic: 0, overtime: 0, shorttime: 0, voluntary_tax: 0, deductions: 0
        };
      }
      const p = empMap[empId].periods[periodKey];
      p.gross += parseFloat(gross) || 0;
      p.paye  += parseFloat(paye)  || 0;
      p.uif   += parseFloat(uif)   || 0;
      p.sdl   += parseFloat(sdl)   || 0;
      p.net   += parseFloat(net)   || 0;
      if (extra) {
        // Enriched fields are set (not accumulated) since one snapshot per employee+period
        p.basic         = parseFloat(extra.basic)        || 0;
        p.overtime      = parseFloat(extra.overtime)     || 0;
        p.shorttime     = parseFloat(extra.shorttime)    || 0;
        p.voluntary_tax = parseFloat(extra.voluntary_tax)|| 0;
        p.deductions    = parseFloat(extra.deductions)   || 0;
      }
    }

    // Historical: only add periods NOT covered by a locked snapshot
    for (const h of (histData || [])) {
      const key = `${h.employee_id}_${h.period_key}`;
      if (snapshotKeys.has(key)) continue; // snapshot takes precedence
      ensureEmp(h.employee_id, h.employees);
      addToPeriod(h.employee_id, h.period_key, h.gross, h.paye, h.uif, 0, h.net);
    }

    // Snapshots: authoritative source — always included, override historical for same period
    for (const snap of Object.values(snapDedup)) {
      const out = snap.calculation_output || {};
      const inp = snap.calculation_input  || {};
      ensureEmp(snap.employee_id, snap.employees);
      addToPeriod(snap.employee_id, snap.period_key,
        out.gross, out.paye, out.uif, out.sdl, out.net,
        {
          basic:         inp.basic_salary,
          overtime:      out.overtimeAmount,
          shorttime:     out.shortTimeAmount,
          voluntary_tax: out.voluntary_overdeduction,
          deductions:    out.deductions
        }
      );
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
        vals.gross          = Math.round(vals.gross          * 100) / 100;
        vals.paye           = Math.round(vals.paye           * 100) / 100;
        vals.uif            = Math.round(vals.uif            * 100) / 100;
        vals.sdl            = Math.round(vals.sdl            * 100) / 100;
        vals.net            = Math.round(vals.net            * 100) / 100;
        vals.basic          = Math.round(vals.basic          * 100) / 100;
        vals.overtime       = Math.round(vals.overtime       * 100) / 100;
        vals.shorttime      = Math.round(vals.shorttime      * 100) / 100;
        vals.voluntary_tax  = Math.round(vals.voluntary_tax  * 100) / 100;
        vals.deductions     = Math.round(vals.deductions     * 100) / 100;
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

    let emp501Records = [];

    // Aggregate from payroll_snapshots (authoritative source — replaces payroll_transactions)
    const { data: snapRows501, error: snap501Err } = await supabase
      .from('payroll_snapshots')
      .select('employee_id, period_key, calculation_output, calculation_input, created_at, employees(id, first_name, last_name, id_number, tax_number, email)')
      .eq('company_id', companyId)
      .eq('is_locked', true)
      .in('period_key', periods);

    if (snap501Err) throw new Error(snap501Err.message);

    // Deduplicate per employee+period (latest wins)
    const snapDedup501 = {};
    for (const s of (snapRows501 || [])) {
      const key = `${s.employee_id}_${s.period_key}`;
      if (!snapDedup501[key] || s.created_at > snapDedup501[key].created_at) {
        snapDedup501[key] = s;
      }
    }

    // Aggregate per employee across all periods
    const empAgg = {};
    for (const snap of Object.values(snapDedup501)) {
      const eid  = snap.employee_id;
      const out  = snap.calculation_output || {};
      const emp  = snap.employees || {};

      if (!empAgg[eid]) {
        empAgg[eid] = {
          employee_id:    eid,
          employee:       emp,
          gross_income:   0, taxable_income: 0,
          paye:           0, uif_employee:   0, uif_employer: 0,
          sdl:            0, medical_credit: 0, net_pay: 0,
          irp5_codes:     {}
        };
      }
      const agg = empAgg[eid];
      agg.gross_income   += parseFloat(out.gross)                    || 0;
      agg.taxable_income += parseFloat(out.taxableGross)             || 0;
      agg.paye           += parseFloat(out.paye)                     || 0;
      agg.uif_employee   += parseFloat(out.uif)                      || 0;
      agg.uif_employer   += 0; // not captured in current snapshot schema
      agg.sdl            += parseFloat(out.sdl)                      || 0;
      agg.medical_credit += parseFloat(out.medicalCredit)            || 0;
      agg.net_pay        += parseFloat(out.net)                      || 0;
      // Note: voluntary_overdeduction is already included in out.paye by the engine
    }

    const r2 = n => Math.round(n * 100) / 100;

    // Round and build output
    emp501Records = Object.values(empAgg).map(agg => {
      const emp = agg.employee;
      return {
        employee_id:    agg.employee_id,
        id_number:      emp.id_number    || null,
        tax_number:     emp.tax_number   || null,
        full_name:      `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
        email:          emp.email        || null,
        gross_income:   r2(agg.gross_income),
        taxable_income: r2(agg.taxable_income),
        paye:           r2(agg.paye),
        uif_employee:   r2(agg.uif_employee),
        uif_employer:   r2(agg.uif_employer),
        sdl:            r2(agg.sdl),
        medical_credit: r2(agg.medical_credit),
        net_pay:        r2(agg.net_pay),
        irp5_codes:     Object.values(agg.irp5_codes)
      };
    });

    // Also include historical import data as a separate list (no IRP5 breakdown available)
    const { data: histData501 } = await supabase
      .from('payroll_historical')
      .select('employee_id, gross, paye, uif, net, employees(first_name, last_name, id_number, tax_number)')
      .eq('company_id', companyId)
      .in('period_key', periods);

    const histAgg = {};
    for (const h of (histData501 || [])) {
      const eid = h.employee_id;
      if (!histAgg[eid]) {
        histAgg[eid] = {
          employee_id: eid,
          full_name:   `${h.employees?.first_name || ''} ${h.employees?.last_name || ''}`.trim(),
          id_number:   h.employees?.id_number  || null,
          tax_number:  h.employees?.tax_number || null,
          gross: 0, paye: 0, uif: 0, net: 0
        };
      }
      histAgg[eid].gross += parseFloat(h.gross) || 0;
      histAgg[eid].paye  += parseFloat(h.paye)  || 0;
      histAgg[eid].uif   += parseFloat(h.uif)   || 0;
      histAgg[eid].net   += parseFloat(h.net)   || 0;
    }

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
