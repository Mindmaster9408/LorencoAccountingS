/**
 * Coaching Module — Auth Routes (CJS)
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { generateToken, authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Login
router.post('/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password } = req.body;

      const result = await query(
        'SELECT id, email, password_hash, first_name, last_name, role, is_active FROM coaching_users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];
      if (!user.is_active) return res.status(403).json({ error: 'Account is deactivated' });

      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) return res.status(401).json({ error: 'Invalid email or password' });

      await query('UPDATE coaching_users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

      const token = generateToken(user.id, user.email, user.role);

      let moduleAccess = [];
      if (user.role === 'coach') {
        const modulesResult = await query(
          `SELECT pm.module_key FROM coaching_coach_program_access cpa
           JOIN coaching_program_modules pm ON cpa.module_id = pm.id
           WHERE cpa.coach_id = $1 AND cpa.is_enabled = true`,
          [user.id]
        );
        moduleAccess = modulesResult.rows.map(m => m.module_key);
      } else if (user.role === 'admin') {
        const all = await query('SELECT module_key FROM coaching_program_modules');
        moduleAccess = all.rows.map(m => m.module_key);
      }

      res.json({
        success: true,
        token,
        user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role, moduleAccess }
      });
    } catch (error) {
      console.error('[Coaching] Login error:', error.message);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// Register (admin only in production)
router.post('/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('firstName').notEmpty().trim(),
    body('lastName').notEmpty().trim(),
    body('role').isIn(['admin', 'coach'])
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, password, firstName, lastName, role } = req.body;

      const existing = await query('SELECT id FROM coaching_users WHERE email = $1', [email]);
      if (existing.rows.length > 0) return res.status(409).json({ error: 'User already exists with this email' });

      const passwordHash = await bcrypt.hash(password, 10);

      const result = await query(
        `INSERT INTO coaching_users (email, password_hash, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, first_name, last_name, role`,
        [email, passwordHash, firstName, lastName, role || 'coach']
      );

      const newUser = result.rows[0];

      if (newUser.role === 'coach') {
        await query(
          `INSERT INTO coaching_coach_program_access (coach_id, module_id, is_enabled)
           SELECT $1, id, true FROM coaching_program_modules WHERE is_default = true`,
          [newUser.id]
        );
      }

      res.status(201).json({
        success: true,
        message: 'User registered successfully',
        user: { id: newUser.id, email: newUser.email, firstName: newUser.first_name, lastName: newUser.last_name, role: newUser.role }
      });
    } catch (error) {
      console.error('[Coaching] Register error:', error.message);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// Get current user
router.get('/me', authenticateToken, async (req, res) => {
  try {
    let moduleAccess = [];
    if (req.user.role === 'coach') {
      const r = await query(
        `SELECT pm.module_key FROM coaching_coach_program_access cpa
         JOIN coaching_program_modules pm ON cpa.module_id = pm.id
         WHERE cpa.coach_id = $1 AND cpa.is_enabled = true`,
        [req.user.id]
      );
      moduleAccess = r.rows.map(m => m.module_key);
    } else if (req.user.role === 'admin') {
      const r = await query('SELECT module_key FROM coaching_program_modules');
      moduleAccess = r.rows.map(m => m.module_key);
    }

    res.json({
      success: true,
      user: { id: req.user.id, email: req.user.email, firstName: req.user.first_name, lastName: req.user.last_name, role: req.user.role, moduleAccess }
    });
  } catch (error) {
    console.error('[Coaching] Get user error:', error.message);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Logout
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

module.exports = router;
