# Lorenco Storehouse Demo Readiness Audit

## Scope Checked

Audit target: current Storehouse inventory module, item screen, supplier screen, PO receive flow, BOM flow, WO flow, costing fields, reports, UI gaps, demo blockers, and browser-storage status.

## What Already Works

- The Storehouse frontend already exists at `frontend-inventory/index.html` and is wired to `/api/inventory`.
- Dashboard, items, movements, warehouses, suppliers, purchase orders, BOMs, work orders, and reports are already present in the UI.
- Backend inventory routes already exist in `backend/modules/inventory/index.js` with subroutes for BOMs, work orders, and reports.
- Atomic stock movement exists through `adjust_inventory_stock()` and is already used by movement, PO receive, and WO completion flows.
- Supplier PO receipt flow exists and updates stock through the backend, not the browser.
- BOM creation and WO lifecycle already exist, including material issuance and completion guards.
- Phase 2A costing tables and logic already exist in migration 041 and the costing service.
- Stock valuation reporting already exists.
- The system already blocks negative stock and prevents WO completion when required materials are not fully issued.

## What Is Broken Or Weak For Demo

- The current dashboard is not demo-shaped. It shows basic counts, but not the demo-specific cards requested for total stock value, finished goods count, raw materials count, or POs awaiting receipt.
- The item table is useful but not demo-clear enough. It does not present the requested business-facing badges and fields in a strong way for a client walkthrough.
- The movement history view is functional but too shallow for forensic trust. It lacks resulting stock, unit cost, total cost, and user attribution in the visible table.
- The frontend token lookup in `frontend-inventory/index.html` still falls back to browser storage for auth token retrieval.
- The current report UX is functional but not polished enough for a client demo narrative.

## What Is Missing For The Demo

- A demo-first dashboard with the requested KPI cards and a clear “Demo Flow” panel.
- A more explicit item master presentation showing SKU, item type, stock, average cost, last purchase cost, stock value, minimum stock, and active status.
- A simple quick-receive flow if the existing PO receive path is too cumbersome for the demo script.
- A visible movement history on each item detail path with forensic-level fields.
- BOM cost summary and cost-per-finished-unit presentation in the UI.
- WO cost summary presentation in the UI.
- A more guided navigation structure for demo use.
- Optional seed/demo data that is explicit, company-scoped, and never auto-runs.

## What Must Be Built Now

- Demo dashboard cards for the requested stock and workflow counts.
- Demo navigation and an obvious flow from item creation to receive stock to BOM to production to valuation.
- Item master presentation upgrades to make item meaning and value immediately obvious.
- A quick receive stock path if the existing PO receive flow is too heavy for a demo.
- A stronger movement history presentation.
- BOM and WO cost summary presentation for client-facing review.
- Stock valuation report improvements with filtering and missing-cost warnings.

## What Can Be Left For Later

- Sales orders.
- Customer orders.
- Delivery and dispatch.
- Full GL posting.
- FIFO consumption.
- Lot and serial tracking.
- Barcode hardware scanning.
- Supplier price lists.
- Purchase approvals.
- Advanced production scheduling.
- Sean AI intelligence.
- Full POS integration.
- Mobile app work.

## Current Local Storage Status

- No inventory business data storage was found in the current Storehouse page.
- One browser-storage fallback exists in `frontend-inventory/index.html` for token lookup: `localStorage.getItem('token') || sessionStorage.getItem('token')`.
- That fallback is auth-token related, not business-data related.
- No evidence was found in the inventory module of stock truth being stored in browser storage.

## Demo Readiness Conclusion

The backend foundation is already strong enough for a limited-scope production-quality demo. The demo is not blocked by missing core stock logic; it is blocked by presentation gaps, a missing demo-specific dashboard experience, and a few narrow API/UI additions needed to make the system client-clear and forensic-friendly.
