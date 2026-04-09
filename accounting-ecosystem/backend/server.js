/**
 * ============================================================================
 * Accounting Ecosystem — Main Server Entry Point
 * ============================================================================
 * Unified modular Express server for:
 *   - Checkout Charlie POS    (module: pos)
 *   - Lorenco Paytime Payroll (module: payroll)
 *   - General Accounting      (module: accounting)
 *
 * Modules are conditionally loaded based on env config.
 * Shared routes (auth, users, companies, employees, audit) are always active.
 * All data is stored in Supabase/PostgreSQL.
 * ============================================================================
 */

// Load environment variables FIRST
const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─── Build Version ────────────────────────────────────────────────────────────
// Each Zeabur redeploy starts a fresh container → new timestamp → new SW bytes
// → browsers detect the updated service worker → caches invalidated automatically.
// Override with BUILD_VERSION env var for deterministic versioning in CI/CD.
const BUILD_VERSION = process.env.BUILD_VERSION || Date.now().toString(36);

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

// ─── Config ──────────────────────────────────────────────────────────────────
const { supabase, checkConnection, ensureDefaultCompany } = require('./config/database');
const { isModuleEnabled, getEnabledModules, getAllModules } = require('./config/modules');

// ─── Middleware ──────────────────────────────────────────────────────────────
const { authenticateToken } = require('./middleware/auth');
const { auditMiddleware } = require('./middleware/audit');
const { requireModule } = require('./middleware/module-check');

// ─── Route Loading ──────────────────────────────────────────────────────────
const authRoutes = require('./shared/routes/auth');
const companiesRoutes = require('./shared/routes/companies');
const usersRoutes = require('./shared/routes/users');
const employeesRoutes = require('./shared/routes/employees');
const auditRoutes = require('./shared/routes/audit');
const customersRoutes = require('./shared/routes/customers');
const ecoClientsRoutes = require('./shared/routes/eco-clients');
// Global KV store — all ecosystem frontend business data (NEVER in localStorage)
const globalKvRoutes = require('./shared/routes/kv');
const ocrRoutes          = require('./shared/routes/ocr');
const featureFlagsRoutes = require('./shared/routes/featureFlags');
const pdfImportRoutes    = require('./shared/routes/pdfImport');
const adminPanelRoutes   = require('./shared/routes/admin-panel');

let posRoutes, payrollRoutes, accountingRoutes, seanRoutes, interCompanyRoutes, coachingRoutes;
let receiptsRoutes, barcodesRoutes, reportsRoutes;
let inventoryRoutes, practiceRoutes;

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
if (isModuleEnabled('inventory'))  inventoryRoutes = require('./modules/inventory');
if (isModuleEnabled('practice'))   practiceRoutes = require('./modules/practice');

// Coaching module — always loaded if COACHING_DATABASE_URL is set
if (process.env.COACHING_DATABASE_URL || process.env.DATABASE_URL) {
  try {
    coachingRoutes = require('./modules/coaching');
  } catch (err) {
    console.warn('  ⚠️  Coaching module failed to load:', err.message);
  }
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
  process.env.APP_URL, // Production URL (e.g. https://your-app.zeabur.app)
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
    // In production, allow Zeabur domains
    if (origin && (origin.endsWith('.zeabur.app') || origin.endsWith('.zeabur.com'))) {
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
  const dbOk = await checkConnection();
  const enabledModules = getEnabledModules();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: BUILD_VERSION,
    database: dbOk ? 'connected' : 'disconnected',
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

/**
 * GET /api/version
 * Returns the running build version for client-side update detection.
 * Served with no-cache so clients always get the current server version.
 * Frontend pages poll this endpoint periodically; if the version changes
 * it means a new deployment has occurred and the UI shows an update banner.
 */
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ version: BUILD_VERSION, timestamp: new Date().toISOString() });
});

