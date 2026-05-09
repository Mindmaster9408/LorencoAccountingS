// Authentication and authorization middleware
import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';

// Verify JWT token
export const authenticateToken = async (req, res, next) => {
    try {
        // Guard: JWT_SECRET must be configured. If missing, all auth would fail silently.
        if (!process.env.JWT_SECRET) {
            console.error('FATAL: JWT_SECRET environment variable is not set');
            return res.status(500).json({ error: 'Server configuration error: JWT_SECRET not set' });
        }

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({ error: 'Access token required' });
        }

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Get user from database
        const result = await query(
            'SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }

        const user = result.rows[0];

        if (!user.is_active) {
            return res.status(403).json({ error: 'User account is deactivated' });
        }

        // Attach user to request
        req.user = user;
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(403).json({ error: 'Invalid token' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(403).json({ error: 'Token expired' });
        }
        console.error('Authentication error:', error.message || error);
        return res.status(500).json({ error: 'Authentication failed', detail: error.message });
    }
};

// Check if user has specific role
export const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                error: 'Insufficient permissions',
                required: roles,
                current: req.user.role
            });
        }

        next();
    };
};

// Check if user is admin
export const requireAdmin = requireRole('admin');

// Check if user is coach or admin
export const requireCoach = requireRole('admin', 'coach');

// Check if coach has access to specific client
export const requireClientAccess = async (req, res, next) => {
    try {
        const clientId = req.params.clientId || req.body.clientId;

        if (!clientId) {
            return res.status(400).json({ error: 'Client ID required' });
        }

        // Admins have access to all clients
        if (req.user.role === 'admin') {
            return next();
        }

        // Check if coach owns this client
        const result = await query(
            'SELECT id FROM coaching_clients WHERE id = $1 AND coach_id = $2',
            [clientId, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({ error: 'Access denied to this client' });
        }

        next();
    } catch (error) {
        console.error('Client access check error:', error);
        return res.status(500).json({ error: 'Failed to verify client access' });
    }
};

// Check if coach has access to specific program module
export const requireModuleAccess = (moduleKey) => {
    return async (req, res, next) => {
        try {
            // Admins have access to all modules
            if (req.user.role === 'admin') {
                return next();
            }

            // Check if coach has access to this module
            const result = await query(
                `SELECT cpa.is_enabled
                 FROM coach_program_access cpa
                 JOIN program_modules pm ON cpa.module_id = pm.id
                 WHERE cpa.coach_id = $1 AND pm.module_key = $2 AND cpa.is_enabled = true`,
                [req.user.id, moduleKey]
            );

            if (result.rows.length === 0) {
                return res.status(403).json({
                    error: 'Access denied to this module',
                    module: moduleKey
                });
            }

            next();
        } catch (error) {
            console.error('Module access check error:', error);
            return res.status(500).json({ error: 'Failed to verify module access' });
        }
    };
};

// Generate JWT token
export const generateToken = (userId, email, role) => {
    return jwt.sign(
        { userId, email, role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
};
