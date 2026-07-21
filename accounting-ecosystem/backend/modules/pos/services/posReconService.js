/**
 * ============================================================================
 * POS Reconciliation Service — posReconService.js
 * ============================================================================
 * Forensic-grade till reconciliation for Checkout Charlie.
 *
 * Three exported functions:
 *   computeSessionRecon(sessionId, companyId)
 *     — Derives authoritative totals from sales, sale_payments, pos_returns.
 *       Pure read — no side effects. Safe to call multiple times.
 *
 *   detectInconsistencies(sessionId, companyId)
 *     — Scans for orphan records, impossible states, and amount mismatches.
 *       Pure read — no side effects.
 *
 *   createReconSnapshot(sessionId, companyId, generatedByUserId,
 *                       generatedByEmail, triggeredBy, cashupData)
 *     — Calls computeSessionRecon + detectInconsistencies, then writes an
 *       immutable row to pos_recon_snapshots.
 *       Wrapped in try/catch — never throws. Safe to fire-and-forget.
 *
 * All queries use the Supabase JS client (PostgREST). No raw SQL.
 * No localStorage, no sessionStorage. DB is the single source of truth.
 * ============================================================================
 */

const { supabase } = require('../../../config/database');

// ── Numeric helpers ───────────────────────────────────────────────────────────

function n(v) {
  const f = parseFloat(v);
  return isNaN(f) ? 0 : f;
}

function round2(v) {
  return Math.round(n(v) * 100) / 100;
}

// ── Core reconciliation computation ──────────────────────────────────────────

/**
 * Compute authoritative reconciliation totals for a till session.
 *
 * Sources:
 *   sales         — completed/voided totals, discount, VAT
 *   sale_payments — payment method breakdown (the only authoritative source)
 *   pos_returns   — refund amounts and methods
 *
 * Returns a plain object with all computed totals. Throws on DB error so the
 * caller can decide how to handle it.
 */
