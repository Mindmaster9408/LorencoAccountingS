/**
 * ============================================================================
 * Authentication & Authorization Middleware - Unified Ecosystem
 * ============================================================================
 * JWT-based authentication with company context and role-based access.
 * BUG FIX #2: All routes properly filter by company_id from JWT.
 * ============================================================================
 */

const jwt = require('jsonwebtoken');
const { hasPermission } = require('../config/permissions');

// Support common env-var casing mistakes (Zeabur UI sometimes uses mixed-case)
const _rawJwt = process.env.JWT_SECRET || process.env.JWT_Secret || process.env.JWTsecret || process.env.Jwt_Secret;
if (!_rawJwt) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
  console.error('Set JWT_SECRET (all-caps) in your environment or Zeabur Variables.');
  process.exit(1);
}

// Promote the discovered value to the canonical env name so other modules read it
if (!process.env.JWT_SECRET && _rawJwt) {
  console.warn('⚠️  Warning: JWT secret found using non-standard env-var name; normalising to JWT_SECRET.');
  process.env.JWT_SECRET = _rawJwt;
}
const JWT_SECRET = process.env.JWT_SECRET;

// Detect obviously insecure placeholder secrets and fail fast in production
const insecurePatterns = [/change-this-secret/i, /your_jwt/i, /placeholder/i, /123456/];
if (process.env.NODE_ENV === 'production') {
  const tooShort = typeof JWT_SECRET === 'string' && JWT_SECRET.length < 32;
  const matchesInsecure = insecurePatterns.some(rx => rx.test(JWT_SECRET));
  if (tooShort || matchesInsecure) {
    console.error('❌ FATAL SECURITY ERROR: JWT_SECRET appears insecure or placeholder-like.');
    console.error('   Set a strong random JWT_SECRET (>=32 chars) in Zeabur Variables before deploying.');
    process.exit(1);
  }
} else {
  if (typeof JWT_SECRET === 'string' && JWT_SECRET.length < 32) {
    console.warn('⚠️  WARNING: JWT_SECRET is short (<32). Consider using a 32+ char secret for production.');
  }
}

/**
 * Authenticate JWT token — extracts user info and attaches to req
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded;
    // BUG FIX #2: Always set companyId on req for easy filtering
    req.companyId = decoded.companyId || null;

    // Allow super admins / global admins to override company via X-Company-Id header
    const headerCompanyId = req.headers['x-company-id'];
    if (headerCompanyId && (decoded.isGlobalAdmin || decoded.role === 'super_admin')) {
      const parsed = parseInt(headerCompanyId, 10);
      if (!isNaN(parsed)) {
        req.companyId = parsed;
      }
    }

    next();
  });
}

/**
 * Require company selection — blocks access if no company selected
 * BUG FIX #2: Ensures every data query has company context
 */
function requireCompany(req, res, next) {
  if (!req.companyId) {
    return res.status(400).json({
      error: 'Company not selected',
      requiresCompanySelection: true,
      message: 'Please select a company before accessing this resource.'
    });
  }
  next();
}

/**
 * Permission checker middleware
 * Usage: requirePermission('PRODUCTS.CREATE')
 */
function requirePermission(permission) {
  return (req, res, next) => {
    const userRole = req.user.role;
    const [category, action] = permission.split('.');

    if (!hasPermission(userRole, category, action)) {
      // Log permission denial for audit
      if (req.auditLog) {
        req.auditLog('PERMISSION_DENIED', 'permission', null, {
          attemptedPermission: permission,
          userRole
        });
      }
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: permission,
        userRole
      });
    }
    next();
  };
}

/**
 * Role checker middleware
 * Usage: requireRole(['business_owner', 'accountant'])
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Access denied',
        message: `Requires one of: ${allowedRoles.join(', ')}`
      });
    }
    next();
  };
}

/**
 * Self or higher role — allows users to access own resources
 */
function selfOrRole(allowedRoles, paramName = 'id') {
  return (req, res, next) => {
    const requestedId = parseInt(req.params[paramName] || req.body[paramName]);
    if (requestedId === req.user.userId) return next();
    if (allowedRoles.includes(req.user.role)) return next();
    return res.status(403).json({ error: 'You can only access your own resources' });
  };
}

/**
 * Super admin check
 */
function requireSuperAdmin(req, res, next) {
  if (!req.user.isSuperAdmin) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

module.exports = {
  authenticateToken,
  requireCompany,
  requirePermission,
  requireRole,
  selfOrRole,
  requireSuperAdmin,
  JWT_SECRET
};
