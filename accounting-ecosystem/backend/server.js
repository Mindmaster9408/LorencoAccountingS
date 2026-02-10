/**
 * ============================================================================
 * Accounting Ecosystem — Main Server Entry Point
 * ============================================================================
 * Unified modular Express server for:
 *   - Checkout Charlie POS    (module: pos)
 *   - Lorenco Paytime Payroll (module: payroll)
 *   - General Accounting      (module: accounting)  — future
 *
 * Modules are conditionally loaded based on env config.
 * Shared routes (auth, users, companies, employees, audit) are always active.
 *
 * MOCK MODE: Set MOCK_MODE=true in .env to run without Supabase.
 *   All data is served from in-memory mock stores.
 *   See TEST-CREDENTIALS.md for test accounts.
 * ============================================================================
 */

// Load environment variables FIRST
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

// ─── Mock Mode Detection ────────────────────────────────────────────────────
const MOCK_MODE = process.env.MOCK_MODE === 'true';

// ─── Config ──────────────────────────────────────────────────────────────────
let supabase, checkConnection, ensureDefaultCompany;
if (!MOCK_MODE) {
  ({ supabase, checkConnection, ensureDefaultCompany } = require('./config/database'));
}
const { isModuleEnabled, getEnabledModules, getAllModules } = require('./config/modules');

// ─── Middleware ──────────────────────────────────────────────────────────────
const { authenticateToken } = require('./middleware/auth');
let auditMiddleware;
if (!MOCK_MODE) {
  ({ auditMiddleware } = require('./middleware/audit'));
} else {
  // No-op audit middleware in mock mode (mock routes handle their own auditing)
  auditMiddleware = (req, res, next) => next();
}
const { requireModule } = require('./middleware/module-check');

// ─── Route Loading (Mock vs Real) ───────────────────────────────────────────
let authRoutes, companiesRoutes, usersRoutes, employeesRoutes, auditRoutes, customersRoutes;
let posRoutes, payrollRoutes, accountingRoutes, seanRoutes, interCompanyRoutes;
let receiptsRoutes, barcodesRoutes, reportsRoutes;
let auditForensicRoutes;

if (MOCK_MODE) {
  // ── Mock Routes ──
  const mockShared = require('./mock-routes-shared');
  authRoutes = mockShared.authRouter;
  companiesRoutes = mockShared.companiesRouter;
  usersRoutes = mockShared.usersRouter;
  employeesRoutes = mockShared.employeesRouter;
  auditRoutes = mockShared.auditRouter;

  // ── Mock Extras (Customers, Receipts, Barcodes, Reports) ──
  const mockExtras = require('./mock-routes-extras');
  customersRoutes = mockExtras.customersRouter;
  receiptsRoutes = mockExtras.receiptsRouter;
  barcodesRoutes = mockExtras.barcodeRouter;
  reportsRoutes = mockExtras.reportsRouter;
  auditForensicRoutes = mockExtras.auditForensicRouter;

  if (isModuleEnabled('pos'))     posRoutes = require('./mock-routes-pos');
  if (isModuleEnabled('payroll')) payrollRoutes = require('./mock-routes-payroll');
  if (isModuleEnabled('sean'))       seanRoutes = require('./sean/routes');
  if (isModuleEnabled('accounting')) accountingRoutes = require('./mock-routes-accounting');
  // Inter-company always loads when SEAN is enabled (it relies on SEAN's mock store)
  if (isModuleEnabled('sean'))       interCompanyRoutes = require('./inter-company/routes');
} else {
  // ── Real Supabase Routes ──
  authRoutes = require('./shared/routes/auth');
  companiesRoutes = require('./shared/routes/companies');
  usersRoutes = require('./shared/routes/users');
  employeesRoutes = require('./shared/routes/employees');
  auditRoutes = require('./shared/routes/audit');
  customersRoutes = require('./shared/routes/customers');

  if (isModuleEnabled('pos')) {
    posRoutes = require('./modules/pos');
    receiptsRoutes = require('./modules/pos/routes/receipts');
    barcodesRoutes = require('./modules/pos/routes/barcodes');
    reportsRoutes = require('./modules/pos/routes/reports');
  }
  if (isModuleEnabled('payroll'))    payrollRoutes = require('./modules/payroll');
  if (isModuleEnabled('accounting')) accountingRoutes = require('./modules/accounting');
  if (isModuleEnabled('sean'))       seanRoutes = require('./sean/routes');
  if (isModuleEnabled('sean'))       interCompanyRoutes = require('./inter-company/routes');
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Global Middleware ───────────────────────────────────────────────────────

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false  // Disabled for API — frontends handle CSP
}));

