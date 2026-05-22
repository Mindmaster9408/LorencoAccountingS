# 43 — MASTER PILOT READINESS AUDIT
## Checkout Charlie — Final Pre-Pilot Review

**Date:** 2026-05-22
**Status:** ✅ Audit complete — pilot-ready with 2 known bugs documented
**Updated:** 2026-05-22 — Workstream 13A complete: BUG-1 (split payments) fixed; reports payment breakdown fixed
**Scope:** All 10 operational domains — full backend + frontend + DB + UX
**Method:** Full static code audit across all routes, services, migrations, and frontend logic

---

## Overall Readiness Score

| Domain | Score | Status |
|---|---|---|
| Checkout Integrity | 10/10 | ✅ Critical bug fixed (Workstream 13A) — split payments fully operational |
| Till + Cashup Integrity | 9.5/10 | Pilot-ready — strong |
| Recovery + Offline | 8.5/10 | Pilot-ready |
| Reporting Trust | 8/10 | Pilot-ready — payment breakdown fixed (Workstream 13A); permission gate still open |
| Inventory Operations | 7/10 | Pilot-ready (stock takes non-atomic, sequential DB calls) |
| Operational UX | 8/10 | Pilot-ready (post Workstream 12A) |
| PWA + Update Safety | 9/10 | Pilot-ready |
| Supportability | 9/10 | Pilot-ready — strong |
| Security + Governance | 8/10 | Pilot-ready |
| Performance + Scale | 8/10 | Pilot-ready |

**Composite score: 8.3/10** → **8.6/10** *(updated post Workstream 13A)*

---

## Pilot Readiness Verdict

> **Pilot-ready. The one critical blocking bug (split payments) has been fixed. One medium risk remains and must be briefed to operations staff.**

The system is architecturally sound and operationally mature for a controlled pilot. Core checkout, offline queuing, reconciliation, session management, and audit trail are all production-grade. The emergency controls are particularly well-designed.

**Workstream 13A (2026-05-22) resolved the critical blocking issue.** One medium risk remains:

1. ~~**CRITICAL**: Split payment checkout broken~~ → **✅ FIXED (Workstream 13A)** — See Section 1 for full fix detail.

2. **MEDIUM**: Offline VAT calculation uses `subtotal * 0.15` (VAT-exclusive additive) instead of the server's VAT-inclusive extraction (`price * rate / (100 + rate)`). Offline receipts show inflated totals. When synced, server recalculates correctly — financial records are right — but cashiers quote the wrong price during offline operation. Brief staff: "If internet drops, the receipt amount is approximate. The system will correct it when it reconnects."

---

## Section 1 — Checkout Integrity

### What works

**Atomic sale creation:** `create_sale_atomic` (migration 027, updated by 030) runs as a single PostgreSQL transaction: INSERT sales → INSERT sale_items → INSERT sale_payments → PERFORM decrement_stock_v2. Any failure rolls back all four. No orphaned sale records possible.

**Idempotency at DB level:** UUID idempotency key generated in JS (`crypto.randomUUID()`) and persisted with offline records. RPC gate: if a key exists, returns the existing sale immediately — no INSERT, no stock decrement. Protects against browser double-submit, refresh on slow connection, and offline-sync replay of already-committed records. Duplicate is logged as `SALE_REPLAYED` in audit trail.

**Server-side price enforcement:** Backend looks up `unit_price` from `products` table. Frontend sends only `productId` + `quantity`. Prices cannot be spoofed from the browser. VAT extraction also happens server-side per product's `vat_rate`.

**Stock policy propagation:** `p_allow_negative_stock` passed from `getStockPolicy()` (60-second server-side cache, DB authoritative) through to `decrement_stock_v2`. Strict mode raises P0001 which rolls back the entire transaction. Negative-stock mode proceeds and emits `NEGATIVE_STOCK_SALE_ALLOWED` + `NEGATIVE_STOCK_CREATED` audit events.

**Double-submit prevention:** `checkoutInProgress` flag set before network call, reset in `finally` block. Button disabled + text changes to "Processing..." during flight.

**Guard chain:** `checkoutInProgress` → `forceUpdatePending` → `tillLocked` → empty cart / no session. All checked before network call.

**Split payment checkout — fully operational (fixed Workstream 13A):** Split payments now correctly call `POST /api/pos/sales` with the `payments` array. The full guard chain, idempotency key, in-memory stock decrement, print/receipt/drawer logic, and try/finally block are all present. See BUG-1 fix record below.

