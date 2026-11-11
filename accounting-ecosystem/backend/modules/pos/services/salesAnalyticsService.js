'use strict';

/**
 * ============================================================================
 * Checkout Charlie — sales analytics (read-only, SQL aggregates)
 * ============================================================================
 * Built 2026-11-11 for Insights (modules/insights), the owner reporting app.
 *
 * Charlie's own reports (routes/reports.js) aggregate in JavaScript after
 * paging rows out of PostgREST 1,000 at a time. That is fine for one month on
 * one report, but an owner dashboard needs 12+ months across several widgets,
 * so this service aggregates in Postgres instead. The DEFINITIONS are kept
 * identical to Charlie's reports, so the numbers match:
 *
 *   - Only sales.status = 'completed' count (voided/held sales never do) —
 *     same as /sales-summary, /top-products, /payment-methods.
 *   - Till sales = SUM(sales.total_amount) — VAT-inclusive, after discounts —
 *     same as /sales-summary's total_revenue.
 *   - Product / category revenue = SUM(sale_items.line_total) — also
 *     VAT-inclusive (checked against live data 2026-11-11: it equals
 *     total_amount except for whole-cart discounts) — same as /top-products.
 *   - Payment methods come from sale_payments (split tenders counted per
 *     tender), upper-cased, NULL = CASH — same as /payment-methods.
 *   - Date range: created_at >= from AND created_at <= to + 'T23:59:59.999',
 *     i.e. Charlie's endOfDay() rule, so a bare end date includes that day.
 *   - Returns (pos_returns) are NOT netted off, exactly like /sales-summary.
 *     Shown separately so the owner can still see them.
 *
 * "Store" = the till's free-text location (tills.location), falling back to
 * the till name. sales has no location_id and the locations table is not
 * linked to tills, so this is the only store signal that exists today.
 *
 * Uses the same direct pg Pool Ledger Leo's reports use (no PostgREST
 * row cap, no .in() URL-length limits). Every query is parameterised and
 * scoped to one company_id.
 *
 * FOLLOW-UP: Charlie's own reports could move onto this service so there is
 * literally one implementation; not done now to avoid touching live POS
 * reports in the same change.
 * ============================================================================
 */

const db = require('../../accounting/config/database');

const STORE_LABEL_SQL = `COALESCE(NULLIF(TRIM(t.location), ''), NULLIF(TRIM(t.till_name), ''), 'Unassigned')`;
const CATEGORY_LABEL_SQL = `COALESCE(NULLIF(TRIM(c.name), ''), NULLIF(TRIM(p.category), ''), 'Uncategorised')`;

function endOfDay(dateStr) {
  return `${dateStr}T23:59:59.999`;
}

function round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

/**
 * Builds the filtered-sales CTE shared by every query below, so every widget
 * on the dashboard agrees on which sales are "in" for the chosen slicers.
 * Returns { sql, params } where sql defines `fs` (filtered sales).
 */
function filteredSalesCte(companyId, from, to, filters = {}) {
  const params = [companyId, from, endOfDay(to)];
  let extra = '';
  if (filters.store) {
    params.push(filters.store);
    extra += ` AND ${STORE_LABEL_SQL} = $${params.length}`;
  }
  if (filters.paymentMethod) {
    params.push(String(filters.paymentMethod).toUpperCase());
    extra += ` AND EXISTS (SELECT 1 FROM sale_payments sp
                 WHERE sp.sale_id = s.id
                   AND UPPER(COALESCE(sp.payment_method, 'cash')) = $${params.length})`;
  }
  const sql = `
    fs AS (
      SELECT s.id, s.sale_number, s.receipt_number, s.total_amount, s.created_at,
             ${STORE_LABEL_SQL} AS store
      FROM sales s
      LEFT JOIN till_sessions ts ON ts.id = s.till_session_id
      LEFT JOIN tills t ON t.id = ts.till_id
      WHERE s.company_id = $1
        AND s.status = 'completed'
        AND s.created_at >= $2
        AND s.created_at <= $3${extra}
    )`;
  return { sql, params };
}

/**
 * Line items of the filtered sales, with their category label. When a
 * category slicer is set, only that category's lines are kept.
 */
function filteredItemsCte(params, filters = {}) {
  let extra = '';
  if (filters.category) {
    params.push(filters.category);
    extra = ` AND ${CATEGORY_LABEL_SQL} = $${params.length}`;
  }
  return `,
    fi AS (
      SELECT si.sale_id, si.product_id, si.product_name, si.quantity,
             COALESCE(si.line_total, si.quantity * si.unit_price, 0) AS line_total,
             ${CATEGORY_LABEL_SQL} AS category
      FROM sale_items si
      INNER JOIN fs ON fs.id = si.sale_id
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE 1 = 1${extra}
    )`;
}

