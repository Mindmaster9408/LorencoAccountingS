'use strict';

/**
 * ============================================================================
 * Labour / Machine Rate Lookup — Stockton Proof scoping (2026-09-12)
 * ============================================================================
 * production_labour_entries.labour_cost and production_machine_entries.
 * machine_cost were previously hardcoded to 0 on every insert — time was
 * tracked, cost never was. inventory_labour_rates / inventory_machine_rates
 * (migration 169) hold the actual rates; this resolves duration_minutes into
 * a real cost at entry-creation time.
 *
 * A company with no rates configured yet gets cost 0 (unchanged from
 * today's behaviour) rather than an error — rates are opt-in, not required.
 * ============================================================================
 */

async function getLabourRate(supabase, companyId, role) {
  const { data: exact } = await supabase
    .from('inventory_labour_rates')
    .select('hourly_rate')
    .eq('company_id', companyId)
    .eq('role', role || 'general')
    .maybeSingle();
  if (exact) return parseFloat(exact.hourly_rate) || 0;

  const { data: fallback } = await supabase
    .from('inventory_labour_rates')
    .select('hourly_rate')
    .eq('company_id', companyId)
    .eq('is_default', true)
    .maybeSingle();
  return fallback ? (parseFloat(fallback.hourly_rate) || 0) : 0;
}

const DEFAULT_MACHINE_KEY = '__default__';

async function getMachineRate(supabase, companyId, machineId) {
  if (machineId) {
    const { data: exact } = await supabase
      .from('inventory_machine_rates')
      .select('hourly_rate')
      .eq('company_id', companyId)
      .eq('machine_id', machineId)
      .maybeSingle();
    if (exact) return parseFloat(exact.hourly_rate) || 0;
  }
  const { data: fallback } = await supabase
    .from('inventory_machine_rates')
    .select('hourly_rate')
    .eq('company_id', companyId)
    .eq('machine_id', DEFAULT_MACHINE_KEY)
    .maybeSingle();
  return fallback ? (parseFloat(fallback.hourly_rate) || 0) : 0;
}

function costForMinutes(hourlyRate, minutes) {
  return Math.round((hourlyRate / 60) * minutes * 100) / 100;
}

module.exports = { getLabourRate, getMachineRate, costForMinutes, DEFAULT_MACHINE_KEY };
