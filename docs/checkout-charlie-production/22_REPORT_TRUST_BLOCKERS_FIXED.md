# 22 — REPORT TRUST BLOCKERS FIXED
## Checkout Charlie — Workstream 6B: Report Trust Blocker Fixes

**Date:** 2026-05-16
**Status:** ✅ Fixed
**File Modified:** `accounting-ecosystem/frontend-pos/index.html`
**Risk:** Zero — frontend display logic only. No backend changes. No business logic changes. No data model changes.

---

## Summary

Three critical bugs identified in Workstream 6A were fixed. All three prevented managers from trusting dashboard KPIs and cash-up workflows. No new features were added. No working reports were touched. Main cash-up flow was verified unaffected.

---

## Bug 1 — Dashboard KPIs Showing False Zeros

### Root Cause

`loadDashboard()` was reading field names that do not exist in the API response.

**API contract** (`GET /api/analytics/dashboard` → `reports.js`):
```json
{
  "today": {
    "sales_count": 47,
    "revenue": 12340.50,
    "voided": 2
  },
  "low_stock_count": 3
}
```

**Frontend was reading** (all invented field names — always undefined → 0):
- `t.net_sales` → doesn't exist
- `t.transaction_count` → doesn't exist
- `t.gross_profit` → doesn't exist (requires cost_price join, not in API)
- `t.avg_transaction_value` → doesn't exist
- `t.avg_basket_size` → doesn't exist

### Fix

**Before:**
```javascript
document.getElementById('kpiTodaySales').textContent = `R ${parseFloat(t.net_sales || 0).toFixed(2)}`;
document.getElementById('kpiTodayTransactions').textContent = `${t.transaction_count || 0} transactions`;
document.getElementById('kpiGrossProfit').textContent = `R ${parseFloat(t.gross_profit || 0).toFixed(2)}`;
const margin = t.net_sales > 0 ? ((t.gross_profit / t.net_sales) * 100).toFixed(1) : '0';
document.getElementById('kpiProfitMargin').textContent = `${margin}% margin`;
document.getElementById('kpiAvgTransaction').textContent = `R ${parseFloat(t.avg_transaction_value || 0).toFixed(2)}`;
document.getElementById('kpiAvgBasket').textContent = `${parseFloat(t.avg_basket_size || 0).toFixed(1)} items avg`;
```

**After:**
```javascript
document.getElementById('kpiTodaySales').textContent = `R ${parseFloat(t.revenue || 0).toFixed(2)}`;
document.getElementById('kpiTodayTransactions').textContent = `${t.sales_count || 0} completed${t.voided > 0 ? ` · ${t.voided} voided` : ''}`;
// Gross profit requires cost_price join — not in current API response
document.getElementById('kpiGrossProfit').textContent = `—`;
document.getElementById('kpiProfitMargin').textContent = `cost data required`;
// Avg transaction derivable from available fields
const avgTx = (t.sales_count > 0) ? (parseFloat(t.revenue) / t.sales_count) : 0;
document.getElementById('kpiAvgTransaction').textContent = `R ${avgTx.toFixed(2)}`;
document.getElementById('kpiAvgBasket').textContent = `—`;
```

### What Changed

| KPI Card | Before | After |
|---|---|---|
| Today's Sales | Always R 0.00 | Correct revenue from API |
| Transactions | Always 0 transactions | Correct count + voided indicator |
| Gross Profit | Always R 0.00 | `—` (honest — data not available) |
| Profit Margin | Always 0% | `cost data required` (honest) |
| Avg Transaction | Always R 0.00 | Derived: revenue ÷ sales_count |
| Avg Basket | Always 0.0 items | `—` (honest — data not available) |

**Honesty principle applied:** Gross profit and avg basket size require `cost_price` data not returned by the current API. Showing `—` is correct. Showing `R 0.00` was actively misleading.

---

## Bug 2 — Pending Cashup Stored Zero for Counted Cash

### Root Cause

