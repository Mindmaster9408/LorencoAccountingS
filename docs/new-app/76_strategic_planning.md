# Codebox 76 — Practice Strategic Planning + Objectives Management

> App: Lorenco Practice Management
> Status: Complete — migration 133 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Are we making progress on the strategic priorities?" — within seconds. Annual objectives, quarterly priorities, initiatives, and KPI links that reference (never duplicate) the KPI engines already built in Codeboxes 50/51/61/73/74/75 and the Risk/QMS registers.

**This is NOT project management, NOT task management, NOT HR performance.** Tasks/workflows remain the operational execution layer; this is strategic practice leadership only.

## Mandatory Pre-Build Audit — Key Findings

No pre-existing strategic-plan/objective table exists anywhere. Confirmed reuse targets, every one accessed via a small, explicit metric registry — never a duplicate KPI engine:

- `kpi-history.js` exports `METRIC_EXTRACTORS`/`METRIC_KEYS` (Codebox 51) — reused directly against the latest active `practice_kpi_snapshots` row.
- `management-dashboard.js` exports `computeSummary()` (Codebox 50) — a small, explicit dot-path registry maps a handful of known-safe `metric_key`s to fields on its return shape. Only called when a manager explicitly views/refreshes a single objective's KPI links — never in a bulk/company-wide scan.
- `capacity.js` exports `buildTeamCapacity()`, `planning-board.js` exports `buildTeamItemPool()`, `alert-rules.js` exports `getRules()` — all reused directly, same pattern established in `partner-scorecards.js` (Codebox 75).
- `practice_partner_scorecards` (132), `practice_profitability_snapshots` (130), `practice_client_success` (118), `practice_risks` (049), `practice_quality_reviews`/`findings` (048) — read directly via cheap, count-only queries for their respective `kpi_source` registries.

## Architect Freedom — Scope Decisions & Deviations

1. **A `confidence` column was added to `practice_strategic_kpi_links`** (`'auto'`/`'manual'`) beyond the spec's literal field list — required by the spec's own "KPI LINK LOGIC" section ("If unsafe: mark confidence = manual") and by the "reason-required" documentation discipline used throughout this session.
2. **`cancellation_reason` columns were added to plans and reviews** for the same "reason required for consequential actions" convention used in every prior codebox this session (Pricing Review, Partner Scorecards).
3. **Four extra event types were added** (`plan_cancelled`, `objective_cancelled`, `initiative_cancelled`, `kpi_link_cancelled`) beyond the spec's literal 17-event list, so the spec's own audit requirement ("no strategic status change without event") holds for this module's soft-cancel DELETE endpoints too.
4. **`_computeObjectiveProgress()` never writes its result back to the stored `progress_percentage` column.** The stored column remains the manual fallback, always visible; every detail/health response returns a separate `computed_progress` + `formula` field alongside it — the two are never conflated, and a computed value never silently overwrites a manually entered one.
5. **The blended initiative+KPI progress score uses a fixed 50/50 weighting**, since the spec's own "PROGRESS LOGIC" section specifies a "blended deterministic score" without an exact ratio — documented explicitly as a judgment call.
6. **Objectives/Initiatives/KPI Links are UI-consolidated into the Plan and Objective detail modals rather than three separate top-level page tabs** — the same UI-consolidation precedent established in Profitability/Pricing Review/Partner Scorecards this session, since these entities only ever make sense scoped to a specific plan/objective.
7. **The `management_dashboard` KPI source's live-refresh path only ever fires when a manager views/refreshes a single objective's KPI links** (bounded, small batch) — never from `getStrategicPlanHealth()` or any bulk/company-wide integration, which read only stored `current_value`/`last_measured_at`.
8. **`GET /objectives?owner_team_member_id=` was added beyond the spec's literal endpoint list** — a safe, read-only, cross-plan lookup needed for the Partner Scorecards integration ("show linked strategic objectives where safe") without that module needing any knowledge of `practice_strategic_plans`.

## Database — Migration 133