/**
 * Sales total, order count and average order value for one period.
 * With a category slicer the figures come from that category's lines
 * (sales = its line totals, orders = sales containing it), otherwise from
 * the sale headers — exactly what an Excel slicer on the rows would give.
 */
async function getTotals(companyId, from, to, filters = {}) {
  const { sql, params } = filteredSalesCte(companyId, from, to, filters);
  let query;
  if (filters.category) {
    query = `WITH ${sql}${filteredItemsCte(params, filters)}
      SELECT COALESCE(SUM(line_total), 0) AS sales, COUNT(DISTINCT sale_id)::int AS orders FROM fi`;
  } else {
    query = `WITH ${sql}
      SELECT COALESCE(SUM(total_amount), 0) AS sales, COUNT(*)::int AS orders FROM fs`;
  }
  const { rows } = await db.query(query, params);
  const sales = round2(rows[0]?.sales);
  const orders = rows[0]?.orders || 0;
  return { sales, orders, avgOrderValue: orders > 0 ? round2(sales / orders) : 0 };
}

/** Month-by-month sales and orders. Months with no sales come back as 0. */
async function getMonthly(companyId, from, to, filters = {}) {
  const { sql, params } = filteredSalesCte(companyId, from, to, filters);
  let query;
  if (filters.category) {
    query = `WITH ${sql}${filteredItemsCte(params, filters)}
      SELECT TO_CHAR(DATE_TRUNC('month', fs.created_at), 'YYYY-MM') AS month,
             SUM(fi.line_total) AS sales, COUNT(DISTINCT fi.sale_id)::int AS orders
      FROM fi INNER JOIN fs ON fs.id = fi.sale_id
      GROUP BY 1`;
  } else {
    query = `WITH ${sql}
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
             SUM(total_amount) AS sales, COUNT(*)::int AS orders
      FROM fs GROUP BY 1`;
  }
  const { rows } = await db.query(query, params);
  const byMonth = {};
  rows.forEach(r => { byMonth[r.month] = { sales: round2(r.sales), orders: r.orders }; });
  return byMonth;
}

async function getByCategory(companyId, from, to, filters = {}) {
  const { sql, params } = filteredSalesCte(companyId, from, to, filters);
  const query = `WITH ${sql}${filteredItemsCte(params, filters)}
    SELECT category AS label, SUM(line_total) AS amount
    FROM fi GROUP BY 1 ORDER BY 2 DESC`;
  const { rows } = await db.query(query, params);
  return rows.map(r => ({ label: r.label, amount: round2(r.amount) }));
}

async function getByStore(companyId, from, to, filters = {}) {
  const { sql, params } = filteredSalesCte(companyId, from, to, filters);
  let query;
  if (filters.category) {
    query = `WITH ${sql}${filteredItemsCte(params, filters)}
      SELECT fs.store AS label, SUM(fi.line_total) AS amount
      FROM fi INNER JOIN fs ON fs.id = fi.sale_id
      GROUP BY 1 ORDER BY 2 DESC`;
  } else {
    query = `WITH ${sql}
      SELECT store AS label, SUM(total_amount) AS amount FROM fs GROUP BY 1 ORDER BY 2 DESC`;
  }
  const { rows } = await db.query(query, params);
  return rows.map(r => ({ label: r.label, amount: round2(r.amount) }));
}

/** Top products by revenue, keyed by product_id (name from the sale line). */
async function getTopProducts(companyId, from, to, filters = {}, limit = 5) {
  const { sql, params } = filteredSalesCte(companyId, from, to, filters);
  params.push(limit);
  const limitIdx = params.length;
  const query = `WITH ${sql}${filteredItemsCte(params, filters)}
    SELECT product_id, MAX(product_name) AS product_name,
           SUM(quantity)::int AS quantity, SUM(line_total) AS revenue
    FROM fi GROUP BY product_id ORDER BY revenue DESC LIMIT $${limitIdx}`;
  const { rows } = await db.query(query, params);
  return rows.map(r => ({
    productId: r.product_id, productName: r.product_name || 'Unknown product',
    quantity: r.quantity || 0, revenue: round2(r.revenue),
  }));
}

