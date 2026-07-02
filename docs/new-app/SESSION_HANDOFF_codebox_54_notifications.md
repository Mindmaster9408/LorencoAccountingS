# Session Handoff — Codebox 54: Practice Notification Centre + Internal Notification Routing

> Date: 2026-07-02
> Status: COMPLETE — migration 111 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Scope decision — helper shipped, not wired

Per the spec's own Integration section ("No automatic conversion yet. Only helper available."), no existing module was modified to actually call `notify()`. Codebox 54 delivers a complete, callable, tested primitive — the routing/dedup/assignment logic — plus the full inbox UI, but leaves "convert an alert into a notification" as a decision for whichever future codebox owns that specific alert source. This kept the change surface to exactly the new notification files plus three small, additive integration points (router mount, nav+bell, one dashboard link) — no regression risk to any of the 53 prior codeboxes' logic.

### Migration 111

- **`practice_notifications`** — full spec field set, plus `completed_at`/`cancelled_at` added for symmetry with the explicitly-requested `read_at`/`archived_at` (the spec's dedicated `/complete` and cancel-only `DELETE` endpoints would otherwise be the only two status transitions without their own timestamp — a gap, not an intentional omission). All 7 requested indexes present.
- **Duplicate guard** — unique index on `(company_id, notification_key, assigned_team_member_id)` scoped to non-terminal statuses, exactly as specified. This is the DB-level half of `notify()`'s deduplication (see below).
- **`practice_notification_events`** — append-only, the exact 7 event types from the spec.

### Backend — `notifications.js` (12 endpoints + `notify()` helper)

Key judgment calls:

**Assignment routing is a strict, documented fallback chain — not a role hierarchy.** `_resolveAssignment()` tries: (1) explicit `teamMemberId` if valid and active, (2) role-based lookup via a client's `responsible_team_member_id`/`reviewer_team_member_id`/`partner_team_member_id` field — but ONLY the specific role requested, never silently substituting a different one if that field is null, (3) Practice Admin fallback trying role `admin` then `owner` then `partner`, first active member by ascending `id` for determinism, (4) unassigned if literally no team members exist. This precedence is fully documented in code comments directly above the function, satisfying the spec's "Document rule" instruction.

**`notify()` is idempotent-safe under concurrency.** The dedup check (query before insert) and the DB unique index (enforced at insert time) work together: if two concurrent calls race for the same `(company_id, notification_key, assignee)`, the loser's insert fails with Postgres error `23505`, which is caught and re-resolved to "return the existing notification" rather than propagating an error to the caller. `notify()` never throws for a legitimate duplicate — only for actual validation failures (missing `cid`/`title`, invalid `category`/`severity`).

**`notify()` never silently drops a notification.** Even in the rare case where a company has zero active team members (so all 4 resolution steps come up empty), the notification is still created with `assigned_team_member_id = null` rather than the function throwing. A future caller doing "raise a notification when X happens" shouldn't have that call fail just because team setup is incomplete elsewhere.

**`POST /` and `notify()` share one code path.** The manual-creation HTTP endpoint builds an `assignment` object from the request body and calls the exact same `notify()` function used by in-process callers — there is exactly one place routing/dedup logic lives, satisfying the spec's "no duplicate routing" Architect Freedom constraint.

**Bulk actions partially succeed and report per-id outcomes.** `POST /bulk-read|archive|complete` accepts an `ids` array, verifies company ownership and current status for each id independently, and returns `{ updated: [...], skipped: [{id, reason}] }` rather than failing the entire batch if one id is invalid or already terminal — matches "Fast inbox loading" / "Good UX" priorities for a UI multi-select action.

### Frontend — `notifications.html` + `js/notifications.js` (prefix `nt`)

- Summary cards (Total / Unread / Assigned To Me / Due Today / Overdue / Critical) — all but Total are clickable quick filters that combine with the status/category/severity dropdown filters
- Checkbox-selectable inbox rows with a bulk action bar (Mark Read / Archive / Complete / Clear Selection)
- Notification detail modal — full context, status-appropriate action buttons (only shows Mark Read on `new`, only shows Mark Unread on `read`, etc.), and a full History panel
- Snooze modal (datetime-local picker, validated non-empty before submit)
- "+ New Notification" manual creation modal (title/message/category/severity/optional assignee id/optional due date)
- No chart library, per architecture boundaries — table/card/pill based throughout

### Notification Bell

Added directly to `layout.js` (shared by all Practice pages), so every page — not just the notifications inbox — shows the bell with a live-on-load unread count. Implemented as a plain `<a>` with fully inline styles (not dependent on the `/practice/css/layout.css` stylesheet link, which was found during this codebox's audit to be a pre-existing dead reference across many pages — see Follow-Up Note; not something introduced or fixed by Codebox 54, out of scope). One `GET /summary` fetch fires per page load from `LAYOUT.init()`, wrapped in a `.catch()` so a failure never breaks page load — matches "No live websocket. Refresh on load."

### Management Dashboard Integration

Added a "🔔 Open Notification Centre" quick-action link next to the existing KPI Snapshot / Review Pack / Alert Rules buttons.

---

## Nothing Regressed

- No existing module's code was modified to call `notify()` — this was a deliberate scope boundary, not an oversight (see spec's own "No automatic conversion yet").
- `management-dashboard.js`, `alert-rules.js`, `kpi-history.js`, `partner-review-packs.js` — untouched.
- `layout.js`'s `init()` function retains its exact prior topbar/nav rendering; the bell and its async summary fetch are purely additive and independently wrapped so a fetch failure cannot break the rest of the topbar or nav.
- `node --check` passes on `notifications.js`, `index.js`, `layout.js`, and both frontend JS files.
- A standalone Node smoke test loaded `notifications.js` in isolation, confirmed `notify`, `CATEGORIES` (13), and `SEVERITIES` (5) are exported correctly, and confirmed the module loads without requiring any other practice module (no circular dependency risk).
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep (the one pre-existing `localStorage.getItem('company')` call in `layout.js`'s `getCompanyName()` predates this codebox and is a permitted UI-preference read, not business data).
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `111_practice_notifications.sql`

Expected: "Success. No rows returned." Apply after migration 110 (already applied per the prior codebox's stated assumption).

No seeding step is required for this codebox (unlike Codebox 53's Alert Rules) — `practice_notifications` starts empty and is populated only by actual `notify()` calls or manual creation via the UI.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, a standalone module-loading smoke test, and grep for browser-storage violations.*

1. Apply migration 111 to Supabase
2. Navigate to `/practice/notifications.html` — should show an empty inbox and zeroed summary cards
3. Confirm the notification bell renders on every Practice page (not just this one) with no badge (0 unread)
4. Click "+ New Notification", fill in Title/Category/Severity, leave assignee blank → Create → confirm it appears in the inbox and the bell badge shows "1"
5. Confirm the created notification was routed via the Practice Admin fallback (check its detail — resolution isn't directly shown in the UI, but confirm `assigned_team_member_id` in the DB row matches an active team member with role `admin`/`owner`/`partner`)
6. Create a second notification with the same conceptual key but via direct API call with `notification_key` set — call again with the same key/assignee → confirm the second call returns the same notification id (`deduped: true`) rather than creating a duplicate row
7. Click a notification → Mark Read → confirm status changes to "Read" and the bell's unread count decrements
8. Mark it Unread → confirm it returns to "New" and the unread count increments again
9. Snooze a notification for 5 minutes in the future → confirm status becomes "Snoozed" with the correct `snoozed_until` displayed
10. Complete a notification → confirm status becomes "Completed" and it drops out of default active filters
11. Archive a notification → confirm status becomes "Archived"
12. Cancel a notification (via detail modal's Cancel button, which calls `DELETE /:id`) → confirm status becomes "Cancelled" and the row still exists in the DB (never hard-deleted)
13. Select 3 notifications via checkboxes → Bulk "Mark Read" → confirm all 3 update and the bulk bar reports "3 selected" before submission
14. Repeat a bulk action including one already-archived id → confirm the response reports it as skipped (`already_terminal`) while the others still succeed
15. Click the "Assigned To Me" summary card → confirm the inbox filters to notifications assigned to the logged-in user's linked team member (requires a `practice_team_members` row with matching `user_id`)
16. Click "Due Today" / "Overdue" summary cards → confirm correct date-based filtering
17. Open a notification's detail modal → confirm its History tab shows every transition performed in steps 7–12 in order
18. Log in as a different company → confirm zero notifications visible, and that the bell badge for that company reflects only its own unread count
19. DevTools → Application → Storage → confirm no notification data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: `/practice/css/layout.css` (linked in nearly every Practice HTML page, including this codebox's new notifications.html) does not exist on disk — only `css/practice.css` does
- Confirmed now: This is a pre-existing condition across dozens of prior-codebox pages, not introduced by Codebox 54. The notification bell was deliberately built with fully inline styles specifically so it renders correctly regardless of whether this stylesheet resolves.
- Not yet confirmed: Whether `/practice/css/layout.css` is served via some build/proxy step not visible in this repo (in which case it's a non-issue), or whether it's a genuinely dead reference across the whole Practice frontend that happens not to matter because `practice.css` is loaded some other way, or because every page's extensive inline `<style>` blocks happen to cover enough of the UI that the missing topbar/nav classes go unnoticed.
- Risk: Unknown until browser-tested — if the topbar genuinely renders unstyled in production, it predates this codebox and affects far more than the notification bell.
- Recommended: Verify in a real browser during the testing pass above (step 3). If the topbar looks unstyled, that's a pre-existing bug worth its own investigation, not a Codebox 54 regression.
```

```
FOLLOW-UP NOTE
- Area: notify() can create an unassigned notification if a company has zero active team members
- Confirmed now: This is handled gracefully (no error thrown), and is documented as step 4 of the routing fallback chain.
- Not yet confirmed: Whether the frontend should surface "Unassigned" notifications with any special visual treatment or a prompt to assign one — currently they just show "Unassigned" in the detail view with no special handling in the inbox list.
- Risk: Low — this can only happen for a company with an incomplete team setup, which is itself an edge case.
- Recommended: If this becomes a real occurrence in practice, consider adding an "Unassigned" quick filter alongside "Assigned To Me" in a future pass.
```

```
FOLLOW-UP NOTE
- Area: No module calls notify() automatically yet — this is the single biggest gap between "alerts exist" (Codebox 50/53) and "notifications are actionable" (this codebox's stated business outcome)
- Confirmed now: This was an explicit, spec-mandated scope boundary ("No automatic conversion yet. Only helper available.") — not an oversight.
- Not yet confirmed: Which future codebox will wire the first automatic notify() call (e.g. from computeAlerts() in management-dashboard.js, or from a scheduled/on-demand alert-to-notification conversion step).
- Risk: None currently — the helper is fully built, tested standalone, and ready to be called; this is a forward-looking note, not a defect.
- Recommended: When that future codebox arrives, use `notificationKey` values that are stable and derived from the source entity (e.g. `risk_high_${riskId}`) so re-running the conversion doesn't create duplicate notifications for the same underlying condition — the dedup guard already supports this pattern.
```
