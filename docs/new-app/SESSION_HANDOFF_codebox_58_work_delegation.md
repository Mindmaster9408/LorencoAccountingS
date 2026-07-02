# Session Handoff — Codebox 58: Practice Delegation + Work Reassignment Controls

> Date: 2026-07-02
> Status: COMPLETE — migration 115 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### One ownership-change pipeline, ten registered source types

`delegation.js`'s `SOURCE_REGISTRY` declares all 10 spec-named source types (Tasks, Deadlines, Risk Reviews, QMS Reviews, QMS Findings, Tax Reviews ×2, Compliance Reviews, Document Requests, Reminders) as data, not code — table name, valid ownership roles and their columns, a default role, how to derive a title, and a deep link. `changeOwnership()` — the single reusable helper the spec's Ownership Engine section asked for — is built entirely from that registry plus a handful of small, independently-reusable primitives (`_resolveRegistry`, `_getCurrentOwner`, `_validateNewOwner`, `_writeSourceOwner`, `_getSourceTitle`). There is exactly one function in the codebase that writes to a source table's owner column; every lifecycle transition (create, decline-revert, cancel-revert) goes through it.

### Two real design decisions worth flagging explicitly

1. **Ownership changes at creation, not at acceptance.** The spec's phrasing ("Every reassignment records... who owns it now... the assignee is notified") was read as: the manager's (or self-delegator's) act of creating the delegation *is* the reassignment — executed immediately, fully audited, and then followed by an optional acknowledgement (`accept`) or reversal (`decline`/`cancel`). This keeps the manager fully in control (consistent with the "manager remains in control" language carried forward from Codebox 56) rather than making reassignment conditional on the new owner's response, which would have introduced an implicit approval gate the spec's Future Enhancements section explicitly rules out ("DO NOT BUILD: approval workflows").
2. **Self-service delegation is real, not just manager delegation.** `POST /` authorizes a caller who is either a manager OR the *current* owner of the specific item (verified server-side, never trusted from the client) — directly implementing the spec's "Work Queue should expose: Delegate — where role allows" language, which only makes sense if individual contributors can hand off their own work without needing elevated permissions.

### Migration 115

- **`practice_work_delegations`** — full spec field set plus `ownership_role` (a structural necessity: `practice_tasks` alone has 4 independent owner columns, and without recording which one was targeted, accept/decline/cancel would have no way to know which column to revert). Never hard-deleted — even declined/cancelled delegations are permanent history.
- **`practice_work_delegation_events`** — append-only, the exact 6 spec event types. Every single ownership write anywhere in the module has a matching `ownership_changed` event row, written in the same operation as the write itself — "no ownership change may occur without an audit record" is enforced by code structure, not by convention.

### Backend — `delegation.js` (10 endpoints, matching spec exactly)

Key judgment calls:

**`decline` and `cancel` both revert ownership, but are not the same action.** `decline` = the new owner refusing work assigned to them. `cancel` = the delegator (or a manager) pulling the delegation back for any reason. Different actors are authorized for each, different notification messages are sent, different event types are recorded — but both call the exact same `_revertOwnership()` primitive underneath, so there's no duplicated "put the column back" logic between them.

**A stale-ownership race is closed by design, not by locking.** `_getCurrentOwner()` always re-reads the source table's live value immediately before validating and writing — it never trusts a `previous_owner_id` the client might have sent. Two people attempting to delegate the same item at nearly the same moment will each see the true state at the instant their own request executes; the second one to actually run the update will simply overwrite with the first one's result already reflected (Postgres's own row-level consistency handles the ordering — no additional locking was added, since a delegation's `UPDATE ... WHERE id = ? AND company_id = ?` is already atomic per row).

**Delegation adds zero new caching — it invalidates two existing caches instead.** The spec required delegation to "immediately affect" Planning Board, Work Queue, Resource Forecast, and Capacity, with an explicit "no duplicated recalculation logic" constraint. Two small exports (`workQueue.invalidateCache()`, `planningBoard.invalidatePoolCache()`) were added to those two files — each just clears the relevant in-process cache Map for a company — and `delegation.js` calls both after every ownership write. Capacity.js has no cache (always queries live) and Resource Forecasting has no cache of its own (it reads through Planning Board's pool), so these two calls cover all four named systems.

**`complete` sends no notification — a deliberate choice, not a gap.** Every other transition represents news the other party needs; `complete` is an administrative close-out by the person who already holds the work. Notifying the original delegator on every single completion was judged more noise than signal. Documented as reversible if real usage disagrees.

### Frontend — `delegation.html` + `js/delegation.js` (prefix `dl`)

- Summary cards (several double as tab-switching quick filters): Total, Pending Acceptance, Awaiting My Response, Accepted, Completed, History
- Tab bar + source-type filter
- Delegation list rows showing the previous-owner → new-owner flow and reason at a glance (no need to open detail just to see who-to-whom)
- Create Delegation modal — source type drives a dynamically-populated ownership-role dropdown (hidden entirely when a source type has only one possible role, e.g. deadlines), new-owner picker sourced from the existing `/api/practice/team` endpoint (no new team-listing endpoint needed)
- Detail modal — Overview (full context + status-appropriate action buttons) and History tabs
- `?delegate=1&source_module=&source_id=&role=` URL parameters open the create modal pre-filled — this is what Work Hub and Planning Board's new "Delegate" buttons link to, so a manager never has to type a numeric ID by hand in the normal flow

### Integrations

Work Hub and Planning Board item rows both gained a "Delegate" quick-action button. Both use an identical small client-side helper (`_delegationModule()`, duplicated across the two files with comments pointing at each other, same pattern already established for the Codebox 55/56 deep-link mapping) that translates the aggregator's unified `'qms'` source into the registry's separate `qms-review`/`qms-finding` keys, and hides the button entirely for `communications` items (not a supported delegation source per the spec's own list).

---

## Nothing Regressed

- `work-queue.js`'s and `planning-board.js`'s existing behavior is fully preserved — both new exports (`invalidateCache`, `invalidatePoolCache`) are additive functions that do nothing unless explicitly called, and nothing in either file's existing code path calls them.
- No source module (tasks, deadlines, risk-register, quality-management, tax modules, compliance-packs, document-requests, reminders) had its own router file modified — `delegation.js` only ever writes to those tables' owner columns via direct, company-scoped `UPDATE` statements, exactly the same pattern every other router in this codebase already uses for its own tables.
- `notifications.js` — untouched; `delegation.js` only calls its already-exported `notify()`.
- `node --check` passes on `delegation.js`, `work-queue.js`, `planning-board.js`, `index.js`, `layout.js`, and both new/modified frontend JS files.
- A standalone Node smoke test loaded `delegation.js` in isolation (requiring `notifications.js`, `work-queue.js`, and `planning-board.js`, which themselves pull in `alert-rules.js` and `capacity.js`) and confirmed the full module chain resolves with no circular dependency, and confirmed all 10 `SOURCE_REGISTRY` keys and the `changeOwnership` export are present.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `115_practice_work_delegation.sql`

Expected: "Success. No rows returned." Apply after migration 114 (already applied per the prior codebox's stated assumption).

No seeding step is required — both new tables start empty and populate only as managers or team members create delegations.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, a standalone module-loading smoke test, and grep for browser-storage violations.*

1. Apply migration 115 to Supabase
2. As a manager, delegate a task (Source Type = Tasks, pick an existing task ID, role = preparer, choose a new owner, give a reason) → confirm: the task's `preparer_team_member_id` actually changes in the DB, a `practice_work_delegations` row exists with `delegation_status = 'delegated'`, `delegation_created` and `ownership_changed` events exist, and the new owner receives a notification ("You have been assigned...")
3. Immediately after step 2, open the new owner's Work Hub → confirm the delegated task appears in their queue right away (proves cache invalidation is working, not just eventually-consistent after the 15s/20s TTL)
4. Open Planning Board's Team Board → confirm the previous owner's workload count decreased and the new owner's increased, immediately
5. As a non-manager who owns a task themselves, delegate it to a colleague → confirm this succeeds (self-service delegation)
6. As a non-manager, attempt to delegate a task that is NOT currently assigned to them (via direct API call or URL manipulation) → confirm a 403, and confirm the task's owner column is unchanged in the DB
7. As the new owner, accept the delegation → confirm status becomes `accepted`, a `delegation_accepted` event exists, and the delegator receives a "Delegation accepted" notification — confirm ownership does NOT change again (it was already changed at step 2)
8. Create a second delegation, then as the new owner decline it → confirm the source record's owner column reverts to the original `previous_owner_id`, status becomes `declined`, an `ownership_changed` event exists showing the reversal, and the delegator receives a "Delegation declined" notification
9. Create a third delegation, then as the delegator (or a manager) cancel it before acceptance → confirm the same reversion behavior as decline, but with `delegation_cancelled` as the status/event, and confirm the (former) new owner receives the "reassigned back" notification
10. Accept a delegation, then mark it complete → confirm status becomes `completed`, `completed_at` is set, a `delegation_completed` event exists, and confirm NO notification was sent for this transition (per the deliberate design choice)
11. Attempt to decline/cancel/complete a delegation that's already in a terminal state → confirm a 422 with a clear error, not a silent no-op or a crash
12. From Work Hub, click "Delegate" on an item → confirm it navigates to the Delegation page with the create modal pre-filled with the correct source_module/source_id/role
13. From Planning Board's Week View, click "Delegate" on an item → confirm the same pre-fill behavior
14. Confirm the "Delegate" button does NOT appear on Work Hub/Planning Board items whose `source_module` is `communications`
15. Delegate a QMS finding vs a QMS review (both show as `source_module: 'qms'` in Work Hub/Planning Board) → confirm each correctly maps to `qms-finding`/`qms-review` respectively in the delegation record (proves the `_delegationModule()` split logic works)
16. As a non-manager, open the Delegation page's list → confirm only delegations where you're the previous owner, new owner, or delegator are visible — not the whole company's history
17. As a manager, confirm the full company-wide delegation history is visible, and that the "Awaiting My Response" summary card/tab correctly isolates delegations where you personally are the new owner with status `delegated`
18. Open Resource Forecast immediately after a delegation → confirm the forecast reflects the new ownership (proves the shared Planning Board pool cache invalidation reaches Resource Forecast too, since it has no cache of its own)
19. Log in as a different company → confirm zero cross-company delegations visible, and confirm attempting to delegate a source_id/new_owner_id belonging to another company fails cleanly (404/422), never silently succeeding
20. DevTools → Application → Storage → confirm no delegation data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: `draft` status is schema-supported but unreachable through any current endpoint
- Confirmed now: POST / always creates directly in `delegated` status (the reassignment executes immediately) — `draft` exists in the CHECK constraint solely because the spec's literal status list includes it.
- Not yet confirmed: Whether a future "prepare a delegation now, send it later" UX is actually wanted, or whether `draft` should simply be removed from the enum if it never gets used.
- Risk: None — an unused enum value has no functional downside.
- Recommended: If a "save as draft" feature is requested later, it needs its own endpoint (e.g. POST /?draft=true skipping the ownership-change step) — do not repurpose the existing POST / for this without very carefully re-checking the "ownership changes immediately" design decision documented above.
```

```
FOLLOW-UP NOTE
- Area: `complete` sends no notification (see Architect Freedom #8 in the technical doc)
- Confirmed now: Deliberate choice to avoid over-notifying on a purely administrative close-out action.
- Not yet confirmed: Whether managers will want visibility into completions without having to actively check the Delegation page (e.g. for their own peace of mind after delegating something important).
- Risk: Low — the information isn't lost, just not pushed; the delegator can always see completion status by revisiting the delegation.
- Recommended: If this becomes a real request, the cleanest fix is a manager-only digest/summary rather than a notification per completion, to avoid recreating the noise problem this choice was meant to avoid.
```

```
FOLLOW-UP NOTE
- Area: `_delegationModule()` client-side mapping (qms split, communications exclusion) is duplicated across work-queue.js and planning-board.js's frontend files
- Confirmed now: Both copies are commented to reference each other, consistent with the same duplication-with-cross-reference pattern already used for the Codebox 55/56 deep-link mapping.
- Not yet confirmed: Whether this mapping will need to grow as more source modules gain delegation support, at which point duplication could become a real maintenance risk.
- Risk: Low today (small, rarely-changing mapping) — same risk profile already accepted and documented in Codebox 56.
- Recommended: If a third frontend consumer of this mapping appears, extract it into a shared frontend utility file at that point, per the same recommendation already on record from Codebox 56.
```