async function computeSessionRecon(sessionId, companyId) {
  const sessionIdInt = parseInt(sessionId);
  const companyIdInt = parseInt(companyId);

  // 1. Session
  const { data: session, error: sessErr } = await supabase
    .from('till_sessions')
    .select('id, company_id, till_id, user_id, status, opening_balance, closing_balance, expected_balance, variance, opened_at, closed_at, notes')
    .eq('id', sessionIdInt)
    .eq('company_id', companyIdInt)
    .single();

  if (sessErr || !session) {
    throw new Error(`Session ${sessionIdInt} not found or access denied`);
  }

  // 2. All sales for this session (completed + voided)
  const { data: sales, error: salesErr } = await supabase
    .from('sales')
    .select('id, status, total_amount, discount_amount, vat_amount, subtotal, payment_method')
    .eq('till_session_id', sessionIdInt)
    .eq('company_id', companyIdInt);

  if (salesErr) throw new Error(`Sales query failed: ${salesErr.message}`);

  const allSales = sales || [];
  const saleIds  = allSales.map(s => s.id);

  // 3. All payments for those sales (authoritative breakdown by method)
  let completedPayments = [];
  if (saleIds.length > 0) {
    const { data: payments, error: payErr } = await supabase
      .from('sale_payments')
      .select('sale_id, payment_method, amount')
      .in('sale_id', saleIds);

    if (payErr) throw new Error(`Payments query failed: ${payErr.message}`);

    const completedSaleIds = new Set(
      allSales.filter(s => s.status === 'completed').map(s => s.id)
    );
    completedPayments = (payments || []).filter(p => completedSaleIds.has(p.sale_id));
  }

  // 4. All completed returns for sales in this session
  let returns = [];
  if (saleIds.length > 0) {
    const { data: retData, error: retErr } = await supabase
      .from('pos_returns')
      .select('original_sale_id, refund_amount, refund_method, status')
      .in('original_sale_id', saleIds)
      .eq('status', 'completed');

    if (retErr) throw new Error(`Returns query failed: ${retErr.message}`);
    returns = retData || [];
  }

  // 5. Compute sale totals
  const completedSales = allSales.filter(s => s.status === 'completed');
  const voidedSales    = allSales.filter(s => s.status === 'voided');

  const saleCount    = completedSales.length;
  const grossSales   = round2(completedSales.reduce((sum, s) => sum + n(s.total_amount), 0));
  const discountTotal = round2(completedSales.reduce((sum, s) => sum + n(s.discount_amount), 0));
  const vatTotal     = round2(completedSales.reduce((sum, s) => sum + n(s.vat_amount), 0));
  const voidCount    = voidedSales.length;
  const voidTotal    = round2(voidedSales.reduce((sum, s) => sum + n(s.total_amount), 0));

  // 6. Compute payment breakdown from sale_payments
  const paymentByMethod = completedPayments.reduce((acc, p) => {
    const method = (p.payment_method || 'cash').toLowerCase();
    acc[method] = round2((acc[method] || 0) + n(p.amount));
    return acc;
  }, {});

  const paymentCash    = round2(paymentByMethod['cash']    || 0);
  const paymentCard    = round2(paymentByMethod['card']    || 0);
  const paymentEft     = round2(paymentByMethod['eft']     || 0);
  const paymentAccount = round2(paymentByMethod['account'] || 0);
  // Sum remaining methods into 'other'
  const knownMethods   = new Set(['cash', 'card', 'eft', 'account']);
  const paymentOther   = round2(
    Object.entries(paymentByMethod)
      .filter(([m]) => !knownMethods.has(m))
      .reduce((sum, [, v]) => sum + v, 0)
  );

  // 7. Compute refund breakdown from pos_returns
  const refundByMethod = returns.reduce((acc, r) => {
    const method = (r.refund_method || 'cash').toLowerCase();
    acc[method] = round2((acc[method] || 0) + n(r.refund_amount));
    return acc;
  }, {});

  const refundCount = returns.length;
  const refundTotal = round2(returns.reduce((sum, r) => sum + n(r.refund_amount), 0));
  const refundCash  = round2(refundByMethod['cash'] || 0);
  const refundCard  = round2(refundByMethod['card'] || 0);

  // 8. Derived totals
  const openingBalance        = round2(session.opening_balance);
  const netSales              = round2(grossSales - refundTotal);
  // Forensically correct cash expectation: only cash payments count toward the
  // physical drawer. Card/EFT/account are settled elsewhere.
  const expectedCashInDrawer  = round2(openingBalance + paymentCash - refundCash);

  return {
    session,
    // Sale totals
    saleCount,
    grossSales,
    discountTotal,
    vatTotal,
    voidCount,
    voidTotal,
    // Payment breakdown (from sale_payments — authoritative)
    paymentCash,
    paymentCard,
    paymentEft,
    paymentAccount,
    paymentOther,
    paymentByMethod,   // full map for JSONB storage
    // Refund totals
    refundCount,
    refundTotal,
    refundCash,
    refundCard,
    refundByMethod,    // full map for JSONB storage
    // Derived
    openingBalance,
    netSales,
    expectedCashInDrawer,
  };
}

// ── Consistency checks ────────────────────────────────────────────────────────

/**
 * Detect anomalies in the sales data for a till session.
 *
 * Checks run (all scoped to this session's sales):
 *   1. Completed sales with no payment records
 *   2. Payment total mismatch (SUM of payments != sale.total_amount, >1¢ tolerance)
 *   3. Negative-total completed sales
 *   4. Duplicate payment rows (same sale_id + method + amount > once)
 *   5. Returns linked to voided sales (logically impossible)
 *
 * Returns an array of issue objects. Empty array = no issues detected.
 * Never throws — errors are returned as an issue of type 'check_error'.
 */
