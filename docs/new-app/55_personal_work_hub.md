# Codebox 55 — Practice Work Queue + Personal Work Hub

> App: Lorenco Practice Management
> Status: Complete — migration 112 not yet applied to Supabase — nothing committed or pushed

## Purpose

Every practice employee's operational home page — answering "what must I work on next?" by aggregating tasks, deadlines, reminders, risks, QMS reviews/findings, compliance packs, document requests, communications, and tax work into one deterministic, explainable, prioritized queue. Management Dashboard remains the executive view; Work Hub is the operational one.

**NOT AI. NOT automatic workload balancing. NOT auto-assignment.** No work items are stored — the queue is always computed live from the source tables, which remain the sole owners of their data.

## Architect Freedom — Scope Decisions & Deviations

1. **Pre-build schema audit, with a caught correction.** A background research pass mapped the exact assignee/due-date/status columns across all 11 named source modules before any code was written. One of its findings was independently spot-checked and found wrong: it reported `practice_deadlines` has no assignee column, but direct inspection of `dashboard.js` (lines 216/225) showed a `responsible_team_member_id` column does exist and is already used elsewhere in the codebase. This is called out explicitly because getting it wrong would have meant deadlines could never appear in a person's own queue — a significant functional gap. All other audit findings were spot-verified against source before use.
2. **"Tasks" + "Review Tasks" consolidated into one source.** The spec's Queue Sources list names both separately, but there is only one table (`practice_tasks`) with built-in `review_status`/`approval_status` columns and four role columns (`assigned_to`, `preparer_team_member_id`, `reviewer_team_member_id`, `approver_team_member_id`). One fetcher (`_fetchTasks`) covers both — a task shows up with `role: 'reviewer'` and `waiting_on: 'me'` when its review is pending on the current user, which is exactly what a separate "Review Tasks" source would have produced, without a second query against the same table.
3. **Notifications kept as a separate, unscored section — never merged into the priority queue.** Notifications already carry their own severity/status semantics (Codebox 54) and the spec's own Frontend section lists "Notifications" alongside "Highest Priority"/"My Queue" as a distinct section, not a filtered view of it. Merging them would have meant re-deriving a second priority score for data that already has one.
4. **"Waiting On Me" vs "Waiting On Others" — a precise, documented definition**, not a vague label:
   - **Waiting on me**: my role on the item is reviewer/approver AND the item's status shows it's specifically pending that action from me (e.g. a task where I'm the reviewer and `review_status` is `pending`/`in_review`; a compliance pack where I'm the reviewer and `status` is `ready_for_review`; a tax return where I'm the reviewer and `status` is `ready_for_review`).
   - **Waiting on others**: my role is preparer/responsible/assignee/owner AND the item is now sitting with someone else (I prepared a task now in review; I requested documents still outstanding from the client; I logged a communication awaiting the client's response).
   - This mapping is implemented once per source fetcher and is fully deterministic — never inferred, never scored differently by section.
5. **No in-place "complete/snooze/delegate" actions for most sources.** The spec's own Architecture Boundaries state this page "does not replace" the 7 named modules — only aggregates them. Implementing safe completion for every source type would mean duplicating 8+ different modules' own update logic and status-transition rules inside this router, directly violating "no business logic duplicated." The only exception is **Notifications**, where Codebox 54 already exposes safe, purpose-built `PUT /:id/read|complete|snooze` endpoints — the Work Hub calls those directly (not a reimplementation) for its Notifications panel's quick actions. Every other item type is "Open" (deep link) only — you complete the actual work on the actual source page.
6. **`item_completed`/`item_snoozed`/`item_delegated` events are schema-supported but only `item_completed`/`item_snoozed` are ever emitted today** (from the Notifications quick actions described in #5). `item_delegated` has no corresponding UI action anywhere yet — there is no reassignment feature in this codebox — the event type exists in the schema for a future "delegate" feature to use without a migration change.
7. **`POST /events` added beyond the spec's literal endpoint list.** The DATABASE section mandates an append-only `practice_work_queue_events` table with 6 event types, but the BACKEND section's endpoint list contains only GETs plus `PUT /preferences` — with no way to ever write an event, the table would stay permanently empty. Adding `POST /events` was necessary, not scope creep (same reasoning applied to `alert-rules.js` and `notifications.js` in prior codeboxes).
8. **Role-based landing routing is client-side, with one caveat.** `/practice` (the bare entry URL used right after selecting the app) now redirects: team members with role `owner`/`partner`/`admin` land on Management Dashboard, everyone else lands on Work Hub. This is implemented as a small inline script in `index.html`, gated so it only fires on the exact `/practice` path — the existing "Dashboard" nav tab was repointed to `/practice/index.html` so the original Command Centre page stays reachable and is never itself redirected (no redirect loop). The caveat: a user with no linked `practice_team_members` row (role unknown) defaults to Work Hub rather than Management Dashboard — a safe-by-default choice, but means an admin whose account isn't yet linked to a team member would land somewhere other than the executive view. Documented as a follow-up.
9. **Deep-link mapping duplicated (not shared) between `work-queue.js` (server) and `notifications.js` (frontend).** Notifications' "Open Source Record" button (the spec's "Notifications: Open directly into source records" integration point) needed the same `source_module → URL` mapping the Work Hub aggregator already builds server-side per item. Since notifications don't go through the aggregator, the mapping was duplicated client-side in `js/notifications.js` rather than introducing a new shared-JS-module dependency between two previously independent frontend files. Both copies are commented to point at each other so future edits don't drift silently.

## Database — Migration 112

No work items are stored — exactly as specified. Two tables:

- **`practice_work_queue_preferences`** — one row per team member (`company_id, team_member_id` unique), controlling only *how* the Work Hub displays (default view, show completed/notifications, section collapse state) — never *what* appears.
- **`practice_work_queue_events`** — append-only, the exact 6 event types from the spec.

## Backend — `work-queue.js`

### Endpoints (13 — the 12 from the spec plus `POST /events`)

`GET /summary`, `GET /my-work`, `GET /today`, `GET /overdue`, `GET /upcoming`, `GET /waiting-on-me`, `GET /waiting-on-others`, `GET /completed`, `GET /notifications`, `GET /preferences`, `PUT /preferences`, `GET /events`, `POST /events`.

### Queue Aggregation Logic

`_buildActiveQueue(cid, teamMemberId)` runs 11 source-fetchers in parallel (`_fetchTasks`, `_fetchDeadlines`, `_fetchReminders`, `_fetchRisks`, `_fetchQmsReviews`, `_fetchQmsFindings`, `_fetchCompliancePacks`, `_fetchDocumentRequests`, `_fetchCommunications`, and 2× `_fetchTaxReturns` for individual/company), each isolated so one source erroring never blocks the others. Every fetcher normalizes its rows into one common item shape (`source_module`, `source_type`, `source_id`, `role`, `title`, `client_name`, `client_risk_rating`, `due_date`, `status`, `manual_priority`, `severity_band`, `blocked`, `waiting_on`, `deep_link`), scores each item, sorts by score descending, and caches the result for 15 seconds per `(company, team member)` pair — a single page load firing `/summary` + `/my-work` + `/notifications` + `/waiting-on-me` + `/waiting-on-others` + `/completed` in quick succession only actually runs the 11 source queries once.

`/today`, `/overdue`, `/upcoming`, `/waiting-on-me`, `/waiting-on-others` all filter the same cached array in JS — they are views, not separate aggregations, satisfying "no duplicated work."

### Priority Engine

Deterministic and additive — documented directly in code comments above `_scoreItem`:

| Factor | Points | Reason text |
|---|---|---|
| Blocked | +100 | "Blocked" |
| Overdue | +90 | "Overdue by N days" |
| Due today | +70 | "Due today" |
| Due in 1–3 days | +50 | "Due in N days" |
| Due in 4–7 days | +20 | "Due in N days" |
| Critical severity | +80 | "Critical severity" |
| High severity | +50 | "High severity" |
| Medium/normal severity | +20 | "Medium severity" |
| Low/info severity | +5 | (not shown — too minor to explain) |
| Marked urgent/high manual priority | +40/+25 | "Marked urgent/high priority" |
| Flagged client | +30 | "Flagged client" |
| High-risk-rated client | +20 | "High-priority client" |
| Waiting on me | +40 | "Waiting on you" |

Bands: ≥150 critical, ≥100 high, ≥50 medium, else low. Every point added has a matching reason fragment joined into the item's `reason` string — there is no scoring that isn't reflected in the explanation shown to the user, satisfying "no hidden scoring."

## Frontend

`work-queue.html` + `js/work-queue.js` (prefix `wq`): time-of-day greeting header, a clickable focus strip (My Work/Today/Overdue/Upcoming/Waiting On Me/Notifications counts), a "Highest Priority" panel (top 5 items from `/summary`), a "My Queue" panel with search + quick-filter chips (All/Today/Overdue/Upcoming) backed by the corresponding endpoints, a "Recently Completed" collapsible panel (14-day window), and a sidebar with Notifications (with inline Mark Read quick action) and Waiting On Me / Waiting On Others panels. Section collapse state persists via `PUT /preferences`. Every work item is one click to open (logs `item_opened`, then navigates straight to the source record via its deep link) — "one-click navigation" and "my desk, not a reporting page" from the spec's UX section.

## Landing-Page Logic

`/practice` (bare root) now performs a role-based client-side redirect: `owner`/`partner`/`admin` → Management Dashboard, everyone else (including unlinked accounts) → Work Hub. The pre-existing "Dashboard" (Command Centre) nav tab was repointed from `/practice` to `/practice/index.html` so it remains reachable without triggering the redirect. See Architect Freedom #8 for the unlinked-account caveat.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `work-queue.js`, both frontend files, and every edited file (`index.js`, `layout.js`, `index.html`, `management-dashboard.html`, `notifications.js`). Confirmed via grep.

## Multi-Tenant Safety

Every source fetcher and every endpoint scopes its query to `company_id`. `_myTeamMemberId` resolves the caller's own team member row scoped to `company_id` + `user_id`; the 15-second cache is keyed by `${company_id}:${team_member_id}`, so no cross-tenant or cross-user cache bleed is possible.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/112_practice_work_queue.sql` | 2 tables |
| `accounting-ecosystem/backend/modules/practice/work-queue.js` | Router + aggregator + priority engine |
| `accounting-ecosystem/backend/frontend-practice/work-queue.html` | Work Hub UI |
| `accounting-ecosystem/backend/frontend-practice/js/work-queue.js` | Work Hub UI logic |
| `docs/new-app/55_personal_work_hub.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_55_work_queue.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `work-queue` router at `/work-queue` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "My Work" nav entry; repointed "Dashboard" to `/practice/index.html` |
| `accounting-ecosystem/backend/frontend-practice/index.html` | Added role-based landing redirect (bare `/practice` only) |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added "🗂️ Open My Work Queue" quick action |
| `accounting-ecosystem/backend/frontend-practice/js/notifications.js` | Added "Open Source Record →" deep-link button in the notification detail modal |
