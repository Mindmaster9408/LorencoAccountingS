'use strict';

/**
 * The two Lorenco companies the ecosystem treats specially — recognised by ID, never by name
 * (2026-11-20, Ruan: company 1 is renamed from "The Infinite Legacy" to "Lorenco Ecosystem";
 * it is only the super users' profile now, and Lorenco Accounting Services is the practice that
 * holds Lorenco's clients).
 *
 *   SUPER_COMPANY_ID     — the super users' profile (company 1). Super admins land here.
 *   LORENCO_PRACTICE_ID  — Lorenco Accounting Services (company 38), the accounting practice that
 *                          manages Lorenco's own clients. Eco billing invoices those clients
 *                          directly (not the practice) — see ecoBilling.computePayers.
 *
 * Stockton (inventory) stays limited to Lorenco's own clients: companies managed by either of
 * these two (and the two themselves).
 *
 * Mirrored in the frontend as ECO_SUPER_COMPANY_ID / STOCKTON_MANAGER_IDS (dashboard.html,
 * admin.html, js/dashboard-v2.js) — change both together.
 */

const SUPER_COMPANY_ID = () => Number(process.env.SUPER_COMPANY_ID || 1);
const LORENCO_PRACTICE_ID = () => Number(process.env.LORENCO_PRACTICE_COMPANY_ID || 38);

const isSuperCompany = (companyId) => companyId != null && Number(companyId) === SUPER_COMPANY_ID();

/** Companies whose clients may use Stockton: the super profile and Lorenco's practice. */
const stocktonManagerIds = () => [SUPER_COMPANY_ID(), LORENCO_PRACTICE_ID()];
const isStocktonManager = (companyId) => companyId != null && stocktonManagerIds().includes(Number(companyId));

/**
 * May this company itself use Stockton? Yes when it is one of the two Lorenco companies or an
 * active client managed by one of them.
 */
async function companyMayUseStockton(supabase, companyId) {
  if (companyId == null) return false;
  if (isStocktonManager(companyId)) return true;
  const { data, error } = await supabase.from('eco_clients').select('id')
    .eq('client_company_id', Number(companyId)).eq('is_active', true)
    .in('company_id', stocktonManagerIds()).limit(1);
  return !error && Array.isArray(data) && data.length > 0;
}

module.exports = { SUPER_COMPANY_ID, LORENCO_PRACTICE_ID, isSuperCompany, stocktonManagerIds, isStocktonManager, companyMayUseStockton };
