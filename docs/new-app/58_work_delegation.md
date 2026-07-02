# Codebox 58 — Practice Delegation + Work Reassignment Controls

> App: Lorenco Practice Management
> Status: Complete — migration 115 not yet applied to Supabase — nothing committed or pushed

## Purpose

Managers can now safely move ownership of a work item to someone else — transparently, auditably, and reversibly. Every reassignment records who moved it, who owned it, who owns it now, why, and when; the new owner is notified; nothing disappears.

**NOT AI delegation. NOT automatic reassignment. NOT approval workflows. NOT skill matching. NOT workload optimisation.** The manager (or the current owner, for their own work) remains in full control of every move.

## Architect Freedom — Scope Decisions & Deviations

1. **One reusable `changeOwnership()` helper, exactly as the spec's Ownership Engine section describes, extended with a registry future modules can register into.** `SOURCE_REGISTRY` maps each of the 10 supported source types to its table, its valid ownership "roles" and the column each maps to, a default role, how to derive a human title, and a deep link — a single, declarative, extensible config. `changeOwnership()` validates ownership, validates the destination, updates the source record, creates the delegation record, writes both required events, notifies the new owner, and returns a result — in that order, in one function, called by exactly one route (`POST /`) and exported for any future module to call directly.
2. **`ownership_role` was added to the migration beyond the spec's literal field list — a structural necessity, not scope creep.** `practice_tasks` alone has 4 independent owner columns (assignee/preparer/reviewer/approver); without recording which one a delegation targeted, accept/decline/cancel could not know which column to revert. This mirrors the same reasoning already used in Codebox 55/56/57 for similarly load-bearing fields the spec's literal table listing omitted.
3. **Ownership changes immediately on `POST /`, not on acceptance.** Re-reading the spec's own business outcome ("Every reassignment records... who owns it now") together with "Manager remains in control" (the phrase carried over verbatim from Codebox 56's recommendation), the interpretation implemented here is: the manager's (or self-delegator's) act of creating a delegation *is* the reassignment, executed and audited immediately. `accept` is the new owner's acknowledgement (no further ownership change); `decline` and `cancel` both revert ownership back to the previous owner (see #4); `complete` closes the record out without touching ownership at all, since by that point the work has genuinely been done by its new owner.
4. **`decline` and `cancel` both revert ownership — they are not the same action wearing two names.** `decline` is the new owner refusing work that was assigned to them (actor = new owner or a manager). `cancel` is the delegator or a manager pulling back a delegation they initiated, for any reason, at any point before completion (actor = delegator or a manager). Both share the same underlying `_revertOwnership()` primitive — one function, two distinct triggers, two distinct notification messages, two distinct event types — satisfying "no duplicated ownership logic" while still giving each action its own honest meaning.
5. **Self-service delegation is explicitly supported, not just manager-initiated delegation.** The spec's own Layout section says Work Queue should expose "Delegate — where role allows," implying delegation isn't purely a manager privilege. `POST /` authorizes a caller who is either (a) a manager, or (b) the *current* owner of the specific item being delegated (resolved server-side from the source table before any change is made, never trusted from the client) — letting any team member hand off their own work without needing elevated permissions, while still blocking them from touching anyone else's assignments.
6. **A stale-ownership race is closed by resolving the current owner fresh at the moment of change**, not from whatever the client believes it to be. `_getCurrentOwner()` always re-reads the source table's live owner column immediately before validating and writing — so two concurrent delegation attempts on the same item can't both "succeed" against a value that was already stale by the time either one executed.
7. **Delegation caches nothing of its own — it invalidates two existing caches instead of building a third.** "Delegation must immediately affect Planning Board / Work Queue / Resource Forecast / Capacity. No duplicated recalculation logic." Rather than adding a notification-style push mechanism, `_writeSourceOwner()` calls `workQueue.invalidateCache(cid)` and `planningBoard.invalidatePoolCache(cid)` (two small, additive exports added to those two files) immediately after every ownership write. Capacity.js has no cache of its own (always queries live), so nothing needed adding there. Resource Forecast has no cache of its own either — it reads through Planning Board's pool, so invalidating that one cache covers it too.
8. **`complete` deliberately sends no notification** — a judgment call, not an oversight. Every other transition (create/accept/decline/cancel) notifies someone because it represents a change the other party needs to know about. `complete` is a closing administrative action by the person who already has the work; notifying the original delegator on every single completion would be noisy relative to its actual informational value. Documented as a reversible choice if practice feedback disagrees.
9. **Viewing is scoped by involvement for everyone except managers.** `GET /`, `GET /:id`, `GET /summary`, and `GET /:id/events` all restrict non-managers to delegations where they are the previous owner, new owner, or delegator — mirroring the privacy boundary already established for Work Hub (self-scoped by default) rather than exposing the whole company's reassignment history to every team member.

## Database — Migration 115

- **`practice_work_delegations`** — one row per reassignment, never deleted (even declined/cancelled delegations are permanent history). `ownership_role` added per Architect Freedom #2. Full 6-status lifecycle (`draft`/`delegated`/`accepted`/`declined`/`cancelled`/`completed`) exactly as specified.
- **`practice_work_delegation_events`** — append-only, the exact 6 spec event types. Every ownership write anywhere in this module has a matching `ownership_changed` event row — enforced by `_writeSourceOwner()`'s caller always writing one in the same operation, never optionally.

