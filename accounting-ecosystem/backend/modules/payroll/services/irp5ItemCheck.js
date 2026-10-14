'use strict';

/**
 * Paytime spec 04 IT-05 — payroll items used WITHOUT an IRP5 code.
 * Ruan 2026-10-14 (option a): warn on every pay run; block the employee's IRP5 at
 * EMP501 (year end). The run itself is never blocked.
 *
 * Which items need a code (SARS IRP5 source codes):
 *   - earnings / allowances (36xx, 37xx …)
 *   - employer contributions (fringe-benefit codes 38xx/4474 …)
 *   - PRE-TAX deductions (pension 4001, provident 4003, RA 4006 …)
 * Net-only deductions (staff loan, savings, garnishee, union fee) are not reported on an
 * IRP5 and need no code. Basic salary, overtime and short time are engine lines (3601),
 * not items.
 * Codes come from the Payroll Items screen (payroll_items_master), matched like the
 * calculation does (itemLink: name + side); a company that still has no screen rows
 * falls back to its old KV item list, exactly as the data service does.
 */

const ItemLink = require('./itemLink');

function needsCode(input) {
  const side = ItemLink.sideOf(input.type);
  if (side === 'deduction') return input.tax_treatment === 'pre_tax';
  return true;
}

/** Items in one calculation_input that need a code and have none (pure). */
function itemsMissingCode(calcInput, codeSource) {
  const ci = calcInput || {};
  const list = [].concat(ci.regular_inputs || [], ci.currentInputs || ci.current_inputs || []);
  const out = [];
  list.forEach(x => {
    if (!x || !x.description) return;
    const amt = Number(x.amount) || 0;
    if (!amt && !x.is_percentage) return;
    if (!needsCode(x)) return;
    const m = ItemLink.pickMaster(codeSource, { name: x.description, type: x.type });
    if (!m || !String(m.irp5_code || '').trim()) out.push({ description: x.description, type: x.type || 'earning' });
  });
  return out;
}

/** The company's code source: screen rows, or the old KV list when it has none. */
async function loadCodeSource(supabase, companyId) {
  const { data, error } = await supabase.from('payroll_items_master')
    .select('id, item_name, item_type, irp5_code').eq('company_id', companyId).eq('is_active', true);
  if (error) throw new Error('Could not load payroll items: ' + error.message);
  if ((data || []).length) return data;
  const { data: kv } = await supabase.from('payroll_kv_store_eco').select('value')
    .eq('company_id', companyId).eq('key', 'payroll_items_' + companyId).maybeSingle();
  let items = kv && kv.value;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_) { items = []; } }
  return (Array.isArray(items) ? items : []).map((k, i) => ({
    id: 'kv' + i, item_name: k.item_name || k.name, item_type: k.item_type || k.type, irp5_code: k.irp5_code || null
  }));
}

/** Human message, one per item name. */
function issueText(items) {
  const names = [...new Set(items.map(i => i.description))];
  return names.map(n => `Payroll item "${n}" has no IRP5 code`);
}

module.exports = { needsCode, itemsMissingCode, loadCodeSource, issueText };
