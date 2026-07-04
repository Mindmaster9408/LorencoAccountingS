# Codebox 73 — Practice Client Profitability + Service Margin Foundation

> App: Lorenco Practice Management
> Status: Complete — migration 130 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Where are we making or losing money?" and "Which clients or services need a pricing/scope conversation?" — within seconds. Analyzes existing Time/Billing/Engagement data to surface margin, realization, write-off, and billing-leakage indicators per client, engagement, service, or the whole practice.

**DO NOT BUILD: accounting, a general ledger, invoicing automation, revenue recognition.** Accounting remains the financial source of truth; Billing/WIP (`practice_billing_packs`) remains the billing workflow source of truth. This module reads from both but writes to neither.

## Mandatory Pre-Build Audit — Key Findings

A dedicated schema investigation (before writing any formula) confirmed:

- No pre-existing profitability/margin table or router exists anywhere — this is a genuinely new feature area.
- `practice_time_entries` (007, extended 061/062) already has `hours`, `billable`, `rate`, `time_type`, `standard_rate`, `override_rate`, `effective_rate`, `recoverable_value`, `billed_value`, `writeoff_value`, `billing_status` (`unbilled`|`pending_review`|`approved`|`rejected`|`billed`|`written_off`), `writeoff_reason`, `billing_pack_id`, `task_id`. **No direct `engagement_id` column** — the only link from a time entry to an engagement is `task_id → practice_tasks.engagement_id` (migration 066, plain integer, no FK).
- `practice_billing_packs`/`practice_billing_pack_lines` (062, extended 063/064) already store pack-level `recoverable_value`/`billable_value`/`writeoff_value` aggregates, recomputed from lines by `billing.js`'s own private `recalculatePack()`. This module **reads these stored aggregates directly — it never re-derives WIP math**, since `billing.js` exports nothing beyond its router.
- **`practice_team_members` has NO cost-rate/internal-rate/charge-out-rate column anywhere in the schema.** This is the single most consequential finding: `estimated_cost` has no live data source and is therefore always `0`, always flagged `TEAM_COST_RATE_MISSING`. See Architect Freedom #1 for the full consequence.
- `practice_client_engagements` has two parallel status columns (`status` from 065, `engagement_status` from 128, Codebox 71). This module deliberately does not filter by either — historical time/billing data for an ended or paused engagement is still real, already-recorded work worth analyzing.

## Architect Freedom — Scope Decisions & Deviations

