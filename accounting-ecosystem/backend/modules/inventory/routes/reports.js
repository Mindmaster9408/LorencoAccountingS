/**
 * ============================================================================
 * Inventory Reports Routes — Phase 2A Costing
 * ============================================================================
 * Endpoints:
 *   GET /reports/stock-valuation         — current stock value per item
 *   GET /reports/cost-history/:itemId    — cost change history for one item
 *   GET /reports/valuation-movements     — forensic cost ledger (date range)
 *   GET /reports/work-order-cost-summary — WO cost breakdown
 *   GET /reports/stock-counts            — count session summary (Codebox 03)
 *   GET /reports/variance-summary        — variance aggregate by reason/type (Codebox 03)
 * ============================================================================
 * All endpoints are company-scoped via req.companyId.
 * All data sourced from Phase 2A tables — no recalculation from live sales.
 * ============================================================================
 */

'use strict';

const express = require('express');
const { supabase } = require('../../../config/database');
const reportingService = require('../services/reportingService');
const { requirePerm, PERM } = require('../permissions');

const router = express.Router();

// ─── GET /reports/stock-valuation ────────────────────────────────────────────
// Returns current stock value per item: qty × average_cost.
// Query params:
//   category  — filter by item category (optional)
//   min_value — hide items with total_value below threshold (optional)
router.get('/stock-valuation', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const result = await reportingService.getStockValuationReport(supabase, req.companyId, {
    category: req.query.category,
    item_type: req.query.item_type,
    min_value: req.query.min_value,
    low_stock: req.query.low_stock === 'true',
    missing_cost: req.query.missing_cost === 'true',
    search: req.query.search
  });

  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json({ report: result.report, items: result.items });
});

