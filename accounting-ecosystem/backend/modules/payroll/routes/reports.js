/**
 * ============================================================================
 * Payroll Reports Routes — Annual (12-Month) Analysis
 * ============================================================================
 * READ-ONLY reporting. Never writes to payroll_snapshots or any payroll table.
 *
 * GET /api/payroll/reports/annual-analysis?taxYear=YYYY/YYYY
 *   Per-employee, per-pay-code, month-by-month breakdown across a SA tax year
 *   with a running total column — the Paytime equivalent of a Sage "12 Month
 *   Analysis" / Age Analysis report. Data comes exclusively from FINALIZED
 *   (is_locked = true) payroll_snapshots — draft periods are never included,
 *   consistent with the finalized-snapshot-is-immutable rule elsewhere in
 *   Paytime (CLAUDE.md Part E, Rule E6).
 *
 * Tax-year date-range/period-list helpers are intentionally duplicated from
 * recon.js rather than extracted to a shared module — recon.js is a CRITICAL
 * auto-trigger file under the Paytime stability lock, and this report is new,
 * additive, read-only functionality that does not need to touch it. Follow-up:
 * consider extracting TaxYearUtils in a dedicated refactor, not bundled here.
 * ============================================================================
 */

'use strict';

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

// ─── SA Tax Year Helpers (mirrors recon.js — see file header note) ──────────

function taxYearToDateRange(taxYear) {
  const [y1, y2] = taxYear.split('/').map(Number);
  if (!y1 || !y2) throw new Error('Invalid tax year format. Use YYYY/YYYY');
  return { startDate: `${y1}-03-01`, endDate: `${y2}-02-28` };
}

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

function r2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

/**
 * GET /api/payroll/reports/annual-analysis?taxYear=YYYY/YYYY
 *
 * Response:
 * {
 *   taxYear, periods: ['YYYY-MM', ...],
 *   employees: [{
 *     employee_id, full_name,
 *     income:  [{ description, periods: {YYYY-MM: amount}, total }],
 *     deductions: [{ description, periods: {...}, total }],
 *     companyContributions: [{ description, periods: {...}, total }],
 *     totals: { income, deductions, companyContributions, grossPay, nettPay, costToCompany } (each keyed by period + total)
 *   }],
 *   summary: {
 *     income: [...], deductions: [...], companyContributions: [...],
 *     totals: { grossPay, nettPay, costToCompany } (each keyed by period + total)
 *   },
 *   notes: [ ...caveats about fields not tracked by the engine yet... ]
 * }
 */
