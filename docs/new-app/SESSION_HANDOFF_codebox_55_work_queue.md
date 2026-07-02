# Session Handoff — Codebox 55: Practice Work Queue + Personal Work Hub

> Date: 2026-07-02
> Status: COMPLETE — migration 112 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Pre-build audit — and a caught error

A background research pass mapped exact column names (assignee/due-date/status/title) across all 11 named source modules before writing the aggregator. Its report was spot-checked against source rather than trusted blindly, which caught a real error: it claimed `practice_deadlines` had no assignee column, but `dashboard.js` (lines 216, 225) directly proved a `responsible_team_member_id` column exists and is already used in production queries. Using the audit's wrong claim would have meant deadlines could never appear in anyone's personal queue — a significant silent gap. All other high-risk claims (risk owner field, QMS reviewer/finding fields, document-requests/communications assignee fields, tax return responsible/reviewer fields, billing having no assignee) were independently confirmed via direct grep before being used in the router.

### Migration 112

- **`practice_work_queue_preferences`** — one row per team member, display-only settings (default view, show completed/notifications, collapsed sections). Never influences queue contents.
- **`practice_work_queue_events`** — append-only, the 6 spec event types. No work items are stored anywhere — confirmed by design: the queue is 100% live-computed on every request (short-TTL cache only, never persisted state).

### Backend — `work-queue.js` (13 endpoints: 12 from spec + `POST /events`)

Key judgment calls:

**Aggregation runs once, filtered many ways.** `_buildActiveQueue()` is the single source of truth — it queries all 11 sources in parallel, normalizes, scores, and sorts. Every other endpoint (`/today`, `/overdue`, `/upcoming`, `/waiting-on-me`, `/waiting-on-others`) filters that same array; none of them re-queries the source tables independently. A 15-second in-process cache keyed by `${company_id}:${team_member_id}` means a single page load's burst of ~6 requests only triggers the expensive aggregation once — directly serving the "Fast loading" implementation priority.

**Priority scoring is additive and fully explainable.** Every point added to an item's score (blocked, overdue, due-today/soon, severity, manual priority, client risk rating, "waiting on you") has a matching human-readable fragment appended to that item's `reason` string. There is no scoring factor that isn't visible in the UI — satisfies the spec's explicit "no hidden scoring" constraint and "The reason must always explain WHY it appears where it does."

**"Waiting on me" vs "waiting on others" has one precise, consistently-applied definition** across every source (see the technical doc for the exact rule per source type) — not a vague or per-source-inconsistent heuristic. This was the single most detail-sensitive part of the aggregator and is documented directly in code comments above each fetcher.

**No item can be completed/snoozed/delegated from the Work Hub except Notifications.** This is a direct consequence of the spec's own Architecture Boundaries ("This page DOES NOT replace... It aggregates them"). Building safe "complete" actions for 8+ different source types would mean re-implementing each module's own status-transition rules here — the definition of "business logic duplicated," which the spec explicitly forbids. Notifications are the one exception because Codebox 54 already exposes safe, purpose-built completion endpoints that this router simply calls, not reimplements.

**`POST /events` was added beyond the literal endpoint list** because without it, the append-only `practice_work_queue_events` table mandated by the DATABASE section could never receive a single row — the spec's endpoint list only included GETs and `PUT /preferences`. Same reasoning already applied in Codebox 53 (`alert-rules.js`) and Codebox 54 (`notifications.js`) for identical gaps.

### Frontend — `work-queue.html` + `js/work-queue.js` (prefix `wq`)

