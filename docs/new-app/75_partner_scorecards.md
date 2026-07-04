# Codebox 75 — Practice Partner Performance + Practice Scorecards

> App: Lorenco Practice Management
> Status: Complete — migration 132 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Which partner portfolio is healthiest? Which manager needs support? Which teams are overloaded? Where is quality declining? Where is profitability improving?" — without opening ten different modules. A management scorecard system that AGGREGATES existing KPIs into executive views.

**This is NOT HR, NOT payroll performance, NOT employee ranking, NOT disciplinary management.** It is executive operational reporting only.

## Mandatory Pre-Build Audit — Key Findings

A dedicated audit (partially via a background research agent that was interrupted by a session limit, completed directly) confirmed the exact reuse surface before any scoring formula was written:

- `management-dashboard.js` already implements `computePracticeScore()` — a practice-wide deterministic weighted-penalty score (quality/compliance/risk/capacity/tax) via `getRules()` thresholds. This module reuses the **exact same penalty formulas** per component, scoped to a specific team member's owned work, since `computePracticeScore()` itself has no per-member scoping.
- `capacity.js` exports `buildTeamCapacity(cid)` — reused directly for the capacity component.
- `skills-matrix.js` exports `getCompetency(cid, teamMemberId)` — reused directly for the learning component.
- `planning-board.js` exports `buildTeamItemPool(cid)` — reused directly for the planning component.
- `alert-rules.js` exports `getRules()` — the exact same `risk_high_min`/`risk_critical_min`/`capacity_overloaded_ratio` thresholds `computePracticeScore()` uses are reused here too, so a threshold change in Alert Rules flows through to scorecards automatically.
- Ownership columns confirmed by table: `practice_clients.responsible_team_member_id`/`.partner_team_member_id`, `practice_client_engagements.responsible_team_member_id`/`.partner_team_member_id`, `practice_quality_reviews.assigned_reviewer_team_member_id`, `practice_quality_findings.responsible_team_member_id`, `practice_risks.owner_team_member_id`, `practice_learning_plans.team_member_id`, `practice_notifications.assigned_team_member_id`.
- **No "team"/department linkage table exists** — `practice_team_members` has a plain `department` TEXT column (Codebox 15) with no separate teams table. "Team" scorecards group by this existing string.

## Architect Freedom — Scope Decisions & Deviations

1. **A `team_key` column was added to the migration beyond the spec's literal field list**, holding the `department` value when `scorecard_type = 'team'`, since no team/department linkage table exists to reference otherwise.
2. **Every component score is null (never fabricated) when its underlying data doesn't exist, with the overall score computed as a weighted average of only the AVAILABLE components** (weights re-normalized to sum to 1 among those). The spec's own weighting example assumes every component is always present; this module documents the re-normalization explicitly since a partner with, say, zero owned clients cannot meaningfully have a "profitability score" of anything, including 0.
3. **Two different "no data" behaviors, by design**: client-portfolio-scoped components (profitability, client success, engagement) return `null`/`confidence: 'none'` when the member owns zero clients/engagements, because the concept doesn't apply. Personal-conduct-scoped components (quality, risk, learning, planning, notifications) default to a perfect 100 when zero rows are attributed to that member, with `confidence: 'low'` and a warning — mirroring `computePracticeScore()`'s own existing behavior (zero incidents contributes to a good score), but flagged so "100" is never silently mistaken for "definitely fine" when it may just mean "not tracked yet."
4. **`GET /team-keys` was added beyond the spec's literal endpoint list** — a safe, read-only addition so the frontend's Team scorecard picker doesn't require guessing department strings.
5. **Review workflow reuses the exact same `review_status` enum and `TRANSITIONS`-map pattern as Profitability (Codebox 73)** rather than inventing a new one, since the spec's review_status values are identical.

## Database — Migration 132

Three new tables: `practice_partner_scorecards` (immutable snapshot), `practice_partner_scorecard_reviews`, `practice_partner_scorecard_events` (append-only). No changes to any existing table.

