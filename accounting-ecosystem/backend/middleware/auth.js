/**
 * ============================================================================
 * Authentication & Authorization Middleware - Unified Ecosystem
 * ============================================================================
 * JWT-based authentication with company context and role-based access.
 * BUG FIX #2:    All routes properly filter by company_id from JWT.
 * HOTFIX-03:     Session revocation check — DB re-verify on every request,
 *                cached 60 s per (userId, companyId) pair.
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

// ── Session validity cache ────────────────────────────────────────────────────
// Avoids a DB round-trip on every request. TTL = 60 s.
// Key: `${userId}_${companyId}` — a separate entry per company context prevents
// a stale "valid" entry for company A from being reused when the user switches
// to company B (which may have different access).
const _sessionCache = new Map();
const _SESSION_TTL = 60_000; // 60 seconds

function _readCache(key) {
  const e = _sessionCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > _SESSION_TTL) { _sessionCache.delete(key); return null; }
  return e;
}

function _writeCache(key, ok, status, reason) {
  _sessionCache.set(key, { ok, status, reason, ts: Date.now() });
  // Evict expired entries when the map grows large (bounded by active sessions)
  if (_sessionCache.size > 2000) {
    const cutoff = Date.now() - _SESSION_TTL;
    for (const [k, v] of _sessionCache) {
      if (v.ts < cutoff) _sessionCache.delete(k);
    }
  }
}

// Lazy-load the Supabase client to avoid any startup-order issues.
// The database module itself does not import from middleware, so no circular dep.
let _supabase = null;
function _db() {
  if (!_supabase) _supabase = require('../config/database').supabase;
  return _supabase;
}

/**
 * DB-level session validity check.
 *
 * Verifies (in order):
 *   1. User still exists in the `users` table and is_active = true
 *   2. If a companyId is present: the company is active
 *   3. If a companyId is present and the user is NOT a super admin:
 *      the user still has an active row in `user_company_access`
 *
 * Results are cached per (userId, companyId) pair for up to 60 s.
 * Revocation takes effect within at most 60 s of the DB change.
 *
 * Fail-open on DB error so that a transient Supabase outage does not
 * lock out every authenticated user.  The JWT signature itself already
 * proves the request was issued by our auth server.
 *
 * Called from authenticateToken (applied to every authenticated request)
 * and exported as requireActiveSession for explicit wiring if needed.
 */
async function _checkActiveSession(req, res, next) {
  const userId    = req.user && req.user.userId;
  const companyId = req.companyId;       // null when no company selected yet
  const isSA      = !!(req.user && req.user.isSuperAdmin);
  const cacheKey  = `${userId}_${companyId || '0'}`;

  // ── Cache hit ───────────────────────────────────────────────────────────────
  const cached = _readCache(cacheKey);
  if (cached) {
    return cached.ok
      ? next()
      : res.status(cached.status).json({ error: cached.reason });
  }

  // ── DB checks ───────────────────────────────────────────────────────────────
  try {
    const db = _db();

    // 1. User must exist and be active
    const { data: user } = await db
      .from('users')
      .select('id, is_active')
      .eq('id', userId)
      .maybeSingle();

    if (!user) {
      _writeCache(cacheKey, false, 401, 'Account not found');
      return res.status(401).json({ error: 'Account not found' });
    }
    if (!user.is_active) {
      _writeCache(cacheKey, false, 401, 'Account is disabled');
      return res.status(401).json({ error: 'Account is disabled' });
    }

    if (companyId) {
      // 2. Company must be active
      const { data: company } = await db
        .from('companies')
        .select('id, is_active')
        .eq('id', companyId)
        .maybeSingle();

      if (!company || !company.is_active) {
        _writeCache(cacheKey, false, 403, 'Company is inactive or not found');
        return res.status(403).json({ error: 'Company is inactive or not found' });
      }

      // 3. Non-super-admins must have an active company membership
      if (!isSA) {
        const { data: access } = await db
          .from('user_company_access')
          .select('id')
          .eq('user_id', userId)
          .eq('company_id', companyId)
          .eq('is_active', true)
          .maybeSingle();

        if (!access) {
          _writeCache(cacheKey, false, 403, 'Access to this company has been revoked');
          return res.status(403).json({ error: 'Access to this company has been revoked' });
        }
      }
    }

    _writeCache(cacheKey, true, 200, null);
    next();
  } catch (err) {
    // Fail open: a DB outage must not lock out all authenticated users.
    console.error('[auth] Session DB check failed — failing open:', err.message);
    next();
  }
}

/**
 * Authenticate JWT token — extracts user info, attaches to req,
 * then verifies the session is still valid in the DB (cached 60 s).
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (_) {
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

  // Chain the async DB session check. The .catch() guard handles any unexpected
  // rejection that escapes _checkActiveSession's own try-catch (Express 4 does
  // not automatically propagate Promise rejections from middleware).
  _checkActiveSession(req, res, next).catch(err => {
    console.error('[auth] authenticateToken — session check unhandled rejection:', err.message);
    next(); // fail open
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
 * Standalone session validity middleware.
 * Equivalent to the DB check inside authenticateToken — useful for routes
 * that apply authenticateToken at an outer layer and want an explicit check
 * deeper in the stack (e.g., after a company context is set by a sub-router).
 */
function requireActiveSession(req, res, next) {
  _checkActiveSession(req, res, next).catch(err => {
    console.error('[auth] requireActiveSession — unhandled rejection:', err.message);
    next();
  });
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
  requireActiveSession,
  requirePermission,
  requireRole,
  selfOrRole,
  requireSuperAdmin,
  JWT_SECRET
};