Six new tables: `practice_strategic_plans`, `practice_strategic_objectives`, `practice_strategic_initiatives`, `practice_strategic_kpi_links`, `practice_strategic_reviews`, `practice_strategic_events` (append-only, one shared log with nullable reference columns). No changes to any existing table.

## Backend — `strategic-planning.js`

Full CRUD across plans/objectives/initiatives/KPI links/reviews, 3 plan workflow actions (activate/complete/archive), 2 review workflow actions (complete/action-required), a generic `/:sourceType/:sourceId/events` lookup, and `getStrategicPlanHealth()` — the engine.

### Strategic Engine — `getStrategicPlanHealth()`

Returns plan, objectives (each with computed progress + formula), initiatives, KPI links, overall progress, at-risk objectives, blocked initiatives, overdue initiatives, KPI gaps, and a list of deterministic "recommended next manual actions" — never a fabricated strategy, only literal flags like "Objective X has no initiatives or KPI links."

## Progress Logic

Per the spec exactly: initiatives-only → average initiative progress; KPI-links-only → weighted average of per-link progress (direction-aware formula: increase/decrease/maintain/threshold); both → 50/50 blend; neither → manual `progress_percentage`. Every path returns its formula string.

## KPI Link Logic

A small, explicit "known-safe" registry (`_resolveMetric()`) per `kpi_source`. Matched combinations get a live-refreshed `current_value` + `confidence: 'auto'` + `last_measured_at`; unmatched combinations (including all `custom` links) are left completely untouched with `confidence: 'manual'`. A manual edit to `current_value` always resets `confidence` back to `'manual'`.

## Integrations

- **Management Dashboard**: a new KPI section (active plans, at-risk objectives, blocked initiatives, reviews due) — count-only queries, same pattern as every other KPI block.
- **Partner Scorecards**: a read-only "Linked Strategic Objectives" line on partner/manager scorecard results, sourced from the new `GET /objectives?owner_team_member_id=` lookup — no new calculation performed by Partner Scorecards itself.
- **Planning Board**: `strategic_initiatives_due_count`/`strategic_initiatives_overdue_count` fields on the existing per-member team board, same lightweight direct-query pattern as every other badge this session.

## Frontend

`strategic-planning.html` + `js/strategic-planning.js` (prefix `sp`): 3 top-level tabs (Plans/Reviews/Events) plus a Plan detail modal (Overview/Objectives/Reviews/Events) and an Objective detail modal (fields + inline Initiatives + inline KPI Links) — consolidating the spec's 7 sections into a navigable two-level modal structure per Architect Freedom #6.

## localStorage Findings

Zero matches across the migration, `strategic-planning.js`, both new frontend files, and every edited file. Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. All writes (plans, objectives, initiatives, KPI links, reviews, workflow actions) manager-gated (`_requireManager`).

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/133_practice_strategic_planning.sql` | 6 tables: plans, objectives, initiatives, KPI links, reviews, append-only events |
| `accounting-ecosystem/backend/modules/practice/strategic-planning.js` | Router + `getStrategicPlanHealth()` engine + progress/KPI-link logic |
| `accounting-ecosystem/backend/frontend-practice/strategic-planning.html` | Strategic Planning UI |
| `accounting-ecosystem/backend/frontend-practice/js/strategic-planning.js` | Strategic Planning UI logic |
| `docs/new-app/76_strategic_planning.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_76_strategic_planning.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `strategic-planning` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Strategic Planning" nav entry |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` + `js/management-dashboard.js` + `management-dashboard.html` | Added `strategic_planning` block + KPI section |
| `accounting-ecosystem/backend/frontend-practice/js/partner-scorecards.js` | Added read-only "Linked Strategic Objectives" line |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` + `js/planning-board.js` | Attaches `strategic_initiatives_due_count`/`overdue_count`; renders them |

## Recommended Codebox 77

Practice Executive Reporting + Board Pack Foundation — a management summary, strategic progress, KPI trends, financial/pricing/profitability signals, risk and QMS, client success, secretarial/compliance health, partner decisions, and an action register, compiled from the operational and strategic intelligence now in place. No AI. No external reporting integration. PDF/HTML reporting only if already supported safely.
