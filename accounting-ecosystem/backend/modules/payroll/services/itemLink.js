'use strict';

/**
 * Paytime — which Payroll Items screen row (payroll_items_master) does a calculation
 * item belong to?  (spec 04 IT-02 / IT-13)
 *
 * Order:
 *   1. the fixed link payroll_items.master_item_id (migration 033)
 *   2. same name AND same side (earning / deduction / employer contribution)
 *   3. same name only, when exactly one screen row has that name (the old behaviour)
 * Two rows with the same name on different sides (company 7: "Savings" earning and
 * deduction) are therefore never mixed up, and a rename no longer cuts the link once
 * 033 has run.
 */

function sideOf(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'deduction') return 'deduction';
  if (t === 'employer_contribution' || t === 'company_contribution') return 'employer';
  return 'earning';
}

const key = (s) => String(s || '').toLowerCase().trim();

/**
 * @param {Array} masters payroll_items_master rows (id, item_name, item_type, …)
 * @param {{master_item_id?, name, type}} item
 * @returns the matching master row or null
 */
function pickMaster(masters, item) {
  const list = masters || [];
  if (item.master_item_id != null) {
    const byId = list.find(m => String(m.id) === String(item.master_item_id));
    if (byId) return byId;
  }
  const n = key(item.name);
  if (!n) return null;
  const sameName = list.filter(m => key(m.item_name) === n);
  const side = sideOf(item.type);
  const sameSide = sameName.filter(m => sideOf(m.item_type) === side);
  if (sameSide.length) return sameSide[0];
  return sameName.length === 1 ? sameName[0] : null;
}

// Column probe — cached only once it exists, so running 033 needs no restart.
let _hasLink = false;
async function hasMasterLink(supabase) {
  if (_hasLink) return true;
  try {
    const { error } = await supabase.from('payroll_items').select('master_item_id').limit(1);
    if (!error) _hasLink = true;
  } catch (_) { /* treated as not there yet */ }
  return _hasLink;
}

module.exports = { sideOf, pickMaster, hasMasterLink };