// CORS — allow configured frontend origins
const allowedOrigins = [
  process.env.FRONTEND_POS_URL || 'http://localhost:5173',
  process.env.FRONTEND_PAYROLL_URL || 'http://localhost:5174',
  process.env.FRONTEND_ACCOUNTING_URL || 'http://localhost:5175',
  'http://localhost:3000', // Self (for serving static files)
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // In development, allow all localhost origins
    if (process.env.NODE_ENV === 'development' && origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Company-Id']
}));

// Body parsing
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Request logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ─── Health & Status Endpoints (no auth required) ────────────────────────────

app.get('/api/health', async (req, res) => {
  let dbOk = false;
  if (MOCK_MODE) {
    dbOk = true; // Mock mode — no database needed
  } else {
    dbOk = await checkConnection();
  }
  const enabledModules = getEnabledModules();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    database: MOCK_MODE ? 'mock (in-memory)' : (dbOk ? 'connected' : 'disconnected'),
    mockMode: MOCK_MODE,
    modules: enabledModules.map(m => m.key),
    uptime: Math.floor(process.uptime())
  });
});

app.get('/api/modules', (req, res) => {
  res.json({
    modules: getAllModules(),
    enabled: getEnabledModules().map(m => m.key)
  });
});

// ─── Shared Routes (always active) ──────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/companies', authenticateToken, companiesRoutes);
app.use('/api/users', authenticateToken, usersRoutes);
app.use('/api/employees', authenticateToken, employeesRoutes);
app.use('/api/audit', authenticateToken, auditRoutes);
if (customersRoutes) {
  app.use('/api/customers', customersRoutes);
}

// ─── Top-level POS-related Routes (receipts, barcodes, reports, analytics) ──
if (receiptsRoutes) {
  app.use('/api/receipts', authenticateToken, receiptsRoutes);
}
if (barcodesRoutes) {
  app.use('/api/barcode', authenticateToken, barcodesRoutes);
}
if (reportsRoutes) {
  app.use('/api/reports', authenticateToken, reportsRoutes);
  app.use('/api/analytics', authenticateToken, reportsRoutes);
}

// ─── Inventory alias (frontend calls /api/inventory) ────────────────────────
if (posRoutes) {
  app.use('/api/inventory', authenticateToken, (req, res, next) => {
    // Forward to POS inventory routes
    req.url = '/inventory' + req.url;
    posRoutes(req, res, next);
  });
}

// ─── Stub routes for features not yet backed by Supabase ─────────────────────
app.get('/api/locations', authenticateToken, (req, res) => res.json({ locations: [] }));
app.get('/api/transfers', authenticateToken, (req, res) => res.json({ transfers: [] }));
app.get('/api/purchase-orders', authenticateToken, (req, res) => res.json({ purchase_orders: [] }));
app.get('/api/suppliers', authenticateToken, (req, res) => res.json({ suppliers: [] }));
app.get('/api/loyalty/programs', authenticateToken, (req, res) => res.json({ programs: [] }));
app.get('/api/promotions', authenticateToken, (req, res) => res.json({ promotions: [] }));
app.get('/api/scheduling/shifts', authenticateToken, (req, res) => res.json({ shifts: [] }));
app.get('/api/scheduling/time/status', authenticateToken, (req, res) => res.json({ status: 'not_clocked_in' }));
app.post('/api/scheduling/time/clock-in', authenticateToken, (req, res) => res.json({ success: true, clocked_in_at: new Date().toISOString() }));
app.post('/api/scheduling/time/clock-out', authenticateToken, (req, res) => res.json({ success: true, clocked_out_at: new Date().toISOString() }));
app.get('/api/loss-prevention/alerts', authenticateToken, (req, res) => res.json({ alerts: [] }));
app.get('/api/audit/suspicious-activity', authenticateToken, (req, res) => res.json({ activities: [] }));
if (auditForensicRoutes) {
  app.use('/api/audit', authenticateToken, auditForensicRoutes);
}

