/**
 * ============================================================================
 * POS Module Index — registers all POS sub-routes
 * ============================================================================
 */

const express = require('express');
const productsRoutes = require('./routes/products');
const salesRoutes = require('./routes/sales');
const customersRoutes = require('./routes/customers');
const categoriesRoutes = require('./routes/categories');
const inventoryRoutes = require('./routes/inventory');
const sessionsRoutes = require('./routes/sessions');
const tillsRoutes = require('./routes/tills');
const kvRoutes = require('./routes/kv');

const router = express.Router();

// Cloud KV store — all POS frontend business data stored here (NOT in localStorage)
router.use('/kv', kvRoutes);

router.use('/products', productsRoutes);
router.use('/sales', salesRoutes);
router.use('/customers', customersRoutes);
router.use('/categories', categoriesRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/sessions', sessionsRoutes);
router.use('/tills', tillsRoutes);
router.use('/till', tillsRoutes);

// Stock adjust alias (frontend uses /api/pos/stock/adjust)
router.post('/stock/adjust', inventoryRoutes);

// Daily discounts placeholder
router.post('/daily-discounts', (req, res) => {
  res.json({ success: true, discounts: [] });
});

// Health check for POS module
router.get('/status', (req, res) => {
  res.json({ module: 'pos', status: 'active', version: '1.0.0' });
});

module.exports = router;
