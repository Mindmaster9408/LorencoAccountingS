# Workstream 85 — Inter-Store Stock Transfers + Shrinkage Control (VERIFIED)

## Method

Verified with a real headless-Chromium (Playwright) test run against the actual, unmodified `frontend-pos/index.html`, served over a local static HTTP server (`http://localhost:58233`) — not `file://`, which is known from earlier workstreams to silently break `fetch`-based API mocking since `API_URL = window.location.origin + '/api'` resolves to an unsupported scheme under `file://`.

All relevant backend endpoints were mocked at the network layer (`page.route()`), and every mocked route asserted the exact request body sent by the frontend, not just that a call occurred.

## Scenarios Verified

| # | Scenario | Result |
|---|---|---|
| 1 | Opening the Inter-Store Transfers modal populates location dropdowns from `GET /transferable-locations` | ✅ `Factory`, `Retail Store` present |
| 2 | Creating a draft transfer sends the correct body | ✅ `{ source_location_id: 1, destination_location_id: 2, transported_by: "John Driver" }` |
| 3 | Draft banner becomes visible after creation | ✅ |
| 4 | Adding an item via barcode scan matches the product and appends a row | ✅ `itemRowAdded: 1` |
| 5 | Saving items sends the correct body to `PUT /:id/items` | ✅ `{ items: [{ product_id: 55, quantity: 1 }] }` |
| 6 | Dispatch is invoked after items are saved | ✅ `dispatchCalled: true` |
| 7 | Outgoing / Incoming / In-Transit list tabs render transfers | ✅ 1 row each |
| 8 | Detail view displays custody field (`transported_by`) | ✅ |
| 9 | Receive submission with a damaged quantity sends the correct body | ✅ `{ items: [{ item_id: 9001, quantity_received: 9, quantity_damaged: 1, quantity_rejected: 0 }] }` |
| 10 | Variances tab lists a discrepancy and shows the investigation-required flag | ✅ |
| 11 | Variance resolution form is present and submits the correct body | ✅ `{ discrepancy_id: 7001, resolution_reason: "confirmed_shortage_in_transit", resolution_notes: "..." }` |
| 12 | Sites settings section lists locations, shows blind-receive toggle state, shows per-site assigned users | ✅ 2 rows, toggle checked, users shown |
| 13 | Creating a new site sends the correct body | ✅ `{ location_name: "Warehouse B" }` |
| 14 | Enterprise Dashboard shows the Inter-Store Transfers KPI section with real counts | ✅ In Transit: 1, Investigations Required: 1 |

## Investigation — `itemRowAdded: 0` (Resolved, Test-Harness Bug)

The first verification run showed `itemRowAdded: 0` and `itemsBodySent: null` — `addStoreTransferItemByBarcode()` appeared not to add a row when given a barcode present in the mocked product list.

**Root cause**: the test set up mock data via `window.products = [...]` inside `page.evaluate()`. `index.html` declares `let products = [];` at the top level of its main (non-module) script. In a classic script's global execution context, a top-level `let`/`const` does **not** become a property of `window` — unlike `var`. So `window.products = [...]` created an unrelated property on the `window` object, while `addStoreTransferItemByBarcode()` continued to read the actual `products` binding via closure, which was still empty. This is the same class of `let`-vs-`window` test-harness pitfall encountered with `cachedSuppliersList` earlier in this session (Workstream 78).

**Fix**: changed the test to assign the bare identifier `products = [...]` inside `page.evaluate()`, which — because `page.evaluate()` executes as if typed directly into the page's console — correctly binds to the script's real top-level `let products` variable.

**Confirmed**: this was purely a test-harness defect. No change was made to `index.html` or any backend file to fix it. After the fix, `itemRowAdded: 1` and `itemsBodySent` matches the expected shape exactly.

## Console Errors — Confirmed Harmless

The verification run logged repeated `404`/JSON-parse console errors referencing `loadProducts()` and `loadStock()`. These originate from calls the app makes after dispatch/receive actions to refresh unrelated product/stock lists (`loadProducts(); loadStock();`), which the minimal test HTTP server does not serve for every endpoint the full app calls. This matches the exact same class of benign noise confirmed harmless in every prior workstream's verification this session (server-side static-file gaps, not application logic faults). No WS85-specific route was implicated in any of these errors.

## Not Covered By This Test (Explicitly Out of Scope)

- Real Supabase persistence (schema correctness for `locations`, `product_location_stock`, `user_locations`, `pos_transfer_discrepancies`, and the extended `pos_company_transfers`/`pos_company_transfer_items` columns) — verified by code review against `pos-schema.js`, not by a live DB round-trip.
- Concurrent-dispatch / concurrent-receive race conditions against the CAS stock-adjustment logic — the CAS pattern itself is proven correct in `company-transfers.js` from Workstream 81 and `adjustLocationStockCAS()` mirrors it exactly, but no concurrency stress test was run for this workstream.
- Role-based access restrictions (`TRANSFERS.CREATE/DISPATCH/RECEIVE` = supervisor, `APPROVE/RESOLVE_VARIANCE` = management) — verified by code review of `requirePermission()` gating in `store-transfers.js`, not by a multi-role test matrix.

```
FOLLOW-UP NOTE
- Area: Role-based permission enforcement for TRANSFERS.* actions
- Dependency: requirePermission('TRANSFERS.RESOLVE_VARIANCE') etc. in store-transfers.js
- Confirmed now: Permission strings are wired to the correct routes per code review.
- Not yet confirmed: End-to-end test with a non-management user attempting
  resolve-variance and receiving a 403.
- Risk if wrong: A supervisor could self-resolve a variance they reported, defeating
  the management-gate control.
- Recommended next check: Add a role-matrix Playwright test (or manual QA pass with a
  supervisor-role test account) before this feature is used for real shrinkage
  investigations.
```

## Cleanup

Scratch test files (`ws85_test.js`) and the background static file server (port 58233) have been removed/stopped. No test artifacts remain in the repository.

## Status

Workstream 85 is implemented and verified. **No commit has been made yet** — awaiting explicit push instruction per this project's established workflow.