// ─── Module Routes (conditionally registered) ───────────────────────────────

if (posRoutes) {
  app.use('/api/pos',
    authenticateToken,
    requireModule('pos'),
    auditMiddleware,
    posRoutes
  );
  console.log('  ✅ POS module (Checkout Charlie) — ACTIVE');
} else {
  console.log('  ⬜ POS module (Checkout Charlie) — disabled');
}

if (payrollRoutes) {
  app.use('/api/payroll',
    authenticateToken,
    requireModule('payroll'),
    auditMiddleware,
    payrollRoutes
  );
  console.log('  ✅ Payroll module (Lorenco Paytime) — ACTIVE');
} else {
  console.log('  ⬜ Payroll module (Lorenco Paytime) — disabled');
}

if (accountingRoutes) {
  app.use('/api/accounting',
    authenticateToken,
    requireModule('accounting'),
    auditMiddleware,
    accountingRoutes
  );
  console.log('  \u2705 Accounting module (Lorenco Accounting) — ACTIVE');
} else {
  console.log('  ⬜ Accounting module (Lorenco Accounting) — disabled');
}

if (seanRoutes) {
  app.use('/api/sean',
    authenticateToken,
    requireModule('sean'),
    seanRoutes
  );
  console.log('  ✅ SEAN AI module — ACTIVE');
} else {
  console.log('  ⬜ SEAN AI module — disabled');
}

if (interCompanyRoutes) {
  app.use('/api/inter-company',
    authenticateToken,
    requireModule('sean'),
    interCompanyRoutes
  );
  console.log('  ✅ Inter-Company Invoice Sync — ACTIVE');
} else {
  console.log('  ⬜ Inter-Company Invoice Sync — disabled');
}

// ─── Static File Serving (optional — for serving frontends) ──────────────────

// Ecosystem frontend (main login + dashboard) — served at root
const ecosystemFrontendPath = path.join(__dirname, '..', 'frontend-ecosystem');
const posFrontendPath = path.join(__dirname, '..', 'frontend-pos');
const payrollFrontendPath = path.join(__dirname, '..', 'frontend-payroll');
const seanFrontendPath = path.join(__dirname, '..', 'frontend-sean');
const accountingFrontendPath = path.join(__dirname, '..', 'frontend-accounting');

// Ecosystem dashboard route
app.use('/dashboard', express.static(ecosystemFrontendPath));
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(ecosystemFrontendPath, 'dashboard.html'));
});

// App frontends
app.use('/pos', express.static(posFrontendPath));
app.use('/payroll', express.static(payrollFrontendPath));
app.use('/sean', express.static(seanFrontendPath));
app.use('/accounting', express.static(accountingFrontendPath));

// SPA fallback for frontend routes
app.get('/pos/*', (req, res) => {
  const indexPath = path.join(posFrontendPath, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'POS frontend not found' });
  }
});

app.get('/payroll/*', (req, res) => {
  const indexPath = path.join(payrollFrontendPath, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Payroll frontend not found' });
  }
});

app.get('/sean/*', (req, res) => {
  const indexPath = path.join(seanFrontendPath, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'SEAN frontend not found' });
  }
});