1. **`estimated_cost` is always 0, and this has a real, structural consequence that is documented prominently rather than hidden**: since `estimated_margin = billed_value − estimated_cost = billed_value − 0 = billed_value`, `margin_percentage` is **always exactly 100** whenever `billed_value > 0` (or `null` when it's 0). This means the margin half of the profitability signal is currently non-informative — every client with any billed value looks "maximally profitable" by margin alone. Rather than quietly let this mislead partners, the engine (a) always adds the `TEAM_COST_RATE_MISSING` warning, (b) the frontend displays a permanent, unmissable banner explaining this, and (c) `_resolveStatus()` still blends both signals (future-proofing for when real cost data arrives) but takes the WORSE of the two tiers, so realization — the one reliable signal today — is never overridden by an artificially perfect margin score.
2. **`profitability_status` resolution uses "worse of two signals wins," not the spec's more ambiguous tier language.** The spec's suggested thresholds use "or" between tiers in a way that doesn't specify what happens when margin and realization disagree (e.g. margin says `profitable`, realization says `watch`). This module computes a tier independently for each metric, then takes the higher-severity (worse) one — documented explicitly since it's a genuine judgment call the spec left open ("Developer may adjust if justified and documented").
3. **`recoverable_value` only counts time entries with `billing_status IN ('approved', 'billed')`** — a literal reading of the spec's own "approved billable time at effective rate" phrasing. Entries still `unbilled`/`pending_review` are excluded from recoverable_value (though they still count toward `hours_recorded`), and a `SIGNIFICANT_UNAPPROVED_TIME` warning fires when a large share of billable hours haven't been approved yet — so this exclusion is never silent.
4. **`writeoff_value` combines two sources deliberately, not either alone**: pack-level `writeoff_value` for packs that have progressed past `draft` (`reviewed`/`approved`/`locked` — a still-draft pack's totals can still change), PLUS individual time-entry `writeoff_value` for entries not yet part of any pack but already marked `written_off`. This avoids both under-counting (ignoring pre-pack write-offs) and double-counting (a pack's own total already includes its lines' write-offs, so entries WITH a `billing_pack_id` are never added a second time from the entry side).
5. **`revenue_amount` is set equal to `billed_value`** — the only defensible "revenue" proxy available without accounting ledger integration, documented explicitly in both the migration and the engine so it's never mistaken for recognized revenue in an accounting sense.
6. **Snapshots are permanently immutable — `DELETE /snapshots/:id` is disabled entirely (405), not offered as a soft-archive.** The spec allowed either approach ("Soft archive preferred if status is added; otherwise keep delete disabled unless necessary"); since no status column was added to snapshots (they don't need a lifecycle — they're a frozen historical record by design, unlike reviews which do have one), disabling delete outright was the more honest choice: a snapshot's entire value is that a partner can always trust it was never altered or hidden after the fact.
7. **Engagement/service/client scoping reuses `practice_tasks.engagement_id`/`.service_id` (migration 066) as the only link from time entries** — since `practice_time_entries` has no direct engagement/service column. Engagement- or service-scoped analysis first resolves matching task IDs, then filters time entries by `task_id IN (...)`. If zero tasks match, the query is forced to zero rows (never silently falls back to unscoped data).
8. **The frontend consolidates the spec's 8 sections into 3 tabs + a detail modal** (Analysis / Snapshots / Reviews) rather than 5 separate top-level tables (practice/client/engagement/service breakdowns would mostly show overlapping data from the same underlying snapshot rows). UI polish is explicitly the lowest implementation priority in the spec, and this consolidation still answers both required UX questions within the same number of clicks.

## Database — Migration 130

Three new tables: `practice_profitability_snapshots`, `practice_profitability_reviews`, `practice_profitability_events` (append-only). No changes to any existing table — this module reads from `practice_time_entries`, `practice_billing_packs`, `practice_tasks`, `practice_client_engagements`, `practice_service_catalog`, and `practice_work_authorizations`, but writes to none of them.

## Backend — `profitability.js`

### Endpoints (~20)

Summary; four ad-hoc analysis endpoints (client/engagement/service/practice, all `GET`, never persisted unless explicitly saved); snapshot create/list/get (delete disabled); full review CRUD + 5 workflow actions (submit/complete/mark-action-required/accept/archive); events.

## Profitability Engine

`calculateProfitability({ companyId, periodStart, periodEnd, clientId, engagementId, serviceId })` — resolves scope, pulls time entries and overlapping billing packs, computes every figure per the documented formulas, and returns a full `assumptions` array alongside the numbers so any consumer (including a saved snapshot) can see exactly what was and wasn't counted.

## Formula Logic

See Architect Freedom #1, #3, #4, #5 for the definitive reasoning behind `estimated_cost`, `recoverable_value`, `writeoff_value`, and `revenue_amount`. `realization_percentage = billed_value / recoverable_value × 100` (only when recoverable_value > 0); `margin_percentage = estimated_margin / billed_value × 100` (only when billed_value > 0) — both `null`, never a fabricated number, when their denominator is zero.

## Leakage Flags

13 deterministic warning codes covering every spec-named leakage signal (high unbilled, high write-offs, low realization, high non-billable time, work outside scope via Codebox 72 reuse, time without engagement link, unfinalized billing packs, recoverable value with no pack) plus `TEAM_COST_RATE_MISSING` (always present) and a few data-integrity checks (negative unbilled, no approved time, no linked tasks).

## Integrations

- **Engagement Management**: a new "Profitability" tab on the engagement detail modal, showing current-month status/realization/write-offs/unbilled (read-only — no snapshot save from this tab).
- **Client Success**: a new "Profitability" section in the client detail modal (status, low-margin warning, open-review "repricing discussion due" flag).
- **Management Dashboard**: new "Profitability" KPI section (low-margin clients, unprofitable clients, high write-offs, low realization) — reads only the most recent 500 saved snapshots, never computes live.
- **Planning Board**: a `low_margin_client` flag → "📉 Low Margin" badge, sourced only from saved snapshots (never a live per-client calculation on every board load).

## Frontend

`profitability.html` + `js/profitability.js` (prefix `pf`): Analysis tab (scope selector + period + Calculate + Save Snapshot + Create Review), Snapshots tab (filterable list + detail modal), Reviews tab (filterable list + status-driven action bar). A permanent warning banner explains the cost-rate limitation up front. No AI, no chart library.

## localStorage Findings

Zero matches across the migration, `profitability.js`, both new frontend files, and every edited file (`index.js`, `layout.js`, `engagement-management.js`, `client-success.js`, `management-dashboard.js`+`js`+`html`, `planning-board.js`+`js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. `client_id` re-verified against `practice_clients` before every analysis. Reads unrestricted per-user; all writes (snapshots, reviews, workflow actions) manager-gated (`_requireManager`).

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/130_practice_client_profitability.sql` | 3 tables: snapshots, reviews, append-only events |
| `accounting-ecosystem/backend/modules/practice/profitability.js` | Router + engine + formulas + leakage flags |
| `accounting-ecosystem/backend/frontend-practice/profitability.html` | Profitability UI |
| `accounting-ecosystem/backend/frontend-practice/js/profitability.js` | Profitability UI logic |
| `docs/new-app/73_client_profitability.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_73_profitability.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `profitability` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Profitability" nav entry |
| `accounting-ecosystem/backend/frontend-practice/js/engagement-management.js` | Added "Profitability" detail tab |
| `accounting-ecosystem/backend/frontend-practice/js/client-success.js` | Added "Profitability" section to client detail modal |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` + `js/management-dashboard.js` + `management-dashboard.html` | Added `profitability` block + KPI section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` + `js/planning-board.js` | Attaches `low_margin_client` flag; renders the badge |

**`billing.js` was NOT modified — its stored pack/line aggregates are read directly, never recalculated by this module.**

## Recommended Codebox 74

Practice Pricing Review + Fee Adjustment Workflow, as specified — once profitability is visible, partners need a controlled way to act on it without auto-changing billing.
