# Workstream 81 — Verification
## Checkout Charlie

**Date:** 2026-07-08
**Method:** `node --check` + full POS module-tree load smoke test on every touched backend file; a real headless-Chromium (Playwright) test against the actual, unmodified `index.html` served over a local HTTP server (`http://localhost:58231`, not `file://` — required for fetch-mocking to work, per the lesson learned in Workstream 80's verification), with every relevant `/api/pos/company-transfers/*` and `/api/pos/company-links/*` call mocked.

---

## Backend Checks

| Check | Result |
|---|---|
| `node --check` on all 5 touched/new backend files | ✅ all pass |
| Full POS module tree (`modules/pos/index.js`, requiring every route file including the new `company-transfers.js`) loads without a require-time error | ✅ confirmed via direct `require()` smoke test |
| `INVENTORY.ADJUST` gate on every write route (send/receive/reject/cancel/return/confirm-return/map/permissions) | ✅ confirmed via code read-through — matches the established Workstream 78/80 pattern |
| `INVENTORY.VIEW` gate on all reads | ✅ confirmed |
| `git diff` — no `localStorage`/`sessionStorage`/`safeLocalStorage` writes introduced anywhere in this workstream | ✅ confirmed (zero matches) |

---

## Frontend Verification (real headless-Chromium, real file, real HTTP server, mocked API)

| Ticket requirement | Result |
|---|---|
| Only linked companies appear (Send Stock dropdown) | ✅ `sendCompanyOptions: ["Select a linked company...", "Pennygrow Retail"]` — exactly the one mocked eligible company, nothing else |
| Unlinked company cannot receive a transfer | ✅ by construction — `/transferable-companies` is the *only* population source for the dropdown, and the backend independently re-validates the relationship+permission on `/send` regardless of what the client sends |
| Sender stock decreases on send | ✅ code inspection confirms `/send` calls `adjustStockCAS(..., -quantity, ...)` per line before any success response |
| Receiver stock does not increase before confirmation | ✅ code inspection confirms no route other than `/receive` ever increases receiver-side stock |
| Receiver stock increases on receive | ✅ `receiveBody` sent to the mocked `/101/receive` endpoint matched exactly what was entered — full qty for the auto-matched item (10), manual qty+mapping for the unmapped item (5, `receiver_product_id: 77`) |
| Return flow reduces receiver stock | ✅ `returnBody: { items: [{ item_id: 5004, quantity: 2, reason: "damaged" }] }` sent correctly to `/102/return` |
| Sender stock increases only after return-received confirmation | ✅ `confirmedReturnId: 103` — confirm action correctly targeted the transfer awaiting confirmation, and code inspection confirms `/confirm-return` is the sole route touching sender stock for a return |
| Product matching works by barcode/product code | ✅ item 5001 (has `barcode`/`product_code`, server pre-supplied a `suggested_match`) rendered with **no** manual-map dropdown and a pre-filled receive quantity (`autoMatchedQtyPrefilled: "10"`) |
| Unknown product blocks receive or requires manual mapping | ✅ item 5002 (no barcode/code, no suggested match) rendered **with** a manual-map dropdown (`hasMapSelectForUnmatched: 1`) — confirmed the UI surfaces the block/mapping requirement rather than silently skipping it |
| Dashboard counts real transfers | ✅ `kpiIncomingPending: "1"`, `kpiOutgoingPending: "1"`, `kpiReturnsPending: "1"` — each computed live from the exact mocked incoming/outgoing transfer lists (1 `sent` incoming, 1 `sent` + 1 `return_sent` outgoing), not hardcoded; `dashboardTransferKPIsVisible: "grid"` confirms the honest-empty-state logic correctly switched to showing the KPI grid because real data existed |
| Company isolation preserved | ✅ every list/detail route requires `req.companyId` to match `company_id` or `receiver_company_id` on the transfer — confirmed via code read-through (403 returned otherwise) |
| Permission gates enforced | ✅ `/send` requires `stock_transfer`; `/receive` requires `receive_transfer`; `/return` requires `return_transfer` — each checked server-side via `getAuthorizedRelationship()`, confirmed via code read-through, not just a frontend-hidden button |
| Permission toggle UI works | ✅ `permStockTransferChecked: true` (correctly loaded from the mocked active relationship's `permissions.stock_transfer: true`), `permReceiveTransferChecked: false` before toggle, `permissionPatchBody: { receive_transfer: true }` sent correctly to `PATCH /company-links/55/permissions` after checking the box |
| Cancel transfer (sender, pre-receive) | ✅ `hasCancelButton: true` shown only for the sender's own `sent`-status transfer; `cancelledId: 104` confirms correct target |
| Reject transfer (receiver, pre-receive) | ✅ `rejectBodyReceived: true` |
| Returns tab shows both roles correctly | ✅ `returnsToConfirmCount: 1` (the one `return_sent` outgoing transfer awaiting our confirmation as sender), `returnableCount: 1` (the one `received` incoming transfer we could return items from as receiver) — the two lists are populated from genuinely different queries/roles, not duplicated |
| Console/page errors | ✅ none related to this workstream's code. Two categories of unrelated noise present in every test this session: the expected `/pos/service-worker.js` 404 (PWA asset the minimal test server doesn't serve) and a pre-existing `loadProducts()` failure caused by the test's generic `{}` catch-all mock not matching the real `/products` response shape — unrelated to transfers, confirmed by Send Stock working correctly anyway via a manually-injected test product option |

---

## Stock Movement — Verified by Code Inspection (not directly observable via mocked network tests)

Actual database row changes were not exercised (no reachable live database from this environment, consistent with every prior workstream this session). Verified instead by reading every stock-affecting code path in `company-transfers.js`:

- `adjustStockCAS()` is the single, shared implementation for every stock change in this file (send decrement, receive increment, reject/cancel restore, return decrement, confirm-return increment) — one function to review for correctness rather than six independent copies.
- The compare-and-swap `WHERE stock_quantity = <value just read>` clause means a concurrent stock change between read and write causes the write to affect zero rows (detected and reported as `concurrent_update`), rather than silently overwriting the concurrent change — a genuine improvement in correctness over the plain read-then-write pattern used elsewhere in the codebase (Workstream 78's supplier receive/return), applied here because the ticket explicitly called out atomicity.
- `/cancel` explicitly skips any item with `quantity_received > 0` before restoring stock — verified this guard exists specifically to prevent a cancel accidentally restoring stock for units the receiver already has (a partially-received-then-cancelled transfer only restores the *un*received portion).

---

## Not Independently Re-Verified (documented, not hidden)

- **Live database write path** — as with every workstream this session, no reachable Postgres connection from this environment. The CAS update pattern is new (not used elsewhere in the codebase before this workstream), so it carries slightly more first-use risk than a pattern already proven in production, even though it's structurally simple and was reviewed carefully.
- **True concurrent-request behavior** — the CAS guard's correctness under real concurrent load (two transfers touching the same product at the same instant) was reasoned through, not load-tested. Low risk given inter-company transfers are an infrequent, staff-mediated action, not a high-frequency path like checkout.
- **Multi-item receive spanning both auto-matched and manually-mapped lines in the same request** — tested with exactly one of each in this verification; not tested with, e.g., 10+ mixed lines, though the code path treats each line independently so this is a low-risk extrapolation.

FOLLOW-UP NOTE
- Area: Inter-company stock transfer — live database smoke test
- Dependency: Zeabur-hosted Postgres, unreachable from this local environment
- Confirmed now: full route logic, CAS stock-update correctness (by code inspection), and complete UI request/response contracts for send/receive/reject/cancel/return/confirm-return (via mocked-network browser test over a real HTTP server)
- Not yet confirmed: actual row-level persistence and CAS behavior against the live database under real conditions
- Risk if wrong: low-to-moderate — this is genuinely new code (the CAS pattern hasn't been used elsewhere in this codebase before), more first-use risk than a workstream that only extends already-proven patterns
- Recommended next review point: first real Turkstra→Pennygrow-style send/receive performed in production after this deploys; confirm `pos_company_transfers`/`pos_company_transfer_items` rows populate correctly and stock changes match expectations on both sides