router.get('/annual-analysis', requirePermission('PAYROLL.VIEW'), async (req, res) => {
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

    // ── Employee names lookup (no FK between snapshots and employees) ────────
    const { data: empRows } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .eq('company_id', companyId);
    const empLookup = {};
    for (const e of (empRows || [])) empLookup[e.id] = e;

    // ── Finalized snapshots only — draft/unfinalized periods are excluded ────
    const { data: snapData, error: snapErr } = await supabase
      .from('payroll_snapshots')
      .select('employee_id, period_key, calculation_output, calculation_input, created_at')
      .eq('company_id', companyId)
      .eq('is_locked', true)
      .in('period_key', periods);

    if (snapErr) throw new Error(snapErr.message);

    // Deduplicate: keep most recent locked snapshot per employee+period.
    const snapDedup = {};
    for (const snap of (snapData || [])) {
      const key = `${snap.employee_id}_${snap.period_key}`;
      if (!snapDedup[key] || snap.created_at > snapDedup[key].created_at) {
        snapDedup[key] = snap;
      }
    }

    // ── Per-employee line-item accumulators ──────────────────────────────────
    // lineItem(bucket, empId, description) → { periods: {YYYY-MM: amount}, total }
    const empData = {}; // empData[empId] = { full_name, income:{}, deductions:{}, companyContributions:{}, totals:{ periods:{}, total } }

    function ensureEmp(id) {
      if (!empData[id]) {
        const e = empLookup[id];
        empData[id] = {
          employee_id: id,
          full_name: e ? `${e.first_name || ''} ${e.last_name || ''}`.trim() : `Employee ${id}`,
          income: {}, deductions: {}, companyContributions: {},
          totals: { grossPay: {}, nettPay: {}, costToCompany: {} }
        };
      }
      return empData[id];
    }

    function addLine(bucket, periodKey, description, amount) {
      if (!amount) return; // skip exact-zero lines — keeps the report uncluttered, matches Sage behaviour
      if (!bucket[description]) bucket[description] = { description, periods: {}, total: 0 };
      bucket[description].periods[periodKey] = r2((bucket[description].periods[periodKey] || 0) + amount);
      bucket[description].total = r2(bucket[description].total + amount);
    }

    for (const snap of Object.values(snapDedup)) {
      const out = snap.calculation_output || {};
      const inp = snap.calculation_input  || {};
      const emp = ensureEmp(snap.employee_id);
      const pk  = snap.period_key;

      // ── Income ──
      addLine(emp.income, pk, 'Basic Salary', inp.basic_salary);
      (Array.isArray(inp.regular_inputs) ? inp.regular_inputs : []).forEach(ri => {
        if (ri.type === 'deduction') return;
        addLine(emp.income, pk, ri.description || ri.type || 'Allowance', ri.amount);
      });
      addLine(emp.income, pk, 'Overtime', out.overtimeAmount);
      if (out.shortTimeAmount) addLine(emp.income, pk, 'Short Time', -Math.abs(out.shortTimeAmount));

      // ── Deductions (statutory + itemised) ──
      addLine(emp.deductions, pk, 'PAYE Tax', out.paye);
      addLine(emp.deductions, pk, 'UIF - Employee', out.uif);
      if (out.medicalCredit) addLine(emp.deductions, pk, 'Medical Aid Tax Credit', -Math.abs(out.medicalCredit));
      (Array.isArray(inp.regular_inputs) ? inp.regular_inputs : []).forEach(ri => {
        if (ri.type !== 'deduction') return;
        addLine(emp.deductions, pk, ri.description || 'Deduction', ri.amount);
      });

      // ── Company Contributions (employer-paid — additive fields only) ──
      addLine(emp.companyContributions, pk, 'UIF - Employer', out.uif_employer);
      addLine(emp.companyContributions, pk, 'SDL', out.sdl);

      // ── Period totals (arithmetically consistent with the payslip: gross - net = "true" total deductions) ──
      emp.totals.grossPay[pk]      = r2((emp.totals.grossPay[pk] || 0) + (out.gross || 0));
      emp.totals.nettPay[pk]       = r2((emp.totals.nettPay[pk]  || 0) + (out.net   || 0));
      const contribThisPeriod      = (out.uif_employer || 0) + (out.sdl || 0);
      emp.totals.costToCompany[pk] = r2((emp.totals.costToCompany[pk] || 0) + (out.gross || 0) + contribThisPeriod);
    }

    // ── Flatten per-employee line-item maps into arrays, add totals row ──────
    function toArray(bucket) { return Object.values(bucket).sort((a, b) => a.description.localeCompare(b.description)); }
    function sumTotalsRow(periodMap) {
      const row = { periods: {}, total: 0 };
      periods.forEach(p => { row.periods[p] = r2(periodMap[p] || 0); row.total = r2(row.total + (periodMap[p] || 0)); });
      return row;
    }

    const employees = Object.values(empData).map(e => ({
      employee_id: e.employee_id,
      full_name:   e.full_name,
      income:               toArray(e.income),
      deductions:           toArray(e.deductions),
      companyContributions: toArray(e.companyContributions),
      totals: {
        grossPay:      sumTotalsRow(e.totals.grossPay),
        nettPay:       sumTotalsRow(e.totals.nettPay),
        costToCompany: sumTotalsRow(e.totals.costToCompany)
      }
    })).sort((a, b) => a.full_name.localeCompare(b.full_name));

    // ── Company-wide summary — same line items, summed across all employees ──
    const summaryIncome = {}, summaryDeductions = {}, summaryContrib = {};
    const summaryTotals = { grossPay: {}, nettPay: {}, costToCompany: {} };
    employees.forEach(e => {
      e.income.forEach(li => li && periods.forEach(p => {
        if (!li.periods[p]) return;
        if (!summaryIncome[li.description]) summaryIncome[li.description] = { description: li.description, periods: {}, total: 0 };
        summaryIncome[li.description].periods[p] = r2((summaryIncome[li.description].periods[p] || 0) + li.periods[p]);
        summaryIncome[li.description].total = r2(summaryIncome[li.description].total + li.periods[p]);
      }));
      e.deductions.forEach(li => li && periods.forEach(p => {
        if (!li.periods[p]) return;
        if (!summaryDeductions[li.description]) summaryDeductions[li.description] = { description: li.description, periods: {}, total: 0 };
        summaryDeductions[li.description].periods[p] = r2((summaryDeductions[li.description].periods[p] || 0) + li.periods[p]);
        summaryDeductions[li.description].total = r2(summaryDeductions[li.description].total + li.periods[p]);
      }));
      e.companyContributions.forEach(li => li && periods.forEach(p => {
        if (!li.periods[p]) return;
        if (!summaryContrib[li.description]) summaryContrib[li.description] = { description: li.description, periods: {}, total: 0 };
        summaryContrib[li.description].periods[p] = r2((summaryContrib[li.description].periods[p] || 0) + li.periods[p]);
        summaryContrib[li.description].total = r2(summaryContrib[li.description].total + li.periods[p]);
      }));
      periods.forEach(p => {
        summaryTotals.grossPay[p]      = r2((summaryTotals.grossPay[p]      || 0) + (e.totals.grossPay.periods[p]      || 0));
        summaryTotals.nettPay[p]       = r2((summaryTotals.nettPay[p]       || 0) + (e.totals.nettPay.periods[p]       || 0));
        summaryTotals.costToCompany[p] = r2((summaryTotals.costToCompany[p] || 0) + (e.totals.costToCompany.periods[p] || 0));
      });
    });

    res.json({
      taxYear,
      periods,
      employees,
      summary: {
        income:               Object.values(summaryIncome).sort((a, b) => a.description.localeCompare(b.description)),
        deductions:           Object.values(summaryDeductions).sort((a, b) => a.description.localeCompare(b.description)),
        companyContributions: Object.values(summaryContrib).sort((a, b) => a.description.localeCompare(b.description)),
        totals: {
          grossPay:      sumTotalsRow(summaryTotals.grossPay),
          nettPay:       sumTotalsRow(summaryTotals.nettPay),
          costToCompany: sumTotalsRow(summaryTotals.costToCompany)
        }
      },
      // Transparency note (CLAUDE.md Rule 8 — never hide uncertainty): this report
      // only includes what the payroll engine actually calculates. Sage-style rows
      // for OID, leave accrual value, and employer pension/provident contribution
      // are NOT included — the engine does not compute these yet.
      notes: [
        'Only finalized (locked) payroll periods are included — drafts are excluded.',
        'Cost To Company = Gross Pay + UIF (Employer) + SDL only. It does not yet include ' +
          'OID, leave accrual value, or employer pension/provident fund contributions — ' +
          'the payroll engine does not calculate these at present.'
      ]
    });
  } catch (err) {
    console.error('Annual analysis report error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
