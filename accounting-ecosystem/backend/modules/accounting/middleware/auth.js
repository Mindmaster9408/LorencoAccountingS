/**
 * ============================================================================
 * Auth Bridge — Adapts ECO Systum authentication for Lorenco Accounting routes
 * ============================================================================
 * ECO's authenticateToken middleware runs BEFORE requests reach accounting routes.
 * It sets req.user = decoded JWT payload and req.companyId.
 *
 * Lorenco routes expect req.user.id, req.user.companyId, req.user.isGlobalAdmin,
 * and use authenticate + hasPermission() per-route.
 *
 * This bridge adapts the ECO token shape to match what Lorenco routes expect.
 * ============================================================================
 */

const GLOBAL_ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'ruanvlog@lorenco.co.za,antonjvr@lorenco.co.za')
  .split(',')
  .map(email => email.trim().toLowerCase());

/**
 * ECO role → Lorenco role mapping
 * ECO roles: super_admin, admin, business_owner, partner, accountant, manager, cashier, employee, readonly
 * Lorenco roles: admin, accountant, bookkeeper, viewer
 */
function mapRole(ecoRole) {
  const mapping = {
    'super_admin': 'admin',
    'admin': 'admin',
    'business_owner': 'admin',
    'practice_manager': 'admin',
    'administrator': 'admin',
    'partner': 'admin',
    'accountant': 'accountant',
    'manager': 'accountant',
    'bookkeeper': 'bookkeeper',
    'cashier': 'bookkeeper',
    'employee': 'viewer',
    'readonly': 'viewer',
    'viewer': 'viewer',
  };
  return mapping[ecoRole] || 'viewer';
}

/**
 * Authentication middleware — adapts ECO's req.user to Lorenco's expected shape.
 * ECO's authenticateToken already verified the JWT and set req.user and req.companyId.
 */
function authenticate(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Adapt ECO JWT shape to Lorenco's expected req.user shape
  // ECO sets: req.user = { userId, companyId, role, email, fullName, isSuperAdmin, ssoSource, targetApp }
  // Lorenco expects: req.user = { id, companyId, email, role, firstName, lastName, companyStatus, isGlobalAdmin }

  const user = req.user;

  // Map id
  if (!user.id && user.userId) {
    user.id = user.userId;
  }

  // Always sync req.companyId → user.companyId so that admin X-Company-Id
  // overrides (set on req.companyId by global auth.js) flow through correctly.
  user.companyId = req.companyId || user.companyId;

  // Map role to Lorenco's role system
  user.role = mapRole(user.role);

  // Map name fields
  if (!user.firstName && user.fullName) {
    const parts = user.fullName.split(' ');
    user.firstName = parts[0] || '';
    user.lastName = parts.slice(1).join(' ') || '';
  }
  if (!user.firstName && user.full_name) {
    const parts = user.full_name.split(' ');
    user.firstName = parts[0] || '';
    user.lastName = parts.slice(1).join(' ') || '';
  }

  // Map admin flags
  if (user.isSuperAdmin || user.is_super_admin) {
    user.isGlobalAdmin = true;
  }
  if (!user.isGlobalAdmin && user.email && GLOBAL_ADMIN_EMAILS.includes(user.email.toLowerCase())) {
    user.isGlobalAdmin = true;
  }

  // Default company status to active (ECO doesn't track this in the JWT)
  if (!user.companyStatus) {
    user.companyStatus = 'active';
  }

  next();
}

/**
 * Permission-based authorization — same PERMISSIONS map as Lorenco
 */