## Backend — `delegation.js`

### Endpoints (10, matching the spec exactly)

`GET /summary`, `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `PUT /:id/accept`, `PUT /:id/decline`, `PUT /:id/cancel`, `PUT /:id/complete`, `GET /:id/events`.

### Delegation Engine

State machine: `delegated` (created — ownership already moved) → `accepted` (acknowledgement only) → `completed` (closes out, no ownership change) — or `delegated`/`accepted` → `declined`/`cancelled` (both revert ownership back to `previous_owner_id`). `draft` is schema-supported (per the spec's literal status list) but not reachable through any current endpoint — `POST /` always creates directly in `delegated` status; `draft` is reserved for a future "prepare now, send later" UX, consistent with how Codebox 56 handled its own unreachable-but-schema-supported note status.

### Ownership Helper — `changeOwnership()`

The single function every delegation-creating code path calls (see Architect Freedom #1). Internally built from smaller, independently reusable primitives: `_resolveRegistry()` (module+role → table+column), `_getCurrentOwner()` (fresh read, closes the race from #6), `_validateNewOwner()` (must be an active team member in the same company), `_writeSourceOwner()` (the actual `UPDATE`, plus cache invalidation), and `_getSourceTitle()` (human-readable title for notifications/UI, handling the two tax-return tables' composite title the same way `work-queue.js` already does). `_revertOwnership()` reuses the same `_writeSourceOwner()` primitive for the decline/cancel paths — there is exactly one function in the entire codebase that writes an owner column on a source table.

## Capacity Integration

Every ownership write calls `workQueue.invalidateCache(cid)` and `planningBoard.invalidatePoolCache(cid)` — two small exports added to those files in this codebox, not a new caching or recalculation system. Capacity.js and Resource Forecasting have no caches of their own to invalidate (the latter reads through Planning Board's pool), so this covers all four pages named in the spec's Capacity Integration section with two lines of invalidation logic.

## Notification Integration

Uses Codebox 54's `notify()` helper directly — no new notification logic. Four of the five transitions notify someone: created → new owner ("You have been assigned..."), accepted → delegator ("Delegation accepted"), declined → delegator ("Delegation declined... ownership has reverted"), cancelled → the (former) new owner ("This item has been reassigned back"). `complete` does not notify (see Architect Freedom #8). Every `notify()` call is wrapped in a non-fatal `.catch()` — a notification failure never blocks or rolls back the underlying ownership change.

## Frontend

`delegation.html` + `js/delegation.js` (prefix `dl`): summary cards (total / pending acceptance / awaiting my response / accepted / completed / history — several double as quick filters), a tab bar (All / Pending Acceptance / Accepted / Completed / History), a source-type filter, a delegation list showing the previous-owner → new-owner flow and reason at a glance, a Create Delegation modal (source type, source ID, ownership role — dynamically populated per source type, new owner, reason, notes, effective date), and a Delegation Detail modal with status-appropriate actions (Accept/Decline/Cancel/Complete) plus a full History tab. The create modal also accepts `?delegate=1&source_module=&source_id=&role=` URL parameters so Work Hub and Planning Board can deep-link directly into a pre-filled delegation for a specific item, rather than requiring a manager to type an ID by hand.

## Integrations

- **Work Hub** item rows gained a "Delegate" quick-action (purple button) next to "Open →", present on every item whose `source_module` maps to a registered delegation source type (all except `communications`, which the spec's Supported Source Types list doesn't include).
- **Planning Board** Week View item rows gained the identical "Delegate" quick-action, using the same `source_module` mapping.
- Both use a small client-side mapping (`_delegationModule()`, duplicated in both files and commented to reference each other) that splits the aggregator's unified `'qms'` source into `qms-review`/`qms-finding` to match `delegation.js`'s registry keys exactly.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `delegation.js`, both frontend files, and every edited file (`work-queue.js`, `planning-board.js`, `index.js`, `layout.js`). Confirmed via grep.

## Multi-Tenant Safety

Every endpoint scopes its queries to `company_id`. `_getCurrentOwner()`, `_validateNewOwner()`, and `_writeSourceOwner()` all re-verify `company_id` on both the source table and `practice_team_members` before touching anything, so a delegation can never reach across companies even if a client sent a cross-tenant `source_id` or `new_owner_id`.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/115_practice_work_delegation.sql` | 2 tables |
| `accounting-ecosystem/backend/modules/practice/delegation.js` | Router + `changeOwnership()` + `SOURCE_REGISTRY` |
| `accounting-ecosystem/backend/frontend-practice/delegation.html` | Delegation UI |
| `accounting-ecosystem/backend/frontend-practice/js/delegation.js` | Delegation UI logic |
| `docs/new-app/58_work_delegation.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_58_work_delegation.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/work-queue.js` | Exported `invalidateCache()` |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | Exported `invalidatePoolCache()` |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `delegation` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Delegation" nav entry |
| `accounting-ecosystem/backend/frontend-practice/js/work-queue.js` | Added "Delegate" quick-action to item rows |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Added "Delegate" quick-action to Week View item rows |
