# Session Handoff — Codebox 56: Practice Planning Board + Weekly Planning Centre

> Date: 2026-07-02
> Status: COMPLETE — migration 113 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Full reuse of two prior codeboxes' aggregation engines

Before writing any new aggregation logic, `capacity.js` and `work-queue.js` were inspected for existing, reusable functions. `capacity.js` already had an internal `buildTeamCapacity(cid)` doing exactly the utilization/capacity-status math needed — it just wasn't exported. `work-queue.js`'s `_buildActiveQueue(cid, tmId)` (Codebox 55) already did the entire 11-source aggregation + deterministic priority scoring needed per team member. Both were exported (one line each, zero behavior change to their own routers) and `planning-board.js` calls them directly. This is the direct implementation of the spec's "No duplicated business logic" success criterion — there is exactly one utilization formula and exactly one priority-scoring formula in the whole codebase, and both are now used by three different pages (Capacity/Work Hub/Planning Board or Management Dashboard/KPI History/Partner Packs/Work Hub/Planning Board respectively).

### Two real bugs caught and fixed while building this

1. **`MANAGER_ROLES` was missing `'manager'` in two places.** Codebox 55's landing-page redirect (`index.html`) and this codebox's own first draft of the Work Hub `?team_member_id=` override both checked `role IN ('owner','partner','admin')` — omitting the distinct `'manager'` role that exists in the team role enum (`practice_team_members.role`). This directly contradicted Codebox 55's own spec language: "Management Dashboard remains default for partners and **practice managers**." Both were corrected. Worth flagging because it's the kind of small inconsistency that would have quietly meant every practice manager (as opposed to owner/partner/admin) landed on the wrong default page and couldn't use the Planning Board's employee-queue links — exactly the audience this codebox is built for.
2. **The Deadline Timeline cannot be built from the per-member item pool** — confirmed by design, not by accident, but worth stating clearly: `buildActiveQueue()` only returns items with a resolved assignee, so any deadline with no `responsible_team_member_id` set is invisible to every personal queue by Codebox 55's own design. A manager planning the week needs exactly those unowned deadlines, since they're the ones most likely to slip through. `GET /deadlines` queries `practice_deadlines` directly rather than reusing the pool.

### Migration 113