// ─── One-time admin password reset endpoint ───────────────────────────────────
// Protected by FORCE_RESET_ADMIN env var. Remove env var after use.
app.get('/api/admin/reset-master', async (req, res) => {
  if (process.env.FORCE_RESET_ADMIN !== 'true') {
    return res.status(403).json({ error: 'Disabled' });
  }
  try {
    const bcrypt = require('bcrypt');
    const { supabase } = require('./config/database');
    const email = 'ruanvlog@lorenco.co.za';
    const password = 'Mindmaster@277477';
    const password_hash = await bcrypt.hash(password, 12);

    // Check if user exists
    const { data: existing } = await supabase
      .from('users')
      .select('id, email, is_active, is_super_admin')
      .or(`email.eq.${email},username.eq.${email}`)
      .maybeSingle();

    if (!existing) {
      // Create the user
      const { data: newUser, error: createErr } = await supabase
        .from('users')
        .insert({ username: email, email, full_name: 'Ruan', password_hash, role: 'super_admin', is_super_admin: true, is_active: true })
        .select('id').single();
      if (createErr) return res.status(500).json({ error: createErr.message });
      return res.json({ success: true, action: 'created', id: newUser.id });
    }

    // Update existing user
    const { error: updateErr } = await supabase
      .from('users')
      .update({ password_hash, is_active: true, is_super_admin: true, role: 'super_admin' })
      .eq('id', existing.id);

    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ success: true, action: 'updated', id: existing.id, was_active: existing.is_active, was_super_admin: existing.is_super_admin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Shared Routes (always active) ──────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/companies', authenticateToken, companiesRoutes);
app.use('/api/users', authenticateToken, usersRoutes);
app.use('/api/employees', authenticateToken, employeesRoutes);
app.use('/api/audit', authenticateToken, auditRoutes);
app.use('/api/eco-clients', authenticateToken, ecoClientsRoutes);
app.use('/api/customers', authenticateToken, customersRoutes);
// Global KV store — ecosystem-wide cloud persistence (NO browser localStorage for business data)
app.use('/api/kv', globalKvRoutes);
// OCR — image and scanned-PDF text extraction (any authenticated user)
app.use('/api/ocr', authenticateToken, ocrRoutes);
// Feature flags — admin management + per-user/company flag checks
app.use('/api/feature-flags', authenticateToken, featureFlagsRoutes);
// PDF import — company registration document extraction and duplicate check
// authenticateToken is applied inside pdfImportRoutes
app.use('/api/import', pdfImportRoutes);
// Admin Panel — super admin only routes (entity classification, user management)
// authenticateToken + requireSuperAdmin are applied inside adminPanelRoutes
app.use('/api/admin', adminPanelRoutes);

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
  // SEAN × Payroll integration (mount BEFORE generic payroll so /api/payroll/sean/* matches first)
  if (isModuleEnabled('sean')) {
    const seanPayrollRoutes = require('./modules/payroll/routes/sean-integration');
    app.use('/api/payroll/sean',
      authenticateToken,
      requireModule('payroll'),
      seanPayrollRoutes
    );
    console.log('  🧠 SEAN × Payroll intelligence — ACTIVE');
  }

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
  // Lorenco Accounting handles its own audit logging via AuditLogger service
  app.use('/api/accounting',
    authenticateToken,
    requireModule('accounting'),
    accountingRoutes
  );
  console.log('  ✅ Accounting module (Lorenco Accounting) — ACTIVE');
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

if (coachingRoutes) {
  app.use('/api/coaching', coachingRoutes);
  console.log('  ✅ Coaching module — ACTIVE');
} else {
  console.log('  ⬜ Coaching module — disabled (set COACHING_DATABASE_URL to enable)');
}

if (inventoryRoutes) {
  app.use('/api/inventory',
    authenticateToken,
    requireModule('inventory'),
    auditMiddleware,
    inventoryRoutes
  );
  console.log('  ✅ Inventory module (Lorenco Storehouse) — ACTIVE');
} else {
  console.log('  ⬜ Inventory module (Lorenco Storehouse) — disabled');
}

if (practiceRoutes) {
  app.use('/api/practice',
    authenticateToken,
    requireModule('practice'),
    auditMiddleware,
    practiceRoutes
  );
  console.log('  ✅ Practice module (Lorenco Practice) — ACTIVE');
} else {
  console.log('  ⬜ Practice module (Lorenco Practice) — disabled');
}

// ─── Static File Serving ─────────────────────────────────────────────────────

const ecosystemFrontendPath = path.join(__dirname, '..', 'frontend-ecosystem');
const posFrontendPath       = path.join(__dirname, '..', 'frontend-pos');
const payrollFrontendPath   = path.join(__dirname, '..', 'frontend-payroll');
const seanFrontendPath      = path.join(__dirname, '..', 'frontend-sean');
const accountingFrontendPath = path.join(__dirname, '..', 'frontend-accounting');
const coachingFrontendPath  = path.join(__dirname, '..', 'frontend-coaching');
const inventoryFrontendPath = path.join(__dirname, '..', 'frontend-inventory');
const practiceFrontendPath  = path.join(__dirname, '..', 'frontend-practice');

// ── Cache-Control helper ──────────────────────────────────────────────────────
// HTML files: never cache — browser must always revalidate on navigation.
// Other assets (CSS, JS, images): short cache (1 hour) with ETag for efficiency.
// This ensures users always get fresh HTML after a deployment without needing
// to manually clear cache or hard-refresh.
const staticOptions = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    } else {
      // Assets without build-time hashes: 1 hour cache with ETag revalidation
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
};

// Helper: send an HTML file with no-cache headers (for named route sendFile calls)
function sendHtml(res, filePath) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(filePath);
}

// ── Service Worker dynamic serving ───────────────────────────────────────────
// Service worker files are served with BUILD_VERSION injected.
// The __BUILD_VERSION__ placeholder in each SW file is replaced at request time
// with the running BUILD_VERSION string. This guarantees the SW file bytes change
// on every new deployment — the browser detects this and triggers the SW update
// lifecycle (install → waiting → activate), invalidating stale caches.
// These routes MUST be registered before express.static for the same path.
function serveSW(res, swPath) {
  try {
    const content = fs.readFileSync(swPath, 'utf8').replace(/__BUILD_VERSION__/g, BUILD_VERSION);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.send(content);
  } catch (err) {
    console.warn('[SW] Service worker file not found:', swPath);
    res.status(404).send('// Service worker not found');
  }
}
app.get('/pos/service-worker.js',     (req, res) => serveSW(res, path.join(posFrontendPath,     'service-worker.js')));
app.get('/payroll/service-worker.js', (req, res) => serveSW(res, path.join(payrollFrontendPath, 'service-worker.js')));

// ── Ecosystem frontend (dashboard, admin, login) ──────────────────────────────
app.use('/dashboard', express.static(ecosystemFrontendPath, staticOptions));
app.get('/dashboard', (req, res) => sendHtml(res, path.join(ecosystemFrontendPath, 'dashboard.html')));

app.get('/admin',     (req, res) => sendHtml(res, path.join(ecosystemFrontendPath, 'admin.html')));
app.get('/client/:id', (req, res) => sendHtml(res, path.join(ecosystemFrontendPath, 'client-detail.html')));

// ── App frontends ─────────────────────────────────────────────────────────────
app.use('/pos',        express.static(posFrontendPath,       staticOptions));
app.use('/payroll',    express.static(payrollFrontendPath,   staticOptions));
app.use('/sean',       express.static(seanFrontendPath,      staticOptions));
app.use('/accounting', express.static(accountingFrontendPath, staticOptions));
app.use('/coaching',   express.static(coachingFrontendPath,  staticOptions));

// Coaching: multi-page app (has login.html, index.html, admin.html, etc.)
app.get('/coaching', (req, res) => {
  sendHtml(res, path.join(coachingFrontendPath, 'login.html'));
});
app.get('/coaching/*', (req, res) => {
  const requestedFile = req.path.replace('/coaching/', '');
  const filePath = path.join(coachingFrontendPath, requestedFile);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendHtml(res, filePath);
  }
  if (fs.existsSync(filePath + '.html')) {
    return sendHtml(res, filePath + '.html');
  }
  sendHtml(res, path.join(coachingFrontendPath, 'index.html'));
});

