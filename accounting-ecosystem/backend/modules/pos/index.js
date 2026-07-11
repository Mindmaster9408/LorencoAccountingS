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
const companyLinksRoutes   = require('./routes/company-links');
const companyTransfersRoutes = require('./routes/company-transfers');
const devicesRoutes        = require('./routes/devices');
const locationsRoutes      = require('./routes/locations');
const storeTransfersRoutes = require('./routes/store-transfers');
const purchaseOrdersRoutes = require('./routes/purchase-orders');
const reportsRoutes        = require('./routes/reports');
const importRoutes         = require('./routes/import');
const pinRoutes            = require('./routes/pin');
const shortcutsRoutes      = require('./routes/shortcuts');

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
router.use('/company-links', companyLinksRoutes);
router.use('/company-transfers', companyTransfersRoutes);
router.use('/devices', devicesRoutes);
router.use('/locations', locationsRoutes);
router.use('/store-transfers', storeTransfersRoutes);
router.use('/purchase-orders', purchaseOrdersRoutes);
router.use('/reports',    reportsRoutes);
router.use('/import',     importRoutes);
router.use('/shortcuts',  shortcutsRoutes);  // User product shortcuts: /api/pos/shortcuts
router.use('/users',      pinRoutes);   // PIN management: /api/pos/users/:id/pin

// Health check for POS module
router.get('/status', (req, res) => {
  res.json({ module: 'pos', status: 'active', version: '1.2.0' });
});

module.exports = router;
