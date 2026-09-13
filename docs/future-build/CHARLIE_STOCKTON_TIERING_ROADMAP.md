# Charlie & Stockton Tiering — Package Concepts + Build Reality Check

**Status:** Draft for discussion. Nothing decided, nothing built. Ruan's own instruction on both concepts: single codebase per app, tier just gates which features are available — never a fork.

This document combines two things:
1. The draft package concepts as Ruan described them.
2. A code-level audit (2026-09-12) of what already exists vs what's a genuine gap, so pricing/scoping isn't based on an inflated build estimate.

---

## Part 1 — Checkout Charlie: Core vs Proof

**One-line positioning:** Charlie Core processes sales. Charlie Proof proves what happened at every till, to the owner and the accountant.

### Feature comparison

| Feature | Core | Proof |
|---|---|---|
| Sales and payments | ✓ | ✓ |
| Products and basic stock | ✓ | ✓ |
| Cashiers and users | ✓ | ✓ |
| Returns and voids | ✓ | ✓ |
| Basic cash-up | ✓ | ✓ |
| Standard sales reports | ✓ | ✓ |
| Offline sales and sync | ✓ | ✓ |
| Full append-only audit trail | Basic | ✓ |
| Immutable cash-up snapshot | — | ✓ |
| Manager approval for sensitive actions | Limited | ✓ |
| Before-and-after records | — | ✓ |
| Mandatory reasons for discounts/voids/overrides | Basic | Mandatory |
| Cash-up exception report | — | ✓ |
| Stock-movement proof | Basic | Full |
| Monthly accountant proof pack | — | ✓ |
| Suspicious-pattern alerts | — | ✓ |
| Priority support | — | ✓ |

### Worked example (a R1,000 sale, later a R200 void)

**Core** shows the manager: the original sale, the R200 void, who the cashier was, the new sale total.

**Proof** additionally shows: exact date/time, which till/device, who initiated the void, who approved it, the mandatory reason, before/after value, whether stock was correctly reversed, whether the cash-up changed as a result, and whether that cashier does this kind of void unusually often — as a record that can't be silently edited or deleted.

### The monthly accountant proof pack (Proof tier)

One bundled package containing: total sales per till/store, cash/card/other payment breakdown, VAT report, returns/refunds, voids, discounts/overrides, cash-up variances, stock movements from sales, offline transactions that synced later, missing/failed transactions, user activity and approvals, and a list of all unresolved exceptions — so Lorenco (or any accountant) never has to hand-assemble CSVs every month.

### Who needs Proof

Multi-cashier stores, 2+ tills, multi-branch, stores with cash variances, absentee owners, staff who can process returns/discounts/voids, businesses needing strong VAT/audit evidence. A tiny single-owner-operator shop probably only needs Core.

### How to sell it

Don't say: *"Proof has an append-only audit trail and immutable snapshots."*
Say: *"When money or stock goes missing, Charlie Proof shows exactly what happened, who did it, and how it affected the cash-up."*

---

## Part 2 — Stockton: Control / Build / Proof

Suggested renaming (clearer for a new customer): **Control → Inventory**, **Build → Manufacturing**, **Proof → Assurance**.

### Feature comparison

| Feature | Control | Build | Proof |
|---|---|---|---|
| Stock and warehouses | ✓ | ✓ | ✓ |
| Purchasing and suppliers | ✓ | ✓ | ✓ |
| Stock counts and transfers | ✓ | ✓ | ✓ |
| Basic BOMs | ✓ | ✓ | ✓ |
| Basic work orders | ✓ | ✓ | ✓ |
| Reservations and shortages | ✓ | ✓ | ✓ |
| Advanced production planning | | ✓ | ✓ |
| Routings and production phases | | ✓ | ✓ |
| Actual material/production cost | | ✓ | ✓ |
| Multi-location control | Limited | ✓ | ✓ |
| Serial and batch tracking | | ✓ | ✓ |
| Expiry dates | | ✓ | ✓ |
| Quality control | | ✓ | ✓ |
| Integrations (Xero, Shopify) | Limited | ✓ | ✓ |
| Approval levels | Basic | ✓ | ✓ |
| Append-only audit trail | Basic | ✓ | ✓ |
| Immutable month-end close | | | ✓ |
| Advanced variance investigation | | | ✓ |
| Full accountant proof pack | | | ✓ |
| Multi-company oversight | | | ✓ |
| Priority support | | | ✓ |

