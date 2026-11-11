/**
 * ============================================================================
 * Customer Invoice Billing Options — annual / monthly (migration 178)
 * ============================================================================
 * Mounted at /api/accounting/customer-invoices (before customer-invoices.js).
 *
 *   POST /:id/billing-choice            { choice: 'annual' | 'monthly' }
 *   GET  /recurring-plans               list this company's monthly plans
 *   POST /recurring-plans/run           bring this company's plans up to date now
 *   POST /recurring-plans/:planId/cancel { reason }
 *
 * All logic lives in services/recurringInvoiceService.js.
 * ============================================================================
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { supabase } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const { userId } = require('../services/customerInvoiceCore');
const { isEmailConfigured } = require('../../../shared/services/email');
const {
  chooseBilling, runDuePlans, cancelPlan, instalmentDate,
} = require('../services/recurringInvoiceService');

// ─── Record the client's choice on a draft invoice ───────────────────────────
// 'monthly' leads to automatic GL posting, so it needs the post permission.

router.post('/:id(\\d+)/billing-choice', authenticate, hasPermission('ar.invoice.post'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  try {
    const result = await chooseBilling({
      companyId: req.companyId,
      invoiceId: parseInt(req.params.id),
      choice:    req.body?.choice,
      actorId:   userId(req),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('POST /customer-invoices/:id/billing-choice error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── List monthly plans ──────────────────────────────────────────────────────

router.get('/recurring-plans', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  try {
    // Opening the list also nudges this company's plans forward (cheap, and a
    // safety net should the hourly timer not have run, e.g. after a restart).
    runDuePlans({ companyId }).catch((e) => console.error('[RecurringInvoices] on-demand run failed:', e.message));

    const { data: plans, error } = await supabase
      .from('customer_invoice_recurring_plans')
      .select('id, customer_id, source_invoice_id, instalments_total, start_date, annual_total, status, last_run_at, last_error, cancel_reason, cancelled_at, created_at')
      .eq('company_id', companyId)
      .order('id', { ascending: false });
    if (error) throw new Error(error.message);

    const planIds = (plans || []).map((p) => p.id);
    const custIds = [...new Set((plans || []).map((p) => p.customer_id))];
    const [{ data: invs }, { data: custs }] = await Promise.all([
      planIds.length
        ? supabase.from('customer_invoices').select('recurring_plan_id, status, emailed_at')
            .eq('company_id', companyId).in('recurring_plan_id', planIds)
        : Promise.resolve({ data: [] }),
      custIds.length
        ? supabase.from('customers').select('id, name').eq('company_id', companyId).in('id', custIds)
        : Promise.resolve({ data: [] }),
    ]);
    const nameById = Object.fromEntries((custs || []).map((c) => [c.id, c.name]));

    const out = (plans || []).map((p) => {
      const mine    = (invs || []).filter((i) => i.recurring_plan_id === p.id);
      const posted  = mine.filter((i) => i.status !== 'draft' && i.status !== 'void').length;
      const emailed = mine.filter((i) => i.emailed_at).length;
      const nextNo  = mine.length + 1;
      return {
        ...p,
        customer_name: nameById[p.customer_id] || `Customer #${p.customer_id}`,
        monthly_amount: Math.round((Number(p.annual_total) / p.instalments_total) * 100) / 100,
        instalments_posted: posted,
        instalments_emailed: emailed,
        next_date: p.status === 'active' && nextNo <= p.instalments_total ? instalmentDate(p.start_date, nextNo) : null,
      };
    });
    // emailConfigured lets the UI warn that auto-emails cannot go out yet.
    res.json({ plans: out, emailConfigured: isEmailConfigured() });
  } catch (err) {
    console.error('GET /customer-invoices/recurring-plans error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Run now (this company only) ─────────────────────────────────────────────

router.post('/recurring-plans/run', authenticate, hasPermission('ar.invoice.post'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  try {
    const result = await runDuePlans({ companyId: req.companyId });
    res.json(result);
  } catch (err) {
    console.error('POST /customer-invoices/recurring-plans/run error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stop a plan ─────────────────────────────────────────────────────────────

router.post('/recurring-plans/:planId(\\d+)/cancel', authenticate, hasPermission('ar.invoice.post'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  try {
    const result = await cancelPlan({
      companyId: req.companyId,
      planId:    parseInt(req.params.planId),
      reason:    req.body?.reason,
      actorId:   userId(req),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('POST /customer-invoices/recurring-plans/:planId/cancel error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
