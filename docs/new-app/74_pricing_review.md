# Codebox 74 — Practice Pricing Review + Fee Adjustment Workflow

> App: Lorenco Practice Management
> Status: Complete — migration 131 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Partners should never increase fees or change engagement scope informally." This module makes every pricing/fee/scope decision reviewed, justified, approved, documented, and auditable — a governance layer, not a calculator. It builds directly on Profitability (Codebox 73): once a margin/realization problem is visible, this module gives partners a controlled, tracked way to act on it without auto-changing anything.

**DOES NOT**: modify invoices, change accounting, update billing automatically, generate engagement letters, send emails, or recommend a specific fee amount. It prepares and governs pricing DECISIONS only. Actual fee/engagement changes happen later, in a future codebox, only after a review reaches `implemented`.

## Mandatory Pre-Build Audit — Key Findings

No new audit subagent was dispatched for this codebox — the relevant schema (Engagement Management, Profitability, Billing, Client Success) was audited first-hand while building Codeboxes 71–73 earlier in this same session. Confirmed findings carried forward:

- No pre-existing pricing-review table or router exists anywhere.
- `practice_client_engagements` (065/128) has `fee_amount`/`fee_basis`/`billing_frequency` — this module copies them onto a review as a **point-in-time snapshot** at review-creation time, never a live link. The engagement's own live fields remain the sole source of truth for "what is the fee right now."
- `practice_profitability_reviews`/`practice_profitability_snapshots` (130, Codebox 73) — `profitability_review_id` links a pricing review to the profitability concern that triggered it; figures are read live from the linked snapshot at prepare-time, never duplicated into new columns.
- `practice_client_success` (118, Codebox 61) is read-only context for the Client Success "commercial review due" integration.

## Architect Freedom — Scope Decisions & Deviations

1. **`buildPricingReview()` never computes or suggests a fee amount — only a category and evidence.** Given a client (and optionally an engagement/profitability review), it resolves the current fee snapshot, pulls the most recent saved profitability snapshot for that client/engagement (never triggering a new calculation), and returns a deterministic `suggested_review_reason` (one of the 10 CHECK-constrained reasons) plus a `suggested_review_items` array (evidence entries: low realization %, write-off amount, high non-billable time). `recommended_action`, `proposed_fee_basis`, and `proposed_fee_amount` are always left for the partner to fill in — satisfying the spec's explicit "must NEVER recommend: Increase to RXXXX."
2. **Partner approval is expected but never silently blocking**, matching the Work Authorization precedent (Codebox 72). `PUT /:id/approve` requires only a manager role (not strictly a partner role) to keep a legitimate business action from being blocked by imperfect role data; if the approver is not recorded as a partner (`owner`/`partner`), the response includes `partner_approval_unverified: true` and the event's metadata flags `approver_role`, so the exception is visible, never hidden.
3. **A `GET /prepare` endpoint was added beyond the spec's literal endpoint list** — a safe, read-only addition (same precedent as prior codeboxes adding one small justified endpoint) that lets the frontend's "New Review" form pre-fill from `buildPricingReview()` without duplicating that logic client-side.
4. **`rejection_reason`, `cancellation_reason`, `approved_by/approved_at`, `implemented_by/implemented_at`** were added to the migration beyond the spec's literal column list — following the exact "distinct action needs its own actor/timestamp pair" and "reason-required for consequential actions" conventions used in every other module this session.
5. **`implemented` is a terminal status that writes nothing to `practice_client_engagements`.** The migration's table comment and the router's `implement` handler both say this explicitly — "implemented" only means the commercial decision was accepted. A future codebox may consume `implemented` reviews to actually update engagement fees; this module never does that itself.

## Database — Migration 131

Three new tables: `practice_pricing_reviews`, `practice_pricing_review_items` (evidence), `practice_pricing_events` (append-only). No changes to any existing table — reads from `practice_client_engagements` and `practice_profitability_reviews`/`practice_profitability_snapshots`, writes to none of them.

## Backend — `pricing-review.js`

### Endpoints