// SPA / MPA fallbacks — always served with no-cache headers
app.get('/pos/*', (req, res) => {
  const indexPath = path.join(posFrontendPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    sendHtml(res, indexPath);
  } else {
    res.status(404).json({ error: 'POS frontend not found' });
  }
});

app.get('/payroll/*', (req, res) => {
  const indexPath = path.join(payrollFrontendPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    sendHtml(res, indexPath);
  } else {
    res.status(404).json({ error: 'Payroll frontend not found' });
  }
});

app.get('/sean/*', (req, res) => {
  const indexPath = path.join(seanFrontendPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    sendHtml(res, indexPath);
  } else {
    res.status(404).json({ error: 'SEAN frontend not found' });
  }
});

// Inventory frontend
app.use('/inventory', express.static(inventoryFrontendPath));
app.get('/inventory/*', (req, res) => {
  const indexPath = path.join(inventoryFrontendPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Inventory frontend not found' });
  }
});

// Practice frontend
app.use('/practice', express.static(practiceFrontendPath));
app.get('/practice/*', (req, res) => {
  const indexPath = path.join(practiceFrontendPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Practice frontend not found' });
  }
});

// Accounting: multi-page frontend (30+ HTML pages)
app.get('/accounting', (req, res) => {
  sendHtml(res, path.join(accountingFrontendPath, 'dashboard.html'));
});
app.get('/accounting/*', (req, res) => {
  const requestedFile = req.path.replace('/accounting/', '');
  const filePath = path.join(accountingFrontendPath, requestedFile);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendHtml(res, filePath);
  }
  if (fs.existsSync(filePath + '.html')) {
    return sendHtml(res, filePath + '.html');
  }
  sendHtml(res, path.join(accountingFrontendPath, 'dashboard.html'));
});

