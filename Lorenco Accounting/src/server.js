require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Middleware
const { enforceCompanyStatus } = require('./middleware/companyStatus');

// Routes
const authRoutes = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const journalsRoutes = require('./routes/journals');
const bankRoutes = require('./routes/bank');
const reportsRoutes = require('./routes/reports');
const aiRoutes = require('./routes/ai');
const auditRoutes = require('./routes/audit');
const vatReconRoutes = require('./routes/vatRecon');
const payeConfigRoutes = require('./routes/payeConfig');
const payeReconciliationRoutes = require('./routes/payeReconciliation');
const employeesRoutes = require('./routes/employees');
const companyRoutes = require('./routes/company');
const integrationsRoutes = require('./routes/integrations');

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================================
// MIDDLEWARE
// ========================================================

// Security headers - relaxed for demo
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
}));

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// Body parsing
app.use(express.json({ limit: process.env.MAX_UPLOAD_SIZE || '10mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.MAX_UPLOAD_SIZE || '10mb' }));

// Compression
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// ========================================================
// ROUTES
// ========================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    service: 'Lorenco Accounting API'
  });
});

// API routes
app.use('/api/auth', authRoutes);
// Apply company status enforcement to all other API routes
app.use('/api', enforceCompanyStatus);
app.use('/api/accounts', accountsRoutes);
app.use('/api/journals', journalsRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/vat-recon', vatReconRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/paye/config', payeConfigRoutes);
app.use('/api/paye/reconciliation', payeReconciliationRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/company', companyRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api/kv', require('./routes/kv'));

// Root endpoint - redirect to login page
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// ========================================================
// ERROR HANDLING
// ========================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    path: req.path,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal Server Error' 
      : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// ========================================================
// SERVER START
// ========================================================

const server = app.listen(PORT, () => {
  console.log('========================================================');
  console.log('  LORENCO ACCOUNTING SYSTEM');
  console.log('========================================================');
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Server running on: http://${process.env.HOST || 'localhost'}:${PORT}`);
  console.log(`  Health check: http://${process.env.HOST || 'localhost'}:${PORT}/health`);
  console.log('========================================================');
  console.log('  Core Features:');
  console.log('    ✓ Multi-tenant architecture');
  console.log('    ✓ Role-based access control');
  console.log('    ✓ Double-entry bookkeeping');
  console.log('    ✓ Bank reconciliation');
  console.log('    ✓ Financial reports');
  console.log('    ✓ Comprehensive audit trail');
  console.log('========================================================');
  console.log('  AI Add-on (Optional):');
  console.log(`    Status: ${process.env.AI_ENABLED === 'true' ? 'Available' : 'Disabled by default'}`);
  console.log('    Modes: Off / Suggest / Draft / Auto');
  console.log('    Features: Bank allocation, reconciliation, journal prep');
  console.log('========================================================');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nSIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

module.exports = app;
