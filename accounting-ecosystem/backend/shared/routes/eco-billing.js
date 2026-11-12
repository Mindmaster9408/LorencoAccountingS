/**
 * ============================================================================
 * Eco billing routes — /api/eco-billing (2026-11-12) — super admin only
 * ============================================================================
 *   GET  /preview                 who is billed, customer link, missing details
 *   POST /sync                    sync every paying company to a Leo customer now
 *   POST /invoice/:companyId      create a DRAFT invoice in Lorenco's Leo
 *
 * Logic lives in shared/services/ecoBilling.js.
 * ============================================================================
 */

const express = require('express');
const svc = require('../services/ecoBilling');
const { isAdminUser } = require('./eco-clients');
const { auditFromReq } = require('../../middleware/audit');

const router = express.Router();

router.use((req, res, next) => {
  if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Super admin access required' });
  next();
});

router.get('/preview', async (req, res) => {
  try {
    res.json(await svc.preview());
  } catch (err) {
    console.error('[eco-billing] preview:', err.message);
    res.status(500).json({ error: 'Could not load billing overview' });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const r = await svc.syncBillingCustomers();
    res.json({ created: r.created, updated: r.updated, unchanged: r.unchanged, failed: r.failed });
  } catch (err) {
    console.error('[eco-billing] sync:', err.message);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

router.post('/invoice/:companyId', async (req, res) => {
  const companyId = parseInt(req.params.companyId, 10);
  if (!companyId) return res.status(400).json({ error: 'Invalid company id' });
  try {
    const r = await svc.createDraftInvoice({ payerCompanyId: companyId, actorId: req.user.userId || req.user.id || null });
    if (r.status === 201) {
      await Promise.resolve(auditFromReq(req, 'CREATE', 'eco_billing_invoice', companyId, {
        module: 'ecosystem',
        metadata: { invoice_id: r.body.invoice_id, invoice_number: r.body.invoice_number, billing_company_id: r.body.billing_company_id },
      })).catch(() => {});
    }
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error('[eco-billing] invoice:', err.message);
    res.status(500).json({ error: 'Could not create the invoice: ' + err.message });
  }
});

module.exports = router;
