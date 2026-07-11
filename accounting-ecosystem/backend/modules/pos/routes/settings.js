/**
 * ============================================================================
 * POS Settings Routes — Company-level POS configuration
 * ============================================================================
 * GET  /api/pos/settings              — read company_settings for this company
 * PUT  /api/pos/settings/stock-policy — update allow_negative_stock_sales
 *                                       (MANAGEMENT roles only)
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');
const { invalidateStockPolicyCache } = require('../services/stockPolicyCache');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

/**
 * GET /api/pos/settings
 * Return company_settings for the authenticated company.
 * Creates a default row if one does not yet exist.
 * All authenticated POS users may read settings (SETTINGS.VIEW).
 */
router.get('/', requirePermission('SETTINGS.VIEW'), async (req, res) => {
  try {
    let { data, error } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', req.companyId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (!data) {
      // No row yet — insert defaults. The schema has UNIQUE(company_id) so
      // concurrent inserts will collide; the second will get a 409 from
      // Supabase. A subsequent GET will then return the existing row.
      const { data: inserted, error: insertErr } = await supabase
        .from('company_settings')
        .insert({ company_id: req.companyId })
        .select()
        .single();

      if (insertErr && insertErr.code !== '23505') {
        return res.status(500).json({ error: insertErr.message });
      }
      data = inserted || null;

      if (!data) {
        // Race: our insert lost — re-fetch the winner's row.
        const { data: refetched } = await supabase
          .from('company_settings')
          .select('*')
          .eq('company_id', req.companyId)
          .maybeSingle();
        data = refetched;
      }
    }

    res.json({ settings: data });
  } catch (err) {
    console.error('[Settings] GET error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/settings/stock-policy
 * Toggle allow_negative_stock_sales for the company.
 * Restricted to MANAGEMENT roles (business_owner, practice_manager, administrator).
 *
 * Body: { allow_negative_stock_sales: boolean }
 */
router.put('/stock-policy', requirePermission('SETTINGS.EDIT'), async (req, res) => {
  try {
    const { allow_negative_stock_sales } = req.body;

    if (typeof allow_negative_stock_sales !== 'boolean') {
      return res.status(400).json({
        error: 'allow_negative_stock_sales must be a boolean',
      });
    }

    // Read the current value for the audit before-snapshot.
    const { data: current } = await supabase
      .from('company_settings')
      .select('allow_negative_stock_sales')
      .eq('company_id', req.companyId)
      .maybeSingle();

    const previousValue = current?.allow_negative_stock_sales ?? false;

    // Upsert: insert row if it doesn't exist, update if it does.
    const { data, error } = await supabase
      .from('company_settings')
      .upsert(
        {
          company_id:                  req.companyId,
          allow_negative_stock_sales,
          updated_at:                  new Date().toISOString(),
          updated_by_user_id:          req.user.userId,
        },
        { onConflict: 'company_id' }
      )
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Immediately evict the server-side cache so the next sale reads the new
    // policy from the DB — no 60-second stale window after a policy change.
    invalidateStockPolicyCache(req.companyId);

    // Audit the policy change — always awaited (this IS the critical event).
    await posAuditFromReq(req, POS_EVENTS.STOCK_POLICY_CHANGED, {
      entityType:     'company_settings',
      entityId:       req.companyId,
      beforeSnapshot: { allow_negative_stock_sales: previousValue },
      afterSnapshot:  { allow_negative_stock_sales },
      metadata: {
        changed_by_email: req.user.email || req.user.username,
        changed_by_role:  req.user.role,
      },
    });

    res.json({
      settings: data,
      message: allow_negative_stock_sales
        ? 'Negative stock sales ENABLED — cashiers may now sell into negative stock'
        : 'Negative stock sales DISABLED — strict stock protection restored',
    });
  } catch (err) {
    console.error('[Settings] PUT stock-policy error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/settings/blind-transfer-receiving
 * Toggle blind_transfer_receiving (Workstream 85) — when enabled, a new
 * inter-store transfer's items hide quantity_sent from the receiver until
 * they submit their own count (see store-transfers.js). Snapshotted onto
 * each transfer at creation, so changing this setting never alters a
 * transfer already in progress.
 *
 * Body: { blind_transfer_receiving: boolean }
 */
router.put('/blind-transfer-receiving', requirePermission('SETTINGS.EDIT'), async (req, res) => {
  try {
    const { blind_transfer_receiving } = req.body;
    if (typeof blind_transfer_receiving !== 'boolean') {
      return res.status(400).json({ error: 'blind_transfer_receiving must be a boolean' });
    }

    const { data, error } = await supabase
      .from('company_settings')
      .upsert(
        { company_id: req.companyId, blind_transfer_receiving, updated_at: new Date().toISOString(), updated_by_user_id: req.user.userId },
        { onConflict: 'company_id' }
      )
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ settings: data });
  } catch (err) {
    console.error('[Settings] PUT blind-transfer-receiving error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/pos/settings/po-invoice-timing
 * Toggle when a Purchase Order's invoice is generated (Workstream 87):
 *   'immediate'            — Option B: invoice raised as soon as the supplier accepts
 *   'after_final_delivery' — Option A: invoice raised only once the order is fully received
 * Snapshotted onto purchase_orders.invoice_timing at PO creation, so changing
 * this setting never alters an already-created order's behaviour.
 *
 * Body: { po_invoice_timing: 'immediate' | 'after_final_delivery' }
 */
router.put('/po-invoice-timing', requirePermission('SETTINGS.EDIT'), async (req, res) => {
  try {
    const { po_invoice_timing } = req.body;
    if (!['immediate', 'after_final_delivery'].includes(po_invoice_timing)) {
      return res.status(400).json({ error: "po_invoice_timing must be 'immediate' or 'after_final_delivery'" });
    }

    const { data, error } = await supabase
      .from('company_settings')
      .upsert(
        { company_id: req.companyId, po_invoice_timing, updated_at: new Date().toISOString(), updated_by_user_id: req.user.userId },
        { onConflict: 'company_id' }
      )
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ settings: data });
  } catch (err) {
    console.error('[Settings] PUT po-invoice-timing error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
