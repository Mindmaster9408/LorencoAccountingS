const express = require('express');
const router = express.Router();
const vatReconService = require('../services/vatReconciliationService');
const auditLogger = require('../services/auditLogger');
const { authenticate, authorize } = require('../middleware/auth');
const { enforceCompanyStatus } = require('../middleware/companyStatus');

// Apply middleware
router.use(authenticate);
router.use(enforceCompanyStatus);

// ========================================================
// VAT PERIODS
// ========================================================

/**
 * GET /api/vat-recon/periods
 * Get all VAT periods for company
 */
router.get('/periods', async (req, res) => {
    try {
        const { companyId } = req.user;
        const { status, fromDate, toDate } = req.query;
        
        const periods = await vatReconService.getPeriods(companyId, {
            status,
            fromDate,
            toDate
        });
        
        res.json({ success: true, periods });
    } catch (error) {
        console.error('Error fetching VAT periods:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/vat-recon/periods/:periodIdOrKey
 * Get single VAT period
 */
router.get('/periods/:periodIdOrKey', async (req, res) => {
    try {
        const { companyId } = req.user;
        const { periodIdOrKey } = req.params;
        
        const period = await vatReconService.getPeriod(companyId, periodIdOrKey);
        
        if (!period) {
            return res.status(404).json({ success: false, error: 'Period not found' });
        }
        
        res.json({ success: true, period });
    } catch (error) {
        console.error('Error fetching VAT period:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/vat-recon/periods
 * Create or get a VAT period
 */
router.post('/periods', async (req, res) => {
    try {
        const { companyId, id: userId } = req.user;
        const periodData = req.body;
        
        const period = await vatReconService.createOrGetPeriod(companyId, periodData);
        
        await auditLogger.log({
            companyId,
            actorType: 'USER',
            actorId: userId,
            actionType: 'VAT_PERIOD_CREATED',
            entityType: 'vat_period',
            entityId: period.id,
            afterJson: period
        });
        
        res.json({ success: true, period });
    } catch (error) {
        console.error('Error creating VAT period:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/vat-recon/periods/generate
 * Auto-generate VAT period records from company settings.
 * Admin/accountant only.
 *
 * Body: { fromDate?: "YYYY-MM-DD", toDate?: "YYYY-MM-DD" }
 */
router.post('/periods/generate', authorize('admin', 'accountant'), async (req, res) => {
    try {
        const { companyId, id: userId } = req.user;
        const { fromDate, toDate } = req.body;

        const created = await vatReconService.generatePeriodsRange(companyId, fromDate, toDate);

        if (created.length > 0) {
            await auditLogger.log({
                companyId, actorType: 'USER', actorId: userId,
                actionType: 'VAT_PERIODS_GENERATED',
                entityType: 'vat_period', entityId: null,
                afterJson: { count: created.length, fromDate, toDate },
            });
        }

        res.json({ success: true, created, count: created.length });
    } catch (error) {
        console.error('Error generating VAT periods:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/vat-recon/periods/:periodId/lock
 * Lock a VAT period manually (without full SARS submission).
 * Admin/accountant only.
 */
router.post('/periods/:periodId/lock', authorize('admin', 'accountant'), async (req, res) => {
    try {
        const { companyId, id: userId } = req.user;
        const periodId = parseInt(req.params.periodId, 10);
        if (isNaN(periodId)) return res.status(400).json({ success: false, error: 'Invalid period ID' });

        const period = await vatReconService.lockPeriod(companyId, periodId, userId);

        await auditLogger.log({
            companyId, actorType: 'USER', actorId: userId,
            actionType: 'VAT_PERIOD_LOCKED',
            entityType: 'vat_period', entityId: period.id,
            afterJson: { period_key: period.period_key, locked_at: period.locked_at },
        });

        res.json({ success: true, period });
    } catch (error) {
        console.error('Error locking VAT period:', error);
        const code = error.message.includes('not found') ? 404
                   : error.message.includes('already locked') ? 409 : 400;
        res.status(code).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/vat-recon/periods/current-open
 * Return the current open VAT period (or create one if none exists).
 */
router.get('/periods/current-open', async (req, res) => {
    try {
        const { companyId } = req.user;
        const period = await vatReconService.getCurrentOpenPeriod(companyId);
        if (!period) return res.json({ success: true, period: null });
        res.json({ success: true, period });
    } catch (error) {
        console.error('Error fetching current open period:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/vat-recon/periods/:periodId/out-of-period
 * Return all out-of-period journals included in this VAT period.
 */
router.get('/periods/:periodId/out-of-period', async (req, res) => {
    try {
        const { companyId } = req.user;
        const periodId = parseInt(req.params.periodId, 10);
        if (isNaN(periodId)) return res.status(400).json({ success: false, error: 'Invalid period ID' });

        const result = await vatReconService.getOutOfPeriodItems(companyId, periodId);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Error fetching out-of-period items:', error);
        const code = error.message.includes('not found') ? 404 : 500;
        res.status(code).json({ success: false, error: error.message });
    }
});

// ========================================================
// VAT RECONCILIATIONS
// ========================================================

/**
 * GET /api/vat-recon/reconciliations/period/:periodIdOrKey
 * Get reconciliation for a specific period
 */
router.get('/reconciliations/period/:periodIdOrKey', async (req, res) => {
    try {
        const { companyId } = req.user;
        const { periodIdOrKey } = req.params;
        const { version } = req.query;
        
        const recon = await vatReconService.getReconciliationByPeriod(
            companyId,
            periodIdOrKey,
            version ? parseInt(version) : null
        );
        
        if (!recon) {
            return res.status(404).json({ success: false, error: 'Reconciliation not found' });
        }
        
        res.json({ success: true, reconciliation: recon });
    } catch (error) {
        console.error('Error fetching reconciliation:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/vat-recon/reconciliations/:reconId
 * Get reconciliation by ID
 */
router.get('/reconciliations/:reconId', async (req, res) => {
    try {
        const { companyId } = req.user;
        const { reconId } = req.params;
        
        const recon = await vatReconService.getReconciliation(companyId, parseInt(reconId));
        
        if (!recon) {
            return res.status(404).json({ success: false, error: 'Reconciliation not found' });
        }
        
        res.json({ success: true, reconciliation: recon });
    } catch (error) {
        console.error('Error fetching reconciliation:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/vat-recon/reconciliations/draft
 * Save draft reconciliation
 */
router.post('/reconciliations/draft', async (req, res) => {
    try {
        const { companyId, id: userId, role } = req.user;
        const reconData = req.body;
        
        // Check permissions (super admins bypass)
        if (!req.user.isGlobalAdmin && !['admin', 'accountant'].includes(role)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Only admin or accountant can save reconciliations' 
            });
        }
        
        const recon = await vatReconService.saveDraftReconciliation(companyId, userId, reconData);
        
        await auditLogger.log({
            companyId,
            actorType: 'USER',
            actorId: userId,
            actionType: 'VAT_RECON_DRAFT_SAVED',
            entityType: 'vat_reconciliation',
            entityId: recon.id,
            afterJson: recon
        });
        
        res.json({ success: true, reconciliation: recon });
    } catch (error) {
        console.error('Error saving draft reconciliation:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/vat-recon/reconciliations/:reconId/approve
 * Approve reconciliation
 */
router.post('/reconciliations/:reconId/approve', async (req, res) => {
    try {
        const { companyId, id: userId, role } = req.user;
        const { reconId } = req.params;
        
        // Check permissions (super admins bypass)
        if (!req.user.isGlobalAdmin && !['admin', 'accountant'].includes(role)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Only admin or accountant can approve reconciliations' 
            });
        }
        
        const beforeRecon = await vatReconService.getReconciliation(companyId, parseInt(reconId));
        const recon = await vatReconService.approveReconciliation(companyId, parseInt(reconId), userId);
        
        await auditLogger.log({
            companyId,
            actorType: 'USER',
            actorId: userId,
            actionType: 'VAT_RECON_APPROVED',
            entityType: 'vat_reconciliation',
            entityId: recon.id,
            beforeJson: beforeRecon,
            afterJson: recon
        });
        
        res.json({ success: true, reconciliation: recon });
    } catch (error) {
        console.error('Error approving reconciliation:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/vat-recon/reconciliations/:reconId/authorize-difference
 * Authorize Income/Expense difference
 */
router.post('/reconciliations/:reconId/authorize-difference', async (req, res) => {
    try {
        const { companyId, id: userId, role, firstName, lastName } = req.user;
        const { reconId } = req.params;
        
        // Check permissions (super admins bypass)
        if (!req.user.isGlobalAdmin && !['admin', 'accountant'].includes(role)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Only admin or accountant can authorize differences' 
            });
        }
        
        const userInitials = vatReconService.generateUserInitials(firstName, lastName);
        const beforeRecon = await vatReconService.getReconciliation(companyId, parseInt(reconId));
        const recon = await vatReconService.authorizeDifference(companyId, parseInt(reconId), userId, userInitials);
        
        await auditLogger.log({
            companyId,
            actorType: 'USER',
            actorId: userId,
            actionType: 'VAT_RECON_DIFF_AUTHORIZED',
            entityType: 'vat_reconciliation',
            entityId: recon.id,
            beforeJson: beforeRecon,
            afterJson: recon,
            metadata: { userInitials }
        });
        
        res.json({ success: true, reconciliation: recon });
    } catch (error) {
        console.error('Error authorizing difference:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/vat-recon/reconciliations/:reconId/authorize-soa
 * Authorize Statement of Account difference
 */
router.post('/reconciliations/:reconId/authorize-soa', async (req, res) => {
    try {
        const { companyId, id: userId, role, firstName, lastName } = req.user;
        const { reconId } = req.params;
        
        // Check permissions (super admins bypass)
        if (!req.user.isGlobalAdmin && !['admin', 'accountant'].includes(role)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Only admin or accountant can authorize SOA differences' 
            });
        }
        
        const userInitials = vatReconService.generateUserInitials(firstName, lastName);
        const beforeRecon = await vatReconService.getReconciliation(companyId, parseInt(reconId));
        const recon = await vatReconService.authorizeSOADifference(companyId, parseInt(reconId), userId, userInitials);
        
        await auditLogger.log({
            companyId,
            actorType: 'USER',
            actorId: userId,
            actionType: 'VAT_RECON_SOA_AUTHORIZED',
            entityType: 'vat_reconciliation',
            entityId: recon.id,
            beforeJson: beforeRecon,
            afterJson: recon,
            metadata: { userInitials }
        });
        
        res.json({ success: true, reconciliation: recon });
    } catch (error) {
        console.error('Error authorizing SOA difference:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========================================================
// SUBMISSION
// ========================================================

/**
 * POST /api/vat-recon/periods/:periodId/submit
 * Submit to SARS and lock period
 */
router.post('/periods/:periodId/submit', async (req, res) => {
    try {
        const { companyId, id: userId, role } = req.user;
        const { periodId } = req.params;
        const submissionData = req.body;
        
        // Check permissions (super admins bypass)
        if (!req.user.isGlobalAdmin && !['admin', 'accountant'].includes(role)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Only admin or accountant can submit to SARS' 
            });
        }
        
        const submission = await vatReconService.submitToSARS(
            companyId,
            parseInt(periodId),
            userId,
            submissionData
        );
        
        await auditLogger.log({
            companyId,
            actorType: 'USER',
            actorId: userId,
            actionType: 'VAT_SUBMITTED_TO_SARS',
            entityType: 'vat_submission',
            entityId: submission.id,
            afterJson: submission,
            metadata: { periodId: parseInt(periodId) }
        });
        
        res.json({ success: true, submission });
    } catch (error) {
        console.error('Error submitting to SARS:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/vat-recon/submissions
 * Get submission history
 */
router.get('/submissions', async (req, res) => {
    try {
        const { companyId } = req.user;
        const { periodId, status } = req.query;
        
        const submissions = await vatReconService.getSubmissions(companyId, {
            periodId: periodId ? parseInt(periodId) : null,
            status
        });
        
        res.json({ success: true, submissions });
    } catch (error) {
        console.error('Error fetching submissions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========================================================
// TRIAL BALANCE INTEGRATION
// ========================================================

/**
 * GET /api/vat-recon/trial-balance
 * Get Trial Balance for a specific period
 */
router.get('/trial-balance', async (req, res) => {
    try {
        const { companyId } = req.user;
        const { fromDate, toDate } = req.query;
        
        if (!fromDate || !toDate) {
            return res.status(400).json({ 
                success: false, 
                error: 'fromDate and toDate are required' 
            });
        }
        
        const trialBalance = await vatReconService.getTrialBalanceForPeriod(
            companyId,
            fromDate,
            toDate
        );
        
        res.json({ success: true, trialBalance });
    } catch (error) {
        console.error('Error fetching trial balance:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========================================================
// AI INTEGRATION HOOKS
// ========================================================

/**
 * POST /api/vat-recon/ai/populate
 * AI hook to populate reconciliation (checks AI guard)
 */
router.post('/ai/populate', async (req, res) => {
    try {
        const { companyId, id: userId } = req.user;
        const { vatPeriodId, values } = req.body;
        
        // TODO: Check AI guard settings for VAT_RECON capability
        // For now, treat as user input with AI actor type
        
        const reconData = {
            vatPeriodId,
            ...values
        };
        
        const recon = await vatReconService.saveDraftReconciliation(companyId, userId, reconData);
        
        await auditLogger.log({
            companyId,
            actorType: 'AI',
            actorId: userId,
            actionType: 'VAT_RECON_AI_POPULATED',
            entityType: 'vat_reconciliation',
            entityId: recon.id,
            afterJson: recon
        });
        
        res.json({ success: true, reconciliation: recon });
    } catch (error) {
        console.error('Error with AI populate:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