// ─── Root — Ecosystem Login Page ─────────────────────────────────────────────
app.get('/', (req, res) => {
  sendHtml(res, path.join(ecosystemFrontendPath, 'login.html'));
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
  console.log('║        ACCOUNTING ECOSYSTEM — Starting Server           ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // 0. Security guard — reject default JWT_SECRET in production
  const { JWT_SECRET } = require('./middleware/auth');
  if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'change-this-secret') {
    console.error('❌ FATAL SECURITY ERROR: JWT_SECRET is set to the default value.');
    console.error('   Anyone can forge authentication tokens with this key.');
    console.error('   Set a strong JWT_SECRET environment variable before deploying.');
    process.exit(1);
  }
  if (JWT_SECRET === 'change-this-secret') {
    console.warn('⚠️  WARNING: JWT_SECRET is using the insecure default value.');
    console.warn('   Set JWT_SECRET in your .env file before deploying to production.\n');
  }

  // 1. Test database connection (retries up to 5 times)
  console.log('🔌 Connecting to Supabase...');
  const connected = await checkConnection(5, 3000);
  if (!connected) {
    console.warn('⚠️  Could not reach Supabase after 5 attempts.');
    console.warn('   Server will start anyway — DB-dependent routes will fail until connection is restored.');
    console.warn('   Check your SUPABASE_URL and SUPABASE_SERVICE_KEY in .env\n');
  } else {
    console.log('✅ Supabase connection verified\n');

    // 2. Ensure default company exists (Bug Fix #1)
    await ensureDefaultCompany();

    // 3. Seed master admin if no users exist; always ensure additional users exist
    const { seedMasterAdmin, seedAdditionalUsers, forceResetMasterAdmin } = require('./config/seed');
    await forceResetMasterAdmin(supabase); // no-op unless FORCE_RESET_ADMIN=true
    await seedMasterAdmin(supabase);
    await seedAdditionalUsers(supabase);

    // 4. Auto-migrate accounting tables (runs on every startup, safe — uses IF NOT EXISTS)
    if (accountingRoutes) {
      try {
        const { ensureAccountingSchema } = require('./config/accounting-schema');
        const accountingDb = require('./modules/accounting/config/database');
        await ensureAccountingSchema(accountingDb.pool);
      } catch (migErr) {
        console.warn('  ⚠️  Accounting schema migration skipped:', migErr.message);
        console.warn('     Set ACCOUNTING_DATABASE_URL (Supabase direct connection) to enable auto-migration.');
      }
    }

    // 4b. Auto-migrate payroll tables (runs on every startup, safe — uses IF NOT EXISTS)
    if (payrollRoutes) {
      try {
        const { ensurePayrollSchema } = require('./config/payroll-schema');
        const accountingDb = require('./modules/accounting/config/database');
        await ensurePayrollSchema(accountingDb.pool);
      } catch (migErr) {
        console.warn('  ⚠️  Payroll schema migration skipped:', migErr.message);
        console.warn('     Set DATABASE_URL (Supabase direct connection string, port 5432) to enable auto-migration.');
      }
    }

    // 4c. Auto-migrate POS tables (runs on every startup, safe — uses IF NOT EXISTS)
    try {
      const { ensurePosSchema } = require('./config/pos-schema');
      const accountingDb = require('./modules/accounting/config/database');
      await ensurePosSchema(accountingDb.pool);
    } catch (migErr) {
      console.warn('  ⚠️  POS schema migration skipped:', migErr.message);
      console.warn('     Set DATABASE_URL (Supabase direct connection string, port 5432) to enable auto-migration.');
    }

    // 4d. Auto-migrate feature flags table (runs on every startup, safe — uses IF NOT EXISTS)
    try {
      const { ensureFeatureFlagsSchema } = require('./config/feature-flags-schema');
      await ensureFeatureFlagsSchema(supabase);
    } catch (migErr) {
      console.warn('  ⚠️  Feature flags schema migration skipped:', migErr.message);
    }
  }

  // 4. Display module status
  console.log('📦 Module Status:');
  // Module loading messages already printed above during route registration

  // 5. Start listening
  server = app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`   ─── Ecosystem ───`);
    console.log(`   🌐 Login:      http://localhost:${PORT}/`);
    console.log(`   📊 Dashboard:  http://localhost:${PORT}/dashboard`);
    console.log(`   🛡️  Admin:      http://localhost:${PORT}/admin`);
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
    if (coachingRoutes) {
      console.log(`   Coaching frontend: http://localhost:${PORT}/coaching`);
    }
    console.log(`\n   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Database:    Supabase`);
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
