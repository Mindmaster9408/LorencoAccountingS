/**
 * ============================================================================
 * Global Payroll Authority Route
 * ============================================================================
 * Read-only endpoint that returns which company holds the global payroll
 * authority designation (is_global_payroll_authority = true).
 *
 * Used by:
 *   - Frontend Tax Config UI: to display the authority name dynamically
 *     instead of the hardcoded string "Infinite Legacy"
 *   - Sean (future): to identify the authority company without hardcoding
 *   - Any component that needs to know who governs global payroll standards
 *
 * Requires: PAYROLL.VIEW — same permission as reading global tax config.
 * Read-only. No writes. No side effects.
 *
 * GET /api/payroll/global-authority
 * Response: { ok: true, company_id, company_name, is_global_payroll_authority }
 * ============================================================================
 */

const express = require('express');
const { authenticateToken, requirePermission } = require('../../../middleware/auth');
const { getGlobalAuthorityCompany } = require('../../../shared/utils/globalAuthority');

const router = express.Router();

router.use(authenticateToken);

/**
 * GET /api/payroll/global-authority
 */
router.get('/', requirePermission('PAYROLL.VIEW'), async (req, res) => {
    try {
        const authority = await getGlobalAuthorityCompany();

        if (!authority) {
            return res.status(404).json({
                ok: false,
                error: 'No global payroll authority has been designated',
                hint: 'Run migration 022_global_payroll_authority.sql in Supabase SQL Editor'
            });
        }

        res.json({
            ok: true,
            company_id: authority.id,
            company_name: authority.company_name,
            is_global_payroll_authority: true
        });
    } catch (err) {
        console.error('[global-authority] Unexpected error:', err.message);
        res.status(500).json({ ok: false, error: 'Database error' });
    }
});

module.exports = router;
