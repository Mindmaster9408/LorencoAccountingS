/**
 * ============================================================================
 * Payroll Module Index — registers all payroll sub-routes
 * ============================================================================
 */

const express = require('express');
const employeesRoutes = require('./routes/employees');
const periodsRoutes = require('./routes/periods');
const transactionsRoutes = require('./routes/transactions');
const itemsRoutes = require('./routes/items');
const attendanceRoutes = require('./routes/attendance');
const kvRoutes = require('./routes/kv');
const reconRoutes = require('./routes/recon');

const router = express.Router();

router.use('/employees', employeesRoutes);
router.use('/periods', periodsRoutes);
router.use('/transactions', transactionsRoutes);
router.use('/items', itemsRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/kv', kvRoutes);
router.use('/recon', reconRoutes);

// Health check for Payroll module
router.get('/status', (req, res) => {
  res.json({ module: 'payroll', status: 'active', version: '1.0.0' });
});

module.exports = router;
