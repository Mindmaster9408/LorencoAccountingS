# 51 — Dashboard + Loyalty Restore — Verified

**Date:** 2026-05-22  
**Audit of:** Workstream in doc 50 — Dashboard/Loyalty/Recovery/Support restore fixes  
**Method:** Full static code audit of `frontend-pos/index.html` and backend routes  
**Status:** ✅ All fixes verified with one bug found and corrected during this audit

---

## Bug Found and Fixed During Verification

### REGRESSION: `async function loadPromotions()` Declaration Dropped

**Found during:** Line-by-line audit of the loyalty section.  
**Cause:** The `showLoyaltyTab` replacement in the prior workstream consumed the `async function loadPromotions() {` function declaration line. The `try {` body was orphaned — floating code inside a script block with no enclosing function. This would have caused a parse error on load, breaking the entire POS script.  
**Fix applied:** Restored `async function loadPromotions() {` declaration immediately before the orphaned `try {` block (line 9623).  
**Verification:** `function loadPromotions` now appears once at line 9623. Function body is intact and properly enclosed.

---

## Verification Results

### Dashboard

| Check | Result | Detail |
|---|---|---|
| `loadDashboard()` called on tab switch | ✅ PASS | `showTab('dashboard')` calls `loadDashboard()` at line 5905 |
| `GET /api/analytics/dashboard` — correct URL | ✅ PASS | Line 9127: `${API_URL}/analytics/dashboard` → resolved via server.js alias to `/api/reports/dashboard` |
| KPI: `kpiTodaySales` populated | ✅ PASS | `R ${parseFloat(t.revenue || 0).toFixed(2)}` |
| KPI: `kpiTodayTransactions` populated | ✅ PASS | `${t.sales_count || 0} completed · N voided` |
| KPI: `kpiGrossProfit` shows `—` | ✅ PASS | Hardcoded `—` with `cost data required` sub (cost_price not in API response — correct) |
| KPI: `kpiAvgTransaction` computed | ✅ PASS | `revenue / sales_count` when sales_count > 0 |
| KPI: `kpiAvgBasket` shows `—` | ✅ PASS | Hardcoded (item count not in dashboard endpoint — correct) |
| Low stock warning when `low_stock_count > 0` | ✅ PASS | Alert row prepended to `dashboardAlerts` with product count and threshold (≤10 units). Replaces empty-state placeholder if present; otherwise prepends before existing alert content. |
| `dashboardActivity` — recent sales load | ✅ PASS | `GET ${API_URL}/pos/sales?limit=8&status=completed` — fetches last 8 completed sales; renders sale_number, item count, total, time |
| `dashboardActivity` empty state | ✅ PASS | Shows "No recent activity" placeholder if `actData.sales` is empty or call fails |
| Loss prevention alerts (loss-prevention stub) | ✅ PASS | Stub returns `{ alerts: [] }` → "No active alerts" empty-state shown; XSS-escaped if real alerts present |
| Locations table (locations stub) | ✅ PASS | Stub returns `{ locations: [] }` → "No locations configured" shown; `escHtml()` applied to `location_name`/`location_type` |
| XSS escaping on alert fields | ✅ PASS | `a.alert_type`, `a.severity`, `a.status` all wrapped in `escHtml()` |
| XSS escaping on location fields | ✅ PASS | `l.location_name`, `l.location_type` wrapped in `escHtml()` |
| Activity render XSS safety | ✅ PASS | `s.sale_number` and `s.id` wrapped in `escHtml()` |

---

### Loyalty — Programs

| Check | Result | Detail |
|---|---|---|
| `loadLoyaltyPrograms()` called on tab switch | ✅ PASS | `showTab('loyalty')` calls `loadLoyaltyPrograms()` at line 5907 |
| URL: `/api/pos/loyalty/program` (singular, under /pos/) | ✅ PASS | Line 9545: `${API_URL}/pos/loyalty/program` — no more hit to top-level stub |
| Response mapped as single object | ✅ PASS | `data.program ? [data.program] : []` — wraps single object in array |
| Field: `p.name` | ✅ PASS | `escHtml(p.name \|\| 'Loyalty Program')` |
| Field: `p.points_per_rand` | ✅ PASS | `parseFloat(p.points_per_rand \|\| 0).toFixed(2)` |
| Field: `p.redemption_rate` | ✅ PASS | `R ${parseFloat(p.redemption_rate \|\| 0).toFixed(4)}` |
| Field: `p.min_redemption_points` | ✅ PASS | `${p.min_redemption_points \|\| 0} pts` |
| Field: Expiry | ✅ PASS | Rendered as `—` (column not in schema) |
| Field: `p.is_active` | ✅ PASS | `Active`/`Inactive` badge |
| Empty state (backend always returns default) | ✅ PASS | Backend always returns a default if no program configured — table always shows ≥1 row. Empty state message is preserved for future use. |
| XSS: `p.name` escaped | ✅ PASS | `escHtml()` applied |

