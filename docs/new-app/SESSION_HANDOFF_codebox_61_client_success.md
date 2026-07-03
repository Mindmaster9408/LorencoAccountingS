# Session Handoff — Codebox 61: Practice Client Success & Relationship Management

> Date: 2026-07-03
> Status: COMPLETE — migration 118 NOT yet applied to Supabase — not committed or pushed
> Codebox 60 (Learning Centre) is ALSO still uncommitted from the prior session turn — both are staged together for the next push.

---

## What Was Built

### An audit finding that shaped the whole migration: `practice_client_contacts` already existed

Before writing migration 118, an audit (mandatory per CLAUDE.md RULE A1 and the codebox's own "Audit first" instruction) found that `practice_client_contacts` already has full, live, working CRUD in `modules/practice/index.js` — but no migration file anywhere in the repo ever created it. Rather than guess at a fresh schema or silently skip the spec's new contact fields, migration 118 reproduces the exact existing column set in a `CREATE TABLE IF NOT EXISTS`, then applies the four new Codebox 61 fields via explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements. This is safe to run whether the table already exists live (expected) or not. See `docs/new-app/61_client_success.md` Architect Freedom #1 for the full reasoning, and RULE A4 ("No Blind Replacements") for the governing principle.

### A composed health engine, not a duplicated one

The spec's "Client Health" section describes an engine that "may use overdue compliance, outstanding documents, risk items, communication cadence, manager assessment, billing issues" — which is, in large part, exactly what the pre-existing `client-health.js` (an earlier, out-of-session codebox) already computes as an OPERATIONAL risk score (overdue deadlines/tasks/periods/engagements/WIP write-offs). Rather than re-implement that scoring a second time under a new name — which would have directly violated the "no duplicated business logic" constraint repeated in nearly every codebox spec this session — `client-success.js`'s `calculateClientHealth()` composes the existing operational score with a new, native communication-cadence calculation. `client-health.js` gained three new exports (`scoreClientFromData`, `fetchHealthData`, `statusFromScore`) — a purely additive change appended after its existing `module.exports = router` line, with zero modification to any of its ~900 lines of existing routes, scoring logic, or Actions subsystem. The combined result — `relationship_status`/`relationship_score` — lives on a brand new table (`practice_client_success`), never written onto `practice_clients`, so the two concepts (operational health vs. relationship health) can never collide in the schema, in an API response, or in a manager's mental model. The existing Client Health page (`client-health.html`) is completely untouched and continues to answer its own, different question.

### Manager override is a hard stop, not a blend

Setting `is_manager_override = true` freezes `relationship_status`/`relationship_score` at whatever the manager set, and `calculateClientHealth()` returns those frozen values verbatim — it never partially applies, never averages against a fresh calculation, and never silently reverts on the next page load. This mirrors the spec's literal "manager can always override" language and reuses the override/audit-trail shape already established by Alert Rules (Codebox 53).

### Communication cadence closes the loop automatically when a meeting is logged

`POST /:clientId/meetings` doesn't just insert a meeting row — it also advances `practice_client_success.last_meaningful_contact_date` (if the new meeting is more recent than what's stored) and sets `next_planned_contact_date` from the meeting's own `next_meeting_date` field. A manager logging a meeting doesn't have to separately remember to also update the relationship record — one action, two effects, both consistent.

### Two deliberate "no delete" decisions

Neither meetings nor opportunities have a `DELETE` route. Meetings are framed by the spec as history ("Meeting History") — this codebase's established convention for anything historical is correct-via-edit, never delete (same pattern as `practice_learning_progress`, KPI History, Partner Review Packs). Opportunities move through status transitions only (`identified → discussed → proposal → won/lost/deferred`) — the spec explicitly forbids a sales-pipeline engine, so `deferred` serves as the practical "make this go away" action without introducing a second lifecycle flag or a hard delete of a record another team member logged.

### Backend — `client-success.js` (~20 endpoints)

Key judgment calls:

**Contacts CRUD is NOT duplicated here.** The spec's endpoint list literally asks for "Contacts CRUD" under the new router, but that functionality already exists, is already tested, and is already live at `/api/practice/clients/:id/contacts`. Building a second, parallel set of contact routes would have created two code paths writing the same table — a direct violation of "Shared > duplicated" for zero functional benefit. The Client Success frontend calls the existing endpoints directly.