async function detectInconsistencies(sessionId, companyId) {
  const issues = [];

  try {
    const sessionIdInt = parseInt(sessionId);
    const companyIdInt = parseInt(companyId);

    // Fetch completed sales + their payments in one pass
    const { data: sales, error: salesErr } = await supabase
      .from('sales')
      .select('id, status, total_amount')
      .eq('till_session_id', sessionIdInt)
      .eq('company_id', companyIdInt);

    if (salesErr) {
      issues.push({ type: 'check_error', detail: `Sales query failed: ${salesErr.message}` });
      return issues;
    }

    const allSales = sales || [];
    const saleIds  = allSales.map(s => s.id);

    if (saleIds.length === 0) return issues;  // Empty session — no checks needed

    const { data: payments, error: payErr } = await supabase
      .from('sale_payments')
      .select('sale_id, payment_method, amount')
      .in('sale_id', saleIds);

    if (payErr) {
      issues.push({ type: 'check_error', detail: `Payments query failed: ${payErr.message}` });
      return issues;  // Cannot run payment checks without payment data — avoids false positives
    }

    const allPayments = payments || [];

    // Group payments by sale_id
    const paymentsBySale = allPayments.reduce((acc, p) => {
      if (!acc[p.sale_id]) acc[p.sale_id] = [];
      acc[p.sale_id].push(p);
      return acc;
    }, {});

    // Check 1 & 2 & 3 — per completed sale
    const completedSales = allSales.filter(s => s.status === 'completed');
    for (const sale of completedSales) {
      const salePayments = paymentsBySale[sale.id] || [];

      // Check 1: No payments at all
      if (salePayments.length === 0) {
        issues.push({
          type:    'sale_no_payments',
          sale_id: sale.id,
          detail:  `Completed sale ${sale.id} has no payment records in sale_payments`,
        });
        continue;  // Skip mismatch check — no data to compare
      }

      // Check 2: Payment total mismatch
      const paidTotal = round2(salePayments.reduce((sum, p) => sum + n(p.amount), 0));
      const saleTotal = round2(n(sale.total_amount));
      if (Math.abs(paidTotal - saleTotal) > 0.01) {
        issues.push({
          type:        'payment_total_mismatch',
          sale_id:     sale.id,
          sale_total:  saleTotal,
          paid_total:  paidTotal,
          difference:  round2(paidTotal - saleTotal),
          detail:      `Sale ${sale.id}: total_amount=${saleTotal}, SUM(payments)=${paidTotal}`,
        });
      }

      // Check 3: Negative sale total
      if (saleTotal <= 0) {
        issues.push({
          type:        'negative_sale_total',
          sale_id:     sale.id,
          total_amount: saleTotal,
          detail:      `Completed sale ${sale.id} has non-positive total_amount: ${saleTotal}`,
        });
      }
    }

    // Check 4: Duplicate payment rows (same sale_id + method + amount)
    const paymentSignatures = {};
    for (const p of allPayments) {
      const key = `${p.sale_id}:${p.payment_method}:${n(p.amount).toFixed(2)}`;
      paymentSignatures[key] = (paymentSignatures[key] || 0) + 1;
    }
    for (const [key, count] of Object.entries(paymentSignatures)) {
      if (count > 1) {
        const [saleId, method, amount] = key.split(':');
        issues.push({
          type:           'duplicate_payment',
          sale_id:        parseInt(saleId),
          payment_method: method,
          amount:         parseFloat(amount),
          count,
          detail:         `Payment row duplicated ${count}x: sale ${saleId}, ${method}, ${amount}`,
        });
      }
    }

    // Check 5: Returns linked to voided sales
    const voidedSaleIds = new Set(allSales.filter(s => s.status === 'voided').map(s => s.id));
    if (voidedSaleIds.size > 0) {
      const { data: badReturns, error: retErr } = await supabase
        .from('pos_returns')
        .select('id, original_sale_id, refund_amount')
        .in('original_sale_id', [...voidedSaleIds]);

      if (retErr) {
        issues.push({ type: 'check_error', detail: `Returns query failed: ${retErr.message}` });
      } else {
        for (const r of (badReturns || [])) {
          issues.push({
            type:             'return_on_voided_sale',
            return_id:        r.id,
            original_sale_id: r.original_sale_id,
            refund_amount:    n(r.refund_amount),
            detail:           `Return ${r.id} references voided sale ${r.original_sale_id}`,
          });
        }
      }
    }
  } catch (err) {
    issues.push({ type: 'check_error', detail: `Consistency check exception: ${err.message}` });
  }

  return issues;
}

// ── Immutable snapshot creation ───────────────────────────────────────────────

