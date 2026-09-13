'use strict';

/**
 * ============================================================================
 * Multi-Company Oversight — Stockton Proof scoping (2026-09-12)
 * ============================================================================
 * Mounted at: /api/inventory/oversight
 *
 * Every other Inventory route trusts req.companyId (one company, from the
 * JWT) — confirmed via audit that Inventory has zero cross-company
 * aggregation anywhere. This is deliberately the one exception: it ignores
 * req.companyId and instead resolves every company the requesting user
 * actually has access to (same resolution pattern as
 * shared/routes/companies.js's GET /), for an owner who runs more than one
 * company on Stockton.
 *
 * GET /oversight/rollup — key metrics per company, side by side.
 * ============================================================================
 */

const express = require('express');
const { supabase } = require('../../../config/database');
const { getStockValuationReport } = require('../services/reportingService');

const router = express.Router();

async function resolveAccessibleCompanyIds(req) {
  if (req.user.isSuperAdmin) {
    const { data } = await supabase
      .from('companies')
      .select('id, company_name, modules_enabled')
      .contains('modules_enabled', ['inventory']);
    return data || [];
  }

  const { data } = await supabase
    .from('user_company_access')
    .select('company_id, companies:company_id (id, company_name, modules_enabled)')
    .eq('user_id', req.user.userId)
    .eq('is_active', true);

  return (data || [])
    .map(r => r.companies)
    .filter(c => c && Array.isArray(c.modules_enabled) && c.modules_enabled.includes('inventory'));
}

router.get('/rollup', async (req, res) => {
  try {
    const companies = await resolveAccessibleCompanyIds(req);
    if (companies.length === 0) {
      return res.json({ companies: [], message: 'No companies with Stockton enabled found for this user.' });
    }

    const rows = await Promise.all(companies.map(async (co) => {
      const [valuation, { count: openWoCount }, { count: openPoCount }, { count: exceptionCount }] = await Promise.all([
        getStockValuationReport(supabase, co.id, {}),
        supabase.from('work_orders').select('id', { count: 'exact', head: true })
          .eq('company_id', co.id).in('status', ['draft', 'released', 'in_progress', 'paused']),
        supabase.from('purchase_orders').select('id', { count: 'exact', head: true })
          .eq('company_id', co.id).in('status', ['draft', 'approved']),
        supabase.from('stock_count_sessions').select('id', { count: 'exact', head: true })
          .eq('company_id', co.id).eq('status', 'submitted'),
      ]);

      return {
        company_id:            co.id,
        company_name:          co.company_name,
        total_stock_value:     valuation.success ? valuation.report.grand_total : null,
        total_items:           valuation.success ? valuation.report.total_items : null,
        missing_cost_items:    valuation.success ? valuation.report.missing_cost_items : null,
        open_work_orders:      openWoCount || 0,
        open_purchase_orders:  openPoCount || 0,
        stock_counts_awaiting_approval: exceptionCount || 0,
      };
    }));

    res.json({
      companies: rows,
      summary: {
        company_count: rows.length,
        total_stock_value_all_companies: rows.reduce((sum, r) => sum + (r.total_stock_value || 0), 0),
      },
    });
  } catch (err) {
    console.error('[inventory oversight] rollup error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