const PERMISSIONS = {
  // Company management
  'company.view': ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'company.edit': ['admin'],
  'company.delete': ['admin'],

  // User management
  'user.view': ['admin', 'accountant'],
  'user.create': ['admin'],
  'user.edit': ['admin'],
  'user.delete': ['admin'],

  // Accounts
  'account.view': ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'account.create': ['admin', 'accountant'],
  'account.edit': ['admin', 'accountant'],
  'account.delete': ['admin', 'accountant'],

  // Journals
  'journal.view': ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'journal.create': ['admin', 'accountant', 'bookkeeper'],
  'journal.edit': ['admin', 'accountant', 'bookkeeper'],
  'journal.post': ['admin', 'accountant'],
  'journal.reverse': ['admin', 'accountant'],
  'journal.delete': ['admin', 'accountant'],

  // Bank
  'bank.view': ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'bank.manage': ['admin', 'accountant', 'bookkeeper'],
  'bank.import': ['admin', 'accountant', 'bookkeeper'],
  'bank.allocate': ['admin', 'accountant', 'bookkeeper'],
  'bank.reconcile': ['admin', 'accountant'],

  // Reports
  'report.view': ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'report.export': ['admin', 'accountant', 'bookkeeper'],

  // AI
  'ai.settings.view': ['admin', 'accountant'],
  'ai.settings.edit': ['admin', 'accountant'],
  'ai.request': ['admin', 'accountant', 'bookkeeper'],
  'ai.approve': ['admin', 'accountant'],

  // Audit
  'audit.view': ['admin', 'accountant'],

  // POS bridge (read POS data + cash/card reconciliation from accounting)
  'pos.view':      ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'pos.manage':    ['admin', 'accountant', 'bookkeeper'],
  'pos.reconcile': ['admin', 'accountant'],

  // Accounts Receivable / Customer invoices
  'ar.invoice.view':   ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'ar.invoice.create': ['admin', 'accountant', 'bookkeeper'],
  'ar.invoice.edit':   ['admin', 'accountant', 'bookkeeper'],
  'ar.invoice.post':   ['admin', 'accountant'],
  'ar.invoice.void':   ['admin', 'accountant'],
  'ar.payment.record': ['admin', 'accountant', 'bookkeeper'],

  // Accounts Payable / Supplier invoices (granular)
  'ap.invoice.view':           ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'ap.invoice.create':         ['admin', 'accountant', 'bookkeeper'],
  'ap.invoice.edit':           ['admin', 'accountant', 'bookkeeper'],
  'ap.invoice.void':           ['admin', 'accountant'],
  'ap.payment.record':         ['admin', 'accountant', 'bookkeeper'],
  'ap.purchase_order.approve': ['admin', 'accountant'],

  // Kept for backward compatibility — new routes use the granular keys above
  'ap.manage': ['admin', 'accountant', 'bookkeeper'],

  // Diagnostics & repair tooling
  'diagnostics.view':   ['admin', 'accountant', 'bookkeeper'],
  'diagnostics.repair': ['admin', 'accountant'],

  // Historical Comparative Financial Engine
  'historical.view':     ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'historical.create':   ['admin', 'accountant'],
  'historical.edit':     ['admin', 'accountant'],
  'historical.finalize': ['admin', 'accountant'],

  // Opening Balance / Prior Year Trial Balance Import
  'opening_balance.view':     ['admin', 'accountant', 'bookkeeper', 'viewer'],
  'opening_balance.create':   ['admin', 'accountant'],
  'opening_balance.edit':     ['admin', 'accountant'],
  'opening_balance.finalize': ['admin', 'accountant'],
  'opening_balance.archive':  ['admin', 'accountant'],
};

function hasPermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Global admins have all permissions
    if (req.user.isGlobalAdmin) {
      return next();
    }

    const allowedRoles = PERMISSIONS[permission];

    if (!allowedRoles) {
      // SECURITY: Unknown permissions must NEVER silently pass. Hard-fail with 403.
      console.error('[accounting] Unknown permission', {
        permission,
        path: req.originalUrl,
        userId: req.user?.id
      });
      return res.status(403).json({
        error: 'Unknown permission configuration',
        permission
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        permission,
        role: req.user.role
      });
    }

    next();
  };
}

/**
 * Role-based authorization
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (req.user.isGlobalAdmin) {
      return next();
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: allowedRoles,
        current: req.user.role
      });
    }

    next();
  };
}

/**
 * Company scope enforcement
 */
function enforceCompanyScope(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.user.isGlobalAdmin) {
    return next();
  }

  const requestCompanyId = parseInt(
    req.params.companyId ||
    req.query.companyId ||
    req.body.companyId
  );

  if (requestCompanyId && requestCompanyId !== req.user.companyId) {
    return res.status(403).json({ error: 'Access denied to this company' });
  }

  next();
}

/**
 * Startup validation — verifies the PERMISSIONS map is structurally sound.
 * Call once at server startup (e.g. in accounting routes index) to catch
 * misconfigured or empty permission entries before any request is served.
 *
 * TODO (future): extend to scan all accounting route files and cross-check
 * every hasPermission('x') call against the PERMISSIONS map so that a
 * missing key is caught at startup rather than at request time.
 */
function validatePermissionMap() {
  const validRoles = new Set(['admin', 'accountant', 'bookkeeper', 'viewer']);
  const errors = [];

  for (const [key, roles] of Object.entries(PERMISSIONS)) {
    if (!Array.isArray(roles) || roles.length === 0) {
      errors.push(`PERMISSIONS['${key}'] is empty or not an array`);
      continue;
    }
    for (const role of roles) {
      if (!validRoles.has(role)) {
        errors.push(`PERMISSIONS['${key}'] contains unknown role '${role}'`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('[accounting] PERMISSIONS map validation FAILED:');
    errors.forEach(e => console.error('  -', e));
    // Not a fatal throw — alerts on startup but does not kill the process.
    // Upgrade to throw if you want a hard startup gate.
  } else {
    console.log(`[accounting] PERMISSIONS map OK — ${Object.keys(PERMISSIONS).length} entries validated`);
  }

  return errors;
}

module.exports = {
  authenticate,
  authorize,
  hasPermission,
  enforceCompanyScope,
  validatePermissionMap,
  PERMISSIONS,
  GLOBAL_ADMIN_EMAILS
};