`completePendingCashup()` sent `closing_balance` in the request body. The `complete-cashup` endpoint destructures `{ counted_cash, counted_card, counted_other, notes }` and uses these to compute `totalCounted`. `closing_balance` is ignored entirely — so `totalCounted` was always `0 + 0 + 0 = 0`, meaning:

- `session.counted_cash = 0` stored in DB
- `session.variance = expected_cash_in_drawer - 0` = full expected amount (always wrong)

### Fix

**Before:**
```javascript
body: JSON.stringify({
    closing_balance: closingBalance,
    notes: notes
})
```

**After:**
```javascript
body: JSON.stringify({
    // Backend reads counted_cash/counted_card/counted_other, not closing_balance
    counted_cash:  closingBalance,
    counted_card:  0,
    counted_other: 0,
    notes: notes
})
```

**Note on `counted_card: 0` and `counted_other: 0`:** The pending cashup UI collects a single `closingBalance` figure (total cash counted). The full cashup form separately collects card and other counts. Pending cashup is a simplified path — submitting 0 for card/other is correct for this flow. The endpoint computes `totalCounted = counted_cash + counted_card + counted_other`, so card and other must be explicitly zeroed rather than undefined.

---

## Bug 3 — Pending Cashup Success Notification Never Fired

### Root Cause

`completePendingCashup()` checked `result.success` after the API call. The `complete-cashup` endpoint returns `{ session: data }` on success — it never sets `result.success`. So `result.success` was always `undefined` (falsy), the `else` branch always ran, and the notification always showed "Failed to complete cashup" — even on a successful cashup.

### Fix

**Before:**
```javascript
if (result.success) {
    showNotification(`Cashup completed. Variance: R ${result.variance.toFixed(2)}`, 'success');
    await loadPendingCashups();
} else {
    showNotification(result.error || 'Failed to complete cashup', 'error');
}
```

**After:**
```javascript
// Endpoint returns { session: data }, not { success: true }
if (result.session) {
    const variance = parseFloat(result.session.variance || 0);
    showNotification(`Cashup completed. Variance: R ${variance.toFixed(2)}`, 'success');
    await loadPendingCashups();
} else {
    showNotification(result.error || 'Failed to complete cashup', 'error');
}
```

---

## What Was NOT Changed

- `completeCashUp()` (main cashup flow, line ~4468) — already correct: checked `result.session`, sent `counted_cash`/`counted_card`/`counted_other`
- `manageSession()` close flow — separate code path, unaffected
- `reports.js` backend — not touched
- `sessions.js` backend — not touched
- `posReconService.js` — not touched
- All working POS reports — not touched
- No localStorage/sessionStorage business data added anywhere

---

## Test Checklist

| Test | Expected Result |
|---|---|
| Open dashboard → Today's Sales | Shows actual revenue, not R 0.00 |
| Open dashboard → Transactions | Shows actual count + voided indicator |
| Open dashboard → Gross Profit | Shows `—` (honest, not false R 0.00) |
| Open dashboard → Avg Transaction | Shows revenue ÷ count, not R 0.00 |
| Pending cashup → submit counted cash → check DB | `counted_cash` = submitted value, not 0 |
| Pending cashup → submit → variance shown | Correct variance (expected − counted), not full expected amount |
| Pending cashup → submit → notification | Shows "Cashup completed. Variance: R X" — not "Failed" |
| Main cashup flow (close session) | Unaffected — still works correctly |
| No localStorage/sessionStorage business data | Browser DevTools → Application → Storage: no payroll/sales/cashup data |

---

## What Remains (Not Fixed in This Workstream)

Per Workstream 6A findings — these are known issues, deferred to future workstreams:

| Issue | Severity | Deferred To |
|---|---|---|
| Sales summary `payment_breakdown` uses `sales.payment_method` (single column) instead of `sale_payments` table — split payments misreported | P2 | Future workstream |
| 12 sidebar report tabs return 404 — not implemented | P3 | Future workstream |
| `suspicious-activity` stub returns `activities` but frontend reads `alerts` — always empty | P3 | Future workstream |
| Gross profit / margin requires `cost_price` join — not available in dashboard API | Future API enhancement | Future workstream |
