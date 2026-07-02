# Codebox 56 — Practice Planning Board + Weekly Planning Centre

> App: Lorenco Practice Management
> Status: Complete — migration 113 not yet applied to Supabase — nothing committed or pushed

## Purpose

The manager's planning wall: who has capacity, who is overloaded, what's at risk, which deadlines matter this week, which clients need attention. Not another task list — a weekly planning and workload-balancing centre a manager can run a Monday meeting from.

**NOT AI. NOT automatic task movement. NOT calendar sync. NOT automatic workload balancing.** This page aggregates and assists planning only — Capacity, Tasks, Notifications, Work Queue, and Management Dashboard remain the owners of their data.

## Architect Freedom — Scope Decisions & Deviations

1. **Full reuse of Codebox 55's aggregator and capacity.js's existing (previously unexported) `buildTeamCapacity()` — zero business logic re-implemented.** The Team Board, Week View, and Summary panels are all built by calling `work-queue.js`'s `buildActiveQueue(cid, teamMemberId)` once per active team member (in parallel) and `capacity.js`'s `buildTeamCapacity(cid)` — both previously internal functions, now exported exactly the way `management-dashboard.js` exported its compute functions for Codebox 51/52 and `alert-rules.js` exported `getRule`/`getRules` for Codebox 53. This is the direct, load-bearing answer to the spec's "No duplicated business logic" success criterion — the priority-scoring engine, the waiting-on-me/others rules, and the utilization/capacity-status math all live in exactly one place each, regardless of whether they're viewed from a personal Work Hub or a team-wide Planning Board.
2. **Team-wide aggregation trades some raw speed for correctness and reuse.** Calling `buildActiveQueue()` once per team member means N parallel calls (each already running 11 parallel source queries with its own 15-second cache) for a team of N people, rather than one hand-optimized team-wide query. For a typical accounting practice team size this is a legitimate priority-3 (fast loading) vs. success-criterion (no duplicated logic) trade-off, resolved in favour of correctness/reuse — reimplementing the same 11-source aggregation and scoring rules a second time, team-wide, would have been the more serious violation. A 20-second board-level cache (on top of Work Queue's own per-member cache) keeps the Summary/Week/Team/Deadline panels — fired together on page load — from recomputing more than once.
3. **The Deadline Timeline is deliberately NOT built from the per-member item pool.** `buildActiveQueue()` only ever returns items that have a resolved assignee — a deadline with no `responsible_team_member_id` is invisible to any personal queue by design (Codebox 55). But a manager planning the week needs to see *unowned* deadlines too, precisely because those are the ones most likely to be missed. `GET /deadlines` queries `practice_deadlines` directly instead, spanning 30 days back (recent overdue) through a configurable forward window (default 30 days), independent of the item pool. This isn't duplicated business logic — there's no scoring or ownership-resolution logic being re-implemented, just a direct company-wide read the personal aggregator was never designed to provide.
4. **Manager-only access, enforced server-side on every endpoint.** The Planning Board is gated to `practice_team_members.role IN ('owner', 'partner', 'admin', 'manager')` — every single endpoint calls `_requireManager()` first and returns 403 otherwise. This also surfaced and fixed a real inconsistency from Codebox 55: the landing-page redirect and the Work Hub's "view as" override had both used `['owner','partner','admin']`, omitting the distinct `'manager'` role that exists in the team role enum — directly contradicting Codebox 55's own spec language ("Management Dashboard remains default for partners and **practice managers**"). Both were corrected as part of this codebox (see Files Modified).
5. **"Work Queue: Open directly into employee queue" required a small, deliberate extension to Codebox 55.** Work Hub was built strictly self-scoped (Codebox 55's own explicit design choice) — there was no way for a manager to view a colleague's queue. Rather than build a second, parallel "team member queue view" inside Planning Board (which would have duplicated the entire Work Hub UI), `work-queue.js`'s `_requireTeamMember()` now accepts an opt-in `?team_member_id=` override, honoured **only** when the caller's own role is manager-level (re-validated server-side on every call, never trusted from the client). A non-manager passing this parameter is silently ignored and always gets their own queue. On the frontend, `work-queue.js` forwards this parameter only to the read-only queue-item GET calls — never to `/preferences` (so browsing a colleague's queue can never touch their display settings) and never to notifications (the Notifications panel always stays scoped to whoever is actually logged in). A "Viewing {name}'s queue — read-only" banner replaces the personal greeting when this mode is active.
6. **Planning note status enum (`open`/`in_progress`/`done`/`archived`) inferred, not given.** The spec lists the note fields but not the allowed `status` values. Given the event vocabulary only includes `note_archived` (no `note_completed`), `archived` was kept as the sole terminal/soft-delete state (via `DELETE`, which never hard-deletes), while `open`/`in_progress`/`done` give a lightweight kanban-style progression for notes that represent a genuine planning task (e.g. "get sign-off from Anton on the ABC Traders extension") rather than a purely static comment.

## Database — Migration 113

No work items are stored — the same principle as Codebox 55. Two tables:

- **`practice_planning_notes`** — manager-authored notes pinned to a `week_start` (always normalized to that week's Monday), optionally scoped to a `team_member_id` and/or `client_id`. Purely informational — never read by any other module.
- **`practice_planning_events`** — append-only, the exact 6 event types from the spec.

## Backend — `planning-board.js`

### Endpoints (12, matching the spec exactly)

`GET /summary`, `GET /week`, `GET /team`, `GET /deadlines`, `GET /capacity`, `GET /planning-notes`, `POST /planning-notes`, `PUT /planning-notes/:id`, `DELETE /planning-notes/:id`, `GET /events`, `POST /events`. (`DELETE /planning-notes/:id` archives, per the codebase's universal soft-delete convention — it never issues a hard `DELETE` against the row.)

### Planning Aggregation Logic

`_buildTeamItemPool(cid)` — the board's one shared, cached building block:
1. Fetches every active `practice_team_members` row for the company.
2. Calls `workQueue.buildActiveQueue(cid, member.id)` for every one of them in parallel via `Promise.all`.
3. Tags each returned item with `team_member_id`/`team_member_name` and flattens into one array.
4. Caches the result for 20 seconds per `company_id`.

Every panel that needs "what's outstanding across the team" (Summary, Week View, Team Board) filters this same array — none of them re-query the 11 source tables independently.

### Weekly Planning Logic

`GET /week?week_start=` normalizes any date to that week's Monday (`_mondayOf`) and returns 6 categorized buckets, each `{ count, items }`, all derived from the same team item pool with zero extra queries:
- **This Week** / **Next Week** — `due_date` within the selected week / the following week.
- **Overdue** — `due_date` before today (absolute, not week-relative — overdue work matters regardless of which week is being viewed).
- **High Risk** — `priority_label === 'critical'` or `blocked === true`.
- **Upcoming Deadlines** — `source_module === 'deadlines'` due within 14 days.
- **Waiting For Review** — `waiting_on === 'me'` across the whole team (i.e. someone, somewhere, is the reviewer/approver and it's sitting with them) — the exact same definition Codebox 55 established, just evaluated team-wide instead of for one person.

`GET /team` merges `buildTeamCapacity()` (utilization/capacity-status) with per-member counts derived from the same item pool (overdue/due-this-week/critical/waiting-for-review/planning-notes), sorted overloaded-first, each card carrying a `work_queue_link` (`?team_member_id=`) and `capacity_link` (`?member_id=`) for one-click navigation.

## Frontend

`planning-board.html` + `js/planning-board.js` (prefix `pb`): a week selector (Prev/Next/This Week), a 10-card weekly summary strip (several cards are clickable quick filters into the Week View tabs or Notifications), a tabbed Week View (This Week/Next Week/Overdue/High Risk/Upcoming Deadlines/Waiting For Review) reusing the same item-row rendering style as Work Hub, a Team Board grid with per-member utilization bars and workload stats, a Deadline Timeline (overdue highlighted), and a Planning Notes panel with add/edit/archive. A single search box filters every already-loaded panel client-side (no extra round-trips) and logs `filter_changed`. No chart library, no AI, per architecture boundaries.

## Manager Workflow

The natural sequence the spec names — Management Dashboard → Planning Board → My Work — is now wired end to end: Management Dashboard has a "🗂️ Open Planning Board" quick action; Planning Board's Team Board cards deep-link into each employee's Work Hub (`?team_member_id=`) and Capacity page (`?member_id=`); Work Hub itself already links back to Notifications and every source module. A non-manager who navigates directly to `/practice/planning-board.html` sees a clear "manager access only" message rather than a broken or empty page.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `planning-board.js`, both frontend files, and every edited file (`capacity.js`, `work-queue.js`, `index.js`, `layout.js`, `index.html`, `management-dashboard.html`). Confirmed via grep.

## Multi-Tenant Safety

Every endpoint scopes its queries to `company_id` and additionally requires the caller's own team-member role to be manager-level (re-resolved server-side from `req.user.userId` on every request — never trusted from a client-supplied value). The team item pool cache and Work Hub's per-member cache are both keyed by `company_id` (and `team_member_id` for the latter), so no cross-tenant or cross-employee data can leak between requests.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/113_practice_planning_board.sql` | 2 tables |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | Router + team-wide aggregation |
| `accounting-ecosystem/backend/frontend-practice/planning-board.html` | Planning wall UI |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Planning wall UI logic |
| `docs/new-app/56_planning_board.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_56_planning_board.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/capacity.js` | Exported the previously-internal `buildTeamCapacity()` for reuse |
| `accounting-ecosystem/backend/modules/practice/work-queue.js` | Exported `buildActiveQueue()`; added the manager-only `?team_member_id=` override; corrected `MANAGER_ROLES` to include `'manager'` |
| `accounting-ecosystem/backend/frontend-practice/js/work-queue.js` | Forwards `?team_member_id=` to queue-item GET calls only (never preferences/notifications); shows a "viewing as" banner |
| `accounting-ecosystem/backend/frontend-practice/index.html` | Corrected the Codebox 55 landing-redirect role check to include `'manager'` |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `planning-board` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Planning Board" nav entry, reordered nav to Dashboard → Management Dashboard → Planning Board → My Work |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added "🗂️ Open Planning Board" quick action |
