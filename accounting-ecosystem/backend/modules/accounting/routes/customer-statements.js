/**
 * ============================================================================
 * Customer Statements
 * ============================================================================
 * Mounted at /api/accounting/customer-statements
 *
 * An itemized, per-customer statement for a date range — opening balance,
 * every invoice/payment movement in the period, running balance, closing
 * balance due. Reuses the same outstanding-balance arithmetic as the Aged
 * Debtors report (customer-invoices.js's /aging route) for the opening
 * balance, but itemizes rather than aggregates.
 * ============================================================================
 */
const express = require('express');
const router  = express.Router();
const { supabase } = require('../../../config/database');
const AuditLogger = require('../services/auditLogger');
const { authenticate, hasPermission } = require('../middleware/auth');
const { generateStatementPdf } = require('../services/invoicePdfService');
const { sendEmail } = require('../../../shared/services/email');

function userId(req) { return req.user?.userId || req.user?.id || null; }

/**
 * Builds { customer, openingBalance, movements, closingBalance } for a
 * customer over [periodStart, periodEnd]. Movements are invoices (positive,
 * increase balance) and payments (negative, decrease balance), sorted by
 * date. Reversed payments are excluded — a reversed payment never happened
 * as far as the customer's balance is concerned.
 */
async function buildStatement(companyId, customerId, periodStart, periodEnd) {
  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, name, email, vat_number')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (custErr) throw new Error(custErr.message);
  if (!customer) return null;

  const { data: invoices, error: invErr } = await supabase
    .from('customer_invoices')
    .select('id, invoice_number, date, total_amount, status')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .not('status', 'in', '("draft","void","cancelled")');
  if (invErr) throw new Error(invErr.message);

  const { data: payments, error: payErr } = await supabase
    .from('customer_payments')
    .select('id, payment_date, amount, reference, is_reversed')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
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

  return { customer, openingBalance, movements, closingBalance: movements.length ? movements[movements.length - 1].runningBalance : openingBalance };
}

router.get('/:customerId/statement', authenticate, hasPermission('ar.invoice.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId  = req.companyId;
  const customerId = parseInt(req.params.customerId);
  const periodStart = req.query.periodStart;
  const periodEnd   = req.query.periodEnd || new Date().toISOString().slice(0, 10);

  if (!periodStart) return res.status(400).json({ error: 'periodStart is required (YYYY-MM-DD)' });

  try {
    const statement = await buildStatement(companyId, customerId, periodStart, periodEnd);
    if (!statement) return res.status(404).json({ error: 'Customer not found' });
    res.json({ periodStart, periodEnd, ...statement });
  } catch (err) {
    console.error('GET /customer-statements/:customerId/statement error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:customerId/statement/send', authenticate, hasPermission('ar.invoice.send'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId  = req.companyId;
  const customerId = parseInt(req.params.customerId);
  const periodStart = req.body?.periodStart;
  const periodEnd   = req.body?.periodEnd || new Date().toISOString().slice(0, 10);

  if (!periodStart) return res.status(400).json({ error: 'periodStart is required (YYYY-MM-DD)' });

  try {
    const statement = await buildStatement(companyId, customerId, periodStart, periodEnd);
    if (!statement) return res.status(404).json({ error: 'Customer not found' });

    const recipientEmail = (req.body?.email || statement.customer.email || '').trim();
    if (!recipientEmail) {
      return res.status(400).json({
        error: `${statement.customer.name} has no email address on file. Add one to the customer record, or provide one for this send.`,
        errorCode: 'NO_CUSTOMER_EMAIL',
      });
    }

    const { data: company, error: companyErr } = await supabase
      .from('companies')
      .select('company_name, trading_name, registration_number, vat_number, address_street, address_suburb, address_city, contact_email, contact_phone, logo_url, bank_name, bank_account_holder, bank_account_number, bank_branch_code')
      .eq('id', companyId)
      .maybeSingle();
    if (companyErr) throw new Error(companyErr.message);

    const pdfBuffer = await generateStatementPdf({
      customer: statement.customer, company: company || {},
      periodStart, periodEnd,
      openingBalance: statement.openingBalance, movements: statement.movements,
    });

    const emailResult = await sendEmail({
      to: recipientEmail,
      subject: `Statement from ${company?.trading_name || company?.company_name || 'us'} — ${periodStart} to ${periodEnd}`,
      body: `Dear ${statement.customer.name},\n\nPlease find your account statement attached.\n\nKind regards`,
      attachments: [{ filename: `Statement-${statement.customer.name}-${periodEnd}.pdf`, content: pdfBuffer }],
    });

    if (!emailResult.success) {
      return res.status(502).json({ error: emailResult.message || 'Failed to send email.' });
    }

    const { error: logErr } = await supabase.from('customer_statement_sends').insert({
      company_id: companyId, customer_id: customerId,
      period_start: periodStart, period_end: periodEnd,
      sent_to: recipientEmail, sent_by: userId(req),
      closing_balance: statement.closingBalance,
    });
    if (logErr) console.error('[CustomerStatements] Failed to log statement send (email itself succeeded):', logErr.message);

    await AuditLogger.log({
      companyId,
      actorType: 'USER', actorId: userId(req),
      actionType: 'CUSTOMER_STATEMENT_EMAILED',
      entityType: 'CUSTOMER', entityId: customerId,
      beforeJson: null,
      afterJson: { customerId, recipientEmail, periodStart, periodEnd, closingBalance: statement.closingBalance },
      reason: 'Customer statement emailed',
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    });

    res.json({ message: `Statement emailed to ${recipientEmail}`, closingBalance: statement.closingBalance });
  } catch (err) {
    console.error('POST /customer-statements/:customerId/statement/send error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
