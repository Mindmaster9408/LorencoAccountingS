# Session Handoff — Codebox 76: Practice Strategic Planning + Objectives Management

> Date: 2026-07-04
> Status: COMPLETE — migration 133 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### The hardest design constraint: KPI links that reference without duplicating

The spec was explicit and repeated: "Do not duplicate KPI calculations," "no duplicate KPI engines," "no rewrite of existing modules." This meant the KPI link engine could not simply call `calculateProfitability()`/`buildScorecard()`/etc. for every link on every read — those are heavier, multi-query engines meant for their own pages. The resolved design is a small, explicit registry (`_resolveMetric()`) that maps a known-safe `kpi_source`/`metric_key` combination to a cheap, direct read (a saved snapshot row, a lightweight count query, or a shared-batch call to an existing lightweight export like `buildTeamCapacity()`). Anything not in the registry — including every `custom` link — simply stays manual forever. Nothing is ever guessed.

### Refresh is bounded, by design

The `management_dashboard` KPI source is the one genuinely expensive path (`computeSummary()` runs ~25 parallel queries). To keep this safe, KPI-link refreshing only ever happens when a manager views or refreshes ONE objective's (small) set of links — via `GET /objectives/:objectiveId/kpis` — never from `getStrategicPlanHealth()` (which reads only already-stored `current_value`s) and never from either of the two other modules' integrations. This mirrors the exact "never call the heavy engine from a bulk/dashboard context" discipline established in Codebox 75's Partner Scorecards.

### Progress is computed, never silently persisted

`progress_percentage` on an objective is a genuine, separately-stored manual fallback field — never overwritten by the engine. Every response that includes computed progress (objective detail, plan health) returns `computed_progress` and `formula` as sibling fields, so a partner can always see both the system's calculation and the last manually entered value, with the formula explaining exactly how the computed figure was derived (blended/initiatives-only/kpi-only/manual-fallback).

### Backend — `strategic-planning.js`

Full CRUD across all 5 entity types, 3 plan actions (activate/complete/archive) plus soft-cancel DELETE, 2 review actions (complete/action-required) plus soft-cancel DELETE, and a generic `/:sourceType/:sourceId/events` lookup covering all 5 entity types from one append-only events table. One small extra endpoint (`GET /objectives?owner_team_member_id=`) was added to support the Partner Scorecards integration without that module needing any knowledge of this module's plan structure.

### Frontend — `strategic-planning.html` + `js/strategic-planning.js` (prefix `sp`)

Three top-level tabs (Plans/Reviews/Events) rather than the spec's literal 7 sections — Objectives/Initiatives/KPI Links only ever make sense scoped to a specific plan/objective, so they live inside a two-level modal structure (Plan detail → Objective detail) instead of being separate, filterless, company-wide tabs. Same UI-consolidation precedent used in every prior codebox this session that faced a similar "child entities only make sense scoped to a parent" situation.

### Integrations — three, all read-only or count-only

**Management Dashboard**: a new KPI block (active plans, at-risk objectives, blocked initiatives, reviews due) — count-only queries. **Partner Scorecards**: a read-only "Linked Strategic Objectives" line appended to any partner/manager scorecard result, sourced from the one new safe cross-plan lookup endpoint. **Planning Board**: `strategic_initiatives_due_count`/`strategic_initiatives_overdue_count` fields added to the existing per-member team board.

---

## Nothing Regressed

- `management-dashboard.js`'s `computeSummary()`, `computePracticeScore()`, `computeAlerts()`, `computePartnerReview()`, `computeExecutiveFeed()` — none modified beyond `computeSummary()` gaining one new additive `strategic_planning` key.
- `capacity.js`, `planning-board.js`, `kpi-history.js`, `alert-rules.js`, `secretarial-calendar.js` — only their existing exported functions are called; `planning-board.js`'s own `GET /team` route gained only additive fields.
- `partner-scorecards.js` — the existing scorecard-rendering flow is unchanged; the new "Linked Strategic Objectives" line is a purely additive async placeholder, same pattern as Client Success's Codebox 75 integration.
- `node --check` passes on every new/modified JS file, verified individually as each was written.
- Full router chain (`require('./modules/practice/index.js')` with dummy env vars) loads cleanly with `strategic-planning.js` mounted, stack size 129 (up from 128).

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`133_practice_strategic_planning.sql`

