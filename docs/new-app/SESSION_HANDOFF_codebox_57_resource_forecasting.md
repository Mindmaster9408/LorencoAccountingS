# Session Handoff — Codebox 57: Practice Resource Forecasting + Future Capacity Planning

> Date: 2026-07-02
> Status: COMPLETE — migration 114 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Third-generation reuse — no source data or aggregation logic duplicated

This is the third codebox in a chain: `capacity.js` (Codebox pre-existing, exported in Codebox 56) → `work-queue.js`'s `buildActiveQueue()` (Codebox 55, exported in Codebox 56) → `planning-board.js`'s `buildTeamItemPool()` (Codebox 56, exported here) → `resource-forecasting.js`. Every hour figure in the forecast ultimately traces back to exactly one utilization formula and one per-item aggregation pass, reused three levels deep. This was the explicit point of the "no duplicated source data" Architect Freedom constraint, and it's the same discipline applied in Codebox 56 for the Planning Board.

### Two careful, additive extensions to `work-queue.js`

Forecasting needed two pieces of data the existing item shape didn't carry:
1. **`known_hours`** — added to `_fetchTasks`'s returned item. `practice_tasks` is the *only* source table across all 11 fetchers with a genuine `estimated_hours` column; every other source type has no comparable field at all. `known_hours` is `null` when the task itself has no estimate — never a guessed number substituted at this layer (guessing happens one layer up, in `resource-forecasting.js`'s `_estimateHours()`, where it's explicit and labelled).
2. **`client_id`** — added to all 10 fetchers' returned items. Every fetcher was already querying `client_id` as part of its `practice_clients:client_id(name, risk_rating)` embed (needed for `client_name`) — this just exposes a field that was already being fetched, not a new query or join.

Both are pure additions (new object keys); no existing field, filter, or ordering changed. Work Hub and Planning Board's rendering is unaffected since neither reads these new keys.

### Migration 114

- **`practice_resource_forecast_snapshots`** — frozen forecast output, same pattern as Codebox 51's KPI snapshots and Codebox 52's partner review packs (`forecast_data`/`summary_data` JSONB, computed once, never recalculated on read). `forecast_weeks` constrained to the spec's exact allowed set (4/6/8/12).
- **`practice_resource_forecast_events`** — append-only, the 3 spec event types.

### Backend — `resource-forecasting.js` (11 endpoints, matching spec exactly)

Key judgment calls:

**Load estimation is one small, pure, fully-documented function.** `_estimateHours(item)` implements the spec's placeholder table exactly (task 1h / review 0.5h / document follow-up 0.25h / deadline admin 0.5h) and extends it to two source types the spec's table didn't explicitly cover — compliance packs and tax returns — using the same "production role = full placeholder, review role = half placeholder" logic already established for tasks, rather than inventing a new rule. Every item's `confidence` is set alongside its hours (`actual_estimate`/`default_placeholder`/`unknown`), and the frontend visibly marks placeholder-derived numbers so a manager never mistakes one for a real estimate — directly satisfying "Document all placeholders. Do not pretend these are exact."

**Overdue items are pulled forward into week 0, not dropped.** A due-yesterday task is still real, unfinished work — excluding it from the forecast would understate the immediate pressure a manager most needs to see. Items due beyond the forecast window, or with no due date at all (a genuine gap for several source types — QMS reviews, compliance packs, and both tax return tables have no due-date column whatsoever), are marked `week_bucket: null` and reported as a distinct "unscheduled" count rather than silently guessed into a week — this is the concrete implementation of "no hidden logic."

**The Deadline Forecast bypasses the item pool entirely**, querying `practice_deadlines` directly across the full window — identical reasoning to Codebox 56's own Deadline Timeline: `buildTeamItemPool()` only ever returns items with a resolved assignee, so an unowned deadline (precisely the kind most likely to be missed) would otherwise never appear in the forecast at all.

**Client pressure and deadline risk are simple threshold functions of already-known fields**, not a second scoring engine: `pressure_status` bands on total forecast hours plus an overdue-item override; deadline `risk_level` bands on overdue-or-priority. No new inputs are introduced, and both are documented directly in the technical doc.

**`forecast_viewed` is logged only for saved-snapshot views, not live forecast polling.** The spec names 3 event types with no explicit trigger rule for `forecast_viewed`; logging it on every live `GET /forecast` call (fired on every filter change) would have made the audit table mostly noise. Opening a specific saved snapshot is the deliberate, meaningful "view" action. This is a narrower trigger than Codebox 56's `board_opened` (logged on every Planning Board page load) — see Follow-Up Notes for the inconsistency this creates across the two codeboxes and why it wasn't resolved by changing either.