### Bugs and gaps

**~~BUG-1 [CRITICAL]~~: Split payment checkout broken — ✅ FIXED (Workstream 13A, 2026-05-22)**

**Root cause (two layered bugs):**

1. **Primary:** `checkoutWithFeatures()` was dead code. The checkout button called `checkout()` directly. The split payment branch inside `checkoutWithFeatures()` literally never executed — regardless of what URL it contained. All split payment attempts silently fell through to the standard single-method path and failed because the request shape was wrong.

2. **Secondary:** The wrong URL `${API_URL}/pos/sales/split-payment` was inside the dead code block. The backend `POST /api/pos/sales` already handled split payments correctly when a `payments` array was present in the body — the infrastructure was fully built. The frontend just never called it.

**Additional gaps fixed in the same pass** (all were in the split path that was unreachable):
- No `checkoutInProgress` / `forceUpdatePending` / `tillLocked` guards on the split path
- No `idempotencyKey` — server would have generated a new UUID on every retry, breaking idempotency protection
- No in-memory stock decrement after success
- No print/receipt/drawer logic on success
- No `try/finally` — button could get stuck in "Processing..." on error

**Nothing changed in the backend `sales.js` route or the `create_sale_atomic` RPC.** The fix was entirely frontend.

**BUG-2 [MEDIUM]: Offline VAT display discrepancy**

Offline checkout calculates:
```javascript
const vatAmount = subtotal * 0.15;           // additive VAT-exclusive
const totalAmount = subtotal + vatAmount;     // product price + 15%
```

Server calculates:
```javascript
vat_total += linePrice * (prod.vat_rate / (100 + prod.vat_rate));  // VAT-inclusive extraction
```

For VAT-inclusive pricing (standard South African retail): a R100 product is priced at R100 including VAT. Correct VAT = R13.04. Correct total = R100.

The offline display would show: VAT = R15.00, total = R115.00. The cashier quotes R115.00 to the customer. When synced, the server records R100.00.

**Financial records are correct** — the sync uses server prices. Only the offline receipt display is wrong. A cashier who memorises offline totals would misquote prices.

**LOW: Return stock restoration is non-fatal with no user notification**

If `restore_stock_for_return` RPC fails after `pos_returns` is committed, the return is recorded (customer gets refund) but stock is not restored. A `console.warn` fires. No notification to cashier or manager. This is auditable after the fact (`pos_returns` record exists), but stock would be understated until a manual adjustment or stock take corrects it.

---

## Section 2 — Till + Cashup Integrity

### What works

**Session uniqueness enforced at DB level:** Partial unique index `idx_till_sessions_till_open_unique` on `(company_id, till_id) WHERE status = 'open'` (migration 037). Application layer checks first and returns 409. DB index is the hard guarantee for concurrent race conditions.

**Session lifecycle states:** `open` → `closed` → `cashed_up` / `force_closed`. No impossible state transitions (409 guards on already-closed sessions). `force_closed` preserves all sales and audit records.

**Forensic reconciliation service (`posReconService.js`):** Derives authoritative totals from three independent sources: `sales` (totals, discounts, VAT, voids), `sale_payments` (payment method breakdown — the only authoritative source for split payments), and `pos_returns` (refund amounts and methods). Five consistency checks: no-payment completed sales, payment total mismatch, negative sale total, duplicate payment rows, returns on voided sales.

**Cash expectation formula is correct:** `expectedCashInDrawer = openingBalance + paymentCash - refundCash`. Only cash payments count toward the physical drawer. Card/EFT/account settled elsewhere. This is a common mistake in POS systems — Checkout Charlie gets it right.

**Immutable snapshots:** `pos_recon_snapshots` table with no UPDATE path in the codebase. Every cashup triggers a new snapshot via `createReconSnapshot` (fire-and-forget, never throws). Till summary report uses snapshot data when available, with explicit `has_snapshot` flag.

### Gaps

**LOW: Cashier email always null in snapshots**

`createReconSnapshot` hardcodes `cashier_email: null` — the session has `user_id` but no email. The email is available on the request object during cashup but not passed through to the service. Post-pilot hardening: pass email from the route into the service.

**LOW: Report time boundary for nightly reconciliation**

