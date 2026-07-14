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
const { posAuditFromReq, logPosEvent, POS_EVENTS } = require('../services/posAuditLogger');
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
 *
 * BUG FIX (found live, Workstream 99): this previously scoped both updates
 * to `company_id = <the company that called confirm/revoke>`, so only the
 * confirming side's own supplier/customer record ever got its link_status
 * flipped to 'active' — the initiating side's record (which auto-confirmed
 * itself when the request was created) stayed stuck on 'pending' forever,
 * even though the underlying relationship was genuinely active on both
 * sides. relationship_id is unique across the whole table regardless of
 * which company's record it's on, so this now updates every record
 * pointing at it — both sides — in one pass each, with no company_id
 * filter needed at all.
 */
async function syncLinkedRecords(relationshipId, status) {
  await supabase.from('suppliers')
    .update({ link_status: status, updated_at: new Date().toISOString() })
    .eq('linked_relationship_id', relationshipId);
  await supabase.from('customers')
    .update({ link_status: status, updated_at: new Date().toISOString() })
    .eq('linked_relationship_id', relationshipId);
}

function generateLinkedRecordCode(prefix) {
  return `${prefix}-` + require('crypto').randomBytes(4).toString('hex').toUpperCase();
}

async function getCompanyDisplayName(companyId) {
  const { data } = await supabase.from('companies').select('company_name, trading_name').eq('id', companyId).maybeSingle();
  return (data && (data.trading_name || data.company_name)) || `Company ${companyId}`;
}

/**
 * Once a relationship is genuinely active, a company can trade in EITHER
 * direction with its partner — sell to them (needs a customer record) or buy
 * from them (needs a supplier record) — regardless of which record type the
 * link happened to be requested through originally (Workstream 100, following
 * the user's confirmed rule: "as daar supplier by een is word hy customer by
 * die ander een gemaak", extended to guarantee BOTH record types on BOTH
 * sides so the relationship works symmetrically no matter who buys/sells).
 *
 * Never duplicates: only fills in whichever of the four (supplier@A,
 * customer@A, supplier@B, customer@B) doesn't already exist for this
 * relationship_id. An existing, manually-created record (e.g. one made
 * before this workstream, or a differently-named one a user prefers) is left
 * completely untouched.
 */
async function ensureMirroredRecords(relationship) {
  const { id: relationshipId, company_a_id: companyA, company_b_id: companyB } = relationship;
  const sides = [
    { owner: companyA, partner: companyB },
    { owner: companyB, partner: companyA },
  ];

  for (const { owner, partner } of sides) {
    const partnerName = await getCompanyDisplayName(partner);

    const { data: existingSupplier } = await supabase
      .from('suppliers').select('id')
      .eq('company_id', owner).eq('linked_relationship_id', relationshipId).maybeSingle();
    if (!existingSupplier) {
      const { data: created } = await supabase.from('suppliers').insert({
        company_id: owner,
        supplier_code: generateLinkedRecordCode('SUP'),
        supplier_name: partnerName,
        name: partnerName,
        payment_terms: 30,
        is_active: true,
        linked_company_id: partner,
        linked_relationship_id: relationshipId,
        link_status: 'active',
      }).select().single();
      if (created) {
        logPosEvent({
          companyId: owner, userEmail: 'company-link-sync', userRole: 'system',
          actionType: POS_EVENTS.COMPANY_LINK_MIRROR_RECORD_CREATED,
          entityType: 'supplier', entityId: created.id,
          metadata: { relationship_id: relationshipId, record_type: 'supplier', partner_company_id: partner, partner_name: partnerName },
        });
      }
    }

    const { data: existingCustomer } = await supabase
      .from('customers').select('id')
      .eq('company_id', owner).eq('linked_relationship_id', relationshipId).maybeSingle();
    if (!existingCustomer) {
      const { data: created } = await supabase.from('customers').insert({
        company_id: owner,
        name: partnerName,
        customer_number: `C-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`,
        customer_group: 'retail',
        loyalty_points: 0,
        loyalty_tier: 'bronze',
        current_balance: 0,
        is_active: true,
        linked_company_id: partner,
        linked_relationship_id: relationshipId,
        link_status: 'active',
      }).select().single();
      if (created) {
        logPosEvent({
          companyId: owner, userEmail: 'company-link-sync', userRole: 'system',
          actionType: POS_EVENTS.COMPANY_LINK_MIRROR_RECORD_CREATED,
          entityType: 'customer', entityId: created.id,
          metadata: { relationship_id: relationshipId, record_type: 'customer', partner_company_id: partner, partner_name: partnerName },
        });
      }
    }
  }
}