Expected: "Success. No rows returned." No seeding step required — all six tables start empty.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migration 133 to Supabase (migration 132 from Codebox 75 should already be live).
2. Navigate to `/practice/strategic-planning.html` — should show zeroed summary cards and both governance banners.
3. Create a plan (name, year, period) → confirm it appears in the Plans list at status "Draft".
4. Open the plan → Activate → confirm status becomes "Active" and an event is recorded.
5. Add an objective (title, area, priority) → confirm it appears with 0% progress and "manual" formula (no initiatives/KPIs yet).
6. Open the objective → add an initiative with a due date → confirm the objective's computed progress becomes the initiative-average formula.
7. Add a KPI link with `kpi_source=risk`, `metric_key=open_risks`, `direction=decrease`, a baseline and target → confirm `current_value` auto-populates on next view of that objective's KPI links, with `confidence=auto`.
8. Manually edit that KPI link's `current_value` → confirm `confidence` flips back to `manual`.
9. Mark the initiative "completed" → confirm `completed_at` is set and `progress_percentage` forces to 100; confirm the objective's computed progress updates to reflect the blended (or initiative-only) formula.
10. Create a Strategic Review against the active plan → confirm the plan transitions to "Under Review"; Complete the review → confirm the plan returns to "Active".
11. Go to `/practice/management-dashboard.html` → confirm the new "Strategic Planning" KPI section shows counts matching the Strategic Planning page.
12. Go to `/practice/partner-scorecards.html`, calculate a Partner or Manager scorecard for a team member who owns a strategic objective → confirm the "Linked Strategic Objectives" line appears.
13. Go to `/practice/planning-board.html`'s team view for a member who owns an overdue strategic initiative → confirm "Strategic overdue" count is non-zero and the "Strategic Planning" quick link appears.
14. As a non-manager, attempt to create/update/action any plan/objective/initiative/KPI link/review → confirm 403 on each; confirm all `GET` reads still succeed.
15. Log in as a different company → confirm zero cross-company plans/objectives/initiatives/KPI links/reviews/events visible.
16. DevTools → Application → Storage → confirm no strategic-planning data in localStorage/sessionStorage/IndexedDB.

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: the KPI link metric registry (_resolveMetric()) is representative, not exhaustive — only a curated subset of metric_keys per kpi_source are known-safe
- Confirmed now: every registered combination is documented in strategic-planning.js's _resolveMetric()/_sharedSourceData() functions; anything outside that set (including every 'custom' link) stays confidence:'manual' forever, by design — never guessed.
- Not yet confirmed: whether partners will want additional metric_keys registered per source over time (e.g. more Management Dashboard dot-paths, more Tax metrics).
- Risk: None — unmatched combinations degrade gracefully to manual entry, never an error, never a fabricated number.
- Recommended next review point: if a specific metric_key/kpi_source combination is requested often as "manual" in practice, add it to the registry in a follow-up change.
```

```
FOLLOW-UP NOTE
- Area: 'under_review'/'reviewed' plan and review statuses are valid CHECK values but not fully wired to a dedicated action in this codebox
- Confirmed now: 'under_review' is reachable only as a side effect of creating a Strategic Review against an 'active' plan (and returns to 'active' when that review completes) — no standalone "start review" action exists. Similarly, review_status 'reviewed' has no dedicated action distinct from 'completed' — only 'action_required' and 'completed' are wired.
- Not yet confirmed: whether partners want a distinct "mark reviewed but not yet fully completed" state with its own action.
- Risk: Low — the schema already allows for a richer flow; this is a scope decision, not a bug. Documented so a future codebox doesn't need to re-audit why these values exist without a matching action.
- Recommended: No action needed unless partners specifically request a richer review-status workflow.
```
