/**
 * Coaching Module — Admin Routes (CJS)
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdmin);

// Get all users
router.get('/users', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, email, first_name, last_name, role, is_active, created_at, last_login
       FROM coaching_users ORDER BY created_at DESC`
    );
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('[Coaching] Get users error:', error.message);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// Get all program modules
router.get('/modules', async (req, res) => {
  try {
    const result = await query('SELECT * FROM coaching_program_modules ORDER BY module_name');
    res.json({ success: true, modules: result.rows });
  } catch (error) {
    console.error('[Coaching] Get modules error:', error.message);
    res.status(500).json({ error: 'Failed to retrieve modules' });
  }
});

// Get coach's module access
router.get('/coaches/:coachId/modules', async (req, res) => {
  try {
    const { coachId } = req.params;
    const result = await query(
      `SELECT pm.*, cpa.is_enabled, cpa.enabled_at
       FROM coaching_program_modules pm
       LEFT JOIN coaching_coach_program_access cpa ON pm.id = cpa.module_id AND cpa.coach_id = $1
       ORDER BY pm.module_name`,
      [coachId]
    );
    res.json({ success: true, modules: result.rows });
  } catch (error) {
    console.error('[Coaching] Get coach modules error:', error.message);
    res.status(500).json({ error: 'Failed to retrieve coach modules' });
  }
});

// Enable/disable module for coach
router.post('/coaches/:coachId/modules/:moduleId',
  [body('isEnabled').isBoolean()],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { coachId, moduleId } = req.params;
      const { isEnabled } = req.body;

      const coachResult = await query('SELECT id, role FROM coaching_users WHERE id = $1', [coachId]);
      if (coachResult.rows.length === 0) return res.status(404).json({ error: 'Coach not found' });
      if (coachResult.rows[0].role !== 'coach') return res.status(400).json({ error: 'User is not a coach' });

      const moduleResult = await query('SELECT id FROM coaching_program_modules WHERE id = $1', [moduleId]);
      if (moduleResult.rows.length === 0) return res.status(404).json({ error: 'Module not found' });

      await query(
        `INSERT INTO coaching_coach_program_access (coach_id, module_id, is_enabled, enabled_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (coach_id, module_id)
         DO UPDATE SET is_enabled = $3, enabled_at = CURRENT_TIMESTAMP, enabled_by = $4`,
        [coachId, moduleId, isEnabled, req.user.id]
      );

      res.json({ success: true, message: `Module ${isEnabled ? 'enabled' : 'disabled'} for coach` });
    } catch (error) {
      console.error('[Coaching] Update module access error:', error.message);
      res.status(500).json({ error: 'Failed to update module access' });
    }
  }
);

// Activate/deactivate user
router.patch('/users/:userId/status',
  [body('isActive').isBoolean()],
  async (req, res) => {
    try {
      const { userId } = req.body;
      const { isActive } = req.body;

      if (String(req.params.userId) === String(req.user.id) && !isActive) {
        return res.status(400).json({ error: 'Cannot deactivate your own account' });
      }

      await query('UPDATE coaching_users SET is_active = $1 WHERE id = $2', [isActive, req.params.userId]);
      res.json({ success: true, message: `User ${isActive ? 'activated' : 'deactivated'}` });
    } catch (error) {
      console.error('[Coaching] Update user status error:', error.message);
      res.status(500).json({ error: 'Failed to update user status' });
    }
  }
);

// Get system stats
router.get('/stats', async (req, res) => {
  try {
    const [usersResult, clientsResult, sessionsResult] = await Promise.all([
      query(`SELECT role, COUNT(*) as count FROM coaching_users WHERE is_active = true GROUP BY role`),
      query(`SELECT status, COUNT(*) as count FROM coaching_clients GROUP BY status`),
      query(`SELECT COUNT(*) as total_sessions FROM coaching_client_sessions`)
    ]);

    res.json({
      success: true,
      stats: {
        users: usersResult.rows,
        clients: clientsResult.rows,
        totalSessions: parseInt(sessionsResult.rows[0].total_sessions || 0),
      }
    });
  } catch (error) {
    console.error('[Coaching] Get stats error:', error.message);
    res.status(500).json({ error: 'Failed to retrieve statistics' });
  }
});

// Create new program module
router.post('/modules',
  [
    body('moduleKey').notEmpty().trim(),
    body('moduleName').notEmpty().trim(),
    body('description').optional(),
    body('isDefault').optional().isBoolean()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { moduleKey, moduleName, description, isDefault } = req.body;

      const result = await query(
        `INSERT INTO coaching_program_modules (module_key, module_name, description, is_default)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [moduleKey, moduleName, description || '', isDefault || false]
      );

      res.status(201).json({ success: true, message: 'Module created successfully', module: result.rows[0] });
    } catch (error) {
      if (error.constraint === 'coaching_program_modules_module_key_key') {
        return res.status(409).json({ error: 'Module key already exists' });
      }
      console.error('[Coaching] Create module error:', error.message);
      res.status(500).json({ error: 'Failed to create module' });
    }
  }
);

module.exports = router;
