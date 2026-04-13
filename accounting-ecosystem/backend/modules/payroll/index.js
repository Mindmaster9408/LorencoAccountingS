/**
 * ============================================================================
 * Payroll Module Index — registers all payroll sub-routes
 * ============================================================================
 * WORKSTREAM 2 STEP 6: Backend Services Integration
 * 
 * Route organization:
 * - /calculate         — NEW unified calculation service (WORKSTREAM 2)
 * - /employees         — employee CRUD
 * - /periods           — period management
 * - /transactions      — payslip listing
 * - /items             — payroll items
 * - /attendance        — attendance tracking
 * - /kv                — key-value store (preferences)
 * - /unlock            — payslip unlock (finalization workflow)
 * - /recon             — reconciliation
 *
 * CALCULATION FLOW:
 *   POST /api/payroll/calculate
 *   → PayrollDataService (fetch + normalize inputs)
 *   → PayrollCalculationService (call engine)
 *   → PayrollHistoryService (prepare snapshot)
 *   → Response (stable, auditable result)
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
const unlockRoutes = require('./routes/unlock');
const calculateRoutes = require('./routes/calculate'); // NEW — Workstream 2 Step 6
const payrunsRoutes   = require('./routes/payruns');   // NEW — Workstream 2 Step 7

const router = express.Router();

// Calculation service endpoint (backend authority for payroll calculations)
router.use('/calculate', calculateRoutes);

// Payroll run, finalize, and history endpoints (all mounted at root — routes defined internally)
// Provides: POST /run, POST /finalize, GET /history, GET /history/run/:id
router.use('/', payrunsRoutes);

// Existing endpoints
router.use('/employees', employeesRoutes);
router.use('/periods', periodsRoutes);
router.use('/transactions', transactionsRoutes);
router.use('/items', itemsRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/kv', kvRoutes);
router.use('/recon', reconRoutes);
// Server-side payslip unlock — replaces client-controlled KV delete pattern
router.use('/unlock', unlockRoutes);

// Health check for Payroll module
router.get('/status', (req, res) => {
  res.json({ module: 'payroll', status: 'active', version: '1.0.0' });
});

module.exports = router;
