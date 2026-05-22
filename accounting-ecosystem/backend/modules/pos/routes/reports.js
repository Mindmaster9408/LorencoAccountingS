/**
 * ============================================================================
 * POS Reports Routes - Checkout Charlie Module
 * ============================================================================
 * Sales reports, analytics, and dashboard data.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { requireCompany, requirePermission } = require('../../../middleware/auth');

const router = express.Router();

router.use(requireCompany);

/**
 * GET /api/reports/sales-summary
 * Daily/weekly/monthly sales summary
 */
router.get('/sales-summary', async (req, res) => {
  try {
    const { from, to, period } = req.query;
    const now = new Date();
    const startDate = from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endDate = to || now.toISOString();

    // Include sale_payments so the payment breakdown is accurate for split payments.
    // sales.payment_method holds only the primary method and is wrong for split sales.
    const { data: sales, error } = await supabase
      .from('sales')
      .select('total_amount, vat_amount, discount_amount, status, created_at, payment_method, sale_payments(payment_method, amount)')
      .eq('company_id', req.companyId)
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    if (error) return res.status(500).json({ error: error.message });

    const completed = (sales || []).filter(s => s.status === 'completed');
    const voided = (sales || []).filter(s => s.status === 'voided');

    // Build payment breakdown from sale_payments rows (authoritative for split payments).
    // Falls back to sales.payment_method + total_amount for any sale with no payment rows
    // (legacy data or edge case).
    const paymentAcc = {};
    for (const s of completed) {
      const pmts = s.sale_payments || [];
      if (pmts.length > 0) {
        for (const p of pmts) {
          const method = (p.payment_method || 'cash').toUpperCase();
          paymentAcc[method] = (paymentAcc[method] || 0) + parseFloat(p.amount || 0);
        }
      } else {
        const method = (s.payment_method || 'cash').toUpperCase();
        paymentAcc[method] = (paymentAcc[method] || 0) + parseFloat(s.total_amount || 0);
      }
    }

    res.json({
      report: {
        period: { from: startDate, to: endDate },
        total_sales: completed.length,
        total_revenue: completed.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
        total_vat: completed.reduce((sum, s) => sum + parseFloat(s.vat_amount || 0), 0),
        total_discounts: completed.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
        voided_count: voided.length,
        voided_amount: voided.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
        payment_breakdown: Object.entries(paymentAcc).map(([method, amount]) => ({ method, amount }))
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/top-products
 * Best-selling products
 */
router.get('/top-products', async (req, res) => {
  try {
    const { from, to, limit = 20 } = req.query;
    const now = new Date();
    const startDate = from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    let query = supabase
      .from('sale_items')
      .select('product_id, product_name, quantity, unit_price, line_total, sales!inner(company_id, status, created_at)')
      .eq('sales.company_id', req.companyId)
      .eq('sales.status', 'completed');

    if (from) query = query.gte('sales.created_at', startDate);
    if (to) query = query.lte('sales.created_at', to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Aggregate by product
    const productMap = {};
    (data || []).forEach(item => {
      const key = item.product_id;
      if (!productMap[key]) {
        productMap[key] = { product_id: key, product_name: item.product_name, total_qty: 0, total_revenue: 0 };
      }
      productMap[key].total_qty += item.quantity;
      productMap[key].total_revenue += parseFloat(item.line_total || item.quantity * item.unit_price);
    });

    const products = Object.values(productMap)
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .slice(0, parseInt(limit));

    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/cashier-performance
 * Sales per cashier — enhanced with sessions worked, refunds, overrides, negative-stock events
 */
router.get('/cashier-performance', async (req, res) => {
  try {
    const { from, to, startDate, endDate } = req.query;
    const now = new Date();
    const start = startDate || from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = endDate || to || now.toISOString();

    const [salesResult, auditResult, sessionsResult] = await Promise.all([
      supabase
        .from('sales')
        .select('user_id, total_amount, status, users:user_id(username, full_name)')
        .eq('company_id', req.companyId)
        .gte('created_at', start)
        .lte('created_at', end),
      supabase
        .from('pos_audit_events')
        .select('user_id, action_type')
        .eq('company_id', req.companyId)
        .in('action_type', [
          'SALE_RETURNED', 'NEGATIVE_STOCK_SALE_ALLOWED',
          'MANAGER_OVERRIDE', 'SUPERVISOR_OVERRIDE_GRANTED', 'RECOVERY_RETRY_TRIGGERED'
        ])
        .gte('created_at', start)
        .lte('created_at', end),
      supabase
        .from('till_sessions')
        .select('user_id')
        .eq('company_id', req.companyId)
        .gte('opened_at', start)
        .lte('opened_at', end)
    ]);

    if (salesResult.error) return res.status(500).json({ error: salesResult.error.message });

    const cashierMap = {};
    (salesResult.data || []).forEach(sale => {
      const key = sale.user_id;
      if (!cashierMap[key]) {
        cashierMap[key] = {
          user_id: key,
          username: sale.users?.username,
          full_name: sale.users?.full_name,
          total_sales: 0, completed_sales: 0, voided_sales: 0, total_revenue: 0,
          sessions_worked: 0, refunds_processed: 0,
          negative_stock_allowed: 0, manager_overrides: 0, recovery_events: 0
        };
      }
      cashierMap[key].total_sales++;
      if (sale.status === 'completed') {
        cashierMap[key].completed_sales++;
        cashierMap[key].total_revenue += parseFloat(sale.total_amount || 0);
      } else if (sale.status === 'voided') {
        cashierMap[key].voided_sales++;
      }
    });

    (auditResult.data || []).forEach(ev => {
      const c = cashierMap[ev.user_id];
      if (!c) return;
      if (ev.action_type === 'SALE_RETURNED') c.refunds_processed++;
      else if (ev.action_type === 'NEGATIVE_STOCK_SALE_ALLOWED') c.negative_stock_allowed++;
      else if (ev.action_type === 'MANAGER_OVERRIDE' || ev.action_type === 'SUPERVISOR_OVERRIDE_GRANTED') c.manager_overrides++;
      else if (ev.action_type === 'RECOVERY_RETRY_TRIGGERED') c.recovery_events++;
    });

    (sessionsResult.data || []).forEach(sess => {
      if (cashierMap[sess.user_id]) cashierMap[sess.user_id].sessions_worked++;
    });

    res.json({
      cashiers: Object.values(cashierMap)
        .map(c => ({
          ...c,
          avg_transaction: c.completed_sales > 0
            ? Math.round((c.total_revenue / c.completed_sales) * 100) / 100
            : 0,
        }))
        .sort((a, b) => b.total_revenue - a.total_revenue)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/inventory-value
 * Current inventory valuation
 */
router.get('/inventory-value', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('id, product_name, stock_quantity, cost_price, unit_price, is_active')
      .eq('company_id', req.companyId)
      .eq('is_active', true);

    if (error) return res.status(500).json({ error: error.message });

    const products = (data || []).map(p => ({
      ...p,
      cost_value: (p.stock_quantity || 0) * (p.cost_price || 0),
      retail_value: (p.stock_quantity || 0) * (p.unit_price || 0)
    }));

    res.json({
      total_items: products.length,
      total_units: products.reduce((sum, p) => sum + (p.stock_quantity || 0), 0),
      total_cost_value: products.reduce((sum, p) => sum + p.cost_value, 0),
      total_retail_value: products.reduce((sum, p) => sum + p.retail_value, 0),
      products
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/analytics/dashboard
 * Dashboard summary data
 */
router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data: todaySales } = await supabase
      .from('sales')
      .select('total_amount, status')
      .eq('company_id', req.companyId)
      .gte('created_at', today.toISOString());

    const completed = (todaySales || []).filter(s => s.status === 'completed');

    const { data: lowStock } = await supabase
      .from('products')
      .select('id')
      .eq('company_id', req.companyId)
      .eq('is_active', true)
      .lte('stock_quantity', 10);

    res.json({
      today: {
        sales_count: completed.length,
        revenue: completed.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
        voided: (todaySales || []).filter(s => s.status === 'voided').length
      },
      low_stock_count: (lowStock || []).length
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/till-summary
 * Per-session till breakdown.
 * Uses pos_recon_snapshots where available (authoritative — sourced from sale_payments).
 * Falls back to till_sessions fields for open/not-yet-cashed-up sessions.
 */
router.get('/till-summary', async (req, res) => {
  try {
    const { from, to, startDate, endDate } = req.query;
    const now = new Date();
    const start = startDate || from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = endDate   || to   || now.toISOString();

    // Parallel: sessions + snapshots (both date-bounded by session open time)
    const [sessResult, snapResult] = await Promise.all([
      supabase
        .from('till_sessions')
        .select('*, tills(till_name, till_number), users:user_id(username, full_name)')
        .eq('company_id', req.companyId)
        .gte('opened_at', start)
        .lte('opened_at', end)
        .order('opened_at', { ascending: false }),
      supabase
        .from('pos_recon_snapshots')
        .select('*')
        .eq('company_id', req.companyId)
        .gte('session_opened_at', start)
        .lte('session_opened_at', end)
        .order('id', { ascending: false }), // newest snapshot first — deduped below
    ]);

    if (sessResult.error) return res.status(500).json({ error: sessResult.error.message });

    const allSessions = sessResult.data || [];
    const sessionIds  = new Set(allSessions.map(s => s.id));

    // Latest snapshot per session (ordered desc by id → first hit wins)
    const snapshotBySession = {};
    (snapResult.data || []).forEach(snap => {
      if (sessionIds.has(snap.till_session_id) && !snapshotBySession[snap.till_session_id]) {
        snapshotBySession[snap.till_session_id] = snap;
      }
    });

    const sessions = allSessions.map(sess => {
      const snap = snapshotBySession[sess.id] || null;
      const base = {
        session_id:  sess.id,
        cashier:     sess.users?.full_name || sess.users?.username || null,
        till_name:   sess.tills?.till_name   || null,
        till_number: sess.tills?.till_number || null,
        status:      sess.status,
        opened_at:   sess.opened_at,
        closed_at:   sess.closed_at,
      };
      if (snap) {
        return {
          ...base,
          has_snapshot:            true,
          is_consistent:           snap.is_consistent,
          consistency_issue_count: snap.consistency_issues?.length || 0,
          opening_balance:         snap.opening_balance,
          sale_count:              snap.sale_count,
          gross_sales:             snap.gross_sales,
          discount_total:          snap.discount_total,
          vat_total:               snap.vat_total,
          void_count:              snap.void_count,
          void_total:              snap.void_total,
          // Payment breakdown from sale_payments (authoritative — not sales.payment_method)
          payment_cash:            snap.payment_cash,
          payment_card:            snap.payment_card,
          payment_eft:             snap.payment_eft,
          payment_account:         snap.payment_account,
          payment_other:           snap.payment_other,
          refund_count:            snap.refund_count,
          refund_total:            snap.refund_total,
          net_sales:               snap.net_sales,
          expected_cash_in_drawer: snap.expected_cash_in_drawer,
          counted_cash:            snap.counted_cash,
          total_counted:           snap.total_counted,
          cash_variance:           snap.cash_variance,
          triggered_by:            snap.triggered_by,
        };
      }
      // Fallback — session closed/open without snapshot yet
      return {
        ...base,
        has_snapshot:            false,
        is_consistent:           null,
        consistency_issue_count: null,
        opening_balance:         parseFloat(sess.opening_balance || 0),
        sale_count:              null,
        gross_sales:             null,
        discount_total:          null,
        vat_total:               null,
        void_count:              null,
        void_total:              null,
        payment_cash:            null, // no split-payment data without snapshot
        payment_card:            null,
        payment_eft:             null,
        payment_account:         null,
        payment_other:           null,
        refund_count:            null,
        refund_total:            null,
        net_sales:               null,
        expected_cash_in_drawer: parseFloat(sess.expected_balance || 0),
        counted_cash:            null,
        total_counted:           sess.closing_balance != null ? parseFloat(sess.closing_balance) : null,
        cash_variance:           sess.variance        != null ? parseFloat(sess.variance)        : null,
        triggered_by:            null,
      };
    });

    // Totals — authoritative (snapshot rows only; don't mix with fallback estimates)
    const snapped = sessions.filter(s => s.has_snapshot);
    const fn = f => snapped.reduce((sum, r) => sum + (r[f] || 0), 0);
    const summary = {
      total_sessions:          sessions.length,
      snapshotted_sessions:    snapped.length,
      open_sessions:           sessions.filter(s => s.status === 'open').length,
      total_sale_count:        fn('sale_count'),
      total_gross_sales:       fn('gross_sales'),
      total_void_count:        fn('void_count'),
      total_refunds:           fn('refund_total'),
      total_net_sales:         fn('net_sales'),
      total_cash:              fn('payment_cash'),
      total_card:              fn('payment_card'),
      total_eft:               fn('payment_eft'),
      inconsistent_sessions:   snapped.filter(s => s.is_consistent === false).length,
      sessions_with_variance:  sessions.filter(s => s.cash_variance != null && s.cash_variance !== 0).length,
    };

    res.json({ sessions, summary });
  } catch (err) {
    console.error('[reports] till-summary:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/negative-stock
 * Two-part report:
 *   Part A: Products currently below zero (live state) + when they last went negative
 *   Part B: Negative stock audit events in the requested period
 *   Plus: company stock policy state (allow_negative_stock_sales)
 */
router.get('/negative-stock', async (req, res) => {
  try {
    const { from, to, startDate, endDate } = req.query;
    const now = new Date();
    const start = startDate || from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = endDate   || to   || now.toISOString();

    const [productsResult, eventsResult, policyResult] = await Promise.all([
      // Part A: Products currently below zero (most negative first)
      supabase
        .from('products')
        .select('id, product_name, sku, stock_quantity, unit_price, cost_price, is_active')
        .eq('company_id', req.companyId)
        .lt('stock_quantity', 0)
        .order('stock_quantity', { ascending: true }),

      // Part B: Negative stock audit events in period (created + allowed)
      supabase
        .from('pos_audit_events')
        .select('id, action_type, product_id, user_id, user_email, created_at, metadata, before_snapshot, after_snapshot, users:user_id(username, full_name)')
        .eq('company_id', req.companyId)
        .in('action_type', ['NEGATIVE_STOCK_CREATED', 'NEGATIVE_STOCK_SALE_ALLOWED'])
        .gte('created_at', start)
        .lte('created_at', end)
        .order('created_at', { ascending: false })
        .limit(250),

      // Company stock policy
      supabase
        .from('company_settings')
        .select('allow_negative_stock_sales')
        .eq('company_id', req.companyId)
        .maybeSingle(),
    ]);

    if (productsResult.error) return res.status(500).json({ error: productsResult.error.message });

    const negativeProducts = productsResult.data || [];
    const events           = eventsResult.data   || [];
    const allowNegative    = policyResult.data?.allow_negative_stock_sales ?? false;

    // For negative products: find most recent NEGATIVE_STOCK_CREATED per product
    // (events already ordered newest-first — first hit per product_id wins)
    const lastWentNegativeByProduct = {};
    events
      .filter(e => e.action_type === 'NEGATIVE_STOCK_CREATED')
      .forEach(e => {
        if (e.product_id && !lastWentNegativeByProduct[e.product_id]) {
          lastWentNegativeByProduct[e.product_id] = e;
        }
      });

    const currently_negative = negativeProducts.map(p => ({
      ...p,
      went_negative_at:      lastWentNegativeByProduct[p.id]?.created_at      || null,
      went_negative_details: lastWentNegativeByProduct[p.id]?.after_snapshot  || null,
    }));

    res.json({
      stock_policy:             { allow_negative_stock_sales: allowNegative },
      currently_negative,
      currently_negative_count: currently_negative.length,
      events_in_period:         events,
      events_in_period_count:   events.length,
      period:                   { from: start, to: end },
    });
  } catch (err) {
    console.error('[reports] negative-stock:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/recovery-sync
 * Unresolved recovery state visibility:
 *   - Stale open sessions (open > 8h)
 *   - Sessions closed but not yet cashed up
 *   - Recovery audit events in period (retries, abandoned, overrides)
 *   - Offline sync/conflict events in period
 */
router.get('/recovery-sync', async (req, res) => {
  try {
    const { from, to, startDate, endDate } = req.query;
    const now = new Date();
    const start = startDate || from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = endDate   || to   || now.toISOString();

    const staleThreshold = new Date(Date.now() - 8 * 3_600_000).toISOString();

    const [recoveryResult, syncResult, staleResult, pendingResult] = await Promise.all([
      // Recovery action events in period
      supabase
        .from('pos_audit_events')
        .select('id, action_type, user_id, user_email, created_at, notes, metadata, users:user_id(username, full_name)')
        .eq('company_id', req.companyId)
        .in('action_type', [
          'RECOVERY_RETRY_TRIGGERED',
          'RECOVERY_MARKED_FAILED',
          'RECOVERY_NOTE_ADDED',
          'SUPERVISOR_OVERRIDE_GRANTED',
          'ABANDONED_SESSION_DETECTED',
        ])
        .gte('created_at', start)
        .lte('created_at', end)
        .order('created_at', { ascending: false })
        .limit(200),

      // Offline sync/conflict events in period
      supabase
        .from('pos_audit_events')
        .select('id, action_type, user_id, user_email, created_at, metadata, users:user_id(username, full_name)')
        .eq('company_id', req.companyId)
        .in('action_type', ['OFFLINE_SYNC_RECEIVED', 'OFFLINE_CONFLICT'])
        .gte('created_at', start)
        .lte('created_at', end)
        .order('created_at', { ascending: false })
        .limit(200),

      // Stale open sessions (open > 8h from now — not date-range-bounded, always live state)
      supabase
        .from('till_sessions')
        .select('id, user_id, till_id, status, opened_at, tills(till_name, till_number), users:user_id(username, full_name)')
        .eq('company_id', req.companyId)
        .eq('status', 'open')
        .lte('opened_at', staleThreshold)
        .order('opened_at', { ascending: true }),

      // Sessions closed but not yet cashed up (closing_balance null = no cashup recorded)
      supabase
        .from('till_sessions')
        .select('id, user_id, till_id, status, opened_at, closed_at, tills(till_name, till_number), users:user_id(username, full_name)')
        .eq('company_id', req.companyId)
        .eq('status', 'closed')
        .is('closing_balance', null)
        .order('closed_at', { ascending: false })
        .limit(50),
    ]);

    const recoveryEvents  = recoveryResult.data || [];
    const syncEvents      = syncResult.data     || [];
    const staleSessions   = staleResult.data    || [];
    const pendingCashup   = pendingResult.data  || [];

    const summary = {
      stale_open_sessions:       staleSessions.length,
      pending_cashup_sessions:   pendingCashup.length,
      recovery_retries:          recoveryEvents.filter(e => e.action_type === 'RECOVERY_RETRY_TRIGGERED').length,
      abandoned_items:           recoveryEvents.filter(e => e.action_type === 'RECOVERY_MARKED_FAILED').length,
      supervisor_overrides:      recoveryEvents.filter(e => e.action_type === 'SUPERVISOR_OVERRIDE_GRANTED').length,
      offline_syncs_received:    syncEvents.filter(e => e.action_type === 'OFFLINE_SYNC_RECEIVED').length,
      offline_conflicts:         syncEvents.filter(e => e.action_type === 'OFFLINE_CONFLICT').length,
      unresolved_count:
        staleSessions.length +
        pendingCashup.length +
        recoveryEvents.filter(e => e.action_type === 'RECOVERY_MARKED_FAILED').length,
    };

    res.json({
      summary,
      stale_sessions: staleSessions.map(s => ({
        ...s,
        age_hours: Math.round((Date.now() - new Date(s.opened_at)) / 3_600_000),
      })),
      pending_cashup_sessions: pendingCashup,
      recovery_events:         recoveryEvents,
      sync_events:             syncEvents,
      period:                  { from: start, to: end },
    });
  } catch (err) {
    console.error('[reports] recovery-sync:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Manager-relevant audit event types (operational feed — excludes high-volume SALE_CREATED noise)
const MANAGER_AUDIT_TYPES = [
  'SALE_VOIDED',
  'SALE_RETURNED',
  'MANAGER_OVERRIDE',
  'SUPERVISOR_OVERRIDE_GRANTED',
  'STOCK_ADJUSTED',
  'NEGATIVE_STOCK_CREATED',
  'NEGATIVE_STOCK_SALE_ALLOWED',
  'TILL_CLOSED',
  'CASHUP_COMPLETED',
  'CASH_VARIANCE_RECORDED',
  'RECOVERY_RETRY_TRIGGERED',
  'RECOVERY_MARKED_FAILED',
  'ABANDONED_SESSION_DETECTED',
];

/**
 * GET /api/reports/audit-activity
 * Manager-visible operational event feed, newest-first.
 * Defaults to manager-relevant event types only.
 * ?action_type=X  — filter to one specific type
 * ?category=X     — filter to an action_category (override, sale, inventory, session, recovery)
 */
router.get('/audit-activity', async (req, res) => {
  try {
    const { from, to, startDate, endDate, action_type, category } = req.query;
    const now = new Date();
    const start = startDate || from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = endDate   || to   || now.toISOString();

    let query = supabase
      .from('pos_audit_events')
      .select('id, action_type, action_category, user_id, user_email, user_role, till_id, till_session_id, sale_id, product_id, created_at, notes, metadata, users:user_id(username, full_name)')
      .eq('company_id', req.companyId)
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false })
      .limit(500);

    if (action_type) {
      query = query.eq('action_type', action_type);
    } else if (category) {
      query = query.eq('action_category', category);
    } else {
      // Default: manager-relevant types only (excludes SALE_CREATED, LOGIN, RECEIPT noise)
      query = query.in('action_type', MANAGER_AUDIT_TYPES);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const events  = data || [];
    const by_type = {};
    events.forEach(e => { by_type[e.action_type] = (by_type[e.action_type] || 0) + 1; });

    res.json({
      events,
      total:    events.length,
      by_type,
      period:   { from: start, to: end },
      ...(events.length === 500 && { truncated: true }),
    });
  } catch (err) {
    console.error('[reports] audit-activity:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