**Behavioral note:** The backend `GET /api/pos/loyalty/program` always returns a default program object (name: 'Loyalty Program', `is_active: false`) even if no program has been explicitly configured. The "No loyalty programs configured" empty state will never render in current behaviour — the default inactive program is shown instead. This is correct and intentional.

---

### Loyalty — Members

| Check | Result | Detail |
|---|---|---|
| `loadLoyaltyMembers()` called on sub-tab click | ✅ PASS | `showLoyaltyTab('members')` calls `loadLoyaltyMembers()` |
| URL: `/api/pos/customers?active_only=true` | ✅ PASS | Line 9594: `${API_URL}/pos/customers?${params}` with `active_only=true` set via `URLSearchParams` |
| Search param passed when term provided | ✅ PASS | `params.set('search', searchTerm)` — routes to Supabase `ilike` filter in `customers.js` |
| `searchLoyaltyMembers()` reads input and triggers load | ✅ PASS | Reads `#loyMemberSearch` value, strips whitespace, calls `loadLoyaltyMembers(term)`. Empty search passes `undefined` → all members loaded |
| Filter: only customers with loyalty data | ✅ PASS | Filter condition: `(loyalty_points !== undefined && loyalty_points !== null) \|\| loyalty_tier`. Customers with `loyalty_points = 0` (enrolled) pass through; customers with no loyalty data (both fields null) are excluded |
| Loading state shows before fetch | ✅ PASS | `tbody.innerHTML = 'Loading members...'` set before fetch starts |
| Empty state when no loyalty members | ✅ PASS | "No loyalty members found." |
| Error state on API failure | ✅ PASS | Both non-ok response and `catch` block render red error row |
| Field: customer name | ✅ PASS | `escHtml(c.name \|\| '—')` with email/phone sub |
| Field: loyalty number | ✅ PASS | `escHtml(c.loyalty_number \|\| c.id \|\| '—')` — falls back to UUID if no dedicated number |
| Field: program | ✅ PASS | Shows `—` (join not done at customer list level — acceptable) |
| Field: tier | ✅ PASS | `escHtml(c.loyalty_tier \|\| 'Standard')` |
| Field: points balance | ✅ PASS | `parseFloat(c.loyalty_points \|\| 0).toFixed(0) pts` |
| Field: lifetime spend | ✅ PASS | Shows `—` (not stored at customer level — acceptable) |
| XSS: all string fields escaped | ✅ PASS | `name`, `email`/`phone`, `loyalty_number`/`id`, `loyalty_tier` all through `escHtml()` |

**Known limitation:** "Loyalty #" column shows the customer's DB UUID when no dedicated `loyalty_number` field is populated. This is functional but not user-friendly. A dedicated loyalty card number column is a future enhancement.

---

### Recovery

| Check | Result | Detail |
|---|---|---|
| `loadRecovery()` called on tab switch | ✅ PASS | `showTab('recovery')` calls `loadRecovery()` |
| Offline queue from IndexedDB | ✅ PASS | `getAllQueuedSales()` reads from `offlineSales` IDB store; returns `[]` if `db` not initialized (safe empty state) |
| Queue empty state | ✅ PASS | "Queue is empty — no pending or failed offline sales." (green) |
| Session health API: `/api/pos/recovery/sessions` | ✅ PASS | Backend returns `{ open, stale, pending_cashup }` — matches `renderSessionHealth(data)` field expectations exactly |
| Session health empty state | ✅ PASS | "All sessions healthy — no open, stale, or uncashed sessions." (green) when all three arrays empty |
| Session health fields: `tills.till_name`, `users.full_name`, `age_hours` | ✅ PASS | Backend Supabase query: `select('*, tills(till_name, till_number), users:user_id(username, full_name)')` — all fields present |
| Emergency panel: `loadEmergencyPanel()` | ✅ PASS | Exists at line 11843; calls `loadEmergencySessionsList()`, `loadEmergencyTillsList()`, `loadEmergencySyncState()` — all three functions exist |
| Role gate: recovery hidden from cashiers | ✅ PASS | `RECOVERY_ALLOWED_ROLES` check in `applyRoleBasedVisibility()` hides nav tab for non-manager roles; backend `requirePermission('SETTINGS.EDIT')` enforces at API level |

**Conclusion:** Recovery was not broken before this workstream and remains correct.

---

### Support

