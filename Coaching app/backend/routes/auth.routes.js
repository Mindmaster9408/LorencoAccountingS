// Authentication routes
import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Login
router.post('/login',
    [
        body('email').isEmail().normalizeEmail(),
        body('password').notEmpty()
    ],
    async (req, res) => {
        try {
            // Validate input
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { email, password } = req.body;

            // Get user from database
            const result = await query(
                'SELECT id, email, password_hash, first_name, last_name, role, is_active FROM users WHERE email = $1',
                [email]
            );

            if (result.rows.length === 0) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            const user = result.rows[0];

            // Check if user is active
            if (!user.is_active) {
                return res.status(403).json({ error: 'Account is deactivated' });
            }

            // Verify password
            const isValidPassword = await bcrypt.compare(password, user.password_hash);

            if (!isValidPassword) {
                return res.status(401).json({ error: 'Invalid email or password' });
            }

            // Update last login
            await query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

            // Generate token
            const token = generateToken(user.id, user.email, user.role);

            // Get user's module access if coach
            let moduleAccess = [];
            if (user.role === 'coach') {
                const modulesResult = await query(
                    `SELECT pm.module_key, pm.module_name
                     FROM coach_program_access cpa
                     JOIN program_modules pm ON cpa.module_id = pm.id
                     WHERE cpa.coach_id = $1 AND cpa.is_enabled = true`,
                    [user.id]
                );
                moduleAccess = modulesResult.rows.map(m => m.module_key);
            } else if (user.role === 'admin') {
                // Admins have access to all modules
                const allModulesResult = await query('SELECT module_key FROM program_modules');
                moduleAccess = allModulesResult.rows.map(m => m.module_key);
            }

            res.json({
                success: true,
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    role: user.role,
                    moduleAccess
                }
            });

        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ error: 'Login failed' });
        }
    }
);

// Register new user (admin only in production, or open for development)
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
            // Validate input
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { email, password, firstName, lastName, role } = req.body;

            // Check if user already exists
            const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);

            if (existingUser.rows.length > 0) {
                return res.status(409).json({ error: 'User already exists with this email' });
            }

            // Hash password
            const passwordHash = await bcrypt.hash(password, 10);

            // Create user
            const result = await query(
                `INSERT INTO users (email, password_hash, first_name, last_name, role)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, email, first_name, last_name, role`,
                [email, passwordHash, firstName, lastName, role || 'coach']
            );

            const newUser = result.rows[0];

            // If coach, assign default modules
            if (newUser.role === 'coach') {
                await query(
                    `INSERT INTO coach_program_access (coach_id, module_id, is_enabled)
                     SELECT $1, id, true FROM program_modules WHERE is_default = true`,
                    [newUser.id]
                );
            }

            res.status(201).json({
                success: true,
                message: 'User registered successfully',
                user: {
                    id: newUser.id,
                    email: newUser.email,
                    firstName: newUser.first_name,
                    lastName: newUser.last_name,
                    role: newUser.role
                }
            });

        } catch (error) {
            console.error('Registration error:', error);
            res.status(500).json({ error: 'Registration failed' });
        }
    }
);

// Get current user info
router.get('/me', authenticateToken, async (req, res) => {
    try {
        // Get user's module access
        let moduleAccess = [];
        if (req.user.role === 'coach') {
            const modulesResult = await query(
                `SELECT pm.module_key, pm.module_name
                 FROM coach_program_access cpa
                 JOIN program_modules pm ON cpa.module_id = pm.id
                 WHERE cpa.coach_id = $1 AND cpa.is_enabled = true`,
                [req.user.id]
            );
            moduleAccess = modulesResult.rows.map(m => m.module_key);
        } else if (req.user.role === 'admin') {
            const allModulesResult = await query('SELECT module_key FROM program_modules');
            moduleAccess = allModulesResult.rows.map(m => m.module_key);
        }

        res.json({
            success: true,
            user: {
                id: req.user.id,
                email: req.user.email,
                firstName: req.user.first_name,
                lastName: req.user.last_name,
                role: req.user.role,
                moduleAccess
            }
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Failed to get user info' });
    }
});

// Logout (client-side token removal, optional server-side blacklist)
router.post('/logout', authenticateToken, (req, res) => {
    // In a more complex system, you might want to blacklist the token here
    res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
