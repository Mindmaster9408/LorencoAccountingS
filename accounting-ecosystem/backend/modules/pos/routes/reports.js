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

// ── pos_audit_events has no FK constraint to users (confirmed directly
// against the live schema — PostgREST error PGRST200: "Could not find a
// relationship between 'pos_audit_events' and 'user_id'"). Several routes
// below embedded `users:user_id(username, full_name)` directly on
// pos_audit_events selects, copying the pattern used successfully
// elsewhere in this file for till_sessions (which DOES have that FK) —
// on pos_audit_events specifically this either 400s the whole query or,
// where the route never checked `.error`, silently returned an empty
// array with no error surfaced at all. This is the live root cause of
// the Enterprise Dashboard's "Recent Activity" 500 (Codebox 77).
// Fix: never embed users on pos_audit_events; fetch events plain, then
// resolve names via one follow-up query and attach them in the exact
// same `{ users: { username, full_name } }` shape the embed would have
// produced, so no downstream code (e.g. `e.users?.full_name`) has to change.
async function attachUserNames(events) {
  const ids = [...new Set(events.map(e => e.user_id).filter(id => id != null))];
  if (ids.length === 0) return events;
  const { data: users } = await supabase.from('users').select('id, username, full_name').in('id', ids);
  const byId = {};
  (users || []).forEach(u => { byId[u.id] = { username: u.username, full_name: u.full_name }; });
  return events.map(e => ({ ...e, users: byId[e.user_id] || null }));
}

router.use(requireCompany);

