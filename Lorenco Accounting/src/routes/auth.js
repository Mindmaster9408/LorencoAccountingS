const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const AuditLogger = require('../services/auditLogger');

const router = express.Router();

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { email, password, companyId, firstName, lastName } = req.body;
    const role = 'viewer'; // New registrations always start as viewer for security

    // Validation
    if (!email || !password || !companyId) {
      return res.status(400).json({ error: 'Email, password, and companyId are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    await client.query('BEGIN');

    // Check if company exists
    const companyCheck = await client.query(
      'SELECT id, status FROM companies WHERE id = $1',
      [companyId]
    );

    if (companyCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Company not found' });
    }

    if (companyCheck.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Company is not active' });
    }

    // Check if email already exists
    const emailCheck = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (emailCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await client.query(
      `INSERT INTO users (company_id, email, password_hash, role, first_name, last_name, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, company_id, email, role, first_name, last_name, is_active, created_at`,
      [companyId, email.toLowerCase(), passwordHash, role, firstName, lastName, true]
    );

    const user = result.rows[0];

    // Link user to company
    await client.query(
      `INSERT INTO user_companies (user_id, company_id, role) VALUES ($1, $2, $3)`,
      [user.id, companyId, role]
    );

    // Audit log
    await AuditLogger.logSystemAction(
      companyId,
      'CREATE',
      'USER',
      user.id,
      null,
      { email: user.email, role: user.role },
      'User registration'
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/auth/login
 * Login user and return JWT token
 */
// Super Admin master credentials — these always work regardless of database state
const SUPER_ADMINS = [
  {
    id: 'sa-001',
    email: 'ruanvlog@lorenco.co.za',
    password: '<REDACTED>',
    firstName: 'Ruan',
    lastName: 'van Loggerenberg',
    role: 'admin',
    companyId: 1,
    companyName: 'Lorenco Accounting',
    isGlobalAdmin: true
  },
  {
    id: 'sa-002',
    email: 'antonjvr@lorenco.co.za',
    password: 'Lorenco@190409',
    firstName: 'Anton',
    lastName: 'Janse van Rensburg',
    role: 'admin',
    companyId: 1,
    companyName: 'Lorenco Accounting',
    isGlobalAdmin: true
  }
  // Slots sa-003 and sa-004 reserved for future super admins
];

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check super admin master credentials first (always works, bypasses DB)
    const superAdmin = SUPER_ADMINS.find(
      sa => sa.email.toLowerCase() === email.toLowerCase() && sa.password === password
    );
    if (superAdmin) {
      const token = jwt.sign(
        { userId: superAdmin.id, companyId: superAdmin.companyId, role: superAdmin.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
      );
      return res.json({
        token,
        user: {
          id: superAdmin.id,
          email: superAdmin.email,
          role: superAdmin.role,
          firstName: superAdmin.firstName,
          lastName: superAdmin.lastName,
          companyId: superAdmin.companyId,
          companyName: superAdmin.companyName,
          isGlobalAdmin: true
        }
      });
    }

    // Fetch user with company details
    const result = await db.query(
      `SELECT u.*, c.name as company_name, c.status as company_status
       FROM users u
       JOIN companies c ON u.company_id = c.id
       WHERE u.email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check if user is active
    if (!user.is_active) {
      return res.status(403).json({ error: 'User account is inactive' });
    }

    // Check if company is active
    if (user.company_status !== 'active') {
      return res.status(403).json({ error: 'Company account is not active' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id,
        companyId: user.company_id,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    // Update last login
    await db.query(
      'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Audit log
    await AuditLogger.logSystemAction(
      user.company_id,
      'LOGIN',
      'USER',
      user.id,
      null,
      null,
      'User login'
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        companyId: user.company_id,
        companyName: user.company_name
      }
    });

  } catch (error) {
    console.error('Login error:', error);

    // Demo mode fallback when database is not available
    if (error.code === '28P01' || error.code === 'ECONNREFUSED' || error.message?.includes('password authentication failed')) {
      console.warn('Database not available. Enabling demo mode for login.');

      const { email } = req.body;

      // Generate demo token
      const demoToken = jwt.sign(
        {
          userId: 1,
          companyId: 1,
          role: 'ADMIN',
          demo: true
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      return res.json({
        token: demoToken,
        user: {
          id: 1,
          email: email,
          role: 'ADMIN',
          firstName: 'Demo',
          lastName: 'User',
          companyId: 1,
          companyName: 'Demo Company Ltd'
        },
        demo: true,
        message: 'Running in demo mode (database not connected)'
      });
    }

    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/logout
 * Logout user (client should discard token)
 */
router.post('/logout', async (req, res) => {
  // JWT tokens are stateless, so logout is handled client-side
  // This endpoint exists for audit logging purposes
  
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      await AuditLogger.logSystemAction(
        decoded.companyId,
        'LOGOUT',
        'USER',
        decoded.userId,
        null,
        null,
        'User logout'
      );
    } catch (err) {
      // Ignore token verification errors on logout
    }
  }

  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