| Check | Result | Detail |
|---|---|---|
| `loadSupportPanel()` called on tab switch | ✅ PASS | `showTab('support')` calls `loadSupportPanel()` |
| `loadSupportHealth()` | ✅ PASS | Calls `/api/pos/recovery/sessions` (confirmed ✅) and `/api/pos/support/negative-stock` (route confirmed ✅) |
| `loadSupportTimeline()` | ✅ PASS | Calls `/api/pos/support/events?limit=50` — route exists in `support.js`, returns `{ events: [...] }` |
| `loadEmergencyPanel()` | ✅ PASS | Exists and functional — verified above |
| Support health empty states | ✅ PASS | Renders "All sessions healthy" when no open/stale sessions; negative stock count is 0 when stock is healthy |
| Support timeline empty state | ✅ PASS | Renders "No events recorded yet." when events array is empty |
| Role gate: support hidden from cashiers | ✅ PASS | Same `RECOVERY_ALLOWED_ROLES` gate as recovery |

**Conclusion:** Support was not broken before this workstream and remains correct.

---

### localStorage / sessionStorage Business Data Audit

| Check | Result | Detail |
|---|---|---|
| All `localStorage.setItem` calls | ✅ PASS | 11 occurrences — all are `token` JWT writes or `isSuperAdmin` flag. One is an availability probe (`_probe` key set then immediately removed). None contain business data. |
| All `sessionStorage.setItem` calls | ✅ PASS | 0 occurrences in `frontend-pos/index.html` |
| New code introduced in this workstream | ✅ PASS | No localStorage/sessionStorage writes in any of the new functions (`loadDashboard`, `loadLoyaltyMembers`, `loadLoyaltyPrograms`, `searchLoyaltyMembers`, `showLoyaltyTab`) |

---

### Function Declaration Integrity Check

| Function | Occurrences | Line | Status |
|---|---|---|---|
| `loadDashboard` | 1 | 9125 | ✅ |
| `loadLoyaltyPrograms` | 1 | 9543 | ✅ |
| `showLoyaltyTab` | 1 | 9573 | ✅ |
| `loadLoyaltyMembers` | 1 | 9585 | ✅ |
| `searchLoyaltyMembers` | 1 | 9618 | ✅ (placeholder removed) |
| `loadPromotions` | 1 | 9623 | ✅ (declaration restored — see bug fix above) |

No duplicate declarations. No orphaned function bodies.

---

## Remaining Placeholder Sections

These are known stubs — not bugs introduced by this workstream.

| Section | What's Placeholder | Impact |
|---|---|---|
| Loyalty → Programs → "+ New Program" | Shows "coming soon" notification | No data entry possible — create is a future workstream |
| Loyalty → Members → "+ Enroll Customer" | Shows "coming soon" notification | Enrollment via POS not yet built |
| Loyalty → Promotions | Always empty — `/api/promotions` stub returns `{ promotions: [] }` | Promotions not yet implemented in backend |
| Loyalty → Members "Program" column | Always `—` | Joining customer → program requires loyalty_transactions join not done at list level |
| Loyalty → Members "Lifetime Spend" column | Always `—` | Not stored per-customer in schema |
| Loyalty → Members "Loyalty #" column | Shows DB UUID when no `loyalty_number` | No dedicated loyalty card number column in schema |
| Dashboard → KPI: Gross Profit | Always `—` | Requires cost_price join, not in dashboard endpoint |
| Dashboard → KPI: Avg Basket | Always `—` | Item count per sale not aggregated in dashboard endpoint |
| Dashboard → KPI: Active Employees | Always `0` | No shift/clock-in tracking implemented |
| Dashboard → Location Performance | Always "No locations configured" | `/api/locations` stub returns `[]` |
| Dashboard → Loss Prevention Alerts | Always "No active alerts" | `/api/loss-prevention/alerts` stub returns `[]` |

---

## Summary

| Category | Result |
|---|---|
| Dashboard KPIs load | ✅ PASS |
| Recent Activity loads | ✅ PASS |
| Low stock warning renders | ✅ PASS |
| Loyalty Programs correct URL + mapping | ✅ PASS |
| Loyalty Members loads and filters | ✅ PASS |
| Loyalty member search works | ✅ PASS |
| Loyalty empty states correct | ✅ PASS |
| Recovery empty states correct | ✅ PASS |
| Support empty states correct | ✅ PASS |
| XSS escaping on all new renders | ✅ PASS |
| No localStorage/sessionStorage business data | ✅ PASS |
| No console-error-prone orphaned code | ✅ PASS (after `loadPromotions` fix) |
| Regression introduced in this workstream | ⚠️ 1 found and fixed — `loadPromotions` declaration dropped |