`GET /summary`, `GET /prepare` (evidence preparation), reviews CRUD (`GET /`, `POST /`, `GET /:id`, `PUT /:id`, `DELETE /:id` soft-cancel requiring `reason`), review items CRUD (`GET /:id/items`, `POST /:id/items`, `PUT /items/:itemId`, `DELETE /items/:itemId`), workflow actions (`PUT /:id/submit`, `/partner-review`, `/approve`, `/reject` requiring `reason`, `/implement`), `GET /:id/events`.

### Pricing Review Engine

`buildPricingReview({ companyId, clientId, engagementId, profitabilityReviewId })` — pure, read-only. See Architect Freedom #1.

### Workflow

`draft → under_review → partner_review → approved → implemented`, with `rejected`/`cancelled` as terminal exits reachable from the earlier non-terminal states. Every transition writes an append-only event via `_writeEvent()`.

## Integrations

- **Engagement Management**: a new "Pricing" tab on the engagement detail modal, listing pricing reviews linked to that engagement (read-only — creating/actioning a review remains an explicit action on the Pricing Reviews page).
- **Profitability**: a new "Create Pricing Review" button on the Analysis result panel that hands off `client_id`/`engagement_id` via the query string to Pricing Review's create flow — Profitability itself never creates a pricing review.
- **Client Success**: a new "Pricing Reviews" section in the client detail modal, plus a deterministic "📌 Commercial review due" flag (low margin/unprofitable this month AND no active, non-terminal pricing review already in progress) — never a suggested fee.
- **Management Dashboard**: a new "Pricing Reviews" KPI section (total, awaiting partner, discussions pending, approved-not-implemented) — a simple count-only query, same pattern as every other KPI block.
- **Planning Board**: a `commercial_review_due` flag → "📌 Commercial Review Due" badge, computed the same way as Client Success's flag, sourced only from saved data (never a live per-client calculation on every board load).

## Frontend

`pricing-review.html` + `js/pricing-review.js` (prefix `pr`): summary cards, filterable review list, a "New Pricing Review" modal that calls `/prepare` on client selection to show current fee, suggested reason, and checkbox-selectable suggested evidence items, and a detail modal with evidence items + a status-driven action bar. Two permanent banners state the governance framing and the "never recommends a fee amount" rule up front.

## localStorage Findings

Zero matches across the migration, `pricing-review.js`, both new frontend files, and every edited file (`index.js`, `layout.js`, `engagement-management.js`, `profitability.js`, `client-success.js`, `management-dashboard.js` + `.js` + `.html`, `planning-board.js` + `.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. `client_id` re-verified against `practice_clients` before every write. Reads unrestricted per-user; all writes (create/update/cancel/workflow actions/evidence items) manager-gated (`_requireManager`).

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/131_practice_pricing_reviews.sql` | 3 tables: reviews, review items, append-only events |
| `accounting-ecosystem/backend/modules/practice/pricing-review.js` | Router + `buildPricingReview()` engine + workflow |
| `accounting-ecosystem/backend/frontend-practice/pricing-review.html` | Pricing Reviews UI |
| `accounting-ecosystem/backend/frontend-practice/js/pricing-review.js` | Pricing Reviews UI logic |
| `docs/new-app/74_pricing_review.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_74_pricing_review.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `pricing-review` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Pricing Reviews" nav entry |
| `accounting-ecosystem/backend/frontend-practice/js/engagement-management.js` | Added "Pricing" detail tab |
| `accounting-ecosystem/backend/frontend-practice/profitability.html` + `js/profitability.js` | Added "Create Pricing Review" button/handoff |
| `accounting-ecosystem/backend/frontend-practice/js/client-success.js` | Added "Pricing Reviews" section + commercial-review-due flag |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` + `js/management-dashboard.js` + `management-dashboard.html` | Added `pricing_review` block + KPI section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` + `js/planning-board.js` | Attaches `commercial_review_due` flag; renders the badge |

**`billing.js`, `engagements.js`, `profitability.js`'s engine, and `engagement-management.js`'s backend router were NOT modified beyond the additive integrations listed above.**

## Recommended Codebox 75

Practice Partner Performance + Practice Scorecards — an aggregation/executive-scorecard layer over existing KPIs (utilization, realization, margin, engagement health, pricing-review throughput) per partner/team, explicitly a management layer, not employee surveillance.