// REPORTS.VIEW = SUPERVISOR_ROLES (config/permissions.js) — excludes cashier/
// senior_cashier/trainee. This permission category already existed but was
// never applied anywhere, so every "Reports" sidebar report was readable by
// any authenticated POS user regardless of role (Workstream 71 audit
// finding). Applied per-route (not router-wide) so /dashboard, /top-products,
// and /inventory-value — none of which are part of the Reports sidebar, and
// /dashboard specifically backs the separate Enterprise "Dashboard" tab that
// is not currently role-restricted — are left exactly as they were, out of
// scope for this workstream.
const reportsViewGate = requirePermission('REPORTS.VIEW');

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

    const { data: sales, error } = await supabase
      .from('sales')
      .select('total_amount, vat_amount, discount_amount, status, created_at, payment_method')
      .eq('company_id', req.companyId)
      .gte('created_at', startDate)
      .lte('created_at', endDate);

    if (error) return res.status(500).json({ error: error.message });

    const completed = (sales || []).filter(s => s.status === 'completed');
    const voided = (sales || []).filter(s => s.status === 'voided');

    res.json({
      report: {
        period: { from: startDate, to: endDate },
        total_sales: completed.length,
        total_revenue: completed.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
        total_vat: completed.reduce((sum, s) => sum + parseFloat(s.vat_amount || 0), 0),
        total_discounts: completed.reduce((sum, s) => sum + parseFloat(s.discount_amount || 0), 0),
        voided_count: voided.length,
        voided_amount: voided.reduce((sum, s) => sum + parseFloat(s.total_amount || 0), 0),
        payment_breakdown: Object.entries(
          completed.reduce((acc, s) => {
            const method = s.payment_method || 'cash';
            acc[method] = (acc[method] || 0) + parseFloat(s.total_amount || 0);
            return acc;
          }, {})
        ).map(([method, amount]) => ({ method, amount }))
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
router.get('/cashier-performance', reportsViewGate, async (req, res) => {
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
router.get('/till-summary', reportsViewGate, async (req, res) => {
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
router.get('/negative-stock', reportsViewGate, async (req, res) => {
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

      // Part B: Negative stock audit events in period (created + allowed).
      // No users embed here — pos_audit_events has no FK to users (see
      // attachUserNames() note at the top of this file); resolved below.
      supabase
        .from('pos_audit_events')
        .select('id, action_type, product_id, user_id, user_email, created_at, metadata, before_snapshot, after_snapshot')
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
    if (eventsResult.error) return res.status(500).json({ error: eventsResult.error.message });

    const negativeProducts = productsResult.data || [];
    const events           = await attachUserNames(eventsResult.data || []);
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
router.get('/recovery-sync', reportsViewGate, async (req, res) => {
  try {
    const { from, to, startDate, endDate } = req.query;
    const now = new Date();
    const start = startDate || from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = endDate   || to   || now.toISOString();

    const staleThreshold = new Date(Date.now() - 8 * 3_600_000).toISOString();

    const [recoveryResult, syncResult, staleResult, pendingResult] = await Promise.all([
      // Recovery action events in period. No users embed — see
      // attachUserNames() note at the top of this file.
      supabase
        .from('pos_audit_events')
        .select('id, action_type, user_id, user_email, created_at, notes, metadata')
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

      // Offline sync/conflict events in period. Same reason, no users embed.
      supabase
        .from('pos_audit_events')
        .select('id, action_type, user_id, user_email, created_at, metadata')
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

    const recoveryEvents  = await attachUserNames(recoveryResult.data || []);
    const syncEvents      = await attachUserNames(syncResult.data     || []);
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
router.get('/audit-activity', reportsViewGate, async (req, res) => {
  try {
    const { from, to, startDate, endDate, action_type, category } = req.query;
    const now = new Date();
    const start = startDate || from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end   = endDate   || to   || now.toISOString();

    // No users embed — pos_audit_events has no FK to users (see
    // attachUserNames() note at the top of this file); resolved below.
    let query = supabase
      .from('pos_audit_events')
      .select('id, action_type, action_category, user_id, user_email, user_role, till_id, till_session_id, sale_id, product_id, created_at, notes, metadata')
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

    const events  = await attachUserNames(data || []);
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

/**
 * ============================================================================
 * Workstream 71 — Sales/VAT reports that the Reports sidebar has always
 * linked to but which never had a matching backend route (previously
 * "Endpoint not found" on every one of these).
 * ============================================================================
 *
 * Gross-profit note (applies to every report below that computes profit):
 * sale_items does not store a cost-price snapshot at time of sale — the
 * create_sale_atomic RPC (which this workstream must not touch) only writes
 * product_id/product_name/quantity/unit_price/vat_rate/line_total. Profit is
 * therefore computed against each product's CURRENT products.cost_price, not
 * a historical snapshot. If a product's cost has changed since a given sale,
 * that sale's reported profit is an approximation using today's cost, not
 * the true historical margin. This is a known, documented limitation, not a
 * bug — a real fix would require adding a cost snapshot column to sale_items
 * via the RPC, which is explicitly out of scope here.
 *
 * VAT note: unit_price/line_total on sale_items are VAT-inclusive (confirmed
 * in sales.js: "VAT is inclusive in unit_price — extract it"). VAT is
 * extracted per line via line_total * (vat_rate / (100 + vat_rate)), matching
 * the exact formula sales.js itself uses at checkout time. Line-item
 * discounts are always 0 in the current checkout flow (only sale-level
 * discount_amount exists), so VAT reports do not attempt to redistribute a
 * sale-level discount back across line items.
 */

// Shared helper — completed sales in range, enriched with cashier name,
// item/quantity aggregates, and gross profit computed from CURRENT product
// cost prices (see note above). Reused by gross-profit, gross-profit-by-*,
// and daily-summary so the same profit calculation isn't duplicated 4 times.
async function fetchSalesWithProfit(companyId, start, end) {
  const { data: sales, error: salesErr } = await supabase
    .from('sales')
    .select('id, sale_number, receipt_number, user_id, subtotal, vat_amount, total_amount, discount_amount, status, created_at, users:user_id(username, full_name)')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .gte('created_at', start)
    .lte('created_at', end)
    .order('created_at', { ascending: false });
  if (salesErr) throw new Error(salesErr.message);

  const saleIds = (sales || []).map(s => s.id);
  let items = [];
  if (saleIds.length > 0) {
    const { data: itemsData, error: itemsErr } = await supabase
      .from('sale_items')
      .select('sale_id, product_id, product_name, quantity, unit_price, vat_rate, line_total')
      .in('sale_id', saleIds);
    if (itemsErr) throw new Error(itemsErr.message);
    items = itemsData || [];
  }

  const productIds = [...new Set(items.map(i => i.product_id).filter(Boolean))];
  let costById = {};
  let productMeta = {};
  if (productIds.length > 0) {
    const { data: products, error: prodErr } = await supabase
      .from('products')
      .select('id, product_code, product_name, category, cost_price')
      .eq('company_id', companyId)
      .in('id', productIds);
    if (prodErr) throw new Error(prodErr.message);
    (products || []).forEach(p => {
      costById[p.id] = parseFloat(p.cost_price || 0);
      productMeta[p.id] = p;
    });
  }

  const itemsBySale = {};
  items.forEach(i => {
    if (!itemsBySale[i.sale_id]) itemsBySale[i.sale_id] = [];
    itemsBySale[i.sale_id].push(i);
  });

  const enrichedSales = (sales || []).map(sale => {
    const saleItems = itemsBySale[sale.id] || [];
    const item_count = saleItems.length;
    const total_quantity = saleItems.reduce((sum, i) => sum + (parseFloat(i.quantity) || 0), 0);
    const cost_total = saleItems.reduce((sum, i) => sum + ((costById[i.product_id] || 0) * (parseFloat(i.quantity) || 0)), 0);
    const total_amount = parseFloat(sale.total_amount || 0);
    const gross_profit = total_amount - cost_total;
    const profit_margin = total_amount > 0 ? Math.round((gross_profit / total_amount) * 10000) / 100 : 0;
    return {
      sale_number: sale.sale_number || sale.receipt_number,
      cashier: sale.users?.full_name || sale.users?.username || 'Unknown',
      user_id: sale.user_id,
      created_at: sale.created_at,
      subtotal: parseFloat(sale.subtotal || 0),
      vat: parseFloat(sale.vat_amount || 0),
      total_amount,
      item_count,
      total_quantity,
      gross_profit: Math.round(gross_profit * 100) / 100,
      profit_margin,
      items: saleItems,
    };
  });

  return { sales: enrichedSales, productMeta };
}

function dateRangeFromQuery(query) {
  const { from, to, startDate, endDate } = query;
  const now = new Date();
  const start = startDate || from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const end   = endDate   || to   || now.toISOString();
  return { start, end };
}

/**
 * GET /api/reports/gross-profit
 * Per-sale gross profit — see cost-price note above.
 */
router.get('/gross-profit', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const { sales } = await fetchSalesWithProfit(req.companyId, start, end);

    const totalSales = sales.reduce((sum, s) => sum + s.total_amount, 0);
    const totalProfit = sales.reduce((sum, s) => sum + s.gross_profit, 0);

    res.json({
      sales: sales.map(({ items, user_id, ...rest }) => rest),
      summary: {
        totalSales,
        totalProfit,
        profitMargin: totalSales > 0 ? Math.round((totalProfit / totalSales) * 10000) / 100 : 0,
        transactionCount: sales.length,
      },
    });
  } catch (err) {
    console.error('[reports] gross-profit:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/gross-profit-by-person
 * Same per-sale profit calculation, grouped by cashier.
 */
router.get('/gross-profit-by-person', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const { sales } = await fetchSalesWithProfit(req.companyId, start, end);

    const byPerson = {};
    sales.forEach(s => {
      const key = s.user_id || 'unknown';
      if (!byPerson[key]) {
        byPerson[key] = { cashier: s.cashier, sales_count: 0, total_sales: 0, total_vat: 0, gross_profit: 0 };
      }
      byPerson[key].sales_count++;
      byPerson[key].total_sales += s.total_amount;
      byPerson[key].total_vat += s.vat;
      byPerson[key].gross_profit += s.gross_profit;
    });

    const people = Object.values(byPerson).map(p => ({
      ...p,
      total_sales: Math.round(p.total_sales * 100) / 100,
      total_vat: Math.round(p.total_vat * 100) / 100,
      gross_profit: Math.round(p.gross_profit * 100) / 100,
      profit_margin: p.total_sales > 0 ? Math.round((p.gross_profit / p.total_sales) * 10000) / 100 : 0,
    })).sort((a, b) => b.gross_profit - a.gross_profit);

    const totalSales = people.reduce((sum, p) => sum + p.total_sales, 0);
    const totalProfit = people.reduce((sum, p) => sum + p.gross_profit, 0);

    res.json({
      data: people,
      summary: {
        totalSales,
        totalProfit,
        profitMargin: totalSales > 0 ? Math.round((totalProfit / totalSales) * 10000) / 100 : 0,
        staffCount: people.length,
      },
    });
  } catch (err) {
    console.error('[reports] gross-profit-by-person:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/gross-profit-by-product
 * Same per-sale-item data, grouped by product.
 */
router.get('/gross-profit-by-product', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const { sales, productMeta } = await fetchSalesWithProfit(req.companyId, start, end);

    const byProduct = {};
    sales.forEach(s => {
      s.items.forEach(item => {
        const key = item.product_id;
        const meta = productMeta[key] || {};
        if (!byProduct[key]) {
          byProduct[key] = {
            product_code: meta.product_code || '—',
            product_name: item.product_name || meta.product_name || 'Unknown',
            category: meta.category || null,
            quantity_sold: 0,
            total_revenue: 0,
            cost_total: 0,
          };
        }
        const qty = parseFloat(item.quantity) || 0;
        const cost = parseFloat(meta.cost_price || 0) * qty;
        byProduct[key].quantity_sold += qty;
        byProduct[key].total_revenue += parseFloat(item.line_total || 0);
        byProduct[key].cost_total += cost;
      });
    });

    const products = Object.values(byProduct).map(p => {
      const gross_profit = p.total_revenue - p.cost_total;
      return {
        product_code: p.product_code,
        product_name: p.product_name,
        category: p.category,
        quantity_sold: p.quantity_sold,
        total_revenue: Math.round(p.total_revenue * 100) / 100,
        gross_profit: Math.round(gross_profit * 100) / 100,
        profit_margin: p.total_revenue > 0 ? Math.round((gross_profit / p.total_revenue) * 10000) / 100 : 0,
      };
    }).sort((a, b) => b.gross_profit - a.gross_profit);

    const totalRevenue = products.reduce((sum, p) => sum + p.total_revenue, 0);
    const totalProfit = products.reduce((sum, p) => sum + p.gross_profit, 0);

    res.json({
      products,
      summary: {
        totalRevenue,
        totalProfit,
        profitMargin: totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) / 100 : 0,
        productCount: products.length,
      },
    });
  } catch (err) {
    console.error('[reports] gross-profit-by-product:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/daily-summary
 * Same per-sale profit calculation, grouped by calendar day.
 */
router.get('/daily-summary', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const { sales } = await fetchSalesWithProfit(req.companyId, start, end);

    const byDay = {};
    sales.forEach(s => {
      const day = new Date(s.created_at).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { sale_date: day, transaction_count: 0, daily_sales: 0, daily_vat: 0, daily_profit: 0 };
      byDay[day].transaction_count++;
      byDay[day].daily_sales += s.total_amount;
      byDay[day].daily_vat += s.vat;
      byDay[day].daily_profit += s.gross_profit;
    });

    const days = Object.values(byDay)
      .map(d => ({
        ...d,
        daily_sales: Math.round(d.daily_sales * 100) / 100,
        daily_vat: Math.round(d.daily_vat * 100) / 100,
        daily_profit: Math.round(d.daily_profit * 100) / 100,
      }))
      .sort((a, b) => new Date(b.sale_date) - new Date(a.sale_date));

    const totalSales = days.reduce((sum, d) => sum + d.daily_sales, 0);
    const totalVat = days.reduce((sum, d) => sum + d.daily_vat, 0);
    const totalProfit = days.reduce((sum, d) => sum + d.daily_profit, 0);

    res.json({
      days,
      summary: {
        totalSales,
        totalVat,
        totalProfit,
        avgDailySales: days.length > 0 ? (totalSales / days.length).toFixed(2) : '0.00',
      },
    });
  } catch (err) {
    console.error('[reports] daily-summary:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/audit-trail
 * Sale-level listing with item/qty aggregates and an honest payment-method
 * label. sales.payment_method is NOT trusted directly — a sale can have
 * multiple sale_payments rows (split tender), so the display label is
 * derived from sale_payments: the single method if there's exactly one,
 * otherwise "Split".
 */
router.get('/audit-trail', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const { sales } = await fetchSalesWithProfit(req.companyId, start, end);

    const { data: sData } = await supabase
      .from('sales')
      .select('id, sale_number, receipt_number')
      .eq('company_id', req.companyId)
      .eq('status', 'completed')
      .gte('created_at', start)
      .lte('created_at', end);
    const saleIds = (sData || []).map(s => s.id);

    let paymentsBySale = {};
    if (saleIds.length > 0) {
      const { data: payments } = await supabase
        .from('sale_payments')
        .select('sale_id, payment_method')
        .in('sale_id', saleIds);
      (payments || []).forEach(p => {
        if (!paymentsBySale[p.sale_id]) paymentsBySale[p.sale_id] = [];
        paymentsBySale[p.sale_id].push(p.payment_method);
      });
    }
    const saleNumberToId = {};
    (sData || []).forEach(s => { saleNumberToId[s.sale_number || s.receipt_number] = s.id; });

    const allMethods = new Set();
    const rows = sales.map(s => {
      const id = saleNumberToId[s.sale_number];
      const methods = id != null ? (paymentsBySale[id] || []) : [];
      const distinctMethods = [...new Set(methods)];
      const payment_method = distinctMethods.length === 0 ? 'unknown'
        : distinctMethods.length === 1 && methods.length === 1 ? distinctMethods[0]
        : 'split';
      allMethods.add(payment_method);
      return {
        sale_number: s.sale_number,
        created_at: s.created_at,
        cashier: s.cashier,
        item_count: s.item_count,
        total_quantity: s.total_quantity,
        subtotal: s.subtotal,
        vat_amount: s.vat,
        total_amount: s.total_amount,
        payment_method,
      };
    });

    res.json({
      sales: rows,
      summary: {
        totalTransactions: rows.length,
        totalAmount: rows.reduce((sum, r) => sum + r.total_amount, 0),
        paymentMethods: [...allMethods],
      },
    });
  } catch (err) {
    console.error('[reports] audit-trail:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/vat-detail
 * Line-item level VAT extraction — see VAT note above.
 */
router.get('/vat-detail', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const { data: sales, error } = await supabase
      .from('sales')
      .select('id, sale_number, receipt_number, created_at, users:user_id(username, full_name), sale_items(product_id, product_name, quantity, unit_price, vat_rate, line_total)')
      .eq('company_id', req.companyId)
      .eq('status', 'completed')
      .gte('created_at', start)
      .lte('created_at', end);
    if (error) return res.status(500).json({ error: error.message });

    const items = [];
    let vatableItems = 0, exemptItems = 0;
    (sales || []).forEach(sale => {
      const cashier = sale.users?.full_name || sale.users?.username || 'Unknown';
      (sale.sale_items || []).forEach(item => {
        const rate = parseFloat(item.vat_rate || 0);
        const lineTotal = parseFloat(item.line_total || 0);
        const vatAmount = rate > 0 ? lineTotal * (rate / (100 + rate)) : 0;
        if (rate > 0) vatableItems++; else exemptItems++;
        items.push({
          sale_number: sale.sale_number || sale.receipt_number,
          created_at: sale.created_at,
          cashier,
          product_name: item.product_name,
          quantity: item.quantity,
          unit_price: parseFloat(item.unit_price || 0),
          subtotal: Math.round((lineTotal - vatAmount) * 100) / 100,
          vat_amount: Math.round(vatAmount * 100) / 100,
          total_with_vat: lineTotal,
        });
      });
    });

    const totalSubtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
    const totalVat = items.reduce((sum, i) => sum + i.vat_amount, 0);
    const totalWithVat = items.reduce((sum, i) => sum + i.total_with_vat, 0);

    res.json({
      items: items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
      summary: { totalSubtotal, totalVat, totalWithVat, vatableItems, exemptItems },
    });
  } catch (err) {
    console.error('[reports] vat-detail:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/vat-summary
 * Same line-item VAT extraction, grouped by calendar day.
 */
router.get('/vat-summary', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const { data: sales, error } = await supabase
      .from('sales')
      .select('id, created_at, sale_items(vat_rate, line_total)')
      .eq('company_id', req.companyId)
      .eq('status', 'completed')
      .gte('created_at', start)
      .lte('created_at', end);
    if (error) return res.status(500).json({ error: error.message });

    const byDay = {};
    (sales || []).forEach(sale => {
      const day = new Date(sale.created_at).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { report_date: day, taxable_amount: 0, vat_collected: 0, exempt_amount: 0, total_sales: 0, transaction_count: 0 };
      byDay[day].transaction_count++;
      (sale.sale_items || []).forEach(item => {
        const rate = parseFloat(item.vat_rate || 0);
        const lineTotal = parseFloat(item.line_total || 0);
        if (rate > 0) {
          const vatAmount = lineTotal * (rate / (100 + rate));
          byDay[day].taxable_amount += lineTotal - vatAmount;
          byDay[day].vat_collected += vatAmount;
        } else {
          byDay[day].exempt_amount += lineTotal;
        }
        byDay[day].total_sales += lineTotal;
      });
    });

    const summary = Object.values(byDay)
      .map(d => ({
        ...d,
        taxable_amount: Math.round(d.taxable_amount * 100) / 100,
        vat_collected: Math.round(d.vat_collected * 100) / 100,
        exempt_amount: Math.round(d.exempt_amount * 100) / 100,
        total_sales: Math.round(d.total_sales * 100) / 100,
      }))
      .sort((a, b) => new Date(b.report_date) - new Date(a.report_date));

    const totalTaxable = summary.reduce((sum, d) => sum + d.taxable_amount, 0);
    const totalVat = summary.reduce((sum, d) => sum + d.vat_collected, 0);
    const totalExempt = summary.reduce((sum, d) => sum + d.exempt_amount, 0);
    const totalSales = summary.reduce((sum, d) => sum + d.total_sales, 0);

    res.json({
      summary,
      totals: {
        totalTaxable,
        totalVat,
        totalExempt,
        totalSales,
        effectiveVatRate: totalTaxable > 0 ? Math.round((totalVat / totalTaxable) * 10000) / 100 : 0,
      },
    });
  } catch (err) {
    console.error('[reports] vat-summary:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/payment-methods
 * Payment breakdown sourced from sale_payments (authoritative for split
 * tender), not sales.payment_method.
 */
router.get('/payment-methods', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const { data: sales, error: salesErr } = await supabase
      .from('sales')
      .select('id')
      .eq('company_id', req.companyId)
      .eq('status', 'completed')
      .gte('created_at', start)
      .lte('created_at', end);
    if (salesErr) return res.status(500).json({ error: salesErr.message });

    const saleIds = (sales || []).map(s => s.id);
    let payments = [];
    if (saleIds.length > 0) {
      const { data, error } = await supabase
        .from('sale_payments')
        .select('payment_method, amount')
        .in('sale_id', saleIds);
      if (error) return res.status(500).json({ error: error.message });
      payments = data || [];
    }

    const byMethod = {};
    payments.forEach(p => {
      const method = (p.payment_method || 'cash').toUpperCase();
      if (!byMethod[method]) byMethod[method] = { payment_method: method, count: 0, total_amount: 0 };
      byMethod[method].count++;
      byMethod[method].total_amount += parseFloat(p.amount || 0);
    });

    const methods = Object.values(byMethod)
      .map(m => ({ ...m, total_amount: Math.round(m.total_amount * 100) / 100 }))
      .sort((a, b) => b.total_amount - a.total_amount);

    res.json({ methods });
  } catch (err) {
    console.error('[reports] payment-methods:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/forensic-audit
 * Filterable POS audit event log. Replaces the frontend's previous call to
 * the nonexistent /api/audit/forensic — pos_audit_events (not the shared
 * ecosystem audit_log table) is the correct source for POS actions.
 * Username filter matches user_email (pos_audit_events does not index a
 * separate display-name column for ilike filtering) — a known approximation,
 * not exact full_name matching.
 */
router.get('/forensic-audit', reportsViewGate, async (req, res) => {
  try {
    const { action_type, entity_type, username, start_date, end_date, limit = 100 } = req.query;
    // No users embed — pos_audit_events has no FK to users (see
    // attachUserNames() note at the top of this file); resolved below.
    let query = supabase
      .from('pos_audit_events')
      .select('id, action_type, entity_type, entity_id, user_id, user_email, created_at, metadata, before_snapshot, after_snapshot, ip_address')
      .eq('company_id', req.companyId)
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit) || 100, 500));

    if (action_type) query = query.eq('action_type', action_type);
    if (entity_type) query = query.eq('entity_type', entity_type);
    if (username) query = query.ilike('user_email', `%${username}%`);
    if (start_date) query = query.gte('created_at', start_date);
    if (end_date) query = query.lte('created_at', end_date);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const entries = (await attachUserNames(data || [])).map(e => ({
      created_at: e.created_at,
      username: e.users?.full_name || e.users?.username || e.user_email,
      action_type: e.action_type,
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      details: e.metadata || e.after_snapshot || e.before_snapshot || {},
      ip_address: e.ip_address,
    }));

    res.json({ entries });
  } catch (err) {
    console.error('[reports] forensic-audit:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/suspicious-activity
 * Replaces the frontend's previous call to /api/audit/suspicious-activity,
 * which was a hardcoded stub in server.js returning an empty array
 * unconditionally (and under the wrong field name — the frontend reads
 * `alerts`, the stub returned `activities`). This is a real implementation
 * against pos_audit_events with documented, sensible thresholds — flags
 * per-cashier counts of voids, negative-stock sales, manager overrides, and
 * refunds over the period that exceed a fixed threshold. Thresholds are a
 * starting point, not a tuned fraud model.
 */
router.get('/suspicious-activity', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const THRESHOLDS = {
      SALE_VOIDED: 3,
      NEGATIVE_STOCK_SALE_ALLOWED: 5,
      SALE_RETURNED: 3,
      MANAGER_OVERRIDE: 5,
      SUPERVISOR_OVERRIDE_GRANTED: 5,
    };
    // No users embed — pos_audit_events has no FK to users (see
    // attachUserNames() note at the top of this file); resolved below.
    const { data, error } = await supabase
      .from('pos_audit_events')
      .select('user_id, user_email, action_type')
      .eq('company_id', req.companyId)
      .in('action_type', Object.keys(THRESHOLDS))
      .gte('created_at', start)
      .lte('created_at', end);
    if (error) return res.status(500).json({ error: error.message });

    const counts = {}; // `${user_id}:${action_type}` -> { count, username }
    (await attachUserNames(data || [])).forEach(e => {
      const key = `${e.user_id}:${e.action_type}`;
      if (!counts[key]) {
        counts[key] = { count: 0, username: e.users?.full_name || e.users?.username || e.user_email, action_type: e.action_type };
      }
      counts[key].count++;
    });

    const LABELS = {
      SALE_VOIDED: 'High void frequency',
      NEGATIVE_STOCK_SALE_ALLOWED: 'Frequent negative-stock sales',
      SALE_RETURNED: 'High refund frequency',
      MANAGER_OVERRIDE: 'Frequent manager overrides',
      SUPERVISOR_OVERRIDE_GRANTED: 'Frequent supervisor overrides',
    };

    const alerts = Object.values(counts)
      .filter(c => c.count > THRESHOLDS[c.action_type])
      .map(c => ({
        alert_type: LABELS[c.action_type] || c.action_type,
        severity: c.count > THRESHOLDS[c.action_type] * 2 ? 'high' : 'medium',
        description: `${c.username} triggered ${c.action_type} ${c.count} times in the selected period (threshold: ${THRESHOLDS[c.action_type]}).`,
        username: c.username,
        count: c.count,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ alerts });
  } catch (err) {
    console.error('[reports] suspicious-activity:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Workstream 83: Sales by Customer + Customer Statement ──────────────────
//
// Data-source facts confirmed against the live schema before writing this:
//   - sale_payments is the correct source for payment-method breakdown
//     (a sale can be split across methods) — used everywhere a payment
//     breakdown is shown, per the ticket's explicit "must use sale_payments"
//     rule, not sales.payment_method (which only reflects one method).
//   - customer_account_transactions exists but is EMPTY in production and
//     is only ever written by the manual POST /:id/account/payment route
//     (type='payment') — nothing in sales.js or the create_sale_atomic RPC
//     (opaque, not in this repo, never touched per every prior ticket's
//     explicit rule) is provably writing 'charge' rows there for ACCOUNT
//     sales. Rather than assume either way, both reports below independently
//     compute ACCOUNT-sale charges directly from `sales` and de-duplicate
//     against any ledger rows that DO reference the same sale_id — correct
//     regardless of whether the RPC turns out to post there or not.

const ACCOUNT_PAYMENT_METHOD = 'ACCOUNT';

async function fetchSalePaymentsForSales(saleIds) {
  if (saleIds.length === 0) return {};
  const { data } = await supabase
    .from('sale_payments')
    .select('sale_id, payment_method, amount, reference, processed_at')
    .in('sale_id', saleIds);
  const bySale = {};
  (data || []).forEach(p => {
    if (!bySale[p.sale_id]) bySale[p.sale_id] = [];
    bySale[p.sale_id].push(p);
  });
  return bySale;
}

async function fetchReturnsForSales(saleIds) {
  if (saleIds.length === 0) return {};
  const { data } = await supabase
    .from('pos_returns')
    .select('id, original_sale_id, refund_amount, refund_method, reason, status, created_at')
    .in('original_sale_id', saleIds);
  const bySale = {};
  (data || []).forEach(r => {
    if (r.status === 'cancelled') return; // a cancelled return never happened
    if (!bySale[r.original_sale_id]) bySale[r.original_sale_id] = [];
    bySale[r.original_sale_id].push(r);
  });
  return bySale;
}

/**
 * GET /api/reports/sales-by-customer
 * Company-scoped, REPORTS.VIEW-gated. Two shapes from one endpoint:
 *   - no customer_id  → summary row per customer (+ one "Walk-in / No
 *     Customer" row for customer_id IS NULL sales)
 *   - customer_id given (a real id, or the sentinel 'walkin') → adds a
 *     `transactions` array with full per-sale drill-down detail
 */
router.get('/sales-by-customer', reportsViewGate, async (req, res) => {
  try {
    const { start, end } = dateRangeFromQuery(req.query);
    const { customer_id, cashier_id, till_id, payment_method, account_only, include_voids, search } = req.query;

    let query = supabase
      .from('sales')
      .select('id, sale_number, receipt_number, customer_id, user_id, till_session_id, subtotal, vat_amount, total_amount, payment_method, status, created_at, users:user_id(username, full_name)')
      .eq('company_id', req.companyId)
      .gte('created_at', start)
      .lte('created_at', end);

    if (include_voids !== 'true') query = query.eq('status', 'completed');
    if (cashier_id) query = query.eq('user_id', parseInt(cashier_id));
    if (payment_method) query = query.eq('payment_method', payment_method);
    if (account_only === 'true') query = query.eq('payment_method', ACCOUNT_PAYMENT_METHOD);

    if (customer_id) {
      if (customer_id === 'walkin') query = query.is('customer_id', null);
      else query = query.eq('customer_id', parseInt(customer_id));
    }

    if (till_id) {
      const { data: sessions } = await supabase.from('till_sessions').select('id').eq('company_id', req.companyId).eq('till_id', parseInt(till_id));
      const sessionIds = (sessions || []).map(s => s.id);
      query = query.in('till_session_id', sessionIds.length > 0 ? sessionIds : [-1]);
    }

    const { data: sales, error } = await query.order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const saleIds = (sales || []).map(s => s.id);
    const [paymentsBySale, returnsBySale] = await Promise.all([
      fetchSalePaymentsForSales(saleIds),
      fetchReturnsForSales(saleIds),
    ]);

    // Till names for drill-down display
    const sessionIds = [...new Set((sales || []).map(s => s.till_session_id).filter(Boolean))];
    let tillNameBySession = {};
    if (sessionIds.length > 0) {
      const { data: sessions } = await supabase.from('till_sessions').select('id, till_id, tills(till_name, till_number)').in('id', sessionIds);
      (sessions || []).forEach(s => { tillNameBySession[s.id] = s.tills ? (s.tills.till_name || s.tills.till_number) : null; });
    }

    // Customer lookup (+ optional name/code search, applied to which
    // customers are included — walk-in is always included unless a search
    // term is given, since it has no name/code to match)
    const customerIds = [...new Set((sales || []).map(s => s.customer_id).filter(Boolean))];
    let customersById = {};
    if (customerIds.length > 0) {
      const { data: customers } = await supabase.from('customers').select('id, name, customer_number').eq('company_id', req.companyId).in('id', customerIds);
      (customers || []).forEach(c => { customersById[c.id] = c; });
    }
    const searchTerm = (search || '').trim().toLowerCase();

    const perSale = (sales || []).map(sale => {
      const payments = paymentsBySale[sale.id] || [];
      const returns = returnsBySale[sale.id] || [];
      const refund = returns.reduce((sum, r) => sum + parseFloat(r.refund_amount || 0), 0);
      const gross = parseFloat(sale.total_amount || 0);
      // Fall back to the sale's single payment_method if no sale_payments
      // rows exist (older data predating the sale_payments table) — an
      // honest fallback, not a silent zero.
      const effectivePayments = payments.length > 0
        ? payments.map(p => ({ method: p.payment_method, amount: parseFloat(p.amount || 0) }))
        : [{ method: sale.payment_method || 'UNKNOWN', amount: gross }];
      const accountAmount = effectivePayments.filter(p => p.method === ACCOUNT_PAYMENT_METHOD).reduce((s, p) => s + p.amount, 0);
      const cashCardAmount = effectivePayments.filter(p => p.method !== ACCOUNT_PAYMENT_METHOD).reduce((s, p) => s + p.amount, 0);

      return {
        sale_id: sale.id,
        customer_id: sale.customer_id,
        sale_number: sale.sale_number || sale.receipt_number,
        date: sale.created_at,
        cashier: sale.users?.full_name || sale.users?.username || 'Unknown',
        till: tillNameBySession[sale.till_session_id] || null,
        payment_breakdown: effectivePayments,
        gross,
        refund,
        net: Math.round((gross - refund) * 100) / 100,
        status: sale.status,
        account_amount: accountAmount,
        cash_card_amount: cashCardAmount,
      };
    });

    // ── Single-customer drill-down ──────────────────────────────────────────
    if (customer_id) {
      const isWalkin = customer_id === 'walkin';
      const custMeta = isWalkin ? null : customersById[parseInt(customer_id)];
      if (!isWalkin && !custMeta) return res.status(404).json({ error: 'Customer not found' });

      const gross_sales = perSale.reduce((s, x) => s + x.gross, 0);
      const returns_total = perSale.reduce((s, x) => s + x.refund, 0);
      const net_sales = perSale.reduce((s, x) => s + x.net, 0);

      return res.json({
        customer: {
          customer_id: isWalkin ? null : custMeta.id,
          customer_name: isWalkin ? 'Walk-in / No Customer' : custMeta.name,
          customer_code: isWalkin ? null : (custMeta.customer_number || null),
          sales_count: perSale.length,
          gross_sales: Math.round(gross_sales * 100) / 100,
          returns_total: Math.round(returns_total * 100) / 100,
          net_sales: Math.round(net_sales * 100) / 100,
          average_sale: perSale.length > 0 ? Math.round((net_sales / perSale.length) * 100) / 100 : 0,
          last_purchase_date: perSale.length > 0 ? perSale[0].date : null,
          account_sales_total: Math.round(perSale.reduce((s, x) => s + x.account_amount, 0) * 100) / 100,
          cash_card_sales_total: Math.round(perSale.reduce((s, x) => s + x.cash_card_amount, 0) * 100) / 100,
        },
        transactions: perSale,
      });
    }

    // ── Summary grouped by customer ─────────────────────────────────────────
    const groups = {};
    perSale.forEach(row => {
      const key = row.customer_id || 'walkin';
      if (!groups[key]) {
        const meta = row.customer_id ? customersById[row.customer_id] : null;
        groups[key] = {
          customer_id: row.customer_id || null,
          customer_name: row.customer_id ? (meta ? meta.name : `Customer #${row.customer_id}`) : 'Walk-in / No Customer',
          customer_code: row.customer_id && meta ? (meta.customer_number || null) : null,
          sales: [],
        };
      }
      groups[key].sales.push(row);
    });

    let rows = Object.values(groups).map(g => {
      const gross_sales = g.sales.reduce((s, x) => s + x.gross, 0);
      const returns_total = g.sales.reduce((s, x) => s + x.refund, 0);
      const net_sales = g.sales.reduce((s, x) => s + x.net, 0);
      return {
        customer_id: g.customer_id,
        customer_name: g.customer_name,
        customer_code: g.customer_code,
        sales_count: g.sales.length,
        gross_sales: Math.round(gross_sales * 100) / 100,
        returns_total: Math.round(returns_total * 100) / 100,
        net_sales: Math.round(net_sales * 100) / 100,
        average_sale: g.sales.length > 0 ? Math.round((net_sales / g.sales.length) * 100) / 100 : 0,
        last_purchase_date: g.sales.reduce((max, x) => (!max || x.date > max) ? x.date : max, null),
        account_sales_total: Math.round(g.sales.reduce((s, x) => s + x.account_amount, 0) * 100) / 100,
        cash_card_sales_total: Math.round(g.sales.reduce((s, x) => s + x.cash_card_amount, 0) * 100) / 100,
      };
    });

    if (searchTerm) {
      rows = rows.filter(r =>
        r.customer_name.toLowerCase().includes(searchTerm) ||
        (r.customer_code || '').toLowerCase().includes(searchTerm)
      );
    }

    rows.sort((a, b) => b.net_sales - a.net_sales);

    res.json({
      customers: rows,
      summary: {
        totalCustomers: rows.length,
        totalGross: Math.round(rows.reduce((s, r) => s + r.gross_sales, 0) * 100) / 100,
        totalReturns: Math.round(rows.reduce((s, r) => s + r.returns_total, 0) * 100) / 100,
        totalNet: Math.round(rows.reduce((s, r) => s + r.net_sales, 0) * 100) / 100,
      },
    });
  } catch (err) {
    console.error('[reports] sales-by-customer:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/reports/customer-statement
 * Company-scoped, REPORTS.VIEW-gated. customer_id is required.
 *
 * "POS Account Statement" — built entirely from POS-recorded data
 * (customer_account_transactions + ACCOUNT-method sales + returns against
 * them). This is NOT a full Accounting-app debtor statement and must not
 * be presented as one; the frontend labels it explicitly.
 *
 * Balance math: replays every known ledger entry in chronological order
 * from the earliest one on record (there is no separate "account opened"
 * balance to seed from — the ledger IS the full history as far as POS has
 * ever recorded). Opening balance for the requested period = the replayed
 * balance immediately before startDate. The final replayed balance (as of
 * the most recent entry) is cross-checked against customers.current_balance
 * — if they disagree, the response says so explicitly rather than silently
 * presenting a number that might not match reality (see Rule A5/A7 —
 * documented uncertainty, not hidden).
 */
router.get('/customer-statement', reportsViewGate, async (req, res) => {
  try {
    const { customer_id, startDate, endDate, include_paid_sales } = req.query;
    if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });

    const { data: customer } = await supabase
      .from('customers')
      .select('id, name, customer_number, contact_number, phone, email, address_line_1, address_line_2, city, current_balance, credit_limit')
      .eq('id', customer_id).eq('company_id', req.companyId).single();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const now = new Date().toISOString();
    const periodStart = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const periodEnd = endDate || now;

    // 1) Full ledger history (all-time — needed to compute a correct opening balance)
    const { data: ledgerRows } = await supabase
      .from('customer_account_transactions')
      .select('id, sale_id, type, amount, reference, notes, created_at')
      .eq('company_id', req.companyId).eq('customer_id', customer_id)
      .order('created_at', { ascending: true });

    const ledgerSaleIds = new Set((ledgerRows || []).filter(r => r.sale_id).map(r => r.sale_id));

    // 2) ACCOUNT-method sales, all-time — synthesize a charge line for any
    // that the ledger doesn't already reference by sale_id (see file-header note)
    const { data: accountSales } = await supabase
      .from('sales')
      .select('id, sale_number, receipt_number, total_amount, status, created_at')
      .eq('company_id', req.companyId).eq('customer_id', customer_id)
      .eq('payment_method', ACCOUNT_PAYMENT_METHOD).eq('status', 'completed')
      .order('created_at', { ascending: true });

    const synthesizedCharges = (accountSales || [])
      .filter(s => !ledgerSaleIds.has(s.id))
      .map(s => ({
        id: `sale-${s.id}`, sale_id: s.id, type: 'charge', amount: parseFloat(s.total_amount || 0),
        reference: s.sale_number || s.receipt_number, notes: 'Account sale', created_at: s.created_at, source: 'sales',
      }));

    // 3) Returns against this customer's ACCOUNT sales — credit lines
    const accountSaleIds = (accountSales || []).map(s => s.id);
    const returnsBySale = await fetchReturnsForSales(accountSaleIds);
    const returnLines = Object.values(returnsBySale).flat().map(r => ({
      id: `return-${r.id}`, sale_id: r.original_sale_id, type: 'return', amount: -parseFloat(r.refund_amount || 0),
      reference: `Return on sale #${r.original_sale_id}`, notes: r.reason || 'Return/credit', created_at: r.created_at, source: 'pos_returns',
    }));

    const ledgerLines = (ledgerRows || []).map(r => ({
      id: `ledger-${r.id}`, sale_id: r.sale_id, type: r.type, amount: parseFloat(r.amount || 0),
      reference: r.reference || null, notes: r.notes || null, created_at: r.created_at, source: 'ledger',
    }));

    const allBalanceAffectingLines = [...ledgerLines, ...synthesizedCharges, ...returnLines]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // Replay from 0 — the ledger is the entire known history
    let running = 0;
    const replayed = allBalanceAffectingLines.map(line => {
      running += line.amount;
      return { ...line, running_balance: Math.round(running * 100) / 100 };
    });

    const noHistoryAtAll = replayed.length === 0;
    const openingEntry = replayed.filter(l => new Date(l.created_at) < new Date(periodStart)).slice(-1)[0];
    const opening_balance = openingEntry ? openingEntry.running_balance : 0;
    const opening_balance_unavailable = noHistoryAtAll && Math.abs(parseFloat(customer.current_balance || 0)) > 0.01;

    const periodLines = replayed.filter(l => new Date(l.created_at) >= new Date(periodStart) && new Date(l.created_at) <= new Date(periodEnd));
    const closing_balance = periodLines.length > 0 ? periodLines[periodLines.length - 1].running_balance : opening_balance;

    // Reconciliation: does our fully-replayed balance (as of the latest
    // entry we know about) match the customer's live current_balance?
    const finalReplayedBalance = replayed.length > 0 ? replayed[replayed.length - 1].running_balance : 0;
    const liveBalance = parseFloat(customer.current_balance || 0);
    const balance_mismatch = Math.abs(finalReplayedBalance - liveBalance) > 0.01;

    // Reference-only "paid in full" sales — shown if requested, never affect the balance
    let paidSaleLines = [];
    if (include_paid_sales === 'true') {
      const { data: paidSales } = await supabase
        .from('sales')
        .select('id, sale_number, receipt_number, total_amount, created_at')
        .eq('company_id', req.companyId).eq('customer_id', customer_id)
        .neq('payment_method', ACCOUNT_PAYMENT_METHOD).eq('status', 'completed')
        .gte('created_at', periodStart).lte('created_at', periodEnd)
        .order('created_at', { ascending: true });
      paidSaleLines = (paidSales || []).map(s => ({
        id: `paid-${s.id}`, sale_id: s.id, type: 'paid_sale',
        debit: parseFloat(s.total_amount || 0), credit: parseFloat(s.total_amount || 0),
        reference: s.sale_number || s.receipt_number, notes: 'Paid in full at time of sale — no effect on account balance',
        created_at: s.created_at, running_balance: null,
      }));
    }

    const transactionLines = [
      ...periodLines.map(l => ({
        ...l,
        debit: l.amount > 0 ? l.amount : 0,
        credit: l.amount < 0 ? -l.amount : 0,
      })),
      ...paidSaleLines,
    ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    res.json({
      statement_type: 'POS Account Statement',
      accounting_boundary_note: 'This statement reflects Checkout Charlie POS account activity only. It is not a full Accounting-app debtor statement unless Accounting integration has been explicitly enabled for this company.',
      customer: {
        id: customer.id, name: customer.name, customer_code: customer.customer_number || null,
        contact: customer.contact_number || customer.phone || null, email: customer.email || null,
        address: [customer.address_line_1, customer.address_line_2, customer.city].filter(Boolean).join(', ') || null,
        credit_limit: customer.credit_limit != null ? parseFloat(customer.credit_limit) : null,
      },
      period: { start: periodStart, end: periodEnd },
      opening_balance,
      opening_balance_unavailable,
      closing_balance,
      live_current_balance: liveBalance,
      balance_mismatch,
      transactions: transactionLines,
      generated_at: now,
    });
  } catch (err) {
    console.error('[reports] customer-statement:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