## Backend — `partner-scorecards.js`

### Endpoints

`GET /summary`, ad-hoc computation (`GET /practice`, `GET /partner/:teamMemberId`, `GET /manager/:teamMemberId`, `GET /team/:teamKey`, `GET /team-keys`), snapshot persistence (`POST /snapshots`, `GET /snapshots`, `GET /snapshots/:id`, `DELETE /snapshots/:id` → 405 immutable), `GET /trends`, reviews CRUD, 5 workflow actions, `GET /events`.

### Scorecard Engine — `buildScorecard()`

Nine components, each stating `source`, `formula`, `weight`, `confidence`, and (where applicable) a `warning` — see the full formula list in the router's own component functions. Never recalculates a metric differently than its source module.

## Weighting

| Component | Weight |
|---|---|
| Profitability | 25% |
| Quality | 20% |
| Client Success | 15% |
| Capacity | 10% |
| Risk | 10% |
| Engagement | 5% |
| Learning | 5% |
| Planning | 5% |
| Notifications | 5% |

Sums to 100%. Documented in `WEIGHTS` at the top of `partner-scorecards.js` — any retune must update both that constant and this table.

## Trends

`GET /trends` compares each saved snapshot in a scorecard_type/scope series against its immediately preceding one — `improved`/`declined`/`stable`/`unknown`. No prediction.

## Integrations

- **Management Dashboard**: a new "Partner Scorecards" KPI section (latest practice score, total snapshots, lowest score needing review) — count-only query, same pattern as every other KPI block.
- **Planning Board**: a `needs_support`/`latest_scorecard_score` field on the existing per-member team board (`GET /team`), rendered as an optional "📉 Needs Support" badge when a member's most recent partner/manager scorecard scores below 60 — informational only, never affects sort order.
- **Client Success**: a read-only "Responsible Team Member Performance" section in the client detail modal, showing the responsible team member's most recently saved scorecard — populated by a direct fetch to the existing `GET /snapshots` endpoint, no new calculation performed by Client Success itself.

## Frontend

`partner-scorecards.html` + `js/partner-scorecards.js` (prefix `psc`): 6 tabs (Practice/Partners/Managers/Teams/History/Reviews). The first four share one compute-panel pattern (scope picker + period + Calculate + component breakdown + Save Snapshot), consolidating implementation while still presenting each as its own tab — the same UI-consolidation precedent established in Profitability (Codebox 73).

## localStorage Findings

Zero matches across the migration, `partner-scorecards.js`, both new frontend files, and every edited file. Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. All writes (snapshot creation, reviews, workflow actions) manager-gated (`_requireManager`).

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/132_practice_partner_scorecards.sql` | 3 tables: scorecards, reviews, append-only events |
| `accounting-ecosystem/backend/modules/practice/partner-scorecards.js` | Router + `buildScorecard()` engine + workflow |
| `accounting-ecosystem/backend/frontend-practice/partner-scorecards.html` | Partner Scorecards UI |
| `accounting-ecosystem/backend/frontend-practice/js/partner-scorecards.js` | Partner Scorecards UI logic |
| `docs/new-app/75_partner_scorecards.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_75_partner_scorecards.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `partner-scorecards` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Partner Scorecards" nav entry |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` + `js/management-dashboard.js` + `management-dashboard.html` | Added `partner_scorecards` block + KPI section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` + `js/planning-board.js` | Attaches `needs_support`/`latest_scorecard_score`; renders the badge |
| `accounting-ecosystem/backend/frontend-practice/js/client-success.js` | Added read-only "Responsible Team Member Performance" section |

## Recommended Codebox 76

Practice Strategic Planning + Objectives Management — once executive scorecards exist, leadership needs to decide where the Practice is going: strategic objectives, annual goals, quarterly priorities, KPIs linked to objectives, initiative tracking, executive reviews, progress snapshots.
