# Session Handoff — Codebox 73: Practice Client Profitability + Service Margin Foundation

> Date: 2026-07-04
> Status: COMPLETE — migration 130 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### An audit that found a real, structural gap before any formula was written

Before writing `calculateProfitability()`, a dedicated schema-investigation pass confirmed exactly what data exists for cost calculation: **`practice_team_members` has no cost-rate column at all, anywhere in the schema.** This isn't a minor detail — it means `estimated_cost` is always `0`, which means `estimated_margin` always equals `billed_value`, which means `margin_percentage` is always exactly `100` (or `null`) regardless of what's actually happening with a client. Discovering this before writing the profitability-status logic — rather than after building something that would have quietly misled partners — shaped nearly every other decision in this codebox: the engine always emits a `TEAM_COST_RATE_MISSING` warning, the frontend carries a permanent banner explaining it, and the status-resolution logic was deliberately built to take the *worse* of margin and realization rather than let an artificially perfect margin score mask a real realization problem.

### Formulas built from real, audited column names, not assumptions

Every formula traces to a specific, confirmed column: `recoverable_value` sums `hours × COALESCE(override_rate, standard_rate, rate)` only for time entries with `billing_status IN ('approved', 'billed')` (the spec's own "approved billable time" language, read literally); `billed_value` reads the stored `billing_pack.billable_value` aggregate for packs that have reached `approved`/`locked` (never re-deriving WIP math that `billing.js` already owns); `writeoff_value` combines pack-level write-offs (once a pack is past `draft`) with entry-level write-offs for entries not yet in any pack — designed specifically to avoid double-counting a write-off from both the entry and its containing pack.

### The one genuinely new scope-resolution mechanic: task-mediated engagement/service linkage

`practice_time_entries` has no `engagement_id` or `service_id` column of its own — the only path from a time entry to an engagement is `task_id → practice_tasks.engagement_id` (a link Codebox 71's migration 066 already added, plain integer, no FK). Engagement- and service-scoped analysis first resolves the matching task IDs, then filters time entries by that set. If zero tasks match, the query is deliberately forced to zero rows rather than silently falling back to unscoped data — "never guess" applied to the one place a query could otherwise return misleadingly broad results.

### Backend — `profitability.js` (~20 endpoints)

Four ad-hoc `GET` analysis endpoints (never persisted unless explicitly saved via `POST /snapshots`), full snapshot create/list/get (delete disabled — see below), full review CRUD plus 5 workflow actions, events.

### Snapshots are permanently immutable by design

The spec allowed either a soft-archive or a fully-disabled delete. Since snapshots have no lifecycle of their own (unlike reviews, which do), disabling delete outright (`405`) was the more honest choice — a snapshot's entire value to a partner is that it can always be trusted as an unaltered historical record.

### Frontend — `profitability.html` + `js/profitability.js` (prefix `pf`)

Three tabs (Analysis / Snapshots / Reviews) rather than the spec's literal 5 separate top-level tables — a deliberate consolidation since those tables would mostly surface the same underlying snapshot rows from different angles, and UI polish is explicitly the lowest priority in the spec's own implementation-priority list.

### Integrations — four, all read-only reuse of the engine, all additive

**Engagement Management**: a new "Profitability" tab on the existing detail modal (current month, read-only). **Client Success**: a new "Profitability" section in the client detail modal (status, low-margin warning, open-review-due flag). **Management Dashboard**: a new KPI section reading only the most recent 500 saved snapshots. **Planning Board**: a new badge, same lightweight, snapshot-only pattern as every other badge this session — it never triggers a live calculation from a board load.

---

## Nothing Regressed

- `billing.js` — **not modified at all**. Its stored pack/line aggregate columns are read directly by the new engine; its private `recalculatePack()` and every other helper remain untouched and unexported, exactly as they were.
- `engagement-management.js`, `work-authorization.js`, `client-success.js` — only their existing GET endpoints/exports are called (read-only); no existing endpoint, render path, or export was changed except the additive new tab/section on each frontend.
- `management-dashboard.js`'s `computeSummary()` — every existing key is unchanged; `profitability` is a new, additive key.
- `planning-board.js`'s `_buildTeamItemPool()` — every existing flag is unchanged; `low_margin_client` is a new, additive field.
- `node --check` passes on every new/modified JS file.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep.
- All files verified present on disk immediately after writing.
- Two dead no-op ternaries (`(lowMargin ? '' : '')`-style leftovers from an editing false-start) were caught and removed from `client-success.js` during self-review, before this handoff was written — the same category of bug flagged and fixed in a prior codebox's self-review, caught again here.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`130_practice_client_profitability.sql`

Expected: "Success. No rows returned." No seeding step is required — the three tables start empty; the first "Calculate" + "Save Snapshot" populates them.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migration 130 to Supabase (migration 129 from Codebox 72 should already be live)
2. Navigate to `/practice/profitability.html` — should show zeroed summary cards and the permanent cost-rate warning banner
3. Select scope = Client, pick a client with approved billable time entries and at least one `approved`/`locked` billing pack in the current month → click Calculate → confirm the result panel shows non-zero `recoverable_value`/`billed_value` and a `realization_percentage`
4. Confirm `margin_percentage` is exactly 100 (given no cost-rate data exists) and `TEAM_COST_RATE_MISSING` appears in the warnings list
5. Click "Save Snapshot" → confirm it appears on the Snapshots tab with the same figures
6. Select scope = Engagement, enter an engagement ID whose tasks have recorded time → confirm the analysis scopes correctly (only time entries whose task links to that engagement)
7. Select scope = Practice (no client/engagement/service) → confirm it aggregates across the whole company for the period
8. Find or create a client with high write-offs relative to recoverable value (write off >15% of recoverable time) → confirm `HIGH_WRITEOFFS` appears in warnings and, if saved as a snapshot, contributes to the Management Dashboard's "High Write-Offs" KPI and the Planning Board's "📉 Low Margin" badge
9. Find or create a client with realization below 70% → confirm `LOW_REALIZATION` appears and the profitability_status reflects the worse tier
10. Click "Create Review" from an analysis result → confirm a review is created linked to that client
11. Walk a review through its full lifecycle: Submit → Complete → Mark Action Required → Accept → Archive — confirm each transition writes an event and the status-driven action bar updates correctly at each step
12. Attempt `DELETE /snapshots/:id` directly (e.g. via curl/Postman) → confirm 405, never actually deletes
13. Go to `/practice/engagement-management.html`, open an engagement's detail modal → confirm the new "Profitability" tab shows current-month figures
14. Go to `/practice/client-success.html`, open a client with a saved low-margin snapshot → confirm the Profitability section shows the warning
15. Go to `/practice/management-dashboard.html` → confirm the new "Profitability" KPI section shows counts matching the Profitability page's saved snapshots
16. Go to `/practice/planning-board.html` for a client with a saved low-margin/high-write-off snapshot → confirm the "📉 Low Margin" badge appears
17. As a non-manager, attempt to save a snapshot, create/update/action a review → confirm 403 on each; confirm all `GET`/analysis reads still succeed
18. Log in as a different company → confirm zero cross-company snapshots/reviews/events visible
19. DevTools → Application → Storage → confirm no profitability data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: practice_team_members has no cost-rate/internal-rate column — estimated_cost and margin_percentage are structurally non-informative until this is added
- Confirmed now: Every profitability figure that depends on cost (estimated_cost, estimated_margin, margin_percentage) is currently a placeholder — always 0/billed_value/100 respectively — with an always-present TEAM_COST_RATE_MISSING warning and a permanent frontend banner explaining this. Realization is the one reliable signal in this pass.
- Not yet confirmed: Whether the practice wants to add a cost-rate column to practice_team_members (e.g. an hourly internal/cost rate per team member) as a follow-up migration, which would make margin_percentage genuinely meaningful.
- Risk: Low today (the limitation is loudly flagged, never hidden) but WOULD become a real risk if a future session or user forgets this caveat and treats margin_percentage as accurate without re-reading this note.
- Recommended next review point: If/when cost-rate data becomes available, update calculateProfitability()'s estimated_cost calculation to use it (SUM(hours × team_member.cost_rate) per entry, grouped by user_id) and remove the TEAM_COST_RATE_MISSING warning + banner once real data exists for all relevant team members.
```

```
FOLLOW-UP NOTE
- Area: "profitability_status resolution — worse of margin vs. realization tier wins" is a documented Architect Freedom deviation from the spec's more ambiguous tier language
- Confirmed now: The spec's suggested thresholds use "or" between adjacent tiers without specifying what happens when the two metrics disagree; this module resolves that by taking the higher-severity tier of the two, which given the cost-rate gap above effectively means realization drives the status in every case today (since margin is always "profitable" when billed_value > 0).
- Not yet confirmed: Whether partners would prefer margin to be excluded from status resolution entirely until real cost data exists, rather than included-but-always-optimistic.
- Risk: None currently — the "worse wins" rule means margin can never make a status look BETTER than realization alone would; it only very rarely (basically never, given always-100 margin) makes it look no better either.
- Recommended: No action needed unless partners specifically request margin be excluded from status resolution until cost data exists.
```