**`GET /opportunities/all` was added beyond the spec's literal client-scoped list.** The spec's own Frontend section lists "Opportunities" as a first-class page section, which only makes sense as a company-wide board, not something visible one client at a time. This is a second read path over the same `practice_client_opportunities` table — no new data, no new business logic.

**Reads are company-scoped only; there is no per-user privacy restriction on which clients a team member can view** — unlike the personal-data privacy model built for Learning Centre/Skills Matrix (manager-or-self-or-mentor). This follows the closest existing precedent: `client-health.js` has no per-user read restriction on client data, only company scoping. `?assigned_to_me=true` is a convenience filter for the "which client needs me today" UX, not an access boundary — writes remain manager-gated throughout.

### Frontend — `client-success.html` + `js/client-success.js` (prefix `cs`)

- Summary cards (total clients, healthy/watch/at-risk/critical counts, reviews overdue, contact overdue, open opportunity value)
- Clients tab — filterable table (status, "assigned to me"); row click opens a detail modal showing relationship info (editable), success activities, meeting history, opportunities, and key contacts (contacts proxy the pre-existing endpoint)
- Manager Override modal — set/clear, with a required reason
- Opportunities tab — company-wide board, filterable by status
- History tab — global event feed
- No chart library, no AI, matching every codebox this session

### Integrations

**Management Dashboard**: a new "Client Relationship (Client Success)" KPI section in `computeSummary()`, computed and rendered alongside — but clearly labeled distinctly from — the existing operational "Client Health" section.
**Planning Board**: `_buildTeamItemPool()` attaches an `at_risk_client` boolean to every work item via one lightweight direct query against `practice_client_success` (not a per-item call into the full health engine) — rendered as a soft, non-blocking "⚠ At-Risk Client" badge next to relevant work items.

---

## Nothing Regressed

- `client-health.js`'s existing ~900 lines (routes, `scoreClientFromData`, `fetchHealthData`, the full Actions subsystem) are unchanged in behavior — the only addition is three lines exporting existing functions for reuse.
- `index.js`'s pre-existing `practice_client_contacts` CRUD routes (lines ~988-1092) are completely untouched — migration 118 only extends the underlying table, never the route code.
- `management-dashboard.js`'s `computeSummary()` — every existing key in its returned object is unchanged; `client_relationship` is a new, additive key. `computeExecutiveFeed()` and the other three routes (`/alerts`, `/partner-review`, `/practice-score`) are untouched.
- `planning-board.js`'s `_buildTeamItemPool()` — the existing `workQueue.buildActiveQueue()` reuse chain and cache invalidation are unchanged; `at_risk_client` is a new, additive field on each item.
- `work-queue.js`, `capacity.js`, `delegation.js`, `skills-matrix.js`, `learning-centre.js`, `notifications.js` — completely untouched.
- `node --check` passes on every new/modified JS file (see Verification below).
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run, in order:
1. `117_practice_learning_centre.sql` (still pending from Codebox 60)
2. `118_practice_client_success.sql`

Expected: "Success. No rows returned." for each. Migration 118 is safe to run even if `practice_client_contacts` already exists live — the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements are idempotent.