// ─── GET /reports/cost-history/:itemId ───────────────────────────────────────
// Returns audit trail of cost changes for a single item.
// Query params:
//   from  — ISO date string (optional, defaults to 90 days ago)
//   to    — ISO date string (optional, defaults to now)
//   limit — max rows (optional, default 200)
router.get('/cost-history/:itemId', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const result = await reportingService.getCostHistory(supabase, req.companyId, req.params.itemId, {
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit
  });

  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/valuation-movements ────────────────────────────────────────
// Returns the forensic valuation ledger for a date range.
// Query params:
//   from         — ISO date string (required)
//   to           — ISO date string (optional, defaults to now)
//   item_id      — filter to one item (optional)
//   source_type  — filter by source: po_receive | wo_issue | wo_complete | manual (optional)
//   limit        — max rows (default 500, max 1000)
router.get('/valuation-movements', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const result = await reportingService.getValuationMovements(supabase, req.companyId, {
    from: req.query.from,
    to: req.query.to,
    item_id: req.query.item_id,
    source_type: req.query.source_type,
    limit: req.query.limit
  });

  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/work-order-cost-summary ────────────────────────────────────
// Returns cost breakdown for work orders.
// Query params:
//   status  — open | finalized | all (default all)
//   from    — filter by WO created_at (optional)
//   to      — filter by WO created_at (optional)
//   limit   — max rows (default 200)
router.get('/work-order-cost-summary', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const result = await reportingService.getWorkOrderCostSummary(supabase, req.companyId, {
    status: req.query.status,
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit
  });

  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/stock-counts ───────────────────────────────────────────────
// Stock count session summary report: list of sessions with line counts,
// variance totals, and applied status.
// Query params: status, from_date, to_date, limit
router.get('/stock-counts', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getStockCountSessionsReport(supabase, req.companyId, {
    status: req.query.status,
    from_date: req.query.from_date,
    to_date: req.query.to_date,
    limit: req.query.limit
  });

  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/variance-summary ───────────────────────────────────────────
// Aggregate variance by reason, item type, and date range.
// Applied sessions only (status='applied').
// Query params: from_date, to_date
router.get('/variance-summary', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getVarianceSummaryReport(supabase, req.companyId, {
    from_date: req.query.from_date,
    to_date: req.query.to_date
  });

  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/operational-dashboard ─────────────────────────────────────
router.get('/operational-dashboard', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getOperationalDashboard(supabase, req.companyId);
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/reservation-report ────────────────────────────────────────
router.get('/reservation-report', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getReservationReport(supabase, req.companyId, {
    status: req.query.status,
    source_type: req.query.source_type,
    item_id: req.query.item_id,
    limit: req.query.limit
  });
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/shortages ────────────────────────────────────────────────
router.get('/shortages', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getShortageReport(supabase, req.companyId);
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/overcommitted ────────────────────────────────────────────
router.get('/overcommitted', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getOvercommittedReport(supabase, req.companyId);
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/purchase-order-report ────────────────────────────────────
router.get('/purchase-order-report', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getPurchaseOrderReport(supabase, req.companyId, {
    status: req.query.status,
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit
  });
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/overdue-purchase-orders ──────────────────────────────────
router.get('/overdue-purchase-orders', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getOverduePurchaseOrdersReport(supabase, req.companyId, {
    as_of: req.query.as_of
  });
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/supplier-history ─────────────────────────────────────────
router.get('/supplier-history', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const result = await reportingService.getSupplierHistoryReport(supabase, req.companyId, {
    item_id: req.query.item_id,
    supplier_id: req.query.supplier_id
  });
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/procurement-suggestions ──────────────────────────────────
router.get('/procurement-suggestions', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getProcurementSuggestionsReport(supabase, req.companyId);
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/production-summary ───────────────────────────────────────
router.get('/production-summary', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getProductionSummaryReport(supabase, req.companyId);
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/wastage ───────────────────────────────────────────────────
router.get('/wastage', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const result = await reportingService.getWastageReport(supabase, req.companyId, {
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit
  });
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/yield-variance ───────────────────────────────────────────
router.get('/yield-variance', requirePerm(PERM.COST_VIEW), async (req, res) => {
  const result = await reportingService.getYieldVarianceReport(supabase, req.companyId, {
    from: req.query.from,
    to: req.query.to,
    direction: req.query.direction,
    limit: req.query.limit
  });
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── GET /reports/alerts ───────────────────────────────────────────────────
router.get('/alerts', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getAlertsPanel(supabase, req.companyId);
  if (!result.success) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json(result);
});

// ─── CB-09 Demand Planning Reports ───────────────────────────────────────────

router.get('/open-sales-orders', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getOpenSalesOrdersReport(supabase, req.companyId, {
    status:    req.query.status,
    customer:  req.query.customer,
    from_date: req.query.from_date,
    to_date:   req.query.to_date,
    limit:     req.query.limit
  });
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

router.get('/atp', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getATPReport(supabase, req.companyId);
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

router.get('/future-demand', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getFutureDemandReport(supabase, req.companyId, {
    days:   req.query.days,
    status: req.query.status
  });
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

router.get('/demand-shortages', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getDemandShortagesReport(supabase, req.companyId);
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

router.get('/demand-dashboard', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getDemandDashboardReport(supabase, req.companyId);
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

// ─── GET /reports/warehouse-stock ─────────────────────────────────────────────
router.get('/warehouse-stock', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getWarehouseStockReport(supabase, req.companyId, {
    warehouse_id: req.query.warehouse_id
  });
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

// ─── GET /reports/transfer-history ────────────────────────────────────────────
router.get('/transfer-history', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getTransferHistoryReport(supabase, req.companyId, {
    status:            req.query.status,
    from_warehouse_id: req.query.from_warehouse_id,
    to_warehouse_id:   req.query.to_warehouse_id,
    from_date:         req.query.from_date,
    to_date:           req.query.to_date,
    limit:             req.query.limit
  });
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

// ─── GET /reports/warehouse-shortages ─────────────────────────────────────────
router.get('/warehouse-shortages', requirePerm(PERM.REPORTS_VIEW), async (req, res) => {
  const result = await reportingService.getWarehouseShortagesReport(supabase, req.companyId);
  if (!result.success) return res.status(result.status || 500).json({ error: result.error });
  res.json(result);
});

module.exports = router;
