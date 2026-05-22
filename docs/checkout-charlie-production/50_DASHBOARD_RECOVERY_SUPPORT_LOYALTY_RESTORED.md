# 50 — Dashboard, Recovery, Support & Loyalty — Restored

**Date:** 2026-05  
**Workstream:** Dashboard/Recovery/Support/Loyalty Operational Data Fix  
**Status:** COMPLETE

---

## Summary

Four enterprise tabs in Checkout Charlie POS (Dashboard, Recovery, Support, Loyalty) were showing empty panels or incorrect/stale data. This document records all root causes found, fixes applied, and known remaining placeholder sections.

---

## Root Causes and Fixes Applied

### 1. Loyalty Programs — Wrong API URL (CRITICAL BUG)

**Root cause:** `loadLoyaltyPrograms()` called `GET ${API_URL}/loyalty/programs`.  
This resolved to `/api/loyalty/programs` — a **top-level stub** in server.js that always returns `{ programs: [] }`.  
The actual loyalty backend route is `GET /api/pos/loyalty/program` (singular, under POS module).

**Fix:**
- Changed URL from `${API_URL}/loyalty/programs` → `${API_URL}/pos/loyalty/program`
- Changed response mapping from `data.programs || []` → `data.program ? [data.program] : []`
- Fixed field name mappings (backend fields vs old frontend expectations):

| Old (broken) | Correct (backend) |
|---|---|
| `p.program_name` | `p.name` |
| `p.points_per_currency` | `p.points_per_rand` |
| `p.points_value` | `p.redemption_rate` |
| `p.minimum_redemption` | `p.min_redemption_points` |
| `p.points_expiry_months` | N/A — not in schema, rendered as `—` |

**Impact:** Loyalty Programs tab now correctly loads the real program config or shows "No loyalty programs configured" empty state.

---

### 2. Loyalty Members — Placeholder Function (BUG)

**Root cause:** `searchLoyaltyMembers()` was `/* placeholder */` — entirely dead code.  
`showLoyaltyTab('members')` showed the members div but never triggered any data load.  
The `loyaltyMembersBody` tbody was perpetually stuck on "Loading members...".

**Fix:**
- Implemented `loadLoyaltyMembers(searchTerm?)` — fetches `GET /api/pos/customers?active_only=true` (optionally with search), filters for customers with loyalty data, renders into `loyaltyMembersBody` table.
- Replaced `searchLoyaltyMembers()` placeholder with a real implementation that reads the search input and calls `loadLoyaltyMembers()`.
- Added `if (tab === 'members') loadLoyaltyMembers()` to `showLoyaltyTab()`.

**Fields rendered:** Customer name, email/phone, loyalty tier, loyalty points balance.  
**Note:** `Loyalty #` and `Lifetime Spend` columns show `—` — the customers table does not store a dedicated loyalty membership number or lifetime spend total. These are future enhancements.

---

### 3. Dashboard — `dashboardActivity` Never Populated (BUG)

**Root cause:** `loadDashboard()` never fetched recent transactions. The `dashboardActivity` div was always left with its placeholder "No recent activity" HTML and never replaced with real data.

**Fix:**
- Added a `GET /api/pos/sales?limit=8&status=completed` fetch inside `loadDashboard()`.
- Renders the last 8 completed sales as a compact activity list: sale number, item count, total amount, time.
- Shows empty state if no sales found.

---

### 4. Dashboard — `low_stock_count` Never Rendered (BUG)

**Root cause:** The `/api/analytics/dashboard` endpoint returns `low_stock_count` (count of active products with `stock_quantity ≤ 10`). `loadDashboard()` fetched this value but never rendered it anywhere.

**Fix:**
- After loading dashboard data, if `low_stock_count > 0`, a warning row is prepended to `dashboardAlerts`:
  - Shows count of low-stock products and threshold (≤10 units).
  - Uses the existing `alert-row warning` CSS class.
- Also fixed minor XSS risk in the alerts renderer — alert fields are now wrapped in `escHtml()`.

