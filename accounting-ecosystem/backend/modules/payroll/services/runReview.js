'use strict';

/**
 * Paytime spec 07 UF-03 — review BEFORE finalizing a pay run.
 * Per employee: this run vs last month's finalized payslip, plus the checks that matter
 * before payslips become final:
 *   large_change   net pay changed by more than 10% and more than R100
 *   new            no finalized payslip last month
 *   negative_net   net pay below zero
 *   tax_number     missing / invalid SARS tax number or ID (IRP5 blocked)
 *   irp5_code      a payroll item without an IRP5 code (IT-05)
 *   not_in_run     paid last month, but not in this run
 * Shows only — never blocks finalizing (the user decides).
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const LARGE_PCT = 10;
const LARGE_MIN = 100;

function previousMonth(periodKey) {
  const [y, m] = String(periodKey).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * @param {object} p
 *   current   run snapshots   { employee_id, calculation_output, calculation_input }
 *   previous  last month's locked snapshots { employee_id, calculation_output }
 *   employees { id, first_name, last_name, … } (for names; tax issues come from taxIssues)
 *   taxIssues (employee) → string[]
 *   missingCodes (calculation_input) → string[]  (item messages)
 */
function buildReview({ current, previous, employees, taxIssues, missingCodes }) {
  const emp = {};
  (employees || []).forEach(e => { emp[e.id] = e; });
  const name = (id) => { const e = emp[id] || {}; return ((e.first_name || '') + ' ' + (e.last_name || '')).trim() || ('Employee #' + id); };
  const prev = {};
  (previous || []).forEach(s => { prev[s.employee_id] = s.calculation_output || {}; });

  const rows = (current || []).map(s => {
    const o = s.calculation_output || {};
    const p = prev[s.employee_id];
    const net = r2(o.net), prevNet = p ? r2(p.net) : null;
    const diff = prevNet == null ? null : r2(net - prevNet);
    const pct = prevNet ? r2(diff / Math.abs(prevNet) * 100) : null;
    const flags = [];
    if (prevNet == null) flags.push({ code: 'new', text: 'No finalized payslip last month' });
    else if (Math.abs(diff) > LARGE_MIN && (prevNet === 0 || Math.abs(pct) > LARGE_PCT)) {
      flags.push({ code: 'large_change', text: `Net pay ${diff > 0 ? 'up' : 'down'} R${Math.abs(diff).toFixed(2)}${pct != null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''} vs last month` });
    }
    if (net < 0 || o.negativeNetPay) flags.push({ code: 'negative_net', text: 'Net pay is negative' });
    (taxIssues(emp[s.employee_id] || {}) || []).forEach(t => flags.push({ code: 'tax_number', text: t }));
    (missingCodes(s.calculation_input) || []).forEach(t => flags.push({ code: 'irp5_code', text: t }));
    return {
      employee_id: s.employee_id, name: name(s.employee_id),
      gross: r2(o.gross), paye: r2(o.paye), net, prev_net: prevNet, diff, diff_pct: pct, flags
    };
  });

  const inRun = new Set((current || []).map(s => String(s.employee_id)));
  const missing = Object.keys(prev).filter(id => !inRun.has(String(id))).map(id => ({
    employee_id: Number(id), name: name(id), prev_net: r2(prev[id].net),
    flags: [{ code: 'not_in_run', text: 'Paid last month, not in this run' }]
  }));

  const sum = (list, k) => r2(list.reduce((a, x) => a + (Number(x[k]) || 0), 0));
  return {
    rows: rows.sort((a, b) => b.flags.length - a.flags.length || a.name.localeCompare(b.name)),
    not_in_run: missing,
    totals: { net: sum(rows, 'net'), prev_net: r2(Object.values(prev).reduce((a, o) => a + (Number(o.net) || 0), 0)) },
    flagged: rows.filter(r => r.flags.length).length + missing.length
  };
}

module.exports = { buildReview, previousMonth, LARGE_PCT, LARGE_MIN };