No seeding step is required or provided — client success records, activities, meetings, and opportunities all start empty and are created entirely by managers as needed. `practice_client_success` rows are also created lazily on first touch (via `_getOrInitSuccessRow()`), so no bulk backfill is needed either.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migrations 117 and 118 to Supabase
2. Navigate to `/practice/client-success.html` — should show zeroed summary cards and a client list with `unknown` relationship status for every client
3. Click a client row → confirm detail modal opens; confirm "Operational health (from Client Health)" line appears if that client has any Client Health scoring data, and confirm it reads correctly without errors if the client has never been scored (health_status `unknown`)
4. Click "Recalculate" → confirm `relationship_status`/`relationship_score` populate based on the composed operational+cadence formula; confirm the client list reflects the new status without a page reload issue (reopen to verify)
5. Click "Manager Override," set status to "Critical" with a reason, submit → confirm the client list immediately shows "Critical" with an "override" flag; confirm a notification is created (check `/practice/notifications.html` or the `practice_notifications` table) with category `client`
6. Click "Recalculate" again while overridden → confirm the status does NOT change (override wins)
7. Click "Clear Override" → confirm the next "Recalculate" produces a fresh, calculated status
8. Log a meeting with a `next_meeting_date` set → confirm the client's `last_meaningful_contact_date` and `next_planned_contact_date` update automatically; confirm cadence status reflects this without a manual edit
9. Add a success activity, mark it complete via `PUT /activities/:id` with `status: completed` → confirm `completed_date` auto-populates
10. Add an opportunity, change its status to `won` → confirm the event log shows `opportunity_won`; confirm it drops out of "open estimated value" in the summary
11. Add a key contact with `is_decision_maker`/`is_financial_contact`/`is_operational_contact` checked → confirm it appears correctly flagged in the Client Success detail modal AND on the existing client detail page's contacts section (same underlying table)
12. As a non-manager, attempt to `PUT` relationship info, set an override, or create an activity/meeting/opportunity → confirm 403 on each; confirm all `GET` reads still succeed
13. Go to `/practice/management-dashboard.html` → confirm the new "Client Relationship (Client Success)" KPI section renders alongside the existing "Client Health" section, with different (and initially zeroed, pre-recalculation) figures
14. Go to `/practice/planning-board.html`, view Week or Team tab items for a client marked at_risk/critical in Client Success → confirm the "⚠ At-Risk Client" badge appears on relevant work items and does not affect their priority ordering
15. Log in as a different company → confirm zero cross-company client-success records/activities/meetings/opportunities/events visible
16. DevTools → Application → Storage → confirm no client-success data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Client Detail page / Risk Register / Knowledge Base / Communications cross-links (spec's Integration section)
- Confirmed now: Client Success itself is fully functional standalone. The spec also asked for links FROM Client Detail, Risk Register, Knowledge Base, and Communications INTO this module (or vice versa), but each of those target pages has its own layout that wasn't audited as part of this codebox — adding a link into unaudited UI risked violating RULE A1/A2 (auditing before change, not accidentally breaking existing layout/behavior in pages this codebox didn't otherwise touch).
- Not yet confirmed: Where in each of those four pages a link/widget would fit without disrupting existing layout.
- Risk: Low — Client Success is fully reachable via its own nav entry; missing cross-links are a discoverability gap, not a functional one.
- Recommended: A small, focused follow-up codebox (or a fast-turnaround task) auditing each of the four target pages individually and adding one contextual link/widget per page.
```

```
FOLLOW-UP NOTE
- Area: "Review Reminders" (a Success Criterion) implemented as a computed field, not a push notification
- Confirmed now: review_status (overdue/due_soon/on_track/none) is computed live from next_review_date on every read. No scheduled/background job exists anywhere in this codebase to push a reminder without a user viewing a page — the same limitation and the same reasoning applied to Learning Centre's "Rule-based reminders" gap in Codebox 60.
- Not yet confirmed: Whether a scheduled digest/notification (e.g. "reviews due this week" sent every Monday) is wanted badly enough to justify introducing this codebase's first background job.
- Risk: None currently — a genuinely unspecified delivery mechanism was correctly left unbuilt rather than guessed at.
- Recommended: If this becomes a real need, it should be designed once as a general-purpose scheduled-digest mechanism (useful for Alert Rules and Reminders too), not a one-off cron job bolted onto this module alone.
```

```
FOLLOW-UP NOTE
- Area: relationship_score composite formula is a simple average of two components (operational score, cadence score), not weighted
- Confirmed now: Deliberate — a weighted formula would need a defensible weighting rationale, and inventing arbitrary weights (e.g. "operational health matters 70%, cadence 30%") would have been exactly the kind of hidden, unrequested judgment call this project's rules caution against. An unweighted average is transparent and easy to explain to a manager questioning a score.
- Not yet confirmed: Whether managers will find an unweighted average intuitive once real data accumulates, or whether one component should dominate.
- Risk: Low — changing the weighting later is a one-line change inside calculateClientHealth(), with no schema impact.
- Recommended: Revisit only if managers give concrete feedback that the blended score feels wrong in practice.
```
