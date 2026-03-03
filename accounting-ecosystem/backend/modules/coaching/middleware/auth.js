/**
 * Coaching Module — Authentication Middleware (CJS)
 */
const jwt = require('jsonwebtoken');
const { query } = require('../db');

const JWT_SECRET = process.env.COACHING_JWT_SECRET || process.env.JWT_SECRET;

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    // First try to find user in coaching_users by decoded userId
    let result = await query(
      'SELECT id, email, first_name, last_name, role, is_active FROM coaching_users WHERE id = $1',
      [decoded.userId]
    );

    // If not found and this is an SSO token from the ecosystem, fall back to
    // matching by email or auto-mapping to the coaching admin user
    if (result.rows.length === 0 && decoded.ssoSource === 'ecosystem') {
      // Try matching by email first
      if (decoded.email) {
        result = await query(
          'SELECT id, email, first_name, last_name, role, is_active FROM coaching_users WHERE email = $1',
          [decoded.email]
        );
      }
      // If still not found, use the first admin user (coaching has a single admin)
      if (result.rows.length === 0) {
        result = await query(
          "SELECT id, email, first_name, last_name, role, is_active FROM coaching_users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
        );
      }
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    if (!user.is_active) {
      return res.status(403).json({ error: 'User account is deactivated' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(403).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({ error: 'Token expired' });
    }
    console.error('[Coaching] Auth error:', error.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions', required: roles, current: req.user.role });
  }
  next();
};

const requireAdmin = requireRole('admin');
const requireCoach = requireRole('admin', 'coach');

const requireClientAccess = async (req, res, next) => {
  try {
    const clientId = req.params.clientId || req.body.clientId;
    if (!clientId) return res.status(400).json({ error: 'Client ID required' });
    if (req.user.role === 'admin') return next();

    const result = await query(
      'SELECT id FROM coaching_clients WHERE id = $1 AND coach_id = $2',
      [clientId, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this client' });
    }
    next();
  } catch (error) {
    console.error('[Coaching] Client access check error:', error.message);
    return res.status(500).json({ error: 'Failed to verify client access' });
  }
};

const requireModuleAccess = (moduleKey) => async (req, res, next) => {
  try {
    if (req.user.role === 'admin') return next();
    const result = await query(
      `SELECT cpa.is_enabled
       FROM coaching_coach_program_access cpa
       JOIN coaching_program_modules pm ON cpa.module_id = pm.id
       WHERE cpa.coach_id = $1 AND pm.module_key = $2 AND cpa.is_enabled = true`,
      [req.user.id, moduleKey]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied to this module', module: moduleKey });
    }
    next();
  } catch (error) {
    console.error('[Coaching] Module access check error:', error.message);
    return res.status(500).json({ error: 'Failed to verify module access' });
  }
};

const generateToken = (userId, email, role) => {
  return jwt.sign({ userId, email, role }, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
};

module.exports = {
  authenticateToken,
  requireRole,
  requireAdmin,
  requireCoach,
  requireClientAccess,
  requireModuleAccess,
  generateToken,
};
