/**
 * ============================================================================
 * POS Company Links Routes — Checkout Charlie (Workstream 80)
 * ============================================================================
 * Manage cross-company relationships used to link a supplier/customer record
 * to another real platform company (e.g. Pennygrow linking Turkstra as a
 * supplier by invitation code).
 *
 * This is a thin, POS-permissioned wrapper around the existing, shared
 * InterCompanyNetwork engine (accounting's inter-company invoice module —
 * /api/inter-company/*, gated on the 'sean' module). Reusing it means POS
 * and Accounting always see the exact same relationship state for a company
 * pair, and a future stock-transfer feature extends the same permissions
 * JSON rather than a second, parallel relationship system.
 *
 * Why a separate wrapper instead of calling /api/inter-company directly from
 * the POS frontend: that route is gated on requireModule('sean') with no
 * company-scoped permission check, which is the wrong boundary for POS —
 * these routes apply POS's own requireCompany + INVENTORY.* permission gates.
 *
 * Routes:
 *   POST  /api/pos/company-links/lookup       — find a company by invitation code (safe preview only)
 *   GET   /api/pos/company-links               — list this company's relationships (any status)
 *   POST  /api/pos/company-links/:id/confirm   — confirm this company's side of a pending link
 *   POST  /api/pos/company-links/:id/revoke    — revoke an active or pending link
 *
 * Security: no global company list is ever returned — lookup requires an
 * exact invitation code match. No relationship data is shared with the
 * other company until both sides confirm. See docs/checkout-charlie-future/
 * INTER_COMPANY_CUSTOMER_SUPPLIER_LINKING.md.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');
const InterCompanyNetwork = require('../../../inter-company/network');
const { supabaseSeanStore } = require('../../../sean/supabase-store');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

function getNetwork() {
  return new InterCompanyNetwork(supabaseSeanStore);
}

/**
 * Sync any supplier/customer rows pointing at this relationship to its
 * current status. Keeps the cheap, denormalised link_status column (used
 * for list-view display without a join) consistent after confirm/revoke.
 */
async function syncLinkedRecords(companyId, relationshipId, status) {
  await supabase.from('suppliers')
    .update({ link_status: status, updated_at: new Date().toISOString() })
    .eq('company_id', companyId).eq('linked_relationship_id', relationshipId);
  await supabase.from('customers')
    .update({ link_status: status, updated_at: new Date().toISOString() })
    .eq('company_id', companyId).eq('linked_relationship_id', relationshipId);
}

/**
 * POST /api/pos/company-links/lookup
 * Find a company by exact invitation code. Returns only safe preview info
 * (id, name, city, industry) — never financial/contact details, and never a
 * browsable list of unrelated companies.
 */
router.post('/lookup', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const invitationCode = (req.body.invitationCode || '').trim();
    if (!invitationCode) return res.status(400).json({ error: 'invitationCode is required' });

    const network = getNetwork();
    const matches = await network.findCompanies({ invitationCode }, req.companyId);
    const match = matches.find(m => m.matchType === 'invitation_code');
    if (!match) return res.status(404).json({ error: 'No company found for that invitation code' });

    res.json({ company: { id: match.companyId, name: match.companyName, preview: match.preview } });
  } catch (err) {
    console.error('[company-links] lookup:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/company-links
 * List this company's relationships (pending, active, and revoked), enriched
 * with the counterparty's display name only — nothing else.
 */
router.get('/', requirePermission('INVENTORY.VIEW'), async (req, res) => {
  try {
    const network = getNetwork();
    const relationships = await network.getAllRelationships(req.companyId);

    const otherCompanyIds = [...new Set(relationships.map(r =>
      r.company_a_id === req.companyId ? r.company_b_id : r.company_a_id
    ))];

    let namesById = {};
    if (otherCompanyIds.length > 0) {
      const { data: companies } = await supabase
        .from('companies').select('id, company_name, trading_name').in('id', otherCompanyIds);
      namesById = Object.fromEntries((companies || []).map(c => [c.id, c.trading_name || c.company_name]));
    }

    const shaped = relationships.map(r => {
      const otherCompanyId = r.company_a_id === req.companyId ? r.company_b_id : r.company_a_id;
      return {
        id: r.id,
        other_company_id: otherCompanyId,
        other_company_name: namesById[otherCompanyId] || `Company ${otherCompanyId}`,
        status: r.status,
        initiated_by_us: r.initiated_by === req.companyId,
        permissions: r.permissions || {},
        created_at: r.created_at,
      };
    });

    res.json({ relationships: shaped });
  } catch (err) {
    console.error('[company-links] list:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/company-links/:id/confirm
 * Confirm this company's side of a pending relationship request.
 */
router.post('/:id/confirm', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const relationshipId = parseInt(req.params.id);
    if (!relationshipId) return res.status(400).json({ error: 'Invalid relationship id' });

    const network = getNetwork();
    const result = await network.confirmRelationship(relationshipId, req.companyId);
    if (!result.success) return res.status(400).json(result);

    await syncLinkedRecords(req.companyId, relationshipId, result.relationship.status);

    if (result.relationship.status === 'active') {
      posAuditFromReq(req, POS_EVENTS.COMPANY_RELATIONSHIP_APPROVED, {
        metadata: { relationship_id: relationshipId },
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[company-links] confirm:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/company-links/:id/revoke
 * Revoke an active or pending relationship. Either side may revoke.
 */
router.post('/:id/revoke', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const relationshipId = parseInt(req.params.id);
    if (!relationshipId) return res.status(400).json({ error: 'Invalid relationship id' });

    const network = getNetwork();
    const result = await network.revokeRelationship(relationshipId, req.companyId);
    if (!result.success) return res.status(400).json(result);

    await syncLinkedRecords(req.companyId, relationshipId, 'revoked');

    posAuditFromReq(req, POS_EVENTS.COMPANY_RELATIONSHIP_REVOKED, {
      metadata: { relationship_id: relationshipId },
    });

    res.json(result);
  } catch (err) {
    console.error('[company-links] revoke:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
