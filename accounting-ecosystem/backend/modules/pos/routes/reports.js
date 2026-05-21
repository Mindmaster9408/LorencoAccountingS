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

    res.json({ cashiers: Object.values(cashierMap).sort((a, b) => b.total_revenue - a.total_revenue) });
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

module.exports = router;