/** Revenue for a given set of product ids — used for the year-on-year column. */
async function getProductRevenue(companyId, from, to, filters, productIds) {
  const ids = (productIds || []).filter(id => id != null);
  if (ids.length === 0) return {};
  const { sql, params } = filteredSalesCte(companyId, from, to, filters);
  const cte = filteredItemsCte(params, filters);
  params.push(ids);
  const query = `WITH ${sql}${cte}
    SELECT product_id, SUM(line_total) AS revenue
    FROM fi WHERE product_id = ANY($${params.length}::int[]) GROUP BY product_id`;
  const { rows } = await db.query(query, params);
  const map = {};
  rows.forEach(r => { map[r.product_id] = round2(r.revenue); });
  return map;
}

async function getPaymentMethods(companyId, from, to, filters = {}) {
  const { sql, params } = filteredSalesCte(companyId, from, to, filters);
  const query = `WITH ${sql}
    SELECT UPPER(COALESCE(sp.payment_method, 'cash')) AS label,
           COUNT(*)::int AS count, SUM(sp.amount) AS amount
    FROM sale_payments sp INNER JOIN fs ON fs.id = sp.sale_id
    GROUP BY 1 ORDER BY 3 DESC`;
  const { rows } = await db.query(query, params);
  return rows.map(r => ({ label: r.label, count: r.count, amount: round2(r.amount) }));
}

/** Refunds processed in the period (shown separately, not netted off). */
async function getReturns(companyId, from, to) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(refund_amount), 0) AS amount
       FROM pos_returns
      WHERE company_id = $1 AND created_at >= $2 AND created_at <= $3
        AND COALESCE(status, 'completed') = 'completed'`,
    [companyId, from, endOfDay(to)]);
  return { count: rows[0]?.count || 0, amount: round2(rows[0]?.amount) };
}

/** Most recent sales in the period, for the detail table. */
async function getRecentSales(companyId, from, to, filters = {}, limit = 15) {
  const { sql, params } = filteredSalesCte(companyId, from, to, filters);
  const cte = filteredItemsCte(params, filters);
  params.push(limit);
  const query = `WITH ${sql}${cte}
    SELECT fs.id, COALESCE(fs.sale_number, fs.receipt_number) AS sale_number, fs.created_at, fs.store,
           COUNT(fi.sale_id)::int AS item_lines,
           COALESCE(SUM(fi.quantity), 0)::int AS quantity,
           ${filters.category ? 'SUM(fi.line_total)' : 'MAX(fs.total_amount)'} AS amount,
           STRING_AGG(DISTINCT fi.category, ', ') AS categories
    FROM fs ${filters.category ? 'INNER' : 'LEFT'} JOIN fi ON fi.sale_id = fs.id
    GROUP BY fs.id, fs.sale_number, fs.receipt_number, fs.created_at, fs.store
    ORDER BY fs.created_at DESC
    LIMIT $${params.length}`;
  const { rows } = await db.query(query, params);
  return rows.map(r => ({
    id: r.id, saleNumber: r.sale_number, createdAt: r.created_at, store: r.store,
    itemLines: r.item_lines, quantity: r.quantity, amount: round2(r.amount),
    categories: r.categories || '',
  }));
}

/** Slicer options: every store, category and payment method this company has used. */
async function getFilterOptions(companyId) {
  // Sequential on purpose: callers already run several of these at once.
  const stores = await db.query(
    `SELECT DISTINCT ${STORE_LABEL_SQL} AS label
       FROM sales s
       LEFT JOIN till_sessions ts ON ts.id = s.till_session_id
       LEFT JOIN tills t ON t.id = ts.till_id
      WHERE s.company_id = $1 AND s.status = 'completed'
      ORDER BY 1`, [companyId]);
  const categories = await db.query(
    `SELECT DISTINCT ${CATEGORY_LABEL_SQL} AS label
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.company_id = $1
      ORDER BY 1`, [companyId]);
  const methods = await db.query(
    `SELECT DISTINCT UPPER(COALESCE(sp.payment_method, 'cash')) AS label
       FROM sale_payments sp
      WHERE sp.company_id = $1
      ORDER BY 1`, [companyId]);
  return {
    stores: stores.rows.map(r => r.label),
    categories: categories.rows.map(r => r.label),
    paymentMethods: methods.rows.map(r => r.label),
  };
}

/** True when the company has ever recorded a completed sale. */
async function hasSalesData(companyId) {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM sales WHERE company_id = $1 AND status = 'completed') AS has`,
    [companyId]);
  return !!rows[0]?.has;
}

module.exports = {
  getTotals,
  getMonthly,
  getByCategory,
  getByStore,
  getTopProducts,
  getProductRevenue,
  getPaymentMethods,
  getReturns,
  getRecentSales,
  getFilterOptions,
  hasSalesData,
  // exported for unit tests
  _internal: { filteredSalesCte, filteredItemsCte, endOfDay },
};
