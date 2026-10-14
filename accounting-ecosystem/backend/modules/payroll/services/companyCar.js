'use strict';

/**
 * Paytime spec 04 IT-07 — company car fringe benefit (Seventh Schedule para 7).
 * Ruan 2026-10-14: calculator per employee (table employee_company_cars, migration 035).
 *
 *   monthly value = determined value × 3.5%   (2.5% when a maintenance plan is included)
 *   PAYE on 80% of the value                   (20% when business use is at least 80%)
 *   IRP5 code 3802; never paid in cash (not in gross or net); in the SDL base via taxable
 *   income; NOT in the UIF base (same path as other non-cash benefits — see the IT-07 note).
 * A car counts in every month from start_period to end_period (open-ended when empty).
 * In a pro-rata month the engine pro-rates it like other regular items (para 7: the value
 * follows the days the car was available).
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function monthlyValue(car) {
  const rate = car.maintenance_plan ? 0.025 : 0.035;
  return r2(Number(car.determined_value) * rate);
}

function taxablePercentage(car) {
  return car.business_use_80 ? 20 : 80;
}

function appliesTo(car, periodKey) {
  return car.start_period <= periodKey && (!car.end_period || car.end_period >= periodKey);
}

/** Regular inputs for the engine for one month (pure). */
function carInputs(cars, periodKey) {
  return (cars || []).filter(c => appliesTo(c, periodKey)).map(c => ({
    description: 'Company car' + (c.description ? ' — ' + c.description : '') + ' (taxable benefit)',
    amount: monthlyValue(c),
    percentage: 0, is_percentage: false, percentage_value: 0,
    type: 'fringe_benefit',
    is_taxable: true,
    tax_treatment: 'net_only',
    paye_projection_type: 'FIXED_RECURRING',
    affects_uif: false,
    taxable_percentage: taxablePercentage(c),
    irp5_code: '3802',
    company_car_id: c.id
  }));
}

let _hasTable = false;
async function hasTable(supabase) {
  if (_hasTable) return true;
  try {
    const { error } = await supabase.from('employee_company_cars').select('id').limit(1);
    if (!error) _hasTable = true;
  } catch (_) { /* not there yet */ }
  return _hasTable;
}

module.exports = { monthlyValue, taxablePercentage, appliesTo, carInputs, hasTable };
