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
const { supabase } = require('../../../config/database');
const { authenticateToken, requireCompany, requirePermission } = require('../../../middleware/auth');
const { auditFromReq } = require('../../../middleware/audit');

const router = express.Router();

router.use(authenticateToken);
router.use(requireCompany);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a unique sale number: SAL-<timestamp>-<4 random chars> */
function generateSaleNumber() {
  const rand = Math.random().toString(36).substr(2, 4).toUpperCase();
  return `SAL-${Date.now()}-${rand}`;
}

/** Normalise camelCase or snake_case field names from the request body. */
function normaliseSaleBody(body) {
  return {
    items:           body.items || [],
    // Accept either camelCase (frontend) or snake_case
    till_session_id: body.till_session_id ?? body.tillSessionId ?? null,
    customer_id:     body.customer_id     ?? body.customerId     ?? null,
    discount_amount: body.discount_amount ?? body.discountAmount ?? 0,
    discount_percent:body.discount_percent?? body.discountPercent?? 0,
    notes:           body.notes           ?? null,
    // Frontend sends a single string paymentMethod; also accept payments array
    payment_method:  body.payment_method  ?? body.paymentMethod  ?? 'cash',
    payments:        body.payments        ?? null,
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
    } = normaliseSaleBody(req.body);

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

    // ── 2. Stock pre-check — reject if any item is insufficient ──────────
    const stockErrors = [];
    for (const item of normItems) {
      const prod = productMap[item.product_id];
      if (!prod) {
        stockErrors.push(`Product ${item.product_id} not found`);
      } else if (prod.stock_quantity < item.quantity) {
        stockErrors.push(
          `Insufficient stock for "${prod.product_name}": have ${prod.stock_quantity}, need ${item.quantity}`
        );
      }
    }
    if (stockErrors.length > 0) {
      return res.status(422).json({ error: 'Stock check failed', details: stockErrors });
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

    // ── 4. Create the sale record ─────────────────────────────────────────
    const saleNumber   = generateSaleNumber();
    const receiptNumber = saleNumber.replace('SAL-', 'RC-');

    const { data: sale, error: saleError } = await supabase
      .from('sales')
      .insert({
        company_id:      req.companyId,
        sale_number:     saleNumber,
        receipt_number:  receiptNumber,
        user_id:         req.user.userId,
        cashier_id:      req.user.userId,    // denormalised alias (added by migration)
        customer_id:     customer_id || null,
        till_session_id: till_session_id || null,
        subtotal,
        discount_amount: discount,
        vat_amount:      vat_total,
        total_amount,
        payment_method:  payment_method || 'cash',
        payment_status:  'completed',
        status:          'completed',
        notes:           notes || null,
      })
      .select()
      .single();

    if (saleError) return res.status(500).json({ error: saleError.message });

    // ── 5. Insert sale items (only schema columns) ────────────────────────
    const saleItems = enrichedItems.map(item => ({
      company_id:   req.companyId,
      sale_id:      sale.id,
      product_id:   item.product_id,
      product_name: item.product.product_name,  // denormalised (added by migration)
      quantity:     item.quantity,
      unit_price:   item.product.unit_price,
      discount_amount: 0,
      vat_rate:     item.product.vat_rate || 15,
      line_total:   item.line_total,
      total_price:  item.line_total,
    }));

    const { error: itemsError } = await supabase.from('sale_items').insert(saleItems);
    if (itemsError) {
      console.error('[Sales] Error inserting sale items:', itemsError.message);
      // Sale is created — log but do not fail the whole request.
      // The stock decrement below is still attempted.
    }

    // ── 6. Insert payment records ─────────────────────────────────────────
    let payments;
    if (paymentsFromBody && paymentsFromBody.length > 0) {
      // Explicit split-payment array
      payments = paymentsFromBody.map(p => ({
        company_id:     req.companyId,
        sale_id:        sale.id,
        payment_method: p.payment_method || p.method || 'cash',
        amount:         p.amount,
        reference:      p.reference || null,
      }));
    } else {
      // Single payment method
      payments = [{
        company_id:     req.companyId,
        sale_id:        sale.id,
        payment_method: payment_method || 'cash',
        amount:         total_amount,
      }];
    }

    const { error: payError } = await supabase.from('sale_payments').insert(payments);
    if (payError) console.error('[Sales] Error inserting payments:', payError.message);

    // ── 7. Decrement stock (company-scoped, with fallback) ────────────────
    for (const item of enrichedItems) {
      const { error: rpcErr } = await supabase.rpc('decrement_stock', {
        p_product_id: item.product_id,
        p_quantity:   item.quantity,
      });

      if (rpcErr) {
        // RPC not available — manual decrement (still company-scoped via product lookup above)
        const newQty = Math.max(0, item.product.stock_quantity - item.quantity);
        await supabase
          .from('products')
          .update({ stock_quantity: newQty })
          .eq('id', item.product_id)
          .eq('company_id', req.companyId);
      }
    }

    await auditFromReq(req, 'CREATE', 'sale', sale.id, {
      module:   'pos',
      newValue: { saleNumber, total_amount, items: enrichedItems.length },
    });

    res.status(201).json({ sale });
  } catch (err) {
    console.error('[Sales] Create sale error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sales/:id/void
 * Void a sale — CRITICAL audit event.
 */
router.post('/:id/void', requirePermission('SALES.VOID'), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Void reason is required' });

    const { data: old } = await supabase
      .from('sales')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .single();

    if (!old) return res.status(404).json({ error: 'Sale not found' });
    if (old.status === 'voided') return res.status(400).json({ error: 'Sale is already voided' });

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
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

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

    res.json({ sale: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/pos/sales/:id/return
 * Process a return/refund for a completed sale.
 * Reverses stock for returned items and records in pos_returns.
 */
router.post('/:id/return', requirePermission('SALES.VOID'), async (req, res) => {
  try {
    const { reason, refund_method, items: returnItems } = req.body;

    if (!reason) return res.status(400).json({ error: 'Return reason is required' });

    const { data: sale } = await supabase
      .from('sales')
      .select('*, sale_items(*)')
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
      })
      .select()
      .single();

    if (retErr) return res.status(500).json({ error: retErr.message });

    // Reverse stock for returned items
    for (const ri of itemsToReturn) {
      if (!ri.product_id || !ri.quantity) continue;
      const { data: prod } = await supabase
        .from('products')
        .select('stock_quantity')
        .eq('id', ri.product_id)
        .eq('company_id', req.companyId)
        .single();

      if (prod) {
        await supabase
          .from('products')
          .update({ stock_quantity: prod.stock_quantity + ri.quantity })
          .eq('id', ri.product_id)
          .eq('company_id', req.companyId);
      }
    }

    await auditFromReq(req, 'RETURN', 'sale', sale.id, {
      module:   'pos',
      metadata: { refund_amount: refundAmount, refund_method, reason },
    });

    res.status(201).json({ return: ret });
  } catch (err) {
    console.error('[Sales] Return error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