- **`practice_planning_notes`** — manager notes pinned to `week_start` (always normalized to that week's Monday via `_mondayOf()`), optionally scoped to `team_member_id` and/or `client_id`. Status enum (`open`/`in_progress`/`done`/`archived`) was inferred from the spec's event vocabulary (only `note_archived` exists, no `note_completed`) since the spec didn't enumerate allowed values explicitly.
- **`practice_planning_events`** — append-only, the exact 6 spec event types.

### Backend — `planning-board.js` (12 endpoints, matching spec exactly)

Key judgment calls:

**Every endpoint is manager-gated server-side**, via `_requireManager()` checking `practice_team_members.role IN ('owner','partner','admin','manager')` resolved fresh from `req.user.userId` on every request — never trusted from any client-supplied value. A non-manager gets a clean 403 with a clear message, and the frontend shows a dedicated "manager access only" state rather than a broken/empty board.

**Team-wide aggregation via N parallel per-member calls, not a hand-optimized team query.** `_buildTeamItemPool()` calls `buildActiveQueue()` once per active team member in parallel, tags each item with who it belongs to, and flattens. This is architecturally the "correct" trade — it guarantees the team view can never drift from what an individual sees in their own Work Hub — at the cost of N×11 concurrent source queries for a team of N people. A 20-second cache (layered on top of Work Queue's own per-member cache) means this only actually runs once per board-load burst (Summary/Week/Team panels fired together), which should be more than adequate for realistic accounting-practice team sizes. Documented as a follow-up in case team size grows large enough to matter.

**Work Hub extended, carefully, to support "view as."** The spec's Integration section explicitly requires "Work Queue: Open directly into employee queue," but Codebox 55 built Work Hub strictly self-scoped. Rather than duplicate the Work Hub UI a second time inside Planning Board, `work-queue.js`'s `_requireTeamMember()` gained an opt-in `?team_member_id=` override — re-validated server-side against the *caller's own* role on every single call (a non-manager passing this parameter is silently ignored, always getting their own queue back). On the frontend, this parameter is forwarded only to the read-only queue-item GET calls; `/preferences` and the Notifications panel always stay scoped to whoever is actually logged in, so a manager browsing a colleague's queue can never accidentally touch that colleague's settings or see their private notifications. A "Viewing {name}'s queue — read-only" banner makes the mode unambiguous.

**Deadline Timeline spans 30 days back through a configurable forward window** (default 30 days, capped at 90) — deliberately wider than the Week View's 14-day "upcoming deadlines" bucket, since the Timeline's job is comprehensive visibility (including things already overdue), not just what's due soon for people who already have the work assigned to them.

### Frontend — `planning-board.html` + `js/planning-board.js` (prefix `pb`)

- Week selector (Prev / This Week / Next) driving every panel via a single `week_start` query param
- 10-card weekly summary strip — several cards double as quick filters (clicking "Overdue" jumps the Week View tabs to the Overdue bucket; clicking "Unread Notifications" opens the Notification Centre)
- Tabbed Week View reusing the same item-row visual language as Work Hub (priority-colored left border, reason text, team-member/client/source meta line) so the two pages feel like one system
- Team Board — a card grid per member with a utilization bar, workload/overdue/due-this-week/critical/waiting-review/notes counts, and one-click "Open Queue" / "Capacity" links
- Deadline Timeline — chronological, overdue entries visually distinct
- Planning Notes — add/edit/archive, scoped to the selected week and optionally to a team member/client
- One search box filters every already-loaded panel client-side (no extra network round-trips per keystroke) and logs a single `filter_changed` event

### Manager Workflow Wiring

Management Dashboard now has a "🗂️ Open Planning Board" quick action positioned before the existing "📋 Open My Work Queue" link, completing the spec's named sequence: Management Dashboard → Planning Board → My Work.

---

## Nothing Regressed

- `capacity.js`'s own 4 routes (`/summary`, `/team`, `/clients`, `/risks`) are completely unchanged — only one `module.exports.buildTeamCapacity = buildTeamCapacity;` line was added at the very end of the file.
- `work-queue.js`'s existing self-scoped behavior is fully preserved for every caller that doesn't pass `?team_member_id=` (the overwhelming majority — every normal staff member using their own Work Hub). The new override is purely additive and role-gated.
- `management-dashboard.js`, `alert-rules.js`, `kpi-history.js`, `partner-review-packs.js`, `notifications.js` — untouched.
- `node --check` passes on `planning-board.js`, `capacity.js`, `work-queue.js`, `index.js`, `layout.js`, and both new/modified frontend JS files.
- A standalone Node smoke test loaded `planning-board.js` in isolation (which itself requires both `capacity.js` and `work-queue.js`) and confirmed the full module chain resolves without a circular dependency.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `113_practice_planning_board.sql`

Expected: "Success. No rows returned." Apply after migration 112 (already applied per the prior codebox's stated assumption).

No seeding step is required — both new tables start empty and populate naturally as managers open the board and add planning notes.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, a standalone module-loading smoke test, and grep for browser-storage violations.*

1. Apply migration 113 to Supabase
2. Log in as a team member with role `staff`/`senior`/`reviewer` → navigate to `/practice/planning-board.html` → confirm the "manager access only" message appears, not a broken/empty page
3. Log in as a team member with role `manager` specifically (not owner/partner/admin) → confirm the board loads correctly (this exercises the `MANAGER_ROLES` fix)
4. As a manager, confirm the week selector shows the current week by default, and Prev/Next correctly shift by 7 days each click, updating every panel
5. Click "This Week" after navigating away — confirm it returns to the actual current week
6. Create a task overdue for a specific team member, then confirm it appears in: that member's Work Hub, the Planning Board's Overdue tab, and that member's Team Board card's "Overdue" count — all three should agree exactly (proves the shared-aggregator design works)
7. Create a `practice_deadlines` row with NO `responsible_team_member_id` set → confirm it appears in the Deadline Timeline (proving the direct-query design) but does NOT appear in any Team Board member's counts or Week View buckets (since it's genuinely unowned)
8. Click a Team Board member's "Open Queue" link → confirm it navigates to their Work Hub with a "Viewing {name}'s queue — read-only" banner, and that the data shown matches what that member sees when logged in themselves
9. While viewing another employee's queue via step 8, confirm collapsing a section or any other preference-style action does NOT change that employee's own saved preferences (verify by having them log in afterward and checking their preferences are untouched)
10. Confirm a regular staff member manually appending `?team_member_id=X` to their own Work Hub URL has zero effect (still sees only their own queue) — proves the server-side role re-validation, not just a client-side check
11. Add a planning note scoped to a specific team member for the current week → confirm it appears in that member's Team Board card's note count and in the Planning Notes panel
12. Add a team-wide planning note (no team member selected) → confirm it appears in the Planning Notes panel but does not inflate any individual member's note count
13. Edit a note, then archive it → confirm archived notes disappear from the default list (verify the row still exists with `status='archived'` in the DB — never hard-deleted)
14. Click a summary card that doubles as a quick filter (e.g. "Overdue") → confirm the Week View tab bar switches to that bucket
15. Click "Unread Notifications" → confirm it navigates to the Notification Centre
16. Type a search term → confirm it filters the Week View, Team Board, Deadline Timeline, and Planning Notes panels simultaneously without any additional network requests
17. Open the browser Network tab and reload the board → confirm the summary/week/team panels don't trigger a redundant burst of duplicate source-table queries (the 20-second pool cache should mean the 11-source aggregation only runs once per team member, not once per panel)
18. Log in as a different company's manager → confirm zero cross-company data in every panel
19. DevTools → Application → Storage → confirm no planning-board data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Team-wide aggregation performance for very large teams
- Confirmed now: _buildTeamItemPool() calls buildActiveQueue() once per active team member in parallel (N×11 concurrent source queries for N team members), cached 20 seconds per company.
- Not yet confirmed: Behaviour/latency for a practice with a very large team (50+ active members) — this hasn't been load-tested.
- Risk: Low for typical accounting practice team sizes (single to low double digits); could become a real "Fast loading" concern (implementation priority #3) if a practice's team grows substantially.
- Recommended: If Planning Board load times become a real complaint, the first lever is extending the cache TTL or pre-warming it on a schedule, before considering a hand-optimized team-wide query that would reintroduce the duplicated-logic risk this codebox specifically avoided.
```

```
FOLLOW-UP NOTE
- Area: Planning note status values (open/in_progress/done/archived) were inferred, not specified
- Confirmed now: Chosen to match the spec's event vocabulary (only note_archived exists as a lifecycle event, implying archived is the sole terminal/soft-delete state) while still giving notes a lightweight progression for genuine planning tasks.
- Not yet confirmed: Whether practice managers actually want/use the open→in_progress→done progression, or whether notes are used purely as static comments (in which case a simpler open/archived binary might have been sufficient).
- Risk: None — the richer enum doesn't prevent simple usage; a manager can just leave every note at "open" until archiving it.
- Recommended: Revisit if user feedback suggests the status field goes unused or is confusing.
```

```
FOLLOW-UP NOTE
- Area: "View as" employee-queue mode has no visual restriction beyond the greeting banner
- Confirmed now: The backend fully prevents preference/notification leakage (see Architect Freedom #5), and item clicks still navigate to real source records exactly as they would for the employee themselves — this is intentional (a manager should be able to open and review the actual work, not just see a summary).
- Not yet confirmed: Whether managers might want an even more visually distinct "read-only" treatment (e.g. disabling the search box, greying out interactive elements) beyond the banner already added.
- Risk: Very low — no data can be corrupted or misattributed in this mode; this is a pure UX polish question.
- Recommended: Gather manager feedback after real usage before investing further here — the current banner-only approach was a deliberate "minimum needed for clarity" choice, not a completeness gap.
```
