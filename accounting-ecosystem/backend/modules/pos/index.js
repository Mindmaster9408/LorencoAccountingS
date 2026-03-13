/**
 * ============================================================================
 * POS Module Index — registers all POS sub-routes
 * ============================================================================
 */

const express = require('express');
const productsRoutes   = require('./routes/products');
const salesRoutes      = require('./routes/sales');
const customersRoutes  = require('./routes/customers');
const categoriesRoutes = require('./routes/categories');
const inventoryRoutes  = require('./routes/inventory');
const sessionsRoutes   = require('./routes/sessions');
const tillsRoutes      = require('./routes/tills');
const kvRoutes         = require('./routes/kv');
const discountsRoutes  = require('./routes/discounts');
const loyaltyRoutes    = require('./routes/loyalty');

const router = express.Router();

// Cloud KV store — all POS frontend business data stored here (NOT in localStorage)
router.use('/kv', kvRoutes);

router.use('/products',   productsRoutes);
router.use('/sales',      salesRoutes);
router.use('/customers',  customersRoutes);
router.use('/categories', categoriesRoutes);
router.use('/inventory',  inventoryRoutes);
router.use('/sessions',   sessionsRoutes);
router.use('/tills',      tillsRoutes);
router.use('/till',       tillsRoutes);   // alias used by some frontend calls
router.use('/discounts',  discountsRoutes);
router.use('/loyalty',    loyaltyRoutes);

// Health check for POS module
router.get('/status', (req, res) => {
  res.json({ module: 'pos', status: 'active', version: '1.2.0' });
});

module.exports = router;
