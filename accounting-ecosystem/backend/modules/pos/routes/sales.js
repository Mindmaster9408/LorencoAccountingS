/**
 * ============================================================================
 * POS Sales Routes - Checkout Charlie Module
 * ============================================================================
 * Sales processing, void handling, and payment recording.
 *
 * Key design decisions:
 *   - Frontend sends items as [{ productId, quantity }] — backend looks up
 *     unit_price and product_name from the products table so prices cannot
 *     be spoofed from the client.
 *   - Stock is pre-checked before the sale is created; insufficient stock
 *     returns 422 with which items are short.
 *   - sale_number is auto-generated (required NOT NULL UNIQUE in schema).
 *   - Both user_id and cashier_id are written so the column exists regardless
 *     of whether the DB already had cashier_id (added by pos-schema.js).
 *   - sale_items uses only columns defined in the schema.
 * ============================================================================
 */

const express = require('express');
const { randomUUID } = require('crypto');
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');
const { posAuditFromReq, POS_EVENTS } = require('../services/posAuditLogger');
const { getStockPolicy } = require('../services/stockPolicyCache');
const { hasPermission } = require('../../../config/permissions');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a unique sale number: SAL-<timestamp>-<4 random chars> */
function generateSaleNumber() {
  const rand = Math.random().toString(36).substr(2, 4).toUpperCase();
  return `SAL-${Date.now()}-${rand}`;
}

/**
 * Apply a signed delta to a customer's live balance + append one ledger row.
 * Shared core for every customer-account write (charge, reversal, and —
 * potential future callers — manual adjustments) so the CAS balance-update
 * pattern exists in exactly one place.
 *
 * BUG FIX (found live, Workstream 90): create_sale_atomic (the opaque RPC —
 * source not in this repo, never modified) does NOT post anything to
 * customer_account_transactions or customers.current_balance for an ACCOUNT
 * sale — confirmed empirically. This function is the fix: called immediately
 * after the RPC succeeds, before the HTTP response is sent.
 *
 * True same-transaction atomicity with create_sale_atomic isn't achievable
 * without changing that RPC (out of scope). The balance update instead uses
 * compare-and-swap (read, then UPDATE ... WHERE current_balance = <value
 * read>) with a bounded retry loop — the same pattern established for stock
 * in stockCAS.js — so a concurrent charge/payment/reversal against the same
 * customer cannot silently overwrite another. If every retry loses the
 * race, or the write fails outright, this returns { ok:false } rather than
 * throwing — callers must not roll back an already-completed sale/void for
 * a ledger-side failure; they log a CRITICAL audit event instead so the gap
 * is loudly discoverable, never silent.
 *
 * idempotencyGuard (optional): a set of exact-match column/value pairs
 * (e.g. { sale_id, type } for a full-sale reversal, keyed on the whole sale
 * — Workstream 91; or { reference } for a partial-return reversal, keyed on
 * the specific pos_returns row — Workstream 93, since a single sale can
 * have many returns and each needs its own independent reversal row). If a
 * ledger row already matches every provided pair, it is returned unchanged
 * (wasDuplicate: true) instead of applying the delta again.
 *
 * @returns {Promise<{ok:true, transaction, newBalance, wasDuplicate?:boolean}|{ok:false, error}>}
 */
async function adjustCustomerAccountLedger({ companyId, customerId, saleId, amount, type, reference, notes, userId, idempotencyGuard }) {
  if (idempotencyGuard) {
    let guardQuery = supabase.from('customer_account_transactions').select('*').eq('company_id', companyId);
    for (const [col, val] of Object.entries(idempotencyGuard)) guardQuery = guardQuery.eq(col, val);
    const { data: existing } = await guardQuery.maybeSingle();
    if (existing) return { ok: true, transaction: existing, newBalance: existing.balance_after, wasDuplicate: true };
  }

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { data: customer, error: custErr } = await supabase
      .from('customers').select('id, current_balance')
      .eq('id', customerId).eq('company_id', companyId).eq('is_active', true).single();
    if (custErr || !customer) return { ok: false, error: custErr ? custErr.message : 'Customer not found' };

    const oldBalance = parseFloat(customer.current_balance || 0);
    const newBalance = Math.round((oldBalance + amount) * 100) / 100;

    const { data: updated, error: updErr } = await supabase
      .from('customers')
      .update({ current_balance: newBalance, updated_at: new Date().toISOString() })
      .eq('id', customerId).eq('company_id', companyId).eq('current_balance', oldBalance)
      .select().maybeSingle();
    if (updErr) return { ok: false, error: updErr.message };
    if (!updated) continue; // lost the race — another write changed current_balance; retry

    const { data: tx, error: txErr } = await supabase
      .from('customer_account_transactions')
      .insert({
        company_id: companyId, customer_id: customerId, sale_id: saleId, type,
        amount, balance_after: newBalance, reference,
        notes, created_by: userId,
      })
      .select().single();
    if (txErr) return { ok: false, error: txErr.message };

    return { ok: true, transaction: tx, newBalance };
  }
  return { ok: false, error: `Balance update lost the compare-and-swap race ${MAX_ATTEMPTS} times in a row` };
}

/** Thin wrapper — posts a 'charge' row for a new account-tender sale. */
async function postAccountCharge({ companyId, customerId, saleId, saleNumber, amount, userId }) {
  return adjustCustomerAccountLedger({
    companyId, customerId, saleId, amount, type: 'charge',
    reference: saleNumber, notes: 'Account sale charge', userId,
  });
}

/**
 * Reverse a previously-posted account charge when its sale is voided
 * (Workstream 91). Never edits the original 'charge' row — appends an
 * offsetting 'charge_reversal' row instead, so financial history is never
 * rewritten, only added to. idempotencyGuard on { saleId, type:
 * 'charge_reversal' } means voiding an already-voided sale, or retrying the
 * same void request, can never reverse the same charge twice — the second
 * call finds the reversal row already there and returns it unchanged.
 */
async function reverseAccountCharge({ companyId, customerId, saleId, saleNumber, amount, reason, userId }) {
  return adjustCustomerAccountLedger({
    companyId, customerId, saleId, amount: -amount, type: 'charge_reversal',
    reference: `Reversal of charge for voided sale ${saleNumber}`,
    notes: reason || 'Account sale voided',
    userId,
    idempotencyGuard: { sale_id: saleId, type: 'charge_reversal' },
  });
}

/**
 * Reverse the account-funded portion of a partial (or full-value) return
 * against an account-tender sale (Workstream 93). Unlike a full-sale void
 * reversal, a single sale can have MANY returns over time (Scenario C: 1000
 * -> return 200 -> return 300 -> balance 500) — so this is keyed on the
 * specific pos_returns row via `reference`, not on the sale as a whole, and
 * a second call for the SAME return (retry, or an accidental duplicate
 * request) finds that exact reversal already posted and returns it
 * unchanged rather than reversing the same return twice.
 *
 * amount here must already be the ACCOUNT-funded share of the refund, not
 * the full refund amount — split-payment allocation happens in the caller
 * (POST /:id/return), proportional to that sale's cash-vs-account tender
 * mix, so a cash-funded return never touches the customer's balance.
 */
