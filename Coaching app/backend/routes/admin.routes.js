// Admin routes for managing users and program access
import express from 'express';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// All routes require admin authentication
router.use(authenticateToken);
router.use(requireAdmin);

// Get all users
router.get('/users', async (req, res) => {
    try {
        const result = await query(
            `SELECT id, email, first_name, last_name, role, is_active, created_at, last_login
             FROM users
             ORDER BY created_at DESC`
        );

        res.json({
            success: true,
            users: result.rows
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Failed to retrieve users' });
    }
});

// Get all program modules
router.get('/modules', async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM program_modules ORDER BY module_name'
        );

        res.json({
            success: true,
            modules: result.rows
        });
    } catch (error) {
        console.error('Get modules error:', error);
        res.status(500).json({ error: 'Failed to retrieve modules' });
    }
});

// Get coach's module access
router.get('/coaches/:coachId/modules', async (req, res) => {
    try {
        const { coachId } = req.params;

        const result = await query(
            `SELECT pm.*, cpa.is_enabled, cpa.enabled_at
             FROM program_modules pm
             LEFT JOIN coach_program_access cpa ON pm.id = cpa.module_id AND cpa.coach_id = $1
             ORDER BY pm.module_name`,
            [coachId]
        );

        res.json({
            success: true,
            modules: result.rows
        });
    } catch (error) {
        console.error('Get coach modules error:', error);
        res.status(500).json({ error: 'Failed to retrieve coach modules' });
    }
});

// Enable/disable module for coach
router.post('/coaches/:coachId/modules/:moduleId',
    [
        body('isEnabled').isBoolean()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { coachId, moduleId } = req.params;
            const { isEnabled } = req.body;

            // Check if coach exists
            const coachResult = await query(
                'SELECT id, role FROM users WHERE id = $1',
                [coachId]
            );

            if (coachResult.rows.length === 0) {
                return res.status(404).json({ error: 'Coach not found' });
            }

            if (coachResult.rows[0].role !== 'coach') {
                return res.status(400).json({ error: 'User is not a coach' });
            }

            // Check if module exists
            const moduleResult = await query(
                'SELECT id FROM program_modules WHERE id = $1',
                [moduleId]
            );

            if (moduleResult.rows.length === 0) {
                return res.status(404).json({ error: 'Module not found' });
            }

            // Upsert coach_program_access
            await query(
                `INSERT INTO coach_program_access (coach_id, module_id, is_enabled, enabled_by)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (coach_id, module_id)
                 DO UPDATE SET is_enabled = $3, enabled_at = CURRENT_TIMESTAMP, enabled_by = $4`,
                [coachId, moduleId, isEnabled, req.user.id]
            );

            res.json({
                success: true,
                message: `Module ${isEnabled ? 'enabled' : 'disabled'} for coach`
            });

        } catch (error) {
            console.error('Update module access error:', error);
            res.status(500).json({ error: 'Failed to update module access' });
        }
    }
);

// Activate/deactivate user
router.patch('/users/:userId/status',
    [
        body('isActive').isBoolean()
    ],
    async (req, res) => {
        try {
            const { userId } = req.params;
            const { isActive } = req.body;

            // Can't deactivate yourself
            if (userId == req.user.id && !isActive) {
                return res.status(400).json({ error: 'Cannot deactivate your own account' });
            }

            await query(
                'UPDATE users SET is_active = $1 WHERE id = $2',
                [isActive, userId]
            );

            res.json({
                success: true,
                message: `User ${isActive ? 'activated' : 'deactivated'}`
            });

        } catch (error) {
            console.error('Update user status error:', error);
            res.status(500).json({ error: 'Failed to update user status' });
        }
    }
);

// Get system statistics
router.get('/stats', async (req, res) => {
    try {
        const stats = {};

        // Total users by role
        const usersResult = await query(
            `SELECT role, COUNT(*) as count
             FROM users
             WHERE is_active = true
             GROUP BY role`
        );
        stats.users = usersResult.rows;

        // Total clients by status
        const clientsResult = await query(
            `SELECT status, COUNT(*) as count
             FROM clients
             GROUP BY status`
        );
        stats.clients = clientsResult.rows;

        // Total sessions
        const sessionsResult = await query(
            'SELECT COUNT(*) as total_sessions FROM client_sessions'
        );
        stats.totalSessions = parseInt(sessionsResult.rows[0].total_sessions);

        // AI usage
        const aiResult = await query(
            `SELECT ai_provider, COUNT(*) as count, SUM(tokens_used) as total_tokens
             FROM ai_conversations
             WHERE ai_provider IS NOT NULL
             GROUP BY ai_provider`
        );
        stats.aiUsage = aiResult.rows;

        res.json({
            success: true,
            stats
        });

    } catch (error) {
        console.error('Get stats error:', error);
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
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { moduleKey, moduleName, description, isDefault } = req.body;

            const result = await query(
                `INSERT INTO program_modules (module_key, module_name, description, is_default)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`,
                [moduleKey, moduleName, description || '', isDefault || false]
            );

            res.status(201).json({
                success: true,
                message: 'Module created successfully',
                module: result.rows[0]
            });

        } catch (error) {
            if (error.constraint === 'program_modules_module_key_key') {
                return res.status(409).json({ error: 'Module key already exists' });
            }
            console.error('Create module error:', error);
            res.status(500).json({ error: 'Failed to create module' });
        }
    }
);

export default router;
