/**
 * ============================================================================
 * Supplier Statements
 * ============================================================================
 * Mounted at /api/accounting/supplier-statements
 *
 * Mirrors customer-statements.js — an itemized, per-supplier transaction
 * history over a date range: opening balance, every invoice/payment
 * movement in the period, running balance, closing balance due. Powers the
 * "click a supplier's outstanding amount → see their transaction history"
 * drill-down from Aged Creditors and Purchase Analysis.
 * ============================================================================
 */
const express = require('express');
const router  = express.Router();
const { supabase } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');

/**
 * Builds { supplier, openingBalance, movements, closingBalance } for a
 * supplier over [periodStart, periodEnd]. Movements are invoices (positive,
 * increase balance owed) and payments (negative, decrease balance), sorted
 * by date. Reversed payments are excluded — a reversed payment never
 * happened as far as the supplier's balance is concerned.
 */
async function buildStatement(companyId, supplierId, periodStart, periodEnd) {
  const { data: supplier, error: supErr } = await supabase
    .from('suppliers')
    .select('id, name, email, vat_number')
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (supErr) throw new Error(supErr.message);
  if (!supplier) return null;

  const { data: invoices, error: invErr } = await supabase
    .from('supplier_invoices')
    .select('id, invoice_number, date, total_amount, status')
    .eq('company_id', companyId)
    .eq('supplier_id', supplierId)
    .not('status', 'in', '("draft","cancelled")');
  if (invErr) throw new Error(invErr.message);

  const { data: payments, error: payErr } = await supabase
    .from('supplier_payments')
    .select('id, payment_date, amount, reference, is_reversed')
    .eq('company_id', companyId)
    .eq('supplier_id', supplierId)
    .neq('is_reversed', true);
  if (payErr) throw new Error(payErr.message);

  const before = (dateStr) => dateStr < periodStart;
  const inRange = (dateStr) => dateStr >= periodStart && dateStr <= periodEnd;

  let openingBalance = 0;
  for (const inv of (invoices || [])) if (before(inv.date)) openingBalance += parseFloat(inv.total_amount) || 0;
  for (const p of (payments || [])) if (before(p.payment_date)) openingBalance -= parseFloat(p.amount) || 0;
  openingBalance = Math.round(openingBalance * 100) / 100;

  const events = [];
  for (const inv of (invoices || [])) {
    if (inRange(inv.date)) events.push({ date: inv.date, type: 'invoice', reference: inv.invoice_number, amount: parseFloat(inv.total_amount) || 0 });
  }
  for (const p of (payments || [])) {
    if (inRange(p.payment_date)) events.push({ date: p.payment_date, type: 'payment', reference: p.reference || `Payment #${p.id}`, amount: -(parseFloat(p.amount) || 0) });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  let running = openingBalance;
  const movements = events.map(e => {
    running = Math.round((running + e.amount) * 100) / 100;
    return { ...e, runningBalance: running };
  });

  return { supplier, openingBalance, movements, closingBalance: movements.length ? movements[movements.length - 1].runningBalance : openingBalance };
}

router.get('/:supplierId/statement', authenticate, hasPermission('ap.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId  = req.companyId;
  const supplierId = parseInt(req.params.supplierId);
  const periodStart = req.query.periodStart;
  const periodEnd   = req.query.periodEnd || new Date().toISOString().slice(0, 10);

  if (!periodStart) return res.status(400).json({ error: 'periodStart is required (YYYY-MM-DD)' });

  try {
    const statement = await buildStatement(companyId, supplierId, periodStart, periodEnd);
    if (!statement) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ periodStart, periodEnd, ...statement });
  } catch (err) {
    console.error('GET /supplier-statements/:supplierId/statement error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