### Tier descriptions

**Stockton Control (Inventory)** — ~R2,499/mo. For a small manufacturer currently on Excel or a simple stock program. Receive/move/count stock, manage POs, set up products and basic BOMs, create/complete work orders, reserve material, see basic shortages and valuation. Pitch: *"Help me get control of my inventory and basic production."*

**Stockton Build (Manufacturing)** — ~R4,999/mo. For a real factory that must plan and measure production daily. Adds full production planning, production phases/routings, actual vs planned cost, labour/material/scrap tracking, batch/serial/expiry tracking, quality control, multiple warehouses/production sites, advanced integrations. Pitch: *"Help me manufacture on time and know exactly what each product costs."*

**Stockton Proof (Assurance)** — ~R8,499/mo. For businesses where the owner, accountant, or auditor needs full proof and strict control. Adds immutable period-end snapshots, full audit trail of sensitive actions, approval on stock adjustments/BOM changes/production close-outs, advanced cost/inventory variance investigation, accountant proof pack, multi-company oversight, priority support/SLA, advanced roles and segregation of duties. Pitch: *"Help me prove every quantity, cost, and change."*

---

## Part 3 — Code Reality Check (2026-09-12 audit)

The point of this section: before pricing or committing engineering time, know what's already built vs genuinely new. Both audits below were done by reading the actual `backend/modules/pos/` and `backend/modules/inventory/` code, not by assumption.

### Charlie Proof — already built (don't re-quote as new work)

- **Immutable cash-up snapshot** — `pos_recon_snapshots` table is DB-trigger-enforced (`BEFORE UPDATE`/`BEFORE DELETE` raise an exception unconditionally). No edit path exists anywhere in the code. This already **is** Proof-grade.
- **Before-and-after values** — void, return, and price-change actions already capture `before_snapshot`/`after_snapshot` JSON with the actual old/new values, not just "an action happened."
- **Suspicious-pattern alerts** — `GET /api/reports/suspicious-activity` already flags per-cashier void/return/override frequency against fixed thresholds, with severity levels.
- **Segregation of duties** — a mature 15-role permission hierarchy already exists (`config/permissions.js`), including a deliberate exclusion of store managers from margin/VAT/forensic reports (a real prior business decision, not a gap).
- **POS-specific audit trail** — `pos_audit_events` (~140 event types covering the sale lifecycle, voids, overrides, price changes, stock, sessions) is genuinely DB-enforced append-only, same trigger pattern as the cash-up snapshot.

### Charlie Proof — genuine gaps, ordered roughly by effort

| # | Gap | Effort | Notes |
|---|---|---|---|
| 1 | Monthly accountant proof-pack export | **Large** | 27 separate report endpoints exist today with zero bundling/export logic tying them together. The single biggest real build item. |
| 2 | Sale/return stock movements not in the unified before/after ledger | **Medium** | Manual adjustments, stock takes, and transfers all log before/after quantity. Sale/return-driven stock changes happen inside an opaque `create_sale_atomic` RPC and aren't captured the same way. |
| 3 | True dual-control (no self-approval) | **Medium** | A manager can currently void, discount, or override their own action with no second approver — a policy decision as much as a code change. |
| 4 | Dedicated cash-up exceptions view | **Small** | The variance/consistency data already exists on every session; just needs a filtered endpoint instead of scanning all sessions. |
| 5 | Mandatory reason on discount/override PIN verification | **Small** | Voids/returns/cancellations already require a reason (400 if missing). Manager-PIN discount/override verification and ad-hoc store discounts do not. |
| 6 | Shared `audit_log` not DB-enforced append-only | **Small** | POS's own `pos_audit_events` table already has the trigger pattern proven — just needs applying to the generic ecosystem-wide table too. |

