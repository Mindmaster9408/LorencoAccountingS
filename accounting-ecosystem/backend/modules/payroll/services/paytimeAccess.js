/**
 * ============================================================================
 * Paytime Access Control Service
 * ============================================================================
 * Single enforcement point for employee visibility filtering in Paytime.
 *
 * Rules (evaluated top-to-bottom, first match wins):
 *   Rule 1: super_admin or business_owner  → see ALL (no filter)
 *   Rule 2: accountant                     → see ALL (trusted finance role)
 *   Rule 3: no paytime_user_config row     → see ALL (backward-compatible default)
 *   Rule 4: employee_scope = 'selected'    → see ONLY paytime_employee_access rows
 *   Rule 5: employee_scope = 'all' AND can_view_confidential = false
 *              → see employees WHERE classification = 'public' only
 *   Rule 6: employee_scope = 'all' AND can_view_confidential = true → see ALL
 *
 * Usage:
 *   const filter = await getEmployeeFilter(supabase, userId, companyId, role);
 *   // Then apply filter.apply(query) to any Supabase employees query
 * ============================================================================
 */

const { supabase } = require('../../../config/database');

const UNRESTRICTED_ROLES = ['super_admin', 'business_owner', 'practice_manager', 'administrator', 'accountant'];

/**
 * Load the paytime_user_config for a user+company pair.
 * Returns null if no row exists (= unrestricted).
 */
async function loadConfig(userId, companyId) {
  const { data } = await supabase
    .from('paytime_user_config')
    .select('modules, employee_scope, can_view_confidential')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  return data || null;
}

/**
 * Resolve the set of visible employee IDs for a user with employee_scope='selected'.
 * Returns an array of integer employee IDs.
 */
async function loadAllowedEmployeeIds(userId, companyId) {
  const { data } = await supabase
    .from('paytime_employee_access')
    .select('employee_id')
    .eq('user_id', userId)
    .eq('company_id', companyId);
  return (data || []).map(r => r.employee_id);
}

/**
 * Build a Supabase query filter descriptor for employee visibility.
 *
 * @param {string} role - The user's role string (e.g. 'payroll_admin')
 * @param {number} userId
 * @param {number} companyId
 * @returns {Promise<{ type: 'none'|'classification'|'ids', ids?: number[] }>}
 *   type 'none'           → no extra filter; user sees all employees in company
 *   type 'classification' → filter to classification='public' only
 *   type 'ids'            → filter to employees whose id is in ids[]
 */
async function getEmployeeFilter(role, userId, companyId) {
  // Rules 1 & 2 — unrestricted roles bypass everything
  if (UNRESTRICTED_ROLES.includes(role)) {
    return { type: 'none' };
  }

  const config = await loadConfig(userId, companyId);

  // Rule 3 — no config row = unrestricted (backward-compatible)
  if (!config) {
    return { type: 'none' };
  }

  // Rule 4 — selected employee list
  if (config.employee_scope === 'selected') {
    const ids = await loadAllowedEmployeeIds(userId, companyId);
    return { type: 'ids', ids };
  }

  // Rules 5 & 6 — employee_scope = 'all'
  if (config.can_view_confidential) {
    return { type: 'none' }; // Rule 6
  }
  return { type: 'classification' }; // Rule 5
}

/**
 * Apply a filter descriptor to a Supabase query chain.
 * Returns the modified query.
 *
 * @param {object} query - Supabase query builder
 * @param {{ type: string, ids?: number[] }} filter
 */
function applyFilter(query, filter) {
  if (filter.type === 'classification') {
    return query.eq('classification', 'public');
  }
  if (filter.type === 'ids') {
    if (filter.ids.length === 0) {
      // No employees assigned — return empty by using an impossible condition
      return query.eq('id', -1);
    }
    return query.in('id', filter.ids);
  }
  return query; // 'none' — no filter applied
}

/**
 * Check if a specific employee is visible to the user.
 * Used to gate single-employee endpoints (GET /:id, salary, bank-details, historical).
 *
 * @param {string} role
 * @param {number} userId
 * @param {number} companyId
 * @param {object} employee - must have fields: id, classification
 * @returns {Promise<boolean>}
 */
async function canViewEmployee(role, userId, companyId, employee) {
  if (UNRESTRICTED_ROLES.includes(role)) return true;

  const config = await loadConfig(userId, companyId);
  if (!config) return true; // Rule 3

  if (config.employee_scope === 'selected') {
    const ids = await loadAllowedEmployeeIds(userId, companyId);
    return ids.includes(employee.id);
  }

  // employee_scope = 'all'
  if (config.can_view_confidential) return true;
  return employee.classification === 'public';
}

/**
 * Check if the user has access to a Paytime module.
 * Returns true if unrestricted or no config row.
 * Returns false if the module is not in config.modules.
 *
 * @param {string} role
 * @param {number} userId
 * @param {number} companyId
 * @param {string} moduleName - 'payroll' | 'leave'
 * @returns {Promise<boolean>}
 */
async function hasModuleAccess(role, userId, companyId, moduleName) {
  if (UNRESTRICTED_ROLES.includes(role)) return true;
  const config = await loadConfig(userId, companyId);
  if (!config) return true; // Rule 3 — no config = unrestricted
  return Array.isArray(config.modules) && config.modules.includes(moduleName);
}

/**
 * Express middleware factory — blocks routes for users missing a required module.
 * Usage: router.get('/', requirePaytimeModule('payroll'), handler)
 */
function requirePaytimeModule(moduleName) {
  return async (req, res, next) => {
    try {
      const role = req.user?.role || '';
      const ok = await hasModuleAccess(role, req.user?.userId, req.companyId, moduleName);
      if (!ok) {
        return res.status(403).json({
          error: `Access denied — your account does not have access to the '${moduleName}' module in Paytime.`
        });
      }
      next();
    } catch (err) {
      console.error('[paytimeAccess] requirePaytimeModule error:', err.message);
      res.status(500).json({ error: 'Server error checking Paytime module access' });
    }
  };
}

module.exports = {
  getEmployeeFilter,
  applyFilter,
  canViewEmployee,
  hasModuleAccess,
  requirePaytimeModule,
};