- Time-of-day greeting header ("Good morning, Anton.")
- Clickable focus strip (My Work / Today / Overdue / Upcoming / Waiting On Me / Notifications counts) that switches the My Queue view
- "Highest Priority" panel — top 5 items straight from `/summary`, no extra request
- "My Queue" panel — search box + quick-filter chips (All/Today/Overdue/Upcoming), each item shows its priority pill, its `reason` text, and a one-click "Open →" button
- "Recently Completed" (14-day window) and "Waiting On Others" — both collapsible, state persisted to `practice_work_queue_preferences.collapsed_sections`
- Sidebar Notifications panel with inline severity pills — clicking marks the notification read and navigates to the full Notifications page
- Every item click logs `item_opened` (via the new `POST /events`) before navigating to the item's deep link — this is the "one-click navigation, links directly into source modules" requirement in action

### Landing-Page Routing

`/practice` (the bare root URL used right after opening the app from the ecosystem hub) now performs one client-side redirect check: fetch `GET /api/practice/work-queue/preferences` (cheap — one query, already needed for the page itself), read `team_member.role`, and redirect `owner`/`partner`/`admin` to Management Dashboard, everyone else to Work Hub. The pre-existing Command Centre page (`index.html`) is never itself redirected — only the bare `/practice` path triggers the check — and the "Dashboard" nav tab was repointed to `/practice/index.html` explicitly so it keeps working and doesn't loop.

### Notifications Integration