async function reverseAccountChargeForReturn({ companyId, customerId, saleId, returnId, saleNumber, amount, reason, userId }) {
  return adjustCustomerAccountLedger({
    companyId, customerId, saleId, amount: -amount, type: 'return_reversal',
    reference: `RETURN-${returnId}`,
    notes: reason || `Partial return against sale ${saleNumber}`,
    userId,
    idempotencyGuard: { reference: `RETURN-${returnId}` },
  });
}

/** Normalise camelCase or snake_case field names from the request body. */
function normaliseSaleBody(body) {
  // CRITICAL FIX (found live, Workstream 96): the real POS checkout UI sends
  // payment method names in UPPERCASE ('CASH', 'CARD', 'ACCOUNT', 'EFT',
  // 'SNAPSCAN', 'ZAPPER' — see selectPayment() button onclick handlers in
  // frontend-pos/index.html), but every account-charge detection check in
  // this file, and reports.js's ACCOUNT_PAYMENT_METHOD constant, compare
  // against lowercase 'account'. 'ACCOUNT' === 'account' is false in
  // JavaScript, so a real cashier selecting Account payment in the browser
  // has never posted a ledger charge or balance update — the Workstream
  // 90/91/93 fixes are correct but were only ever live-verified via direct
  // API calls using lowercase, never through the actual checkout screen.
  // Normalised once, here, at the single choke point both the regular sale
  // route and the /orders route parse their body through — the safe,
  // defensive place, since client-supplied casing should never be trusted.
  const rawMethod = body.payment_method ?? body.paymentMethod ?? 'cash';
  const rawPayments = body.payments ?? null;
  return {
    items:           body.items || [],
    // Accept either camelCase (frontend) or snake_case
    till_session_id: body.till_session_id ?? body.tillSessionId ?? null,
    customer_id:     body.customer_id     ?? body.customerId     ?? null,
    discount_amount: body.discount_amount ?? body.discountAmount ?? 0,
    discount_percent:body.discount_percent?? body.discountPercent?? 0,
    notes:           body.notes           ?? null,
    // Frontend sends a single string paymentMethod; also accept payments array
    payment_method:  typeof rawMethod === 'string' ? rawMethod.toLowerCase() : rawMethod,
    payments:        Array.isArray(rawPayments)
      ? rawPayments.map(p => ({
          ...p,
          payment_method: typeof (p.payment_method ?? p.method) === 'string'
            ? (p.payment_method ?? p.method).toLowerCase()
            : (p.payment_method ?? p.method),
        }))
      : rawPayments,
    // Accept camelCase (frontend) or snake_case; fallback generated server-side
    idempotency_key: body.idempotency_key ?? body.idempotencyKey ?? null,
    // 'offline_sync' when sent by syncOfflineSales(); 'online' for real-time checkout
    source:          body.source || 'online',
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/pos/sales
 */
router.get('/', requirePermission('SALES.VIEW'), async (req, res) => {
  try {
    const { from, to, status, cashier_id, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('sales')
      .select('*, sale_items(*), sale_payments(*)', { count: 'exact' })
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (from)        query = query.gte('created_at', from);
    if (to)          query = query.lte('created_at', to);
    if (status)      query = query.eq('status', status);
    if (cashier_id)  query = query.eq('cashier_id', cashier_id);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({
      sales:      data || [],
      total:      count,
      page:       parseInt(page),
      totalPages: Math.ceil((count || 0) / parseInt(limit))
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/pos/sales/:id
 */
router.get('/:id', requirePermission('SALES.VIEW'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sales')
      .select('*, sale_items(*, products(product_name, barcode)), sale_payments(*)')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Sale not found' });
    res.json({ sale: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sales
 * Create a new sale.
 *
 * Request body:
 *   items           — array of { productId, quantity } (camelCase from frontend)
 *                     OR { product_id, quantity, unit_price } (snake_case)
 *   paymentMethod   — 'cash' | 'card' | 'account' (single method)
 *   payments        — array of { payment_method, amount } (split payment)
 *   tillSessionId   — open session ID (camelCase from frontend)
 *   customerId      — optional customer FK
 *   discount_amount — flat discount
 *   discount_percent— % discount
 *   notes           — optional notes
 */
router.post('/', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const {
      items,
      till_session_id,
      customer_id,
      discount_amount: discountAmt,
      discount_percent,
      notes,
      payment_method,
      payments: paymentsFromBody,
      idempotency_key: clientIdempotencyKey,
      source,
    } = normaliseSaleBody(req.body);

    // Use client-supplied key (online checkout or offline sync replay) or
    // generate a server-side key so every sale is idempotency-protected.
    const idempotencyKey = clientIdempotencyKey || randomUUID();

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    // ── 1. Collect product IDs and look up prices from DB ─────────────────
    // Normalise camelCase productId → product_id
    const normItems = items.map(item => ({
      product_id: item.product_id ?? item.productId,
      quantity:   item.quantity,
    }));

    const productIds = [...new Set(normItems.map(i => i.product_id).filter(Boolean))];
    if (productIds.length === 0) {
      return res.status(400).json({ error: 'Items must include valid product IDs' });
    }

    const { data: productRows, error: prodErr } = await supabase
      .from('products')
      .select('id, product_name, unit_price, vat_rate, requires_vat, stock_quantity')
      .in('id', productIds)
      .eq('company_id', req.companyId)
      .eq('is_active', true);

    if (prodErr) return res.status(500).json({ error: prodErr.message });

    const productMap = {};
    for (const p of (productRows || [])) productMap[p.id] = p;

    // ── 2a. Company stock policy — 60-second server-side cache ──────────────
    // DB remains authoritative; cache refreshes on every TTL expiry or miss.
    const allowNegativeStock = await getStockPolicy(req.companyId, supabase);

    // ── 2b. Stock pre-check ────────────────────────────────────────────────
    // Strict mode (allowNegativeStock = false): any insufficient item → 422.
    // Negative-stock mode (allowNegativeStock = true): insufficient items are
    // audited as warnings but the sale continues. The RPC enforces the same
    // flag atomically so the application layer cannot override the DB logic.
    const stockErrors = [];
    const negativeStockItems = [];

    for (const item of normItems) {
      const prod = productMap[item.product_id];
      if (!prod) {
        stockErrors.push(`Product ${item.product_id} not found`);
      } else if (prod.stock_quantity < item.quantity) {
        if (!allowNegativeStock) {
          stockErrors.push(
            `Insufficient stock for "${prod.product_name}": have ${prod.stock_quantity}, need ${item.quantity}`
          );
        } else {
          // Will go negative — track for audit; sale is allowed.
          negativeStockItems.push({
            product_id:   prod.id,
            product_name: prod.product_name,
            current_stock: prod.stock_quantity,
            requested:    item.quantity,
            will_reach:   prod.stock_quantity - item.quantity,
          });
        }
      }
    }

    if (stockErrors.length > 0) {
      posAuditFromReq(req, POS_EVENTS.SALE_STOCK_FAILED, {
        tillSessionId: till_session_id,
        source,
        metadata: { stock_errors: stockErrors, item_count: normItems.length },
      });
      return res.status(422).json({ error: 'Stock check failed', details: stockErrors });
    }

    // Log each item that will drive stock negative before proceeding.
    for (const neg of negativeStockItems) {
      posAuditFromReq(req, POS_EVENTS.NEGATIVE_STOCK_SALE_ALLOWED, {
        productId:     neg.product_id,
        tillSessionId: till_session_id,
        source,
        metadata: {
          product_name:  neg.product_name,
          current_stock: neg.current_stock,
          quantity_sold: neg.requested,
          projected_stock: neg.will_reach,
        },
      });
    }

    // ── 3. Calculate totals using DB prices (cannot be spoofed) ──────────
    let subtotal  = 0;
    let vat_total = 0;

    const enrichedItems = normItems.map(item => {
      const prod      = productMap[item.product_id];
      const linePrice = prod.unit_price * item.quantity;
      subtotal += linePrice;
      if (prod.requires_vat && prod.vat_rate) {
        // VAT is inclusive in unit_price — extract it
        vat_total += linePrice * (prod.vat_rate / (100 + prod.vat_rate));
      }
      return { ...item, product: prod, line_total: linePrice };
    });

    const discount = discountAmt || (discount_percent ? subtotal * discount_percent / 100 : 0);
    const total_amount = Math.max(0, subtotal - discount);

    // ── 3b. Validate split payment total if provided ──────────────────────
    if (paymentsFromBody && paymentsFromBody.length > 0) {
      const paymentsTotal = paymentsFromBody.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
      if (paymentsTotal < total_amount - 0.01) {   // 1-cent tolerance for rounding
        return res.status(400).json({
          error:    'Payment total is less than the sale total',
          required: total_amount,
          received: paymentsTotal,
        });
      }
    }

    const saleNumber   = generateSaleNumber();
    const receiptNumber = saleNumber.replace('SAL-', 'RC-');

    // ── 4. Build payments array for RPC ──────────────────────────────────
    let payments;
    if (paymentsFromBody && paymentsFromBody.length > 0) {
      payments = paymentsFromBody.map(p => ({
        payment_method: p.payment_method || p.method || 'cash',
        amount:         p.amount,
        reference:      p.reference || null,
      }));
    } else {
      payments = [{
        payment_method: payment_method || 'cash',
        amount:         total_amount,
        reference:      null,
      }];
    }

    // ── 5. Atomic sale creation via Supabase RPC ──────────────────────────
    // create_sale_atomic runs INSERT sales + INSERT sale_items +
    // INSERT sale_payments + PERFORM decrement_stock_v2 in one plpgsql
    // transaction. Any failure (including P0001 on insufficient stock)
    // rolls back all writes. No orphaned sale records possible.
    const { data: rpcResult, error: rpcError } = await supabase.rpc('create_sale_atomic', {
      p_company_id:           req.companyId,
      p_user_id:              req.user.userId,
      p_sale_number:          saleNumber,
      p_receipt_number:       receiptNumber,
      p_till_session_id:      till_session_id || null,
      p_customer_id:          customer_id || null,
      p_payment_method:       payment_method || 'cash',
      p_notes:                notes || null,
      p_subtotal:             subtotal,
      p_discount_amount:      discount,
      p_vat_amount:           vat_total,
      p_total_amount:         total_amount,
      p_idempotency_key:      idempotencyKey,
      p_allow_negative_stock: allowNegativeStock,
      p_items:    enrichedItems.map(item => ({
        product_id:      item.product_id,
        product_name:    item.product.product_name,
        quantity:        item.quantity,
        unit_price:      item.product.unit_price,
        vat_rate:        item.product.vat_rate || 15,
        line_total:      item.line_total,
        discount_amount: 0,
      })),
      p_payments: payments,
    });

    if (rpcError) {
      const msg = (rpcError.message || '').toLowerCase();
      if (msg.includes('insufficient stock')) {
        posAuditFromReq(req, POS_EVENTS.SALE_STOCK_FAILED, {
          tillSessionId: till_session_id,
          source,
          metadata: { rpc_error: rpcError.message, stage: 'atomic_rpc' },
        });
        return res.status(422).json({ error: 'Stock check failed', details: [rpcError.message] });
      }
      posAuditFromReq(req, POS_EVENTS.SALE_RPC_FAILED, {
        tillSessionId: till_session_id,
        source,
        metadata: { rpc_error: rpcError.message },
      });
      console.error('[Sales] create_sale_atomic failed:', rpcError);
      return res.status(500).json({ error: 'Sale creation failed', details: rpcError.message });
    }

    // ── 6. Audit + response ───────────────────────────────────────────────
    if (rpcResult.was_duplicate) {
      console.log('[Sales] Duplicate sale blocked by idempotency key — returning existing sale:', rpcResult.sale_id);
      posAuditFromReq(req, POS_EVENTS.SALE_REPLAYED, {
        saleId:        rpcResult.sale_id,
        tillSessionId: till_session_id,
        source,
        afterSnapshot: { sale_id: rpcResult.sale_id, sale_number: rpcResult.sale_number },
        metadata:      { idempotency_key: idempotencyKey },
      });
    }

    // Audit only for new sales; replayed duplicates already have an audit record.
    if (!rpcResult.was_duplicate) {
      await auditFromReq(req, 'CREATE', 'sale', rpcResult.sale_id, {
        module:   'pos',
        newValue: { saleNumber, total_amount, items: enrichedItems.length },
      });
      posAuditFromReq(req, POS_EVENTS.SALE_CREATED, {
        saleId:        rpcResult.sale_id,
        tillSessionId: till_session_id,
        source,
        afterSnapshot: {
          sale_id:        rpcResult.sale_id,
          sale_number:    saleNumber,
          receipt_number: receiptNumber,
          total_amount,
          item_count:     enrichedItems.length,
          payment_method: payment_method || 'cash',
        },
      });

      // Log NEGATIVE_STOCK_CREATED for each item whose stock went below zero.
      // negativeStockItems were identified in the pre-check; will_reach is the
      // projected post-sale stock level. Fire-and-forget.
      for (const neg of negativeStockItems) {
        posAuditFromReq(req, POS_EVENTS.NEGATIVE_STOCK_CREATED, {
          saleId:        rpcResult.sale_id,
          productId:     neg.product_id,
          tillSessionId: till_session_id,
          source,
          metadata: {
            product_name:  neg.product_name,
            stock_before:  neg.current_stock,
            quantity_sold: neg.requested,
            stock_after:   neg.will_reach,
            sale_number:   saleNumber,
          },
        });
      }

      // Post the account-tender portion (if any) to the customer's ledger +
      // live balance. Only the ACCOUNT-tender amount is charged — a split
      // payment with cash+account only charges the account leg. Gated on
      // !was_duplicate so a retried/replayed sale never double-charges.
      const accountAmount = Math.round(payments
        .filter(p => p.payment_method === 'account')
        .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) * 100) / 100;

      if (accountAmount > 0 && customer_id) {
        const chargeResult = await postAccountCharge({
          companyId: req.companyId, customerId: customer_id, saleId: rpcResult.sale_id,
          saleNumber, amount: accountAmount, userId: req.user.userId,
        });
        if (chargeResult.ok) {
          posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_CHARGE_POSTED, {
            saleId: rpcResult.sale_id, tillSessionId: till_session_id, source,
            afterSnapshot: { customer_id, amount: accountAmount, new_balance: chargeResult.newBalance },
            metadata: { sale_number: saleNumber, transaction_id: chargeResult.transaction.id },
          });
        } else {
          // CRITICAL: the sale already succeeded and stock already moved —
          // this must never throw and roll back a completed sale. Logged
          // loudly instead of silently, per the ticket's atomicity requirement.
          console.error('[Sales] CRITICAL: account charge posting failed after sale succeeded:', rpcResult.sale_id, chargeResult.error);
          posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_CHARGE_FAILED, {
            saleId: rpcResult.sale_id, tillSessionId: till_session_id, source,
            metadata: { sale_number: saleNumber, customer_id, amount: accountAmount, error: chargeResult.error },
          });
        }
      }
    }

    res.status(201).json({
      sale: {
        id:              rpcResult.sale_id,
        sale_number:     rpcResult.sale_number,
        receipt_number:  rpcResult.receipt_number,
        total_amount:    rpcResult.total_amount,
        subtotal,
        vat_amount:      vat_total,
        discount_amount: discount,
        payment_method,
        status:          'completed',
      },
      saleId:       rpcResult.sale_id,
      saleNumber:   rpcResult.sale_number,
      totalAmount:  rpcResult.total_amount,
      wasDuplicate: rpcResult.was_duplicate || false,
    });
  } catch (err) {
    console.error('[Sales] Create sale error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sales/orders
 * Place an ORDER — a customer buys now, collects later. Stock is reserved
 * immediately (decremented via the same create_sale_atomic RPC as a normal
 * sale, so a reserved item cannot be sold to someone else while the
 * customer waits) but the sale is NOT marked 'completed' — it sits in a new
 * 'on_order' status until POST /:id/fulfill (pickup) or
 * POST /:id/cancel-order (never collected) resolves it.
 *
 * Deliberately a SEPARATE endpoint rather than a flag on POST / (create
 * sale): the regular sale path is a heavily-audited, live-verified, correct
 * flow (Workstreams 89-93) — branching new "maybe-partial-payment,
 * maybe-different-terminal-status" logic into it risks regressing a proven
 * path. Reusing create_sale_atomic + postAccountCharge unchanged keeps all
 * the proven stock/idempotency machinery; only what happens to the
 * resulting row after the RPC returns is new.
 *
 * Body: same shape as POST / (items, till_session_id, customer_id, notes,
 * idempotency_key), plus:
 *   deposit_amount — optional, defaults to 0. 0 <= deposit_amount <= total.
 *   payment_method — how the deposit (if any) was paid ('cash'|'card'|'account').
 */
router.post('/orders', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const {
      items, till_session_id, customer_id, discount_amount: discountAmt, discount_percent,
      notes, payment_method, idempotency_key: clientIdempotencyKey, source,
    } = normaliseSaleBody(req.body);
    const depositAmount = Math.round((parseFloat(req.body.deposit_amount ?? req.body.depositAmount ?? 0) || 0) * 100) / 100;

    const idempotencyKey = clientIdempotencyKey || randomUUID();

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }
    if (depositAmount < 0) {
      return res.status(400).json({ error: 'deposit_amount cannot be negative' });
    }

    const normItems = items.map(item => ({
      product_id: item.product_id ?? item.productId,
      quantity:   item.quantity,
    }));

    const productIds = [...new Set(normItems.map(i => i.product_id).filter(Boolean))];
    if (productIds.length === 0) {
      return res.status(400).json({ error: 'Items must include valid product IDs' });
    }

    const { data: productRows, error: prodErr } = await supabase
      .from('products')
      .select('id, product_name, unit_price, vat_rate, requires_vat, stock_quantity')
      .in('id', productIds)
      .eq('company_id', req.companyId)
      .eq('is_active', true);

    if (prodErr) return res.status(500).json({ error: prodErr.message });

    const productMap = {};
    for (const p of (productRows || [])) productMap[p.id] = p;

    const allowNegativeStock = await getStockPolicy(req.companyId, supabase);

    const stockErrors = [];
    for (const item of normItems) {
      const prod = productMap[item.product_id];
      if (!prod) {
        stockErrors.push(`Product ${item.product_id} not found`);
      } else if (prod.stock_quantity < item.quantity && !allowNegativeStock) {
        stockErrors.push(`Insufficient stock for "${prod.product_name}": have ${prod.stock_quantity}, need ${item.quantity}`);
      }
    }
    if (stockErrors.length > 0) {
      return res.status(422).json({ error: 'Stock check failed', details: stockErrors });
    }

    let subtotal = 0;
    let vat_total = 0;
    const enrichedItems = normItems.map(item => {
      const prod = productMap[item.product_id];
      const linePrice = prod.unit_price * item.quantity;
      subtotal += linePrice;
      if (prod.requires_vat && prod.vat_rate) {
        vat_total += linePrice * (prod.vat_rate / (100 + prod.vat_rate));
      }
      return { ...item, product: prod, line_total: linePrice };
    });

    const discount = discountAmt || (discount_percent ? subtotal * discount_percent / 100 : 0);
    const total_amount = Math.max(0, subtotal - discount);

    if (depositAmount > total_amount + 0.01) {
      return res.status(400).json({ error: 'deposit_amount cannot exceed the order total', total_amount, depositAmount });
    }

    const saleNumber = generateSaleNumber();
    const receiptNumber = saleNumber.replace('SAL-', 'ORD-');

    // Same atomic RPC as a normal sale — reserves stock the identical way.
    // A zero-amount payment leg is passed when there's no deposit, rather
    // than omitting p_payments, since the RPC's existing fallback behaviour
    // (used by the regular sale path) is only proven for a non-empty array.
    const { data: rpcResult, error: rpcError } = await supabase.rpc('create_sale_atomic', {
      p_company_id:           req.companyId,
      p_user_id:              req.user.userId,
      p_sale_number:          saleNumber,
      p_receipt_number:       receiptNumber,
      p_till_session_id:      till_session_id || null,
      p_customer_id:          customer_id || null,
      p_payment_method:       payment_method || 'cash',
      p_notes:                notes || null,
      p_subtotal:             subtotal,
      p_discount_amount:      discount,
      p_vat_amount:           vat_total,
      p_total_amount:         total_amount,
      p_idempotency_key:      idempotencyKey,
      p_allow_negative_stock: allowNegativeStock,
      p_items: enrichedItems.map(item => ({
        product_id:      item.product_id,
        product_name:    item.product.product_name,
        quantity:        item.quantity,
        unit_price:      item.product.unit_price,
        vat_rate:        item.product.vat_rate || 15,
        line_total:      item.line_total,
        discount_amount: 0,
      })),
      p_payments: [{ payment_method: payment_method || 'cash', amount: depositAmount, reference: null }],
    });

    if (rpcError) {
      const msg = (rpcError.message || '').toLowerCase();
      if (msg.includes('insufficient stock')) {
        return res.status(422).json({ error: 'Stock check failed', details: [rpcError.message] });
      }
      console.error('[Sales] create_sale_atomic (order) failed:', rpcError);
      return res.status(500).json({ error: 'Order creation failed', details: rpcError.message });
    }

    if (rpcResult.was_duplicate) {
      const { data: existingOrder } = await supabase.from('sales').select('*, sale_items(*), sale_payments(*)').eq('id', rpcResult.sale_id).single();
      posAuditFromReq(req, POS_EVENTS.ORDER_REPLAYED, {
        saleId: rpcResult.sale_id, tillSessionId: till_session_id, source,
        metadata: { idempotency_key: idempotencyKey },
      });
      return res.status(200).json({ order: existingOrder, wasDuplicate: true });
    }

    // The RPC always creates the row as status='completed' (its own internal
    // default — its source is not in this repo and is never modified, per
    // the postAccountCharge note above). Immediately flip it to 'on_order'
    // before anything else can observe it as a finished sale.
    const paymentStatus = depositAmount <= 0 ? 'unpaid' : (depositAmount >= total_amount - 0.01 ? 'completed' : 'partial');
    const { data: orderRow, error: statusErr } = await supabase
      .from('sales')
      .update({ status: 'on_order', payment_status: paymentStatus })
      .eq('id', rpcResult.sale_id)
      .eq('company_id', req.companyId)
      .select('*, sale_items(*), sale_payments(*)')
      .single();

    if (statusErr) {
      // CRITICAL: stock is already reserved and the row exists as
      // 'completed' — logged loudly rather than silently left wrong,
      // matching the existing postAccountCharge/reverseAccountCharge
      // failure-handling convention in this file.
      console.error('[Sales] CRITICAL: order created but status flip to on_order failed:', rpcResult.sale_id, statusErr.message);
    }

    await auditFromReq(req, 'CREATE', 'sale', rpcResult.sale_id, {
      module: 'pos',
      newValue: { saleNumber, total_amount, deposit_amount: depositAmount, status: 'on_order' },
    });
    posAuditFromReq(req, POS_EVENTS.ORDER_CREATED, {
      saleId: rpcResult.sale_id, tillSessionId: till_session_id, source,
      afterSnapshot: {
        sale_id: rpcResult.sale_id, sale_number: saleNumber, receipt_number: receiptNumber,
        total_amount, deposit_amount: depositAmount, payment_status: paymentStatus,
      },
    });

    // Deposit paid on account — charge the customer's ledger for exactly
    // the deposit amount, same function used by regular account sales.
    if (depositAmount > 0 && (payment_method || 'cash') === 'account' && customer_id) {
      const chargeResult = await postAccountCharge({
        companyId: req.companyId, customerId: customer_id, saleId: rpcResult.sale_id,
        saleNumber, amount: depositAmount, userId: req.user.userId,
      });
      if (chargeResult.ok) {
        posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_CHARGE_POSTED, {
          saleId: rpcResult.sale_id, tillSessionId: till_session_id, source,
          afterSnapshot: { customer_id, amount: depositAmount, new_balance: chargeResult.newBalance },
          metadata: { sale_number: saleNumber, transaction_id: chargeResult.transaction.id, order_deposit: true },
        });
      } else {
        console.error('[Sales] CRITICAL: order deposit account charge failed after order created:', rpcResult.sale_id, chargeResult.error);
        posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_CHARGE_FAILED, {
          saleId: rpcResult.sale_id, tillSessionId: till_session_id, source,
          metadata: { sale_number: saleNumber, customer_id, amount: depositAmount, error: chargeResult.error },
        });
      }
    }

    res.status(201).json({
      order: orderRow || {
        id: rpcResult.sale_id, sale_number: saleNumber, receipt_number: receiptNumber,
        total_amount, deposit_amount: depositAmount, status: 'on_order', payment_status: paymentStatus,
      },
      wasDuplicate: false,
    });
  } catch (err) {
    console.error('[Sales] Create order error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sales/:id/void
 * Void a sale — CRITICAL audit event.
 *
 * BUG FIX (found + closed live, Workstream 91): voiding an account sale
 * previously only flipped sales.status — the customer's ledger and live
 * balance were never touched, confirmed live in Workstream 90 (balance
 * unchanged before/after voiding a sale that had charged it). This route
 * now reverses the account-tender portion of the sale (split payments only
 * reverse their ACCOUNT leg — the cash/card legs are untouched, matching
 * the ticket's explicit split-payment rule) via reverseAccountCharge(),
 * which appends an offsetting 'charge_reversal' ledger row rather than
 * editing the original 'charge' row — financial history is only ever
 * added to, never rewritten.
 *
 * Manager-tier gate: voiding a plain cash/card sale still only requires
 * SALES.VOID (supervisor), unchanged. Voiding a sale that has a real
 * account-tender component to reverse additionally requires SALES.REFUND
 * (management) — reusing the existing permission tier rather than adding a
 * new one, since reversing money owed by a customer is exactly what that
 * tier already gates. If the caller only has SALES.VOID, the request is
 * rejected before anything is written, rather than voiding the sale and
 * silently skipping the reversal (which would recreate the exact bug this
 * workstream closes).
 *
 * Double-void / retry safety: the status update itself is CAS-guarded
 * (WHERE status = <value just read>), so two concurrent void requests can
 * never both succeed. reverseAccountCharge()'s own idempotency guard
 * (existing 'charge_reversal' row for this sale_id) is a second, independent
 * safety net — even if the CAS window is somehow crossed, or the same void
 * request is retried after a network hiccup, the reversal is applied once.
 */
router.post('/:id/void', requirePermission('SALES.VOID'), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Void reason is required' });

    const { data: old } = await supabase
      .from('sales')
      .select('*, sale_payments(*)')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!old) return res.status(404).json({ error: 'Sale not found' });
    if (old.status === 'voided') return res.status(400).json({ error: 'Sale is already voided' });

    const accountAmount = Math.round((old.sale_payments || [])
      .filter(p => p.payment_method === 'account')
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) * 100) / 100;

    // Manager-tier gate — checked BEFORE any write, so a supervisor-only
    // caller cannot partially void (sale flips to voided, reversal skipped).
    if (accountAmount > 0 && !hasPermission(req.user.role, 'SALES', 'REFUND')) {
      return res.status(403).json({
        error: 'Voiding an account sale reverses a customer\'s owed balance and requires management approval (SALES.REFUND)',
      });
    }

    // CAS-guarded status update — a concurrent second void request finds
    // zero rows updated (old.status has already changed underneath it) and
    // is told the sale is already voided, rather than both requests racing
    // into the reversal logic below.
    const { data, error } = await supabase
      .from('sales')
      .update({
        status:     'voided',
        void_reason: reason,
        voided_by:  req.user.userId,
        voided_at:  new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .eq('status', old.status)
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(400).json({ error: 'Sale is already voided' });

    await auditFromReq(req, 'VOID', 'sale', req.params.id, {
      module:   'pos',
      oldValue: { status: old.status, total_amount: old.total_amount },
      newValue: { status: 'voided', void_reason: reason },
      metadata: {
        receipt_number:  old.receipt_number,
        original_amount: old.total_amount,
        reason,
      },
    });
    posAuditFromReq(req, POS_EVENTS.SALE_VOIDED, {
      saleId:         req.params.id,
      tillSessionId:  old.till_session_id || null,
      beforeSnapshot: { status: old.status, total_amount: old.total_amount, receipt_number: old.receipt_number },
      afterSnapshot:  { status: 'voided', void_reason: reason },
      metadata:       { reason },
    });

    let reversal = null;
    if (accountAmount > 0 && old.customer_id) {
      posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_REVERSAL_MANAGER_APPROVED, {
        saleId: req.params.id,
        metadata: { customer_id: old.customer_id, amount: accountAmount, approved_by_role: req.user.role },
      });

      const reversalResult = await reverseAccountCharge({
        companyId: req.companyId, customerId: old.customer_id, saleId: parseInt(req.params.id),
        saleNumber: old.sale_number, amount: accountAmount, reason, userId: req.user.userId,
      });

      if (reversalResult.ok) {
        reversal = reversalResult.transaction;
        posAuditFromReq(req, reversalResult.wasDuplicate ? POS_EVENTS.CUSTOMER_ACCOUNT_REVERSAL_REPLAYED : POS_EVENTS.CUSTOMER_ACCOUNT_CHARGE_REVERSED, {
          saleId: req.params.id,
          afterSnapshot: { customer_id: old.customer_id, amount: accountAmount, new_balance: reversalResult.newBalance },
          metadata: { sale_number: old.sale_number, transaction_id: reversalResult.transaction.id, reason },
        });
      } else {
        // CRITICAL: the sale is already voided — this must never throw and
        // roll that back. Logged loudly, per the same rule as postAccountCharge.
        console.error('[Sales] CRITICAL: account charge reversal failed after void succeeded:', req.params.id, reversalResult.error);
        posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_REVERSAL_FAILED, {
          saleId: req.params.id,
          metadata: { sale_number: old.sale_number, customer_id: old.customer_id, amount: accountAmount, error: reversalResult.error },
        });
      }
    }

    res.json({ sale: data, reversal });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sales/:id/return
 * Process a return/refund for a completed sale.
 * Reverses stock for returned items and records in pos_returns.
 *
 * BUG FIX (found + closed live, Workstream 93): a partial (or full-value)
 * return against an account-tender sale previously never touched the
 * customer's ledger or live balance at all — confirmed live in Workstream
 * 91's investigation (`refund_method` defaulted to 'cash' regardless of the
 * original sale's payment method, and `sale.customer_id` was never read).
 * This route now reverses the ACCOUNT-FUNDED SHARE of the refund only —
 * for a split-payment sale (e.g. cash 300 + account 700), the reversal is
 * `refundAmount * (accountTenderTotal / saleTotal)`, proportional
 * allocation being the only fair rule available without per-item tender
 * tracking (which does not exist in this schema and is out of scope to
 * add — "do not redesign returns"). A 100%-account sale's returns are
 * simply `refundAmount * 1.0`, the ticket's primary worked example.
 *
 * Multiple partial returns against the same sale are each reversed
 * independently (Scenario C: 1000 -> return 200 -> return 300 -> balance
 * 500) — the idempotency key for reverseAccountChargeForReturn is the
 * specific pos_returns row, not the sale, so a second, third, Nth return
 * against one sale each get their own ledger entry, while retrying the
 * SAME return request is still blocked (see idempotency_key below).
 *
 * Manager-tier gate: mirrors Workstream 91 exactly — a return with no
 * account-funded portion (pure cash/card sale) still only requires
 * SALES.VOID (supervisor), unchanged. A return that reverses a real amount
 * off a customer's balance additionally requires SALES.REFUND (management),
 * checked before any write.
 *
 * idempotency_key (optional): protects the whole operation — retrying the
 * same request returns the original pos_returns row unchanged rather than
 * creating a second return (which would double-restore stock and
 * double-reverse the ledger).
 */
router.post('/:id/return', requirePermission('SALES.VOID'), async (req, res) => {
  try {
    const { reason, refund_method, items: returnItems, idempotency_key: idempotencyKey } = req.body;

    if (!reason) return res.status(400).json({ error: 'Return reason is required' });

    if (idempotencyKey) {
      const { data: existingReturn } = await supabase
        .from('pos_returns').select('*')
        .eq('company_id', req.companyId).eq('idempotency_key', idempotencyKey).maybeSingle();
      if (existingReturn) {
        posAuditFromReq(req, POS_EVENTS.RETURN_REPLAYED, {
          saleId: req.params.id, metadata: { return_id: existingReturn.id, idempotency_key: idempotencyKey },
        });
        return res.status(200).json({ return: existingReturn, wasDuplicate: true, reversal: null });
      }
    }

    const { data: sale } = await supabase
      .from('sales')
      .select('*, sale_items(*), sale_payments(*)')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    if (sale.status === 'voided') return res.status(400).json({ error: 'Cannot return a voided sale' });

    // Determine which items are being returned (all if not specified)
    const itemsToReturn = returnItems && returnItems.length > 0
      ? returnItems
      : sale.sale_items.map(i => ({ product_id: i.product_id, quantity: i.quantity }));

    const refundAmount = itemsToReturn.reduce((sum, ri) => {
      const orig = sale.sale_items.find(si => si.product_id === ri.product_id);
      if (!orig) return sum;
      return sum + (orig.unit_price * ri.quantity);
    }, 0);

    // Proportional account-share allocation — see fix note above.
    const saleTotal = parseFloat(sale.total_amount || 0);
    const accountTenderTotal = (sale.sale_payments || [])
      .filter(p => p.payment_method === 'account')
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const accountShareRatio = saleTotal > 0 ? (accountTenderTotal / saleTotal) : 0;
    const accountPortionOfReturn = Math.round(refundAmount * accountShareRatio * 100) / 100;

    // Manager-tier gate — checked BEFORE any write, same rule as Workstream 91's void gate.
    if (accountPortionOfReturn > 0 && !hasPermission(req.user.role, 'SALES', 'REFUND')) {
      return res.status(403).json({
        error: 'This return reverses a customer\'s owed balance and requires management approval (SALES.REFUND)',
      });
    }

    // Record in pos_returns
    const { data: ret, error: retErr } = await supabase
      .from('pos_returns')
      .insert({
        company_id:       req.companyId,
        original_sale_id: sale.id,
        refund_amount:    refundAmount,
        refund_method:    refund_method || 'cash',
        reason,
        items_json:       itemsToReturn,
        status:           'completed',
        processed_by:     req.user.userId,
        idempotency_key:  idempotencyKey || null,
      })
      .select()
      .single();

    if (retErr) {
      if (idempotencyKey && retErr.code === '23505') {
        const { data: winner } = await supabase.from('pos_returns').select('*').eq('company_id', req.companyId).eq('idempotency_key', idempotencyKey).maybeSingle();
        if (winner) return res.status(200).json({ return: winner, wasDuplicate: true, reversal: null });
      }
      return res.status(500).json({ error: retErr.message });
    }

    // Reverse stock for returned items — atomic per-item UPDATE via RPC.
    // restore_stock_for_return uses stock_quantity = stock_quantity + qty at DB level:
    // no read required, no race window under concurrent returns of the same product.
    for (const ri of itemsToReturn) {
      if (!ri.product_id || !ri.quantity) continue;
      const { error: stockErr } = await supabase.rpc('restore_stock_for_return', {
        p_product_id: ri.product_id,
        p_quantity:   ri.quantity,
        p_company_id: req.companyId,
      });
      if (stockErr) {
        // Non-fatal: pos_returns record is already committed. Log for investigation.
        console.warn('[Sales] restore_stock_for_return non-fatal error:',
          stockErr.message, '| product_id:', ri.product_id);
      }
    }

    await auditFromReq(req, 'RETURN', 'sale', sale.id, {
      module:   'pos',
      metadata: { refund_amount: refundAmount, refund_method, reason },
    });
    posAuditFromReq(req, POS_EVENTS.SALE_RETURNED, {
      saleId:         sale.id,
      tillSessionId:  sale.till_session_id || null,
      beforeSnapshot: { status: sale.status, total_amount: sale.total_amount },
      afterSnapshot:  { refund_amount: refundAmount, refund_method, items_returned: itemsToReturn.length },
      metadata:       { reason, return_id: ret.id },
    });

    let reversal = null;
    if (accountPortionOfReturn > 0 && sale.customer_id) {
      posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_RETURN_MANAGER_APPROVED, {
        saleId: sale.id,
        metadata: { customer_id: sale.customer_id, amount: accountPortionOfReturn, return_id: ret.id, approved_by_role: req.user.role },
      });

      const reversalResult = await reverseAccountChargeForReturn({
        companyId: req.companyId, customerId: sale.customer_id, saleId: sale.id, returnId: ret.id,
        saleNumber: sale.sale_number, amount: accountPortionOfReturn, reason, userId: req.user.userId,
      });

      if (reversalResult.ok) {
        reversal = reversalResult.transaction;
        posAuditFromReq(req, reversalResult.wasDuplicate ? POS_EVENTS.CUSTOMER_ACCOUNT_RETURN_REVERSAL_REPLAYED : POS_EVENTS.CUSTOMER_ACCOUNT_RETURN_REVERSED, {
          saleId: sale.id,
          afterSnapshot: { customer_id: sale.customer_id, amount: accountPortionOfReturn, new_balance: reversalResult.newBalance },
          metadata: { return_id: ret.id, transaction_id: reversalResult.transaction.id, reason },
        });
      } else {
        // CRITICAL: the return is already recorded and stock already restored —
        // this must never throw and roll that back. Logged loudly, matching
        // the same rule as postAccountCharge / reverseAccountCharge.
        console.error('[Sales] CRITICAL: return account-reversal failed after return succeeded:', ret.id, reversalResult.error);
        posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_RETURN_REVERSAL_FAILED, {
          saleId: sale.id,
          metadata: { return_id: ret.id, customer_id: sale.customer_id, amount: accountPortionOfReturn, error: reversalResult.error },
        });
      }
    }

    res.status(201).json({ return: ret, reversal });
  } catch (err) {
    console.error('[Sales] Return error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sales/:id/fulfill
 * Customer collects an order (status 'on_order') and settles whatever
 * balance is still owed.
 *
 * CAS-guarded: the status UPDATE only succeeds `WHERE status = 'on_order'`,
 * so a retried/double-tapped fulfill request finds zero rows updated on
 * the second attempt and gets a clean "not an open order" response instead
 * of double-charging the remaining balance — the same protection pattern
 * as /void's double-void guard, no separate idempotency_key needed because
 * (unlike returns) fulfillment is a one-time terminal transition per order.
 *
 * Body: { payment_method } — required only if a balance remains; ignored
 * (no-op) if the order was already paid in full at order time.
 */
router.post('/:id/fulfill', requirePermission('SALES.CREATE'), async (req, res) => {
  try {
    const { payment_method } = req.body;

    const { data: order } = await supabase
      .from('sales')
      .select('*, sale_payments(*)')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'on_order') {
      return res.status(400).json({ error: `This sale is not an open order (status: ${order.status})` });
    }

    const amountPaid = (order.sale_payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const amountOwed = Math.round((parseFloat(order.total_amount || 0) - amountPaid) * 100) / 100;

    if (amountOwed > 0.01 && !payment_method) {
      return res.status(400).json({ error: 'payment_method is required to settle the remaining balance', amount_owed: amountOwed });
    }

    let finalPayment = null;
    if (amountOwed > 0.01) {
      const { data: paymentRow, error: paymentErr } = await supabase
        .from('sale_payments')
        .insert({
          company_id: req.companyId, sale_id: order.id, payment_method,
          amount: amountOwed, status: 'completed', processed_by: req.user.userId,
          processed_at: new Date().toISOString(),
        })
        .select().single();
      if (paymentErr) return res.status(500).json({ error: paymentErr.message });
      finalPayment = paymentRow;
    }

    // CAS-guarded — see doc comment above.
    const { data: fulfilled, error: fulfillErr } = await supabase
      .from('sales')
      .update({ status: 'completed', payment_status: 'completed' })
      .eq('id', order.id)
      .eq('company_id', req.companyId)
      .eq('status', 'on_order')
      .select('*, sale_items(*), sale_payments(*)')
      .maybeSingle();

    if (fulfillErr) return res.status(500).json({ error: fulfillErr.message });
    if (!fulfilled) return res.status(400).json({ error: 'This order was already fulfilled or cancelled' });

    await auditFromReq(req, 'UPDATE', 'sale', order.id, {
      module: 'pos',
      oldValue: { status: 'on_order' },
      newValue: { status: 'completed', amount_settled: amountOwed },
    });
    posAuditFromReq(req, POS_EVENTS.ORDER_FULFILLED, {
      saleId: order.id, tillSessionId: order.till_session_id || null,
      beforeSnapshot: { status: 'on_order', amount_paid: amountPaid },
      afterSnapshot: { status: 'completed', amount_settled: amountOwed },
      metadata: { sale_number: order.sale_number },
    });

    let reversal = null;
    if (amountOwed > 0.01 && payment_method === 'account' && order.customer_id) {
      const chargeResult = await postAccountCharge({
        companyId: req.companyId, customerId: order.customer_id, saleId: order.id,
        saleNumber: order.sale_number, amount: amountOwed, userId: req.user.userId,
      });
      if (chargeResult.ok) {
        reversal = chargeResult.transaction;
        posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_CHARGE_POSTED, {
          saleId: order.id, tillSessionId: order.till_session_id || null,
          afterSnapshot: { customer_id: order.customer_id, amount: amountOwed, new_balance: chargeResult.newBalance },
          metadata: { sale_number: order.sale_number, transaction_id: chargeResult.transaction.id, order_final_settlement: true },
        });
      } else {
        console.error('[Sales] CRITICAL: order final-settlement account charge failed after fulfill succeeded:', order.id, chargeResult.error);
        posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_CHARGE_FAILED, {
          saleId: order.id, tillSessionId: order.till_session_id || null,
          metadata: { sale_number: order.sale_number, customer_id: order.customer_id, amount: amountOwed, error: chargeResult.error },
        });
      }
    }

    res.json({ sale: fulfilled, final_payment: finalPayment, reversal });
  } catch (err) {
    console.error('[Sales] Fulfill order error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sales/:id/cancel-order
 * Order never collected — restore the reserved stock and reverse any
 * deposit paid on account. Reuses the exact same building blocks as
 * /void (account-reversal, manager-tier gate) and /return (stock
 * restoration via restore_stock_for_return), rather than duplicating
 * either. Terminal status is 'voided' — the same status a regular void
 * uses — so every existing report/query that already distinguishes
 * completed vs voided sales handles a cancelled order correctly with zero
 * additional changes.
 *
 * Manager-tier gate mirrors /void exactly: only escalates to SALES.REFUND
 * when there's a real account-funded deposit to reverse.
 */
router.post('/:id/cancel-order', requirePermission('SALES.VOID'), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Cancellation reason is required' });

    const { data: order } = await supabase
      .from('sales')
      .select('*, sale_items(*), sale_payments(*)')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'on_order') {
      return res.status(400).json({ error: `This sale is not an open order (status: ${order.status})` });
    }

    const depositAccountAmount = Math.round((order.sale_payments || [])
      .filter(p => p.payment_method === 'account')
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) * 100) / 100;

    if (depositAccountAmount > 0 && !hasPermission(req.user.role, 'SALES', 'REFUND')) {
      return res.status(403).json({
        error: 'Cancelling this order reverses a customer\'s owed balance and requires management approval (SALES.REFUND)',
      });
    }

    // CAS-guarded status update — same double-cancel protection as /void.
    const { data: cancelled, error: cancelErr } = await supabase
      .from('sales')
      .update({ status: 'voided', void_reason: reason, voided_by: req.user.userId, voided_at: new Date().toISOString() })
      .eq('id', order.id)
      .eq('company_id', req.companyId)
      .eq('status', 'on_order')
      .select()
      .maybeSingle();

    if (cancelErr) return res.status(500).json({ error: cancelErr.message });
    if (!cancelled) return res.status(400).json({ error: 'This order was already fulfilled or cancelled' });

    // Restore stock for every reserved item — same RPC /return uses.
    for (const item of (order.sale_items || [])) {
      if (!item.product_id || !item.quantity) continue;
      const { error: stockErr } = await supabase.rpc('restore_stock_for_return', {
        p_product_id: item.product_id,
        p_quantity:   item.quantity,
        p_company_id: req.companyId,
      });
      if (stockErr) {
        console.warn('[Sales] restore_stock_for_return (cancel-order) non-fatal error:', stockErr.message, '| product_id:', item.product_id);
      }
    }

    await auditFromReq(req, 'VOID', 'sale', order.id, {
      module: 'pos',
      oldValue: { status: 'on_order' },
      newValue: { status: 'voided', void_reason: reason },
      metadata: { sale_number: order.sale_number, reason },
    });
    posAuditFromReq(req, POS_EVENTS.ORDER_CANCELLED, {
      saleId: order.id, tillSessionId: order.till_session_id || null,
      beforeSnapshot: { status: 'on_order' },
      afterSnapshot: { status: 'voided', void_reason: reason },
      metadata: { reason, items_restored: (order.sale_items || []).length },
    });

    let reversal = null;
    if (depositAccountAmount > 0 && order.customer_id) {
      posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_REVERSAL_MANAGER_APPROVED, {
        saleId: order.id,
        metadata: { customer_id: order.customer_id, amount: depositAccountAmount, approved_by_role: req.user.role },
      });

      const reversalResult = await reverseAccountCharge({
        companyId: req.companyId, customerId: order.customer_id, saleId: order.id,
        saleNumber: order.sale_number, amount: depositAccountAmount, reason, userId: req.user.userId,
      });

      if (reversalResult.ok) {
        reversal = reversalResult.transaction;
        posAuditFromReq(req, reversalResult.wasDuplicate ? POS_EVENTS.CUSTOMER_ACCOUNT_REVERSAL_REPLAYED : POS_EVENTS.CUSTOMER_ACCOUNT_CHARGE_REVERSED, {
          saleId: order.id,
          afterSnapshot: { customer_id: order.customer_id, amount: depositAccountAmount, new_balance: reversalResult.newBalance },
          metadata: { sale_number: order.sale_number, transaction_id: reversalResult.transaction.id, reason },
        });
      } else {
        console.error('[Sales] CRITICAL: order deposit reversal failed after cancel-order succeeded:', order.id, reversalResult.error);
        posAuditFromReq(req, POS_EVENTS.CUSTOMER_ACCOUNT_REVERSAL_FAILED, {
          saleId: order.id,
          metadata: { sale_number: order.sale_number, customer_id: order.customer_id, amount: depositAccountAmount, error: reversalResult.error },
        });
      }
    }

    res.json({ sale: cancelled, reversal });
  } catch (err) {
    console.error('[Sales] Cancel order error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