app.get('/accounting/*', (req, res) => {
  const indexPath = path.join(accountingFrontendPath, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Accounting frontend not found' });
  }
});

// ─── Root — Ecosystem Login Page ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(ecosystemFrontendPath, 'login.html'));
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
    hint: 'Check /api/health for available modules and /api/modules for module status'
  });
});

// ─── Global Error Handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  // CORS error
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS: Origin not allowed' });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token expired' });
  }

  // Log unexpected errors
  console.error('❌ Unhandled error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.originalUrl,
    method: req.method,
    userId: req.userId || 'unauthenticated'
  });

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('👋 Server closed. Goodbye.');
    process.exit(0);
  });
  // Force close after 10s
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// ─── Start Server ────────────────────────────────────────────────────────────
let server;

async function start() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  if (MOCK_MODE) {
    console.log('║   ACCOUNTING ECOSYSTEM — Starting Server (MOCK MODE)    ║');
  } else {
    console.log('║        ACCOUNTING ECOSYSTEM — Starting Server           ║');
  }
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  if (MOCK_MODE) {
    // Initialize mock data store
    const { initMockData } = require('./mock-data');
    await initMockData();
    // Initialize SEAN mock data if module enabled
    if (isModuleEnabled('sean')) {
      const { initSeanMockData } = require('./sean/mock-store');
      initSeanMockData();
    }
    console.log('🎭 MOCK MODE ACTIVE — No database required');
    console.log('   All data is in-memory and resets on restart\n');
  } else {
    // 1. Test database connection
    console.log('🔌 Connecting to Supabase...');
    const connected = await checkConnection();
    if (!connected) {
      console.error('❌ Cannot reach Supabase. Check your .env credentials.');
      console.error('   💡 Tip: Set MOCK_MODE=true in .env to test without a database.');
      process.exit(1);
    }
    console.log('✅ Supabase connection verified\n');

    // 2. Ensure default company exists (Bug Fix #1)
    await ensureDefaultCompany();
  }

  // 3. Display module status
  console.log('📦 Module Status:');
  // Module loading messages already printed above during route registration

  // 4. Start listening
  server = app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`   ─── Ecosystem ───`);
    console.log(`   🌐 Login:      http://localhost:${PORT}/`);
    console.log(`   📊 Dashboard:  http://localhost:${PORT}/dashboard`);
    console.log(`   ─── APIs ───`);
    console.log(`   Health check:  http://localhost:${PORT}/api/health`);
    console.log(`   Module status: http://localhost:${PORT}/api/modules`);
    console.log(`   SSO Launch:    POST /api/auth/sso-launch`);
    console.log(`   ─── App Frontends ───`);
    if (posRoutes) {
      console.log(`   POS frontend:  http://localhost:${PORT}/pos`);
    }
    if (payrollRoutes) {
      console.log(`   Payroll frontend: http://localhost:${PORT}/payroll`);
    }
    if (seanRoutes) {
      console.log(`   SEAN AI frontend: http://localhost:${PORT}/sean`);
      console.log(`   SEAN Import API:  POST /api/sean/import/upload`);
    }
    if (interCompanyRoutes) {
      console.log(`   Inter-Company API: /api/inter-company/*`);
    }
    if (accountingRoutes) {
      console.log(`   Accounting frontend: http://localhost:${PORT}/accounting`);
    }
    if (MOCK_MODE) {
      console.log(`\n   🎭 MOCK MODE — Test credentials:`);
      console.log(`      POS:     pos@test.com     / pos123`);
      console.log(`      Payroll: payroll@test.com  / payroll123`);
      console.log(`      Admin:   admin@test.com    / admin123`);
      console.log(`      Master:  ruanvlog@lorenco.co.za / Mindmaster@277477`);
    }
    console.log(`\n   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Database:    ${MOCK_MODE ? 'MOCK (in-memory)' : 'Supabase'}`);
    console.log('─'.repeat(58) + '\n');
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

start().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
