/**
 * ============================================================================
 * Global Payroll Authority Helpers
 * ============================================================================
 * DB-authoritative checks for the global payroll authority designation.
 *
 * The authority flag (companies.is_global_payroll_authority = true) is the
 * sole source of truth. No role check, no company-name match, no hardcoded IDs.
 *
 * Migration: backend/config/migrations/022_global_payroll_authority.sql
 *
 * Usage (backend routes):
 *   const { isGlobalPayrollAuthority, getGlobalAuthorityCompany } =
 *     require('../../shared/utils/globalAuthority');
 *
 *   // Guard a write endpoint:
 *   const ok = await isGlobalPayrollAuthority(req.companyId);
 *   if (!ok) return res.status(403).json({ error: '...' });
 *
 *   // Get full authority record for a read endpoint:
 *   const authority = await getGlobalAuthorityCompany();
 * ============================================================================
 */

const { supabase } = require('../../config/database');

/**
 * Returns true if the given companyId belongs to the company that holds
 * is_global_payroll_authority = true in the companies table.
 *
 * Returns false (not throws) on DB error so callers can safely use it in
 * authorization guards — a DB failure defaults to deny, never to allow.
 *
 * @param {number|null} companyId
 * @returns {Promise<boolean>}
 */
async function isGlobalPayrollAuthority(companyId) {
    if (!companyId) return false;

    const { data, error } = await supabase
        .from('companies')
        .select('id')
        .eq('id', companyId)
        .eq('is_global_payroll_authority', true)
        .maybeSingle();

    if (error) {
        console.error('[globalAuthority] DB error in isGlobalPayrollAuthority:', error.message);
        return false; // Fail closed — deny on DB error
    }

    return !!data;
}

/**
 * Returns the company record for the global payroll authority, or null if
 * none has been designated (migration not yet run or column missing).
 *
 * @returns {Promise<{id: number, company_name: string, is_global_payroll_authority: boolean}|null>}
 */
async function getGlobalAuthorityCompany() {
    const { data, error } = await supabase
        .from('companies')
        .select('id, company_name, is_global_payroll_authority')
        .eq('is_global_payroll_authority', true)
        .maybeSingle();

    if (error) {
        console.error('[globalAuthority] DB error in getGlobalAuthorityCompany:', error.message);
        return null;
    }

    return data || null;
}

module.exports = { isGlobalPayrollAuthority, getGlobalAuthorityCompany };