### Stockton Build/Proof — already built (don't re-quote as new work)

- **Multi-warehouse/transfers** — mature: full create → approve → ship → receive → cancel lifecycle with partial-line support, per-location stock, availability rollups.
- **Work-order lifecycle + variance tracking** — material required-vs-issued variance, yield reports, wastage tracking with reason codes, all with real endpoints.
- **Actual cost accumulation** — `costingService.js` computes real per-work-order material/labour/overhead cost (though see the labour gap below).
- **Basic approval gates** — PO approval and stock-count approval both exist as real, permission-gated steps (though not maker-checker — see gaps).
- **Reporting depth** — ~25 separate report endpoints already cover stock valuation, variance, wastage, yield, transfer history, etc.

### Stockton Build/Proof — genuine gaps

| # | Gap | Effort | Notes |
|---|---|---|---|
| 1 | Production routings/phases | **Large** | A work order today is flat: release → issue materials → complete. No multi-step operation/routing sequence exists anywhere. |
| 2 | Quality control | **Large** | No QC/inspection/hold-and-release workflow exists at all. "Quarantine" is only a bin-location name today, not a process. |
| 3 | Xero/Shopify integration | **Large** | Zero code exists for either — would be built from scratch (OAuth, API client, sync job). |
| 4 | Labour/machine costing | **Medium** | Time is tracked (duration_minutes) but cost is hardcoded to 0 on every entry — no rate table exists anywhere in the schema. |
| 5 | Lot/serial/expiry tracking | **Medium–Large** | Production *batch numbers* exist (a manufacturing-output ledger), but there is no serial_number, expiry_date, or lot concept for inventory items at all. |
| 6 | Maker-checker / tiered approvals | **Medium** | BOM changes and stock adjustments need only one permission-holder today. Stock-count approval is explicitly commented in the code as "role separation is PREP ONLY" — not actually enforced to be a different person. |
| 7 | Period-end immutable snapshot | **Medium** | Doesn't exist for Inventory — but Payroll and Accounting both already have a working lock/snapshot pattern in this codebase that can be copied rather than designed from scratch. |
| 8 | Inconsistent audit-trail coverage | **Small–Medium** | `stock-counts.js`, `reservations.js`, `procurement.js`, and `settings.js` currently make **zero** calls to the shared audit log — including the single most sensitive action in the module (approving a stock-count adjustment). |
| 9 | Combined proof-pack export | **Large** | Same shape of gap as Charlie's — ~25 reports exist standalone, nothing bundles them. |
| 10 | Multi-company oversight | **Medium–Large** | Every query is strictly single-company-scoped today (confirmed across all 12 route files); no rollup/dashboard view for an owner with multiple companies exists. |

### Bottom line

**Charlie Proof** is closer to "expose and polish what's already there" than a from-scratch build — most of the hard forensic infrastructure (immutable snapshots, before/after capture, alerting, RBAC) already exists. The proof-pack export is the one genuinely large item.

**Stockton Proof/Build** has materially more real, uncredited build work — routings, QC, integrations, lot/serial tracking, and labour costing are all missing outright, not just "needs a tier gate." The Assurance-tier items specifically (immutable snapshot, maker-checker, proof pack, multi-company) mirror Charlie's gaps closely enough that building the shared plumbing once (e.g. a generic "period lock" service, a generic "proof pack" export framework) could serve both apps rather than solving each twice — worth keeping in mind when this is actually scoped.

---

## Open questions for next discussion

- Final tier names and pricing (both decks above are drafts).
- Whether "Proof"/"Assurance"-tier infrastructure (period lock, proof-pack export, maker-checker) should be built as **shared services** reusable across Charlie, Stockton, and potentially the Document Collector, rather than one-off per app.
- Whether Stockton's larger gap list changes the relative pricing gap between Build and Proof, or whether some "Build" claims (routings, QC, integrations) need re-scoping before the tier boundary is finalized.
- Gating mechanism: reuse the existing `companies.modules_enabled`/addon-flag pattern (same as `serial_tracking` today) — no new mechanism needed.
