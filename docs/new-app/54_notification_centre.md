# Codebox 54 — Practice Notification Centre + Internal Notification Routing

> App: Lorenco Practice Management
> Status: Complete — migration 111 not yet applied to Supabase — nothing committed or pushed

## Purpose

The practice already knows when something is wrong (Codebox 53's alert rules decide the thresholds). What's been missing is a way to route that knowledge to a specific person as an actionable item — "Anton: 3 client tax returns require review" rather than a generic dashboard alert nobody owns. This codebox builds that central, assigned, actionable inbox.

**NOT email. NOT SMS. NOT push notifications. NOT Teams. NOT Sean AI.** Internal to Practice Management only.

## Architect Freedom — Scope Decisions & Deviations

1. **Helper shipped, not wired.** Per the spec's own Integration section ("No automatic conversion yet. Only helper available."), no existing module (risk-register.js, alert-rules.js, tax modules, etc.) was modified to call `notify()`. This keeps Codebox 54 self-contained — a clean, callable primitive other codeboxes can adopt later — rather than a risky simultaneous refactor of half the practice.
2. **Two extra timestamp columns** (`completed_at`, `cancelled_at`) beyond the spec's literal field list, for symmetry with the explicitly-requested `read_at`/`archived_at`/`snoozed_until`. Given dedicated `PUT /:id/complete` and `DELETE /:id` (cancel) endpoints exist, leaving those two transitions without their own timestamp would have been an inconsistent gap, not a scope reduction.
3. **`notify()` never throws away a notification.** If assignment resolution finds no team member at all (rare — only possible if the company has zero active team members), the notification is still created with `assigned_team_member_id = null` rather than being silently dropped. This was a judgment call: the alternative (throwing an error) would mean a future caller's business logic (e.g. "create a notification when a risk becomes critical") could fail outright just because team setup is incomplete — worse than an unassigned notification a partner can pick up manually.
4. **Assignment routing is single-shot, not a role hierarchy.** Requesting `{ role: 'reviewer', clientId }` and finding the client's `reviewer_team_member_id` is null falls straight through to the Practice Admin fallback — it does NOT try `owner` or `partner` instead. This was deliberate: silently reassigning a "reviewer" notification to whoever the "owner" happens to be would misrepresent why the notification was routed there. The Practice Admin fallback exists precisely for this "nothing matched" case.
5. **Bulk actions partially succeed.** A bulk request with 10 ids where 2 are already terminal or belong to another company doesn't fail the whole batch — it processes the other 8 and reports exactly which ids were skipped and why (`not_found` / `already_terminal` / `update_failed`). This matches the spec's "Fast inbox loading" and "Good UX" priorities better than an all-or-nothing transaction would for a UI bulk-select action.
6. **Bulk action events reuse the singular event types** (`notification_read`, `notification_archived`, `notification_completed`) with `metadata: { bulk: true }` rather than inventing new `notification_bulk_*` event types — keeps the audit event vocabulary to exactly the 7 types the spec lists.

## Database — Migration 111

Two tables (`IF NOT EXISTS`, safe to re-run):

- **`practice_notifications`** — full spec field set (`notification_key`, `title`, `message`, `category`, `severity`, `source_module`, `source_type`, `source_id`, `assigned_team_member_id`, `created_by`, `notification_status`, `read_at`, `snoozed_until`, `archived_at`, `due_date`, `metadata` jsonb, `created_at`) plus `completed_at`/`cancelled_at`/`updated_at` (see Architect Freedom #2). All 7 requested indexes present (`company_id`, `assigned_team_member_id`, `status`, `severity`, `category`, `created_at`, `due_date`).
- **Duplicate guard** — exactly as specified: unique index on `(company_id, notification_key, assigned_team_member_id)` scoped to non-terminal statuses (`NOT IN ('completed','archived','cancelled')`). Once a notification reaches a terminal status, the same key frees up — so a recurring condition (e.g. the same risk staying high across multiple days) creates a fresh notification after the old one is resolved, rather than being blocked forever.
- **`practice_notification_events`** — append-only, exactly the 7 event types from the spec.

## Backend — `notifications.js`

### Endpoints (12, matching the spec exactly)

`GET /summary`, `GET /`, `GET /:id`, `POST /`, `PUT /:id/read`, `PUT /:id/unread`, `PUT /:id/snooze`, `PUT /:id/archive`, `PUT /:id/complete`, `DELETE /:id` (cancel only), `GET /:id/events`, `POST /bulk-read`, `POST /bulk-archive`, `POST /bulk-complete`.

### Routing Logic — the documented assignment-resolution rule

`_resolveAssignment(cid, assignment)` tries, in order:

1. **Explicit team member id** (manual assignment) — used if it belongs to this company and is active.
2. **Role-based via a client's owner/reviewer/partner field** — `assignment = { role: 'owner'|'reviewer'|'partner', clientId }` looks up `practice_clients.responsible_team_member_id` / `.reviewer_team_member_id` / `.partner_team_member_id` respectively. Used only if that specific field is set AND the referenced member is active. A client missing that field does not fall back to a different role field (see Architect Freedom #4) — it falls through to step 3.
3. **Practice Admin fallback** — first active team member found trying role `admin`, then `owner`, then `partner`, ordered by `id` ascending (oldest team member first) for determinism.
4. **No team members exist at all** — the notification is created unassigned (`assigned_team_member_id = null`). Rare; documented as a follow-up risk.

### Helper Logic — `notify()`

The reusable entry point future modules call in-process (`require('./notifications').notify({...})`):

1. Validates `cid`, `title`, `category` (against the 13-value enum), `severity` (against the 5-value enum).
2. Resolves the assignee via `_resolveAssignment` above.
3. **Deduplicates**: if `notificationKey` is given, checks for an existing active (non-terminal) notification for `(company_id, notification_key, resolved_team_member_id)` — if found, returns that id with `created: false, deduped: true` instead of inserting a new row. A `23505` unique-violation on insert (a concurrent race between the dedup check and the insert) is caught and re-resolved to the same "return the existing row" behaviour rather than erroring, so `notify()` is safe to call concurrently.
4. **Stores the event** (`notification_created`) with the resolution method recorded in `metadata`.
5. **Returns** `{ notificationId, created, deduped, resolution_method }`.

`POST /` (manual creation from the UI) calls this exact same `notify()` function internally — there is only one code path that creates notifications, satisfying "no duplicate routing" from Architect Freedom.

## Frontend

`notifications.html` + `js/notifications.js` (prefix `nt`): summary cards (Total/Unread/Assigned To Me/Due Today/Overdue/Critical — the non-total cards are clickable quick filters), a status/category/severity filter bar, a checkbox-selectable inbox list with a bulk action bar (Mark Read / Archive / Complete), a notification detail modal showing full context plus its full History, a Snooze modal (datetime picker), and a manual "+ New Notification" creation modal. No chart library, per architecture boundaries.

## Notification Bell

`layout.js` (shared by every Practice page) now renders a 🔔 bell in the top bar next to the company badge, linking to `/practice/notifications.html`. On every page load, `LAYOUT.init()` fires one `GET /api/practice/notifications/summary` fetch and populates a small red unread-count badge on the bell (hidden when zero). **No live websocket — refresh on load only**, exactly per spec. The fetch is wrapped so a failure (e.g. module not yet enabled for a company) fails silently and simply shows no badge, never breaking page load.

## Multi-Tenant Safety

Every query across all 12 endpoints and the `notify()` helper is scoped to `company_id`. `_verifyNotification` re-checks ownership before every mutation. `_resolveAssignment` and `_myTeamMemberId` both scope their `practice_team_members`/`practice_clients` lookups to the same `company_id`, so cross-tenant assignment or "assigned to me" leakage is not possible.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `notifications.js`, both frontend files, and the `layout.js`/`index.js`/`management-dashboard.html` edits. Confirmed via grep. (Note: `layout.js`'s pre-existing `getCompanyName()` reads a cached display name from `localStorage.getItem('company')` — this is pre-existing code, not introduced by Codebox 54, and is a permitted UI-preference use under Part D, not business data.)

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/111_practice_notifications.sql` | 2 tables |
| `accounting-ecosystem/backend/modules/practice/notifications.js` | Router + `notify()` helper |
| `accounting-ecosystem/backend/frontend-practice/notifications.html` | Inbox UI |
| `accounting-ecosystem/backend/frontend-practice/js/notifications.js` | Inbox UI logic |
| `docs/new-app/54_notification_centre.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_54_notifications.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `notifications` router at `/notifications` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Notifications" nav entry + notification bell with unread badge |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added "🔔 Open Notification Centre" quick action |
