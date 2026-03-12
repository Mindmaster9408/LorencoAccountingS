/**
 * ============================================================================
 * Module Check Middleware
 * ============================================================================
 * Prevents access to disabled modules. Returns 403 if the requested
 * module is not enabled in config/modules.js.
 * ============================================================================
 */

const { isModuleEnabled, companyHasModule, modules } = require('../config/modules');
const { supabase } = require('../config/database');

/**
 * Factory: create middleware that blocks access if a module is disabled
 * Usage: router.use(requireModule('pos'))
 *
 * @param {string} moduleKey - 'pos', 'payroll', or 'accounting'
 */
function requireModule(moduleKey) {
  return async (req, res, next) => {
    // 1. Check global server-level toggle
    if (!isModuleEnabled(moduleKey)) {
      return res.status(403).json({
        error: 'Module not available',
        module: moduleKey,
        message: `The ${modules[moduleKey]?.name || moduleKey} module is not enabled on this server.`
      });
    }

    // 2. If user is authenticated, also check company-level toggle
    // Super admins bypass company-level module restrictions
    if (req.companyId && !req.user?.isSuperAdmin) {
      const hasModule = await companyHasModule(supabase, req.companyId, moduleKey);
      if (!hasModule) {
        return res.status(403).json({
          error: 'Module not enabled for company',
          module: moduleKey,
          message: `Your company does not have the ${modules[moduleKey]?.name || moduleKey} module enabled. Contact your administrator.`
        });
      }
    }

    // 3. Per-user app access check (level 3 of the 3-tier gate).
    // Super admins are exempt.  If the user has ANY rows in user_app_access
    // for their (userId, companyId) pair, then the requested app must be in
    // those rows.  Zero rows means "unrestricted" (default: no restriction set).
    if (req.user?.userId && req.companyId && !req.user?.isSuperAdmin) {
      const { data: appRows, error: appErr } = await supabase
        .from('user_app_access')
        .select('app_key')
        .eq('user_id', req.user.userId)
        .eq('company_id', req.companyId);

      if (!appErr && appRows && appRows.length > 0) {
        const grantedApps = appRows.map(r => r.app_key);
        if (!grantedApps.includes(moduleKey)) {
          return res.status(403).json({
            error: 'App access not granted',
            module: moduleKey,
            message: `You do not have access to the ${modules[moduleKey]?.name || moduleKey} app. Contact your administrator.`
          });
        }
      }
      // Zero rows → no restriction recorded → allow through
    }

    next();
  };
}

/**
 * Simple synchronous check (server-level only, no DB call)
 * Use when you don't need company-level verification
 */
function requireModuleSync(moduleKey) {
  return (req, res, next) => {
    if (!isModuleEnabled(moduleKey)) {
      return res.status(403).json({
        error: 'Module not available',
        module: moduleKey,
        message: `The ${modules[moduleKey]?.name || moduleKey} module is not enabled.`
      });
    }
    next();
  };
}

module.exports = {
  requireModule,
  requireModuleSync,
};