Added an "Open Source Record →" button to the notification detail modal (Codebox 54's `notifications.html`) using the same `source_module → URL` mapping the Work Hub aggregator uses server-side, duplicated client-side since notifications don't flow through the aggregator. Satisfies the spec's "Notifications: Open directly into source records" integration point.

### Management Dashboard Integration

Added a "🗂️ Open My Work Queue" quick action. Deliberately **not** labelled "My Team Work" as the spec's Integration section names it — this codebox's aggregator is strictly personal (one team member's own queue, never a team-wide view), and a genuinely team-wide planning view is explicitly Codebox 56's job (Planning Board). Using the spec's literal label here would have promised functionality that doesn't exist yet.

---

## Nothing Regressed

- No existing source module (tasks, deadlines, reminders, risk-register, quality-management, compliance-packs, document-requests, communications, tax modules) was modified — this router is 100% read-only against them.
- `notifications.js` backend untouched; only the frontend detail modal gained one new button.
- `management-dashboard.js`, `alert-rules.js`, `kpi-history.js`, `partner-review-packs.js` — untouched.
- The existing Command Centre (`index.html`) page's own dashboard logic (`dashboard.js`, KPI cards, risk panels) is completely unchanged — only a small, isolated, gated redirect script was added above it, and it only fires on the exact bare `/practice` path.
- `node --check` passes on `work-queue.js`, `index.js`, `layout.js`, `notifications.js`, and both new frontend JS files.
- A standalone Node smoke test loaded `work-queue.js` in isolation and confirmed the full `index.js` router chain (all 6 mounted practice sub-routers, including the new one) still loads without error — no circular dependency introduced.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `112_practice_work_queue.sql`

Expected: "Success. No rows returned." Apply after migration 111 (already applied per the prior codebox's stated assumption).

No seeding step is required — `practice_work_queue_preferences` and `practice_work_queue_events` both start empty and populate naturally as users open the Work Hub and adjust settings.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, a standalone module-loading smoke test, and grep for browser-storage violations.*

1. Apply migration 112 to Supabase
2. Ensure at least one logged-in test user has a linked, active `practice_team_members` row (matching `user_id`), and that some outstanding tasks/deadlines/risks/etc. are assigned to that team member
3. Navigate to `/practice/work-queue.html` directly — confirm the greeting, focus strip, and all panels populate without errors
4. Navigate to bare `/practice` as a staff-role user — confirm it redirects to `/practice/work-queue.html`
5. Navigate to bare `/practice` as an owner/partner/admin-role user — confirm it redirects to `/practice/management-dashboard.html`
6. Click the "Dashboard" nav tab from any Practice page — confirm it lands on the Command Centre (`/practice/index.html`) without being redirected away
7. Create/assign a task to the test team member with `due_date` = yesterday → confirm it appears in "Overdue" (both the focus-strip count and the filtered My Queue view) with a "Overdue by 1 day" reason and a red-bordered critical/high priority pill
8. Create a task where the test team member is the `reviewer_team_member_id` and `review_status = 'in_review'` → confirm it appears in "Waiting On Me" with reason including "Waiting on you"
9. Create a task where the test team member is the `preparer_team_member_id` and `review_status = 'in_review'` → confirm the SAME task appears in "Waiting On Others" (not "Waiting On Me") for that team member
10. Confirm a `practice_deadlines` row with `responsible_team_member_id` set to the test team member appears correctly in the queue (this exercises the corrected audit finding — see technical doc)
11. Click any work item → confirm it logs an `item_opened` event (check `practice_work_queue_events` table) and navigates to the correct source page with the right `?open=` id
12. Switch quick-filter chips (Today/Overdue/Upcoming/All) → confirm the My Queue list updates correctly and a `queue_filtered` event is logged
13. Search for a known item's title → confirm it filters correctly and search text carries through to the underlying view's endpoint
14. Collapse "Recently Completed" → refresh the page → confirm it stays collapsed (persisted via `PUT /preferences`)
15. Click a notification in the sidebar → confirm it marks the notification read (check in `/practice/notifications.html`) and navigates to the Notifications page
16. Open a notification with a `source_module`/`source_type`/`source_id` set → confirm the "Open Source Record →" button appears and navigates correctly
17. Complete a task directly on `/practice/tasks.html` → confirm it drops out of the active queue and appears in "Recently Completed" on the Work Hub within the 14-day window
18. Log in as a team member with NO linked `practice_team_members` row → confirm the Work Hub shows the "not linked" message gracefully (no error, no crash) and that bare `/practice` falls back to Work Hub rather than erroring
19. Log in as a different company → confirm zero cross-company items ever appear in any panel
20. DevTools → Application → Storage → confirm no work-queue data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Unlinked users (no practice_team_members row) default to Work Hub, not Management Dashboard, in the landing-page redirect
- Confirmed now: This is a safe-by-default choice — an unknown role should not land on the executive view.
- Not yet confirmed: Whether any current owner/partner/admin accounts are missing their practice_team_members link (if so, they'd land on an empty Work Hub instead of Management Dashboard until linked).
- Risk: Low — only affects users whose account setup is already incomplete; the Work Hub gracefully shows a "not linked" message rather than erroring either way.
- Recommended: As part of applying migration 112, spot-check that all current partners/admins have an active, linked practice_team_members row.
```

```
FOLLOW-UP NOTE
- Area: item_delegated event type exists in the schema but is not emitted by any current UI action
- Confirmed now: There is no reassignment/delegation feature anywhere in the practice module yet — this event type was added purely because the spec's DATABASE section names it as one of the 6 required event types.
- Not yet confirmed: What a "delegate" action would concretely do (reassign the underlying source record's assignee field, which varies by source module) — this needs its own design, likely in Codebox 56 (Planning Board) or a dedicated future codebox.
- Risk: None currently — an unused, schema-supported event type has no functional downside.
- Recommended: When a delegation feature is designed, it should call the same event logging pattern already established here (`POST /work-queue/events` with `event_type: 'item_delegated'`), rather than inventing a new logging path.
```

```
FOLLOW-UP NOTE
- Area: Deep-link source_module → URL mapping is duplicated between work-queue.js (server) and js/notifications.js (client), rather than shared
- Confirmed now: Both copies are commented to reference each other. This was a deliberate call to avoid introducing a new shared-module dependency between two previously independent frontend files for a small, low-churn mapping table.
- Not yet confirmed: Whether this mapping will need to grow significantly as more source modules gain deep-link support in future codeboxes, at which point duplication could become a real maintenance risk.
- Risk: Low today (10 entries, rarely changes) — would increase if the mapping grows substantially.
- Recommended: If a third consumer of this mapping appears in a future codebox, extract it into a small shared frontend utility (e.g. `js/deep-links.js`) at that point rather than duplicating a third time.
```