/**
 * Create an immutable reconciliation snapshot for a till session.
 *
 * @param {number|string} sessionId
 * @param {number|string} companyId
 * @param {number|null}   generatedByUserId
 * @param {string|null}   generatedByEmail
 * @param {string}        triggeredBy   — 'cashup' | 'manual'
 * @param {object}        cashupData    — { counted_cash, counted_card, counted_other, total_counted, variance }
 *
 * Wrapped in try/catch. Never throws. Returns the created snapshot row or null on failure.
 * Safe to call without await (fire-and-forget).
 */
async function createReconSnapshot(
  sessionId,
  companyId,
  generatedByUserId,
  generatedByEmail,
  triggeredBy = 'cashup',
  cashupData  = {}
) {
  try {
    const recon  = await computeSessionRecon(sessionId, companyId);
    const issues = await detectInconsistencies(sessionId, companyId);

    const session = recon.session;

    // Cash variance: counted CASH vs forensically correct cash expectation.
    // Deliberately counted_cash, not total_counted — total_counted folds in
    // counted_card/counted_other, which would compare an all-methods figure
    // against a cash-only expectation (the same mismatch this whole service
    // exists to correct). Falls back to a caller-supplied variance (e.g. the
    // manual re-snapshot trigger in reconciliation.js, which only has the
    // session's already-computed variance, not a fresh counted_cash) so a
    // re-snapshot never fabricates a number that was never actually counted.
    const totalCounted  = n(cashupData.total_counted);
    const cashVariance  = cashupData.counted_cash != null
      ? round2(n(cashupData.counted_cash) - recon.expectedCashInDrawer)
      : (cashupData.variance != null ? round2(cashupData.variance) : null);

    const { data, error } = await supabase
      .from('pos_recon_snapshots')
      .insert({
        till_session_id:        parseInt(sessionId),
        company_id:             parseInt(companyId),
        till_id:                session.till_id || null,

        cashier_user_id:        session.user_id || null,
        cashier_email:          null,   // not stored on till_sessions — filled by caller if needed
        generated_by_user_id:   generatedByUserId  || null,
        generated_by_email:     generatedByEmail   || null,
        triggered_by:           triggeredBy,

        session_opened_at:      session.opened_at,
        session_closed_at:      session.closed_at,
        session_status:         session.status,

        opening_balance:        recon.openingBalance,

        sale_count:             recon.saleCount,
        gross_sales:            recon.grossSales,
        discount_total:         recon.discountTotal,
        vat_total:              recon.vatTotal,
        void_count:             recon.voidCount,
        void_total:             recon.voidTotal,

        payment_cash:           recon.paymentCash,
        payment_card:           recon.paymentCard,
        payment_eft:            recon.paymentEft,
        payment_account:        recon.paymentAccount,
        payment_other:          recon.paymentOther,

        refund_count:           recon.refundCount,
        refund_total:           recon.refundTotal,
        refund_cash:            recon.refundCash,
        refund_card:            recon.refundCard,

        net_sales:              recon.netSales,
        expected_cash_in_drawer: recon.expectedCashInDrawer,

        counted_cash:           cashupData.counted_cash  != null ? n(cashupData.counted_cash)  : null,
        counted_card:           cashupData.counted_card  != null ? n(cashupData.counted_card)  : null,
        counted_other:          cashupData.counted_other != null ? n(cashupData.counted_other) : null,
        total_counted:          cashupData.total_counted != null ? totalCounted                : null,
        cash_variance:          cashVariance,

        payment_breakdown:      recon.paymentByMethod,
        refund_breakdown:       recon.refundByMethod,

        is_consistent:          issues.length === 0,
        consistency_issues:     issues.length > 0 ? issues : null,
      })
      .select()
      .single();

    if (error) {
      console.error('[posReconService] Snapshot insert error:', error.message, '| session:', sessionId);
      return null;
    }

    console.log('[posReconService] Snapshot created:', data.id, '| session:', sessionId,
      issues.length > 0 ? `| ISSUES: ${issues.length}` : '| clean');
    return data;
  } catch (err) {
    console.error('[posReconService] Snapshot exception (non-fatal):', err.message, '| session:', sessionId);
    return null;
  }
}

module.exports = { computeSessionRecon, detectInconsistencies, createReconSnapshot };
