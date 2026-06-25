/**
 * ============================================================================
 * POS Module Index — registers all POS sub-routes
 * ============================================================================
 */

const express = require('express');
const productsRoutes       = require('./routes/products');
const salesRoutes          = require('./routes/sales');
const customersRoutes      = require('./routes/customers');
const categoriesRoutes     = require('./routes/categories');
const inventoryRoutes      = require('./routes/inventory');
const sessionsRoutes       = require('./routes/sessions');
const reconciliationRoutes = require('./routes/reconciliation');
const tillsRoutes          = require('./routes/tills');
const kvRoutes             = require('./routes/kv');
const discountsRoutes      = require('./routes/discounts');
const loyaltyRoutes        = require('./routes/loyalty');
const settingsRoutes       = require('./routes/settings');
const recoveryRoutes       = require('./routes/recovery');
const supportRoutes        = require('./routes/support');
const emergencyRoutes      = require('./routes/emergency');
const suppliersRoutes      = require('./routes/suppliers');
const reportsRoutes        = require('./routes/reports');
const importRoutes         = require('./routes/import');

const router = express.Router();

// Cloud KV store — all POS frontend business data stored here (NOT in localStorage)
router.use('/kv', kvRoutes);

router.use('/products',   productsRoutes);
router.use('/sales',      salesRoutes);
router.use('/customers',  customersRoutes);
router.use('/categories', categoriesRoutes);
router.use('/inventory',  inventoryRoutes);
router.use('/sessions',   sessionsRoutes);
// Reconciliation routes — mounted after sessionsRoutes so session handlers take
// priority; /sessions/:id/reconciliation and /snapshot fall through to this router.
router.use('/sessions',   reconciliationRoutes);
router.use('/tills',      tillsRoutes);
router.use('/till',       tillsRoutes);   // alias used by some frontend calls
router.use('/discounts',  discountsRoutes);
router.use('/loyalty',    loyaltyRoutes);
router.use('/settings',   settingsRoutes);
router.use('/recovery',   recoveryRoutes);
router.use('/support',    supportRoutes);
router.use('/emergency',  emergencyRoutes);
router.use('/suppliers',  suppliersRoutes);
router.use('/reports',    reportsRoutes);
router.use('/import',     importRoutes);

// Health check for POS module
router.get('/status', (req, res) => {
  res.json({ module: 'pos', status: 'active', version: '1.2.0' });
});

module.exports = router;