/**
 * GET /api/pos/company-links/my-code
 * Get this company's own invitation code, generating and persisting one if
 * it doesn't have one yet (idempotent — see InterCompanyNetwork.enable()).
 * This is the code a trading partner enters on THEIR side (Settings →
 * Suppliers → Manage Linked Products → Company Link) to request a link to
 * this company.
 */
router.get('/my-code', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const network = getNetwork();
    const result = await network.enable(req.companyId, {});
    if (!result.success) return res.status(500).json({ error: result.error });
    res.json({ invitation_code: result.invitationCode });
  } catch (err) {
    console.error('[company-links] my-code:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

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

    await syncLinkedRecords(relationshipId, result.relationship.status);

    if (result.relationship.status === 'active') {
      await ensureMirroredRecords(result.relationship);

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

    await syncLinkedRecords(relationshipId, 'revoked');

    posAuditFromReq(req, POS_EVENTS.COMPANY_RELATIONSHIP_REVOKED, {
      metadata: { relationship_id: relationshipId },
    });

    res.json(result);
  } catch (err) {
    console.error('[company-links] revoke:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/company-links/:id/statement
 * Reconciliation statement between this company and its linked trading
 * partner (Workstream 100) — every inter_company_invoices row in EITHER
 * direction between the two companies, side by side, so both companies'
 * "sold to them" and "bought from them" invoices can be compared and
 * reconciled in one place instead of two separate, disconnected invoice
 * lists.
 *
 * inter_company_invoices is a single shared row per invoice (sender_company_id
 * / receiver_company_id on the same row — see invoice-sender.js), so there is
 * no risk of the two companies' copies of an invoice's amount ever disagreeing
 * with each other; the real reconciliation signal is whether the receiving
 * side has approved/paid it yet, which is what `recon_status` below surfaces.
 */
router.get('/:id/statement', requirePermission('PURCHASE_ORDERS.VIEW'), async (req, res) => {
  try {
    const relationshipId = parseInt(req.params.id);
    if (!relationshipId) return res.status(400).json({ error: 'Invalid relationship id' });

    const rel = await supabaseSeanStore.getRelationshipById(relationshipId);
    if (!rel) return res.status(404).json({ error: 'Relationship not found' });
    if (rel.company_a_id !== req.companyId && rel.company_b_id !== req.companyId) {
      return res.status(403).json({ error: 'Not authorized for this relationship' });
    }

    const otherCompanyId = rel.company_a_id === req.companyId ? rel.company_b_id : rel.company_a_id;
    const otherCompanyName = await getCompanyDisplayName(otherCompanyId);

    const { data: invoices, error } = await supabase
      .from('inter_company_invoices')
      .select('id, invoice_number, sender_company_id, receiver_company_id, date, due_date, total, subtotal, vat_amount, sender_status, receiver_status, payment_status, amount_paid, purchase_order_id, created_at')
      .or(`and(sender_company_id.eq.${req.companyId},receiver_company_id.eq.${otherCompanyId}),and(sender_company_id.eq.${otherCompanyId},receiver_company_id.eq.${req.companyId})`)
      .order('date', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    let totalSold = 0, totalBought = 0, totalOutstanding = 0;
    const shaped = (invoices || []).map(inv => {
      const direction = inv.sender_company_id === req.companyId ? 'sold' : 'bought';
      const remaining = Math.round(((inv.total || 0) - (inv.amount_paid || 0)) * 100) / 100;

      let reconStatus;
      if (inv.receiver_status === 'rejected') reconStatus = 'disputed';
      else if (inv.payment_status === 'paid') reconStatus = 'reconciled';
      else if (inv.receiver_status === 'pending') reconStatus = 'awaiting_approval';
      else if (inv.payment_status === 'partial') reconStatus = 'partially_paid';
      else reconStatus = 'approved_unpaid';

      if (direction === 'sold') totalSold += inv.total || 0;
      else totalBought += inv.total || 0;
      if (reconStatus !== 'reconciled' && reconStatus !== 'disputed') totalOutstanding += remaining;

      return {
        id: inv.id, invoiceNumber: inv.invoice_number, direction,
        date: inv.date, dueDate: inv.due_date,
        total: inv.total, amountPaid: inv.amount_paid || 0, remaining,
        senderStatus: inv.sender_status, receiverStatus: inv.receiver_status, paymentStatus: inv.payment_status,
        reconStatus, purchaseOrderId: inv.purchase_order_id,
      };
    });

    res.json({
      otherCompany: { id: otherCompanyId, name: otherCompanyName },
      summary: {
        totalSold: Math.round(totalSold * 100) / 100,
        totalBought: Math.round(totalBought * 100) / 100,
        netBalance: Math.round((totalSold - totalBought) * 100) / 100,
        totalOutstanding: Math.round(totalOutstanding * 100) / 100,
        invoiceCount: shaped.length,
      },
      invoices: shaped,
    });
  } catch (err) {
    console.error('[company-links] statement:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PATCH /api/pos/company-links/:id/permissions
 * Toggle the POS-specific permission flags on an active relationship
 * (Workstream 81 — required before either side can send/receive/return
 * inter-company stock transfers). Only the 5 POS flags below can be set
 * here — accounting's send_invoices/receive_invoices/auto_match_payments
 * remain exclusively accounting's concern and are merged through untouched.
 *
 * Body: { stock_transfer?, receive_transfer?, return_transfer?, pricing_visible?, invoice_reference_visible?, purchase_orders? } — booleans
 *
 * Either party to an already-active relationship may toggle these flags —
 * the relationship itself already required mutual confirmation, so
 * enabling a transfer capability on top of it is not a new trust boundary.
 * Only an ACTIVE relationship's permissions can be changed (pending/revoked
 * relationships have nothing to transfer against yet).
 *
 * purchase_orders (Workstream 87) — gates whether this relationship's
 * supplier side is even offered as a PO destination (see
 * GET /purchase-orders/transferable-suppliers). Deliberately separate from
 * stock_transfer: a company may allow ad-hoc stock transfers without opening
 * itself up to formal purchase orders, or vice versa.
 */
const POS_PERMISSION_KEYS = ['stock_transfer', 'receive_transfer', 'return_transfer', 'pricing_visible', 'invoice_reference_visible', 'purchase_orders'];

router.patch('/:id/permissions', requirePermission('INVENTORY.ADJUST'), async (req, res) => {
  try {
    const relationshipId = parseInt(req.params.id);
    if (!relationshipId) return res.status(400).json({ error: 'Invalid relationship id' });

    const rel = await supabaseSeanStore.getRelationshipById(relationshipId);
    if (!rel) return res.status(404).json({ error: 'Relationship not found' });
    if (rel.company_a_id !== req.companyId && rel.company_b_id !== req.companyId) {
      return res.status(403).json({ error: 'Not authorized for this relationship' });
    }
    if (rel.status !== 'active') {
      return res.status(400).json({ error: 'Only an active relationship\'s permissions can be changed' });
    }

    const updatedPermissions = { ...(rel.permissions || {}) };
    for (const key of POS_PERMISSION_KEYS) {
      if (typeof req.body[key] === 'boolean') updatedPermissions[key] = req.body[key];
    }

    const updated = await supabaseSeanStore.updateRelationship(relationshipId, { permissions: updatedPermissions });
    if (!updated) return res.status(500).json({ error: 'Failed to update permissions' });

    res.json({ relationship: { id: updated.id, status: updated.status, permissions: updated.permissions } });
  } catch (err) {
    console.error('[company-links] permissions:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