---

### 5. Dashboard — XSS Safety Improvement

**Additional fix (caught during review):**  
The existing alerts renderer in the old `loadDashboard()` rendered `a.alert_type`, `a.severity`, `a.status` directly into innerHTML without escaping. These are API-sourced strings. Wrapped in `escHtml()` in the updated code.

Similarly, `l.location_name` and `l.location_type` in the locations table renderer were unescaped — also fixed.

---

## Recovery Section — Status

**No bugs found.** Recovery was working correctly:

- `loadRecovery()` reads offline queue from IndexedDB via `getAllQueuedSales()` — correct.
- `renderQueueItems()` renders queue items with retry/abandon/note actions — correct.
- `GET /api/pos/recovery/sessions` backend route (`recovery.js`) returns `{ open, stale, pending_cashup }` with session objects containing `tills.till_name`, `users.full_name`, `age_hours`, `closed_age_hours` — exactly matching `renderSessionHealth()` expectations.
- Supervisor override panel is functional.

**Recovery is fully operational.** If it appeared empty in testing, it means there are no queued offline sales and no stale/open sessions — both are correct empty states.

---

## Support Section — Status

**No bugs found.** Support (`loadSupportPanel`) was working correctly:

- `loadSupportHealth()` — calls `/api/pos/recovery/sessions` and `/api/pos/support/negative-stock`. Both routes exist and return correct shapes.
- `loadSupportTimeline()` — calls `/api/pos/support/events?limit=50`. Route exists, returns `{ events: [...] }`.
- `loadEmergencyPanel()` — exists (line 11843), calls `loadEmergencySessionsList()`, `loadEmergencyTillsList()`, `loadEmergencySyncState()`. All three functions exist and call correct routes (`/api/pos/recovery/sessions`, `/api/pos/tills`, `/api/pos/emergency/state`).

**Support is fully operational.** If panels appear empty, it means there are no open sessions, no negative stock, and no audit events — correct empty states.

---

## Known Remaining Placeholders (Not Bugs — Future Work)

| Section | What's Placeholder |
|---|---|
| Loyalty — Programs | "+ New Program" button shows "coming soon" notification |
| Loyalty — Members | "+ Enroll Customer" button shows "coming soon" notification |
| Loyalty — Promotions | "+ New Promotion" button shows "coming soon" notification; promotions list always empty (stub route at `/api/promotions`) |
| Dashboard — KPI: Gross Profit | Always `—` — requires `cost_price` data join not in current API |
| Dashboard — KPI: Avg Basket | Always `—` — item count per sale not aggregated in dashboard endpoint |
| Dashboard — KPI: Active Employees | Always `0` — no shift tracking implemented |
| Dashboard — Locations | Always "No locations configured" — `/api/locations` stub always returns `[]` |
| Recovery — Session Health | Empty-state if no stale/open sessions (correct behaviour) |

---

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/frontend-pos/index.html` | `loadLoyaltyPrograms()` — URL fix + field name fix |
| `accounting-ecosystem/frontend-pos/index.html` | `loadLoyaltyMembers()` — new function implemented |
| `accounting-ecosystem/frontend-pos/index.html` | `searchLoyaltyMembers()` — replaced placeholder with real implementation |
| `accounting-ecosystem/frontend-pos/index.html` | `showLoyaltyTab()` — added members load trigger |
| `accounting-ecosystem/frontend-pos/index.html` | `loadDashboard()` — added recent activity fetch, low_stock_count render, XSS fixes |

---

## Regression Risk Assessment

| Area | Risk | Notes |
|---|---|---|
| Loyalty programs tab | Low | URL and field fix — no business logic changed |
| Loyalty members tab | Low | New read-only fetch — no writes |
| Dashboard activity | Low | New read-only fetch from `/api/pos/sales` — existing sales route |
| Dashboard low stock | Low | Rendering only — no data mutation |
| Recovery | None | Not modified |
| Support | None | Not modified |
| Core POS checkout flow | None | None of the modified functions are in the checkout path |
