# Codebox 68 — Practice Secretarial Entity Lifecycle Management

> App: Lorenco Practice Management
> Status: Complete — migration 125 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Where is this entity in its lifecycle, and what must happen before it can move to the next stage?" — within seconds. Tracks a richer, entity-lifecycle-specific status (pre-incorporation through active/dormant/deregistered/liquidated/closed and back via restoration) with controlled, checklist-gated transitions and a full audit trail.

**DO NOT BUILD: CIPC API integration, automatic deregistration/restoration/liquidation, legal advice, trust accounting.** Manual entity lifecycle tracking and control only — future CIPC/API work must plug into this engine, not replace it.

## Architect Freedom — Scope Decisions & Deviations

1. **`current_lifecycle_status` is deliberately a separate, richer model from `practice_secretarial_profiles.company_status`** (Codebox 62/63's 6-value enum: active/dormant/deregistration_process/deregistered/in_liquidation/other). The two are never automatically synchronised — see migration 125's header. `company_status` remains the quick "what does the accountant think this company's status is" field; `current_lifecycle_status` is the full 14-value lifecycle model with governed transitions, checklists, and audit trail. A manager who moves an entity through Entity Lifecycle must still update Secretarial's `company_status` separately if they want both to agree — this is intentional, not an oversight.
2. **`activate` is reused for two different source statuses** (`incorporated → active` and `restored → active`) rather than adding a 16th transition_type, since the spec's own list only enumerates 15 types and both represent "this entity is now operating normally." Documented in `TRANSITION_RULES`'s comment.
3. **`close_entity` uses a dynamic "any non-terminal" rule** rather than an enumerated `from` list, since a client can be closed from essentially any non-terminal state (including directly from `pre_incorporation` if a plan is abandoned) — enumerating all 11 non-terminal statuses individually would be brittle against future status additions.
4. **`custom` and `status_review` get special dynamic validation**: `status_review` must never change status (a pure "confirmed as-is" checkpoint); `custom` is blocked from a terminal status unless it matches one of the two documented exceptions (`deregistered → restoration_pending`, `closed → active`) — matching the two real-world "undo terminal" flows the spec explicitly calls out (`start_restoration`, `reopen_entity`).
5. **Checklist defaults are exactly the 5 sets the spec named explicitly** (`mark_dormant`, `start_deregistration`, `start_restoration`, `start_liquidation`, `commence_trading`). The remaining 9 transition types each get a minimal generic 2-item set (Internal review + Partner approval) rather than either duplicating one of the 5 named sets or shipping with nothing — a manager can always add more items manually. `custom` gets zero default items, exactly as specified.
6. **Every cross-module summary in `getEntityLifecycleProfile()` is wrapped in `_safe()`** (try/catch → fallback `null`), so a failure or absence in Statutory Calendar, Secretarial, Beneficial Ownership, or Secretarial Evidence data never blocks the lifecycle profile itself from loading — directly satisfying the spec's "if evidence helper exists, use it... do not block if helper unavailable" instruction, applied consistently to all four integrations rather than evidence alone.
7. **Secretarial Calendar integration ("lifecycle transitions may create statutory obligations only where safe") was scoped down to zero new writes this pass.** No concrete mapping from a lifecycle transition to a specific statutory obligation type was specified, and inventing one risks creating obligations the spec didn't ask for. This is a documented, explicit follow-up rather than a guess.
8. **Management Dashboard KPI uses cheap, count-only direct queries** (matching the Beneficial Ownership KPI's established pattern) rather than calling `getEntityLifecycleProfile()` per entity — the full engine composes 4 other modules and is too expensive to run for every tracked entity on every dashboard load.
9. **Planning Board's lifecycle badge is scoped to "transition awaiting review or implementation"** (`ready_for_review`/`approved` transition_status) — the same deliberately lightweight, plain-status-filter pattern used for every other Planning Board badge this session (at-risk client, annual return due, BO readiness, statutory workload, evidence blocked).

## Database — Migration 125

Four new tables: `practice_entity_lifecycle_profiles` (one row per client), `practice_entity_lifecycle_transitions`, `practice_entity_lifecycle_checklist_items`, `practice_entity_lifecycle_events` (append-only). Full field-by-field rationale in the migration's own header and per-table comments. No changes to any existing table.

## Backend — `entity-lifecycle.js`

### Endpoints (~18)

Summary, client lifecycle profile (get/create/update, including "Mark Reviewed"), full transition CRUD (create/list/get/edit/cancel), checklist generation + item CRUD, workflow actions (submit-review, approve with checklist-override, reject, implement, complete), and events (client-wide and per-source).

## Lifecycle Engine

`getEntityLifecycleProfile(cid, clientId)` — the single entry point for "everything about this entity's lifecycle right now." Returns current status, active/latest-completed transitions, outstanding checklist items, and four independently-`_safe()`-wrapped cross-module summaries (Statutory Calendar, Secretarial, Beneficial Ownership, Secretarial Evidence), plus deterministic risk flags and next-action suggestions (`NEXT_ACTION_SUGGESTIONS` lookup — no AI, no scoring model).

## Transition Rules

`TRANSITION_RULES` is the single source of truth for which `(transition_type, old_status)` combinations are allowed and what `new_status` they must produce. An unlisted combination always blocks with 422 — "never guess." See Architect Freedom #2-4 for the three special-cased rules (`activate`, `close_entity`, `custom`/`status_review`).

## Checklist Logic

`CHECKLIST_DEFAULTS` — see Architect Freedom #5. Generation (`POST /transitions/:id/generate-checklist`) is a one-time action unless `?force=true` is passed to clear and regenerate; required items block approval unless a manager provides `override_reason`.

## Implementation / Status Update Logic

`PUT /transitions/:id/implement` re-validates the transition against the **current** profile status (not the status captured at creation time) before applying — if another transition moved the entity's status in the meantime, this blocks with 422 rather than silently applying a stale transition. Captures `before_snapshot`/`after_snapshot` of the full profile row and writes both a `transition_implemented` and a `lifecycle_status_changed` event.

## Integrations

- **Secretarial**: a new "Entity Lifecycle" panel added to `secretarial.html`, reusing `GET /entity-lifecycle/client/:clientId` (status + risk flag count only — no duplicate logic).
- **Client Detail**: Section 22 now shows lifecycle status + risk flag count, in the same defensive try/catch style as every other secretarial sub-summary on that page.
- **Planning Board**: a `lifecycle_transition_pending` flag (transitions `ready_for_review`/`approved`) rendered as a "🔄 Lifecycle Pending" badge.
- **Management Dashboard**: a new "Entity Lifecycle" KPI section (entities tracked, high/critical risk, non-compliant, transitions pending review) via cheap count-only queries (see Architect Freedom #8).
- **Secretarial Calendar / Secretarial Evidence**: read-only integration only this pass — see Architect Freedom #6-7.

## Frontend

`entity-lifecycle.html` + `js/entity-lifecycle.js` (prefix `el`): client-picker-first (lifecycle is per-client), summary cards, 3 tabs (Lifecycle Profile / Transitions / Events). The Transitions tab's detail modal has its own Checklist/Details/Events sub-tabs and a status-driven action bar (Generate Checklist, Submit for Review, Approve/Reject, Implement, Complete, Cancel), mirroring the pattern already established in `secretarial-workflows.js`'s change-case detail modal. No document viewer, no chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `entity-lifecycle.js`, both new frontend files, and every edited file (`index.js`, `layout.js`, `secretarial.js` + its frontend JS, `client-detail.js`, `planning-board.js` + its frontend JS, `management-dashboard.js` + its frontend JS, `management-dashboard.html`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. `client_id` on every transition/checklist item is independently re-verified against `practice_clients` before being accepted. Reads unrestricted per-user; writes and workflow actions manager-gated (`_requireManager`).

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/125_practice_secretarial_entity_lifecycle.sql` | 4 tables: profiles, transitions, checklist items, events |
| `accounting-ecosystem/backend/modules/practice/entity-lifecycle.js` | Router + transition rules + lifecycle engine |
| `accounting-ecosystem/backend/frontend-practice/entity-lifecycle.html` | Entity Lifecycle UI |
| `accounting-ecosystem/backend/frontend-practice/js/entity-lifecycle.js` | Entity Lifecycle UI logic |
| `docs/new-app/68_entity_lifecycle.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_68_entity_lifecycle.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `entity-lifecycle` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Entity Lifecycle" nav entry |
| `accounting-ecosystem/backend/frontend-practice/secretarial.html` | Added "Entity Lifecycle" panel |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial.js` | Loads/renders the lifecycle panel, sets the deep link |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Section 22 now shows lifecycle status + risk flag count |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | `_buildTeamItemPool()` attaches `lifecycle_transition_pending` flag |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Renders the "Lifecycle Pending" badge |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | Requires nothing new (direct queries); added `entity_lifecycle` block to `computeSummary()` |
| `accounting-ecosystem/backend/frontend-practice/js/management-dashboard.js` | Renders the new Entity Lifecycle KPI section |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added `kpiEntityLifecycle` section |

## Recommended Codebox 69

A CIPC-facing or client-portal read view of entity lifecycle status, or wiring the documented Secretarial Calendar follow-up (lifecycle transitions creating statutory obligations) once a concrete mapping is specified.
