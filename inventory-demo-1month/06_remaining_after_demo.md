# Lorenco Storehouse — What Remains After Demo

**Date:** 2026-05-26  
**Status:** 20/20 demo tests PASS. Demo scope complete. Production hardening required before go-live.

---

## What Is Demo-Ready (works today)

| Capability | State |
|---|---|
| Item management (raw materials + finished goods) | Demo-ready |
| Supplier management | Demo-ready |
| Quick-receive stock with cost | Demo-ready |
| Weighted average cost calculation | Demo-ready |
| BOM (Bill of Materials) creation and activation | Demo-ready |
| BOM cost summary (recipe cost, unit cost estimate) | Demo-ready |
| Work order lifecycle (draft → release → start → complete) | Demo-ready |
| Material issue (with insufficient-stock guard) | Demo-ready |
| Completion guard (cannot complete before full issue) | Demo-ready |
| Finished goods stock creation on WO completion | Demo-ready |
| Raw material stock deduction on issue | Demo-ready |
| WO cost summary (material cost, unit cost) | Demo-ready |
| Stock valuation report (full + filtered by item type) | Demo-ready |
| Movement history (audit trail per item) | Demo-ready |
| Multi-company isolation via JWT | Demo-ready |
| No browser storage for business data | Enforced |
| Storehouse frontend loads at `/inventory` | Demo-ready |

---

## What Is NOT Production-Complete

### Phase 2 — Backend Hardening (required before go-live)

#### 1. Replace `adjustStock` Node.js helper with DB transaction / proper RPC

**Current state:** The `adjustStock()` helper in `routes/stock-helpers.js` runs stock updates and movement inserts as two sequential Supabase calls — not a single atomic DB transaction. If the server crashes between the UPDATE and the INSERT, stock can change without a movement record.

**Required fix:** Rewrite as a proper PostgreSQL function / Supabase RPC that executes UPDATE + INSERT in a single transaction. Alternatively, use Supabase's row-level locking or a BEGIN/COMMIT block via the direct DB connection.

**Risk if not fixed:** Stock discrepancy between `inventory_items.current_stock` and the sum of `stock_movements` records. Detectable but would require manual reconciliation.

---

#### 2. Populate `stock_valuation_movements` (costing ledger)

**Current state:** `adjustStock` does NOT insert into `stock_valuation_movements`. This table was designed as a running costing ledger (running avg cost, running qty, per-movement). The movement history endpoint currently falls back to `stock_movements` directly, which has no running totals.

**Required fix:** Add `stock_valuation_movements` insert to `adjustStock` — or replace `adjustStock` with the corrected RPC that does it natively. Then remove the fallback branch from `GET /items/:id/movements`.

**Impact:** Without this, the movement history shows no `running_avg_cost` column — only `resulting_stock` (which we compute locally). For demo this is fine. For production reporting and audit, the full ledger is needed.

---

#### 3. FIFO / average costing finalization

**Current state:** Weighted average cost is implemented. FIFO (cost layers) table `inventory_cost_layers` exists in the schema (migration 041) but is not populated by `adjustStock`.

**Required fix:** Decide whether this client needs FIFO or weighted average. Implement accordingly. FIFO requires a cost-layer consumption loop on each outbound movement.

**Impact:** Affects WO costing accuracy and stock valuation at individual layer level. For most manufacturing SMEs, weighted average is acceptable.

---

#### 4. Stock reservations

**Current state:** No reservation mechanism. A work order being drafted does not reserve raw material stock. Two concurrent work orders could both issue the same stock.

**Required fix:** Add a `reserved_qty` column to `inventory_items`. Increment on WO release, decrement on issue or WO cancellation. Guard available qty = `current_stock - reserved_qty` in the issue route.

**Impact:** In a single-user or low-concurrency demo environment this is not a problem. In production with multiple users, this is a data integrity risk.

---

#### 5. Stock count workflow

**Current state:** No physical count / stocktake feature. Stock can only be adjusted via movements (in/out/adjustment type).

**Required fix:** Build a stockcount workflow: create count sheet → enter physical counts → post variances as `adjustment` movements.

---

#### 6. Role-based permissions

**Current state:** All inventory routes require only a valid company JWT. No granular role check (e.g. only warehouse staff can issue, only managers can receive).

**Required fix:** Add `INVENTORY.VIEW`, `INVENTORY.RECEIVE`, `INVENTORY.ISSUE`, `INVENTORY.ADMIN` permission flags to `backend/config/permissions.js`. Apply via existing `requirePermission` middleware.

---

#### 7. Purchase order (PO) flow

**Current state:** Quick-receive exists (bypasses PO). No formal PO creation → approval → GRN flow.

**Required fix:** Build PO lifecycle if client needs formal procurement control. Quick-receive is sufficient for small operations.

---

#### 8. Accounting GL integration

**Current state:** No GL posting. Stock receipts and movements do not create journal entries.

**Required fix:** When Accounting module integration is scoped, add event hooks: on receipt → debit Inventory / credit Accounts Payable; on issue → debit WIP / credit Inventory; on WO complete → debit Finished Goods / credit WIP.

**Timeline:** Accounting integration is a separate phase — do not build this before the client confirms the module scope.

---

#### 9. POS integration

**Current state:** Storehouse and Checkout Charlie (POS) are separate modules. No automatic stock deduction on POS sale.

**Required fix:** When a POS sale is completed, trigger a stock `out` movement on the relevant items. Requires an event/webhook between POS and Inventory modules.

**Timeline:** Phase 3 — after Storehouse is production-hardened.

---

## Known Safe Limitations for the Demo

| Limitation | Why it is safe for demo |
|---|---|
| `adjustStock` is not atomic | Demo is single-user, low transaction volume. Crash window is milliseconds. |
| No `stock_valuation_movements` rows | Movement history fallback to `stock_movements` works correctly. Running avg cost shows null — acceptable for demo. |
| No stock reservations | Demo uses sequential operations. No concurrent user risk. |
| No role permissions | Demo is single admin user. No unauthorized access risk in demo environment. |
| No PO workflow | Quick-receive demonstrates the stock receipt concept adequately. |
| No GL posting | Accounting is not in scope for this demo. |

---

## Recommended Phase Sequence After Demo

| Phase | Scope |
|---|---|
| **Phase 2 — Hardening** | Atomic `adjustStock` via DB transaction; populate `stock_valuation_movements`; FIFO or confirm weighted-avg; stock reservations |
| **Phase 3 — Procurement** | PO lifecycle, GRN, supplier price lists |
| **Phase 4 — Operations** | Stock count workflow, adjustments, transfers between warehouses |
| **Phase 5 — Permissions** | Role-based inventory permissions |
| **Phase 6 — Integrations** | POS → stock deduction; Accounting GL posting |
| **Phase 7 — Intelligence** | Sean AI — low stock prediction, reorder suggestions, demand forecasting |