### Frontend — `resource-forecasting.html` + `js/resource-forecasting.js` (prefix `rf`)

- Filter bar (start date, forecast weeks 4/6/8/12, team member) plus "Run Forecast"
- 6 summary cards (total capacity, allocated, capacity gap, overloaded weeks, critical weeks, unscheduled items)
- **Weekly Forecast Board** — the page's centrepiece, designed specifically to answer "do we have enough capacity?" within the spec's 30-second usability requirement: one column per week, a grey capacity bar next to a status-colored allocated bar (both height-scaled to the largest value currently in view), utilization % and status label directly beneath each pair
- Team Forecast table, sorted worst-status-first, with one-click "Open Queue" per member (reusing Codebox 56's `?team_member_id=` manager override)
- Client Pressure and Deadline Pressure tables — placeholder-hour entries visibly marked with `*` and amber coloring so they're never confused with real estimates
- Save Snapshot modal + a Saved Snapshots table with open/archive actions
- No chart library — pure CSS, consistent with every other codebox this session

### Integrations

Planning Board, Capacity, and Management Dashboard all gained a link/quick-action into the Resource Forecast page, completing the spec's Integration section exactly (including the Management Dashboard link, marked optional in the spec but included for workflow consistency with the Planning Board and Work Queue links already present there from Codebox 56/55).

---

## Nothing Regressed

- `work-queue.js`'s existing behavior for Work Hub and Planning Board is fully preserved — both new fields (`known_hours`, `client_id`) are additive object keys that neither existing consumer reads or is affected by.
- `capacity.js`, `planning-board.js`'s own routes, `management-dashboard.js`, `alert-rules.js`, `kpi-history.js`, `partner-review-packs.js`, `notifications.js` — all untouched beyond the two additive edits described above and the one `module.exports.buildTeamItemPool` line added to `planning-board.js`.
- `node --check` passes on `resource-forecasting.js`, `work-queue.js`, `planning-board.js`, `capacity.js`, `index.js`, `layout.js`, and both new frontend JS files.
- A standalone Node smoke test loaded `resource-forecasting.js` in isolation (which itself requires `capacity.js` and `planning-board.js`, which in turn requires `work-queue.js`, which requires `alert-rules.js`) and confirmed the full 4-level module chain resolves without a circular dependency.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `114_practice_resource_forecasting.sql`

Expected: "Success. No rows returned." Apply after migration 113 (already applied per the prior codebox's stated assumption).

No seeding step is required — both new tables start empty and populate only as managers save forecast snapshots.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, a standalone module-loading smoke test, and grep for browser-storage violations.*

1. Apply migration 114 to Supabase
2. As a non-manager, navigate to `/practice/resource-forecasting.html` → confirm the "manager access only" message, not a broken page
3. As a manager, run the default 6-week forecast → confirm the Weekly Forecast Board renders 6 columns with plausible-looking bars, and that a manager could genuinely eyeball overload within ~30 seconds (the spec's explicit usability bar)
4. Create a task with a real `estimated_hours` value due in week 2 → confirm it contributes to week 2's `allocated_hours` with `confidence: actual_estimate`, and that the Client/Deadline tables (where applicable) reflect the real number, not a placeholder
5. Create a task with no `estimated_hours` → confirm it still appears with a 1-hour (preparer) or 0.5-hour (reviewer) placeholder and `confidence: default_placeholder`, visibly marked in the UI
6. Create a task due yesterday (overdue) → confirm it's pulled forward into Week 1's `allocated_hours`, not excluded and not counted as "unscheduled"
7. Create a QMS review (no due date) assigned to a team member → confirm it appears in that member's total workload data but is counted under `unscheduled_item_count`, not silently placed in a week
8. Overload a specific team member (assign far more hours than their `weekly_capacity_hours` in one week) → confirm their Team Forecast row shows `over_capacity`/`critical` status and a positive capacity gap, and that the corresponding week(s) also show elevated `total_critical`/`overloaded_weeks` at the whole-practice summary level
9. Create an unowned `practice_deadlines` row (no `responsible_team_member_id`) due within the forecast window → confirm it appears in the Deadline Pressure table (owner shown as "Unassigned") but does not inflate any individual team member's Team Forecast numbers
10. Filter by a specific `team_member_id` → confirm `/forecast` and `/summary` scope correctly to just that person's capacity and allocated hours, while `/team`, `/clients`, `/deadlines` (which are practice-wide by design) remain unaffected by that filter
11. Switch forecast weeks between 4/6/8/12 → confirm the Weekly Forecast Board, summary cards, and all tables recompute correctly for the new window
12. Save a snapshot with a name and notes → confirm it appears in the Saved Snapshots table with the correct period and capacity gap
13. Open a saved snapshot → confirm its detail view shows the frozen summary figures, and confirm (via the DB or `GET /snapshots/:id/events`) that a `forecast_viewed` event was logged
14. Change underlying data (e.g. complete several tasks) after saving a snapshot, then reopen that snapshot → confirm its numbers are unchanged (frozen snapshot stability, same test pattern used for Codebox 51/52's snapshots)
15. Archive a snapshot → confirm it disappears from the default snapshot list but the row still exists with `status='archived'` in the DB (never hard-deleted)
16. Click "Open Queue" on a Team Forecast row → confirm it navigates to that member's Work Hub with the Codebox 56 "viewing as" read-only banner
17. Click the Planning Board / Capacity / Management Dashboard quick links → confirm each navigates correctly to the Resource Forecast page
18. Log in as a different company's manager → confirm zero cross-company data in every panel and every saved snapshot list
19. Performance: with a team of several members and a realistic number of active tasks/deadlines, confirm the forecast page loads in a reasonable time and that reloading shortly after (within ~20 seconds) is noticeably faster due to `planning-board.js`'s pool cache being warm
20. DevTools → Application → Storage → confirm no forecasting data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Event-logging trigger inconsistency between Codebox 56 (Planning Board) and this codebox
- Confirmed now: Planning Board logs `board_opened` on every page load (a "session start" style event). Resource Forecasting deliberately does NOT log an equivalent event on every live `GET /forecast` call — only `forecast_viewed` on opening a specific saved snapshot — because the forecast page's filter bar (start date/weeks/team member) triggers much more frequent re-fetching than Planning Board's week-shift buttons do, and logging every one of those would have produced a much noisier, lower-value audit trail.
- Not yet confirmed: Whether managers or auditors will find it inconsistent that one planning page logs "opened" events and the other doesn't.
- Risk: Very low — purely an audit-trail completeness/consistency question, no functional impact.
- Recommended: If a future audit requirement needs "who looked at the live forecast and when" (as opposed to "who saved/viewed a snapshot"), add a debounced or session-scoped `forecast_viewed` (or a new event type) rather than logging on every filter-bar change.
```

```
FOLLOW-UP NOTE
- Area: Several source types have no due-date column at all (QMS reviews, compliance packs, both tax return tables)
- Confirmed now: Items from these sources always land in the "unscheduled" bucket (week_bucket: null) regardless of forecast window — this is surfaced via unscheduled_item_count in the summary, not hidden.
- Not yet confirmed: Whether managers will find it confusing that a real, outstanding tax return never appears in any specific week of the Weekly Forecast Board, only in the aggregate "unscheduled" count and in the Client Pressure table's totals.
- Risk: Low-medium — this is a genuine, inherent data-availability gap (not a bug), but "unscheduled" as a bucket is less actionable for weekly planning than a real week assignment would be.
- Recommended: If this becomes a real usability complaint, the fix belongs in the owning module (e.g. adding a target/expected-completion date to tax returns and QMS reviews) rather than in the forecasting layer inventing a fake date — consistent with "source modules remain owners."
```

```
FOLLOW-UP NOTE
- Area: Client pressure/deadline risk banding thresholds (30h/15h/5h; overdue-or-urgent) are first-pass heuristics, not tuned against real practice data
- Confirmed now: Fully deterministic and documented, but the specific hour thresholds were reasoned defaults, not derived from any actual practice's historical workload data (none was available to calibrate against).
- Not yet confirmed: Whether 30/15/5 hours are the right breakpoints for a typical practice's client base, or whether they'll need adjustment once used against real data.
- Risk: Low — thresholds are trivially adjustable constants in one function (`_computeClientForecast` / the inline version in `GET /clients`), not embedded logic scattered across the codebase.
- Recommended: Revisit these three numbers after a few weeks of real usage if client pressure banding doesn't match managers' intuition.
```