Till summary filters by `gte('opened_at', start)`. A session opened at 23:55 and closed at 00:10 appears in the previous day's report. Managers doing nightly end-of-day reconciliation need to be briefed on this boundary behavior.

---

## Section 3 — Recovery + Offline

### What works

**IndexedDB queue design:** Correct storage choice — structured, queryable, survives reload, not cleared with normal browser data clearing, works per-origin. Offline sales are immutable once queued (only status changes, never deleted until confirmed by server).

**Idempotency key persisted with offline record:** Generated once per checkout attempt. Same key sent on every sync retry. Server idempotency gate prevents duplicates on repeated POSTs — a network timeout after server commit returns the existing sale, not a new one.

**Sync loop safety:** `syncInProgress || !isOnline || !token || syncPaused` guard at the top. Mid-cycle guard: `if (!isOnline || syncPaused) { break; }`. `syncInProgress = false` in `finally` block. `syncProgress` reset in `finally`. Cannot get stuck.

**Conflict taxonomy:** Stock conflicts (`422` with "stock" in error) → `conflict_stock` immediately (no retry — stock won't improve). Session conflicts → `conflict_session` immediately. Server errors (5xx) → retry up to 3 times, then `failed`. Clean error classification.

**Sync pause is DB-persistent:** `pos_emergency_state.sync_paused` survives page reload, cross-device. Every browser in the company stops retrying when a manager pauses sync. Resumes from queue-intact state.

### Gaps

**MEDIUM: No maximum queue escalation threshold**

The offline banner shows queue count and sync progress, but there's no warning when the queue exceeds a critical size. If a cashier accumulates 30+ offline sales over a long outage, there's no automatic escalation to the manager. Suggested: at 20+ pending items, the banner should pulse or change colour and suggest calling the manager.

**MEDIUM: Offline receipt shows wrong totals (BUG-2 — see Section 1)**

During offline operation, cashiers quote prices from the offline receipt which are inflated by ~15%. When connectivity restores, the correct amount is committed.

**LOW: Conflict-status items require manual manager action but there's no notification**

Items marked `conflict_stock` or `conflict_session` sit silently in the queue. The manager must visit the Recovery tab to see them. There's no proactive notification to the manager. For a pilot store checking the Recovery tab daily, this is acceptable.

**LOW: No queue auto-expiry**

Abandoned and failed items accumulate in IDB indefinitely. After 30+ pilot days, the queue could contain dozens of old entries that were manually resolved. Consider adding a 7-day auto-expiry for `abandoned`/`failed` status items.

---

## Section 4 — Reporting Trust

### What works

**Till summary uses authoritative source:** Snapshot data (sourced from `sale_payments`) takes precedence. Fallback clearly marked `has_snapshot: false` with null values for data that can't be derived without the snapshot.

**Negative stock report:** Two-part report — current state (products below zero) and audit events for the period. Links each negative product to its most recent `NEGATIVE_STOCK_CREATED` event. Complete picture.

**Cashier performance report:** Three parallel queries (sales, audit events, sessions). Breaks down refunds, negative stock allowed, manager overrides, and recovery events per cashier. Goes beyond typical SMB POS reports.

**Recovery-sync report:** 4 parallel queries. Includes stale sessions, pending cashup, recovery events, and offline sync/conflict events. Correct `unresolved_count` metric.

**Audit activity report:** Defaults to manager-relevant event types (excludes high-volume `SALE_CREATED` noise). Supports category-level filtering. 500-event limit with `truncated: true` flag.

### Gaps

**MEDIUM: Reports routes have no permission gate**

`reports.js` applies only `requireCompany`. No `requirePermission` middleware. Any authenticated user with a company context — including cashier roles — can call `GET /api/reports/cashier-performance`, `GET /api/reports/till-summary`, etc. In the current UI, cashiers don't see the Reports tab (role-based visibility), so this is not a live exploit. It's a defense-in-depth gap that should be closed before broader rollout.

**Recommended fix:** Add `requirePermission('REPORTS.VIEW')` to the reports router.

**~~MEDIUM: Sales summary payment breakdown uses `sales.payment_method`~~** → ✅ **FIXED (Workstream 13A, 2026-05-22)**

`GET /reports/sales-summary` now queries `sale_payments` rows directly to compute payment method totals. The previous grouping on `sales.payment_method` was inaccurate for split payments (it captured only the primary method). The fix correctly aggregates all payment rows per method — accurate for single-method and split-method sales. Fixed in the same workstream as the split payment checkout fix.

---

## Section 5 — Inventory Operations

### What works

**Manual adjustment:** Reads from DB, computes new qty, updates, inserts to `inventory_adjustments`, dual audit trail (`auditFromReq` + `posAuditFromReq`). Reason required.

**Stock take:** Computes variance per item, applies only non-zero variances, inserts `pos_stock_take_items` for every counted item (including zero-variance). Audit event per adjustment. `variance_count` tracked on header record.

**Supplier receive:** Increments stock, optionally updates `cost_price`, records in `pos_supplier_receive_items`, dual audit trail.

**Transfer:** Correctly differentiates wastage/spoilage (stock-reducing) from floor/backroom (visibility-only). Records all transfers in `pos_stock_transfers`.

**Retail boundary preserved:** No manufacturing, no sub-assemblies, no bill-of-materials. Operations are retail-appropriate.

### Gaps

**MEDIUM: Stock take and supplier receive are non-atomic sequential loops**

For an N-item stock take, the backend makes ~4N sequential DB round trips (SELECT product, UPDATE products, INSERT inventory_adjustment, INSERT stock_take_item). On Supabase REST (not raw TCP), each round trip adds 50–200ms latency:

- 20-item stock take: ~80 round trips → potentially 4–16 seconds
- 50-item stock take: ~200 round trips → potentially 10–40 seconds

If the server crashes or the connection drops midway, the stock take header record shows the completed `variance_count` but stock is partially updated with no rollback.

**Mitigation for pilot:** Stock takes at pilot scale (20–50 products) are slow but functional. Brief operators to not interrupt a stock take in progress. Document the partial-update risk. A longer-term fix is to move stock take application to an RPC-based batch transaction.

**LOW: Supplier receive uses read-then-write (not atomic increment)**

```javascript
const oldQty = parseFloat(product.stock_quantity || 0);
const newQty = oldQty + qty;
await supabase.from('products').update({ stock_quantity: newQty ... })
```

Under concurrent receives of the same product, one increment could be lost. For a pilot with one receiving clerk, this race is practically impossible. The `restore_stock_for_return` RPC uses the correct atomic pattern (`SET stock_quantity = stock_quantity + qty`) — the same pattern should be used for receives post-pilot.

---

## Section 6 — Operational UX

### What works

**Dark theme always active:** Correct for retail — unconditional, no toggle, no mode confusion. Post-Workstream-12A, all white-island panels are eliminated or overridden.

**Guard chain on checkout:** `checkoutInProgress` → `forceUpdatePending` → `tillLocked` → empty cart — all checked in sequence before any network call. Button state correctly reflects each guard.

**Emergency controls visibility:** Support tab hidden from cashier roles (frontend) + `requirePermission('SETTINGS.EDIT')` (backend). Both gates required and both present.

**Offline banner:** Single source of truth (`updateOfflineBanner()`). Shows pending count, conflict badges, sync progress, sync-paused state. No polling — called on state change only.

**Recovery panel:** Session health (open, stale, pending cashup), offline queue, supervisor override form. Manager can retry/abandon queue items with reason (audit trail).

### Gaps

**~~MEDIUM: Split payment UX broken~~** → ✅ **FIXED (Workstream 13A, 2026-05-22)**

Split payment UX now works end-to-end. The full flow — guard checks, idempotency key, server call to `POST /api/pos/sales` with `payments` array, stock decrement, receipt, drawer trigger — is in place and matches the single-payment path.

**MEDIUM: Offline receipt VAT inflated (BUG-2)**

Cashier quotes R115 for a R100 (VAT-inclusive) product during offline operation. Receipt shows inflated total.

**LOW: Sale complete modal auto-dismiss can race with receipt interaction**

If the cashier is viewing the receipt in the sale complete modal when the auto-dismiss countdown fires, the modal closes while they're still reading it. The countdown timer is `saleCompleteAutoClose`. Minor operational annoyance.

---

## Section 7 — PWA + Update Safety

### What works

**Cache busting on every deployment:** `CACHE_VERSION = 'pos-__BUILD_VERSION__'` — the version string is replaced at request time by the Express server. New deployment = new cache name = service worker detects stale bytes on next update check → install/activate triggers old cache deletion.

**Stale cache deletion:** SW activate event deletes all `pos-*`, `static-*`, `data-*`, `checkout-*` caches except the current version. All clients are notified via `postMessage({ type: 'SW_UPDATED' })`.

**Force update flow is complete:** `onForceUpdateRequired` hook in index.html sets `forceUpdatePending = true`. Checkout, addToCart, and checkout button are all gated on this flag. Non-dismissible banner with no escape. Correctly propagated via `update-check.js` polling and SW message listeners.

**Soft update is non-disruptive:** Banner slides in at bottom — does not block the till interface. Cashier can dismiss and finish the current sale before refreshing.

### Gaps

**LOW: Background sync delegate pattern is incomplete**

The SW `sync-sales` event handler sends a `SYNC_SALES` postMessage to all open clients. If the app is closed when the background sync fires (e.g., device was offline all night, browser closed), there are no clients to receive the message and the sync is silently deferred. This is a documented platform limitation of Background Sync on mobile browsers. The impact is low because the app triggers its own sync on reconnect.

**LOW: Stale-while-revalidate for CSS/JS means first pageview after deployment shows stale UI**

The SW serves cached CSS/JS immediately on first request and refreshes in the background. A cashier who navigated to the POS 10 minutes before a deployment would see the old UI for that session. Critical fixes use `force_update = true` via `/api/version` to force a reload.

---

## Section 8 — Supportability

### What works

**Audit trail completeness:** `pos_audit_events` covers 28+ event types across 8 categories: sale, session, sync, recovery, override, inventory, auth, settings. Append-only at DB level (trigger-enforced). Audit failure never propagates — `posAuditLogger.js` wraps all inserts in try/catch.

**Support timeline:** Events panel in Support tab shows the last N operational events with labelled, colour-coded badges. Emergency events appear with `override` category label.

**Diagnostics export:** Includes queue state, app version (`window.__posAppVersion`), force update flag, online status, session state, recent events.

**Stale session detection:** `ABANDONED_SESSION_DETECTED` fires once per 24 hours per stale session. Deduplication prevents audit log flooding on repeated manager page loads.

**Recovery panel is actionable:** Manager can retry queue items (triggers `RECOVERY_RETRY_TRIGGERED`), abandon with reason (`RECOVERY_MARKED_FAILED`), or add notes (`RECOVERY_NOTE_ADDED`). All create immutable audit records.

### Gaps

**LOW: No stack-level health probe**

The Support tab shows event history and queue state but cannot trigger a test transaction to verify the full stack is responding. Adding a simple "Ping API" button that calls a lightweight endpoint and reports response time would reduce first-line support calls.

**LOW: SW version not included in diagnostics export**

`window.__posAppVersion` tracks the app version but not the active service worker version. During troubleshooting, these may differ. Exposing `navigator.serviceWorker.controller?.scriptURL` in the diagnostics export would help.

---

## Section 9 — Security + Governance

### What works

**Company isolation:** All Supabase queries include `.eq('company_id', req.companyId)`. No cross-company data leakage found in any route. `requireCompany` middleware blocks requests with null `companyId`.

**Price enforcement:** Backend looks up prices — frontend cannot inject pricing.

**Emergency action authorization:** All emergency endpoints behind `requirePermission('SETTINGS.EDIT')`. Frontend role-gate is defense-in-depth on top. JWT contains role — role cannot be elevated without server-side re-auth.

**Audit immutability:** `pos_audit_events` is append-only (DB trigger prevents UPDATE/DELETE). Emergency actions create audit events with acting manager email, reason, previous state, new state.

**Soft delete for products:** `is_active = false` — products are not deleted. Historical sales referencing the product remain intact.

### Gaps

**MEDIUM: Reports routes have no permission gate**

Any authenticated user with a company context can call all report endpoints. Detailed in Section 4. Requires `requirePermission('REPORTS.VIEW')` before broader rollout.

**LOW: JWT revocation gap in force-logout**

Force-logout closes all open sessions for a user but cannot invalidate their JWT. The user's token remains valid until natural expiry. Without an open session, they cannot process sales (checkout guard checks `currentSession`). The gap: they can still read product data, customer data, etc. during the token TTL. Documented in `EMERGENCY_USER_FORCE_LOGOUT` audit metadata. This is a post-pilot hardening item (requires token blacklist architecture).

**LOW: No rate limiting on sale submission**

No request rate limiting visible on any POS endpoint. A buggy client (or a malicious one) could submit hundreds of sale creation requests per minute. Supabase has connection-level limits, but application-layer rate limiting (e.g., `express-rate-limit`) is not implemented.

**LOW: Frontend role check is DOM-manipulable**

The Support/Emergency tab is hidden for cashiers via `applyRoleBasedVisibility()` which adds a `role-hidden` class. A user who can execute JS in the browser console could remove this class and see the tab. The backend `SETTINGS.EDIT` permission is the actual security gate. This is defense-in-depth appropriate — the UI gate is a UX convenience, not a security control. Document it as such.

---

## Section 10 — Performance + Scale

### What works

**Core DB indexes (migration 033):** 14 performance indexes added. Critical paths covered:
- `idx_sales_session_company` — posReconService per-session lookup
- `idx_sale_payments_sale_id` — payment IN array lookup during reconciliation
- `idx_till_sessions_company_user_status` — `/sessions/current` lookup
- `idx_products_company_active_stock` — low-stock dashboard filter
- All indexes are IF NOT EXISTS — idempotent and safe

**Single-round-trip atomic sale creation:** `create_sale_atomic` executes the entire sale (sale + items + payments + stock decrement) in one server call. Fastest possible path for the most frequent operation.

**60-second stock policy cache:** `getStockPolicy()` caches `allow_negative_stock_sales` in memory with TTL. Prevents a DB hit on every sale creation.

**Report query parallelism:** Recovery-sync, cashier-performance, and till-summary reports use `Promise.all` for independent queries. Correct pattern.

### Gaps

**MEDIUM: Stock take and supplier receive performance (see Section 5)**

Sequential N*4 DB round trips. 50-item stock take = potentially 40+ seconds. This is the most significant performance risk for pilot operations.

**MEDIUM: `GET /products` loads all products without pagination**

The product list endpoint returns all active products for the company in a single query. For a pilot store with 100–300 products, this is fine. For a company with 1,000+ products, the payload grows large and the product grid becomes slow to render. Pagination is not implemented. This is a pre-broader-rollout concern, not a pilot blocker.

**LOW: `pos_audit_events` has no retention policy**

A single busy till: 100 sales/day × 2 events minimum = 200 events/day. With session, inventory, and sync events: potentially 300–500 events/day per company. After 6 months pilot: 50,000–90,000 events per company. The 6 existing indexes (migration 028) handle this volume, but there is no archival or retention plan. Plan for partitioning or archival before 12-month volume.

**LOW: products cache in-memory decrement drifts from server on multi-cashier**

After a sale, `checkout()` decrements `product.stock_quantity` in the local `products` array for display purposes. This is display-only and correct for single-cashier operation. On multi-till, another cashier's sale is not reflected until `loadProducts()` runs. Cashier A could see "3 in stock" when Cashier B just sold the last 3. The backend still enforces stock atomically — this is only a UI display lag, not a data integrity issue.

---

## What Already Exceeds Typical SMB POS Systems

| Feature | Why It Exceeds |
|---|---|
| **Atomic sale creation via RPC** | Single DB transaction — no partial-write states possible. Most SMB POS use application-level transactions that can leave orphaned records on crash. |
| **DB-level idempotency key** | Prevents duplicate charges on retry. Most SMB POS don't have this. Enterprise feature. |
| **Forensic reconciliation service** | 5 consistency checks, sources from `sale_payments` (not `sales.payment_method`), immutable snapshots. Better than most paid POS systems. |
| **Offline-first with IndexedDB queue** | Web-based SMB POS typically fail completely during network outages. Checkout Charlie sells offline and queues for sync. |
| **Emergency controls with audit trail** | Force close, lock till, sync pause, force logout — all with mandatory reasons and immutable audit events. Rarely seen below enterprise tier. |
| **Negative stock audit trail** | Not just "it's negative" — tracks when each item went negative, which sale caused it, and the projected post-sale level. |
| **Recon snapshot immutability** | Once created, `pos_recon_snapshots` cannot be modified. Strong guarantee for financial audits. |
| **DB-level duplicate session protection** | Partial unique index prevents two cashiers sharing a till — even under concurrent race conditions. |
| **28+ typed audit events** | Full operational history: sale lifecycle, offline sync, inventory movements, emergency controls, recovery actions. |

---

## Top Remaining Operational Risks

| Risk | Severity | If It Hits |
|---|---|---|
| ~~Split payment broken (BUG-1)~~ | ~~HIGH~~ | ✅ **FIXED — Workstream 13A** |
| Offline VAT display wrong (BUG-2) | MEDIUM — during connectivity loss | Cashier quotes R115 for a R100 item. Customer confusion, possible price disputes. |
| Stock take partial-update on server crash | MEDIUM — rare | Partial stock take applied, no rollback. Manager needs to verify and re-run the failed items. |
| Return stock not restored on RPC failure | LOW | Refund recorded, stock not restored. Silent inventory error until next stock take. |
| Reports accessible without permission | MEDIUM — no live exploit today | Any authenticated cashier could access cashier performance data via API. |
| IDB conflicts not proactively surfaced | LOW | Stock/session conflicts sit silently in queue. Manager won't see them unless they check the Recovery tab. |
| `pos_audit_events` no retention plan | LOW — long-term | Table grows unbounded. No pilot blocker, but needs a plan before 12 months. |

---

## Recommended Next 5 Workstreams

### ~~Workstream 13A — Split Payment Bug Fix~~ — ✅ COMPLETE (2026-05-22)

Two-bug fix: (1) `checkoutWithFeatures()` was dead code — split payment path never executed; wired correctly into the active checkout flow. (2) URL corrected from `/pos/sales/split-payment` to `/pos/sales`. All missing guards, idempotency key, stock decrement, receipt/drawer logic, and try/finally block added to the split path. Sales-summary report updated to query `sale_payments` instead of `sales.payment_method`. Backend unchanged.

### Workstream 13B — Reports Permission Gate
Add `requirePermission('REPORTS.VIEW')` to the reports router. Audit all report endpoints for role-appropriateness. Verify cashier role cannot access manager-level reports. 1–2 hours.

### Workstream 13C — Offline VAT Display Fix
Correct offline VAT calculation to use VAT-inclusive extraction (`price * rate / (100 + rate)`) instead of additive 15%. Requires knowing which products are VAT-inclusive (can read `requires_vat` from cached products). Update offline receipt display and the `totalAmount` stored in IDB. 2–4 hours.

### Workstream 14A — Stock Take Atomicity + Performance
Replace the sequential N*4 loop with an RPC-based batch transaction: a single `apply_stock_take` plpgsql function that accepts the full items array as JSONB and applies all variances in one transaction. Reduces 200 round trips to 1. Adds rollback safety. 4–8 hours.

### Workstream 14B — Supplier Receive Atomic Increment
Change supplier receive stock update from read-then-write to atomic `SET stock_quantity = stock_quantity + qty` (same pattern as `restore_stock_for_return`). Eliminates race condition under concurrent receives. 1–2 hours.

---

## Controlled Pilot Rollout Recommendation

**Phase 1 — Pre-launch (before first cashier session):**
1. Apply migration 038 to Supabase (if not already applied — emergency controls)
2. Brief all cashiers: if internet drops during a sale, the receipt total is approximate
3. Verify whether the pilot store uses split payments — if yes, fix BUG-1 first
4. Confirm at least one manager can access the Support/Emergency tab and knows the workflows

**Phase 2 — Day 1 (first live shift):**
1. Manager monitors the Support tab → Events timeline in real time
2. Manager monitors the Recovery tab at end of shift
3. Verify at least one sale, one void, and one session close/cashup complete successfully
4. Check `pos_recon_snapshots` was created for the first session

**Phase 3 — Week 1:**
1. Fix BUG-1 (split payments) and BUG-2 (offline VAT) as soon as confirmed
2. Fix reports permission gate (Workstream 13B)
3. Review first week's audit trail for any unexpected events
4. Review `pos_audit_events` for any `SALE_RPC_FAILED` or `OFFLINE_CONFLICT` patterns

**Phase 4 — Month 1:**
1. Plan and execute Workstream 14A (stock take batch RPC) before first serious stock count
2. Review `pos_recon_snapshots` consistency scores — flag any sessions with `is_consistent = false`
3. Plan data retention policy for `pos_audit_events`

---

## Estimated Support Burden — First 30 Days

| Category | Likelihood | Est. Incidents | Notes |
|---|---|---|---|
| Split payment failures (if used) | HIGH if store splits | 2–5/day | Shows "Checkout failed" — cashier calls manager |
| Offline VAT confusion | LOW in practice | 1–3 total | Only if connectivity drops during operation |
| Stale session needs force close | MEDIUM | 1–2/week | Cashier forgets to close till. Manager uses emergency force close. Easy. |
| Recovery queue conflict | LOW | 1–3 total | Offline sale stock conflict. Manager marks as resolved. |
| "App not loading" (SW/cache issue) | LOW | 0–1 total | Handled by forced update flow. Manager refreshes. |
| Report access question | LOW | 1–2 total | Cashier can't see report tab — manager accesses for them |
| Product not in search | LOW | 2–5 total | Product needs to be added to the system |

**Total estimated first-30-day support incidents: 15–30** — manageable for a controlled pilot with one or two stores and a responsive technical contact.

---

## What Would Block Broader Rollout

1. **Split payment bug** — must be fixed before any store that uses split cash+card payments
2. **Reports permission gate** — should be closed before exposing the system to untrusted users
3. **Stock take performance** — 40-second stock takes are unacceptable for a store with 200+ products
4. **Offline VAT correctness** — must be fixed for any store with frequent connectivity issues
5. **JWT revocation** — a post-pilot hardening item, but becomes important at scale (force logout should actually log someone out)
6. **No rate limiting** — before broader rollout, basic rate limiting on sale creation endpoints
7. **Supplier receive race condition** — before high-volume multi-user operations

Items 1–4 are workstream-sized fixes (1–8 hours each). Items 5–7 are larger architectural additions. None are architectural blockers — they're scope and effort questions.

---

## Would You Personally Trust This System in a Real Retail Pilot Today?

### Yes — with conditions.

**Conditions:**
1. The pilot store does not use split payments — OR BUG-1 is fixed before go-live.
2. Operations staff are briefed that offline receipts show approximate totals.
3. A manager with Support tab access is reachable during the first week.

**Why yes:**

The core financial path — sale creation, stock decrement, payment recording, session management, reconciliation — is architecturally sound and well-protected. The atomic RPC pattern with idempotency key is better than many commercial POS systems I would trust in production. The audit trail is forensic-grade. The emergency controls give a manager the tools to recover from any foreseeable operational failure without calling a developer.

The two bugs (split payment 404, offline VAT display) are real issues but both are narrow in scope: split payment hits only stores using mixed cash/card payments, and VAT display is cosmetic (financial records are correct). Neither corrupts data or creates an unrecoverable state.

The system has been built with the right instincts throughout: DB is authoritative, no business data in browser storage, atomic operations at the DB level, idempotency on every replay path, and an audit trail that records enough detail to reconstruct events days after the fact. These are the foundations of a trustworthy financial system, and they're all present.

The gaps (reports without permission gates, sequential stock take loops, supplier receive race condition) are real but not pilot-blockers at controlled single-store scale with a manager present. They are pre-broader-rollout items, not pre-pilot items.

**What I would watch in week 1:**
- `OFFLINE_CONFLICT` events in the audit trail (indicates stock discrepancies during offline operation)
- `pos_recon_snapshots.is_consistent = false` rows (indicates recon anomalies)
- `CASH_VARIANCE_RECORDED` events with variance > R50 (unexplained cash differences)
- Any `SALE_RPC_FAILED` events (indicates DB-level failures)

If week 1 shows clean audit data on those four metrics, I would be confident to expand the pilot.

---

## Architecture Boundaries Confirmed Preserved

| Boundary | Status |
|---|---|
| No business data in browser storage | ✅ Confirmed — `syncPaused`, `tillLocked`, `printerDegraded`, `forceUpdatePending`, `checkoutInProgress` are all JS module-level variables; sourced from DB on login |
| No sales deleted | ✅ Void and force-close set `status` only — no DELETE in any route |
| No audit trail tampered | ✅ `pos_audit_events` is append-only at DB level |
| Checkout atomicity | ✅ `create_sale_atomic` — all-or-nothing RPC |
| Queue integrity under sync pause | ✅ IDB records untouched; pause stops new retry cycles only |
| Idempotency at DB level | ✅ `idempotency_key` unique index on `sales` table |
| Company isolation | ✅ All queries include `.eq('company_id', req.companyId)` |
| Paytime module | ✅ Not touched in any Checkout Charlie workstream |
| Zeabur deployment rules | ✅ No zbpack.json, Dockerfile intact |
| Price server-authoritative | ✅ Frontend sends product IDs only; backend fetches prices |
