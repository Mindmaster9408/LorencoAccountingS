# Session Handoff — Codebox 68: Practice Secretarial Entity Lifecycle Management

> Date: 2026-07-03
> Status: COMPLETE — migrations 117-125 confirmed applied to Supabase by the user (2026-07-03), including 125 for this codebox
> Codeboxes 60-68 have been committed and pushed to origin/main (commit fa53a26), per the user's explicit "after this one please push" instruction.

---

## What Was Built

### A deliberately separate lifecycle model, never auto-synced with Secretarial's `company_status`

`practice_secretarial_profiles.company_status` (Codebox 62/63) is a 6-value quick-status field (active/dormant/deregistration_process/deregistered/in_liquidation/other). This codebox's `current_lifecycle_status` is a full 14-value model (pre_incorporation through active/trading/dormant/non_compliant/deregistration_pending/deregistered/restoration_pending/restored/liquidation_pending/liquidated/closed/unknown) with governed, checklist-gated transitions and a complete audit trail. The two are intentionally never automatically synchronised — documented at the top of migration 125 so no future session mistakes this for a bug.

### A 15-transition-type state machine, with two documented terminal exceptions

`TRANSITION_RULES` is the single source of truth for which `(transition_type, old_status)` combination is valid and what `new_status` it must produce. Three transition types needed special dynamic handling rather than a flat enumerated list:
- `activate` legitimately applies from two different source statuses (`incorporated` OR `restored`) — no 16th transition_type was invented for the second case, since the spec's own list tops out at 15.
- `close_entity` is allowed from any non-terminal status (`from: 'non_terminal'`), resolved dynamically rather than enumerating all 11 non-terminal statuses individually.
- `custom` is blocked from a terminal status **unless** it matches one of the two documented exceptions the spec's own transition list implies (`deregistered → restoration_pending` via `start_restoration`, `closed → active` via `reopen_entity`) — everything else terminal stays terminal.

An unlisted `(transition_type, old_status)` combination always returns 422 — "never guess" applied literally.

### Re-validation at implementation time, not just at creation time

`PUT /transitions/:id/implement` re-checks the transition against the entity's **current** profile status, not the status captured when the transition was created. If a different transition implemented first and moved the entity's status in the meantime, this blocks with a clear 422 rather than silently applying a now-stale transition on top of the wrong base state.

### Every cross-module summary is independently fault-isolated

`getEntityLifecycleProfile()` composes four other modules' summaries (Statutory Calendar, Secretarial, Beneficial Ownership, Secretarial Evidence). Each is wrapped in its own `_safe()` try/catch with a `null` fallback, so any one being unavailable or erroring never prevents the lifecycle profile itself from loading — the spec's "if evidence helper exists, use it, do not block if unavailable" instruction applied uniformly to all four integrations, not just evidence.

### Backend — `entity-lifecycle.js` (~18 endpoints)

Full profile CRUD (including a "Mark Reviewed" action distinct from a plain field update), transition CRUD with dedicated action endpoints (submit-review, approve with checklist-override-reason, reject, implement, complete), checklist generation/item CRUD, and events (client-wide and per-source).

### Frontend — `entity-lifecycle.html` + `js/entity-lifecycle.js` (prefix `el`)

Client-picker-first (lifecycle is inherently per-client), 3 tabs (Lifecycle Profile / Transitions / Events). The Transitions tab's detail modal mirrors `secretarial-workflows.js`'s proven change-case detail pattern: a status-driven action bar plus Checklist/Details/Events sub-tabs.

### Integrations

- **Secretarial**: new "Entity Lifecycle" panel on `secretarial.html`, status + risk-flag-count summary only.
- **Client Detail**: Section 22 gained a lifecycle status + risk flag line, same defensive try/catch style as every other secretarial sub-summary already there.
- **Planning Board**: `lifecycle_transition_pending` flag (transition `ready_for_review`/`approved`) → "🔄 Lifecycle Pending" badge, same lightweight direct-query pattern as every other badge this session.
- **Management Dashboard**: new "Entity Lifecycle" KPI section via cheap count-only queries (entities tracked, high/critical risk, non-compliant, transitions pending review) — deliberately not a per-entity `getEntityLifecycleProfile()` call, which composes 4 other modules and would be too expensive at dashboard scale.

---

## Nothing Regressed

- `secretarial.js` (Codebox 62), `secretarial-calendar.js` (Codebox 67), `beneficial-ownership.js` (Codebox 65), `secretarial-evidence.js` (Codebox 66) — completely untouched. `entity-lifecycle.js` only *reads* their existing exports (`getCorporateProfile`, `buildStatutoryCalendar`, `getBeneficialOwnershipProfile`, `getChecklistReadiness`); none of their own endpoints, exports, or internal logic changed.
- `management-dashboard.js`'s `computeSummary()` — every existing key (`evidence_readiness`, `statutory_compliance`, `beneficial_ownership`, `client_relationship`, etc.) is unchanged; `entity_lifecycle` is a new, additive key.
- `planning-board.js`'s `_buildTeamItemPool()` — the existing at-risk-client, annual-return-due, pending-statutory-change, BO-readiness-concern, statutory-workload, and evidence-blocked flags are all unchanged; `lifecycle_transition_pending` is a new, additive field.
- `client-detail.js`'s `loadClientSecretarial()` — every existing sub-summary (company status, active directors, upcoming actions, recent changes, governance, BO) is unchanged; the new lifecycle block is additive and independently try/caught.
- `index.js` and `layout.js` — purely additive (one router mount, one nav entry).
- `node --check` passes on every new/modified JS file (see Final Verification below).
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migrations Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run, in order:
1. `117_practice_learning_centre.sql` (still pending)
2. `118_practice_client_success.sql` (still pending)
3. `119_practice_secretarial_foundation.sql` (still pending)
4. `120_practice_secretarial_workflows.sql` (still pending)
5. `121_practice_secretarial_resolutions_minutes.sql` (still pending)
6. `122_practice_secretarial_beneficial_ownership.sql` (still pending)
7. `123_practice_secretarial_calendar.sql` — **already applied per the user's earlier note; do not re-run.**
8. `124_practice_secretarial_evidence.sql` (still pending)
9. `125_practice_secretarial_entity_lifecycle.sql` — this codebox, not yet applied.

Expected: "Success. No rows returned." for migration 125. No seeding step is required — profiles are lazily created on first access (`_getOrInitProfile()`), checklists and transitions are all created entirely by managers as needed.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migrations 117-125 to Supabase (in order, skipping 123 which is already live)
2. Navigate to `/practice/entity-lifecycle.html` — should show zeroed summary cards
3. Select a client with no existing lifecycle profile → confirm a profile auto-creates with `current_lifecycle_status = 'unknown'` on first load
4. Create a new transition of type `incorporate` (old_status `unknown` → should auto-resolve `new_status` to `incorporated`) → confirm it appears in the Transitions tab as `draft`
5. Attempt a transition that's invalid for the current status (e.g. `commence_trading` while status is still `unknown`) → confirm 422 with a clear reason
6. Open the transition detail → click "Generate Checklist" → confirm the correct default item set appears (compare against `CHECKLIST_DEFAULTS` for the chosen transition_type)
7. Tick all required items → click "Submit for Review" → click "Approve" → confirm no override warning appears
8. Create a second transition, leave a required checklist item unticked → attempt "Approve" → confirm the warning about incomplete items appears and blocks until an override reason is provided
9. Click "Implement" on an approved transition with an effective date → confirm the client's `current_lifecycle_status` updates and both `transition_implemented` and `lifecycle_status_changed` events appear in the Events tab
10. From another browser tab/session, implement a second competing transition for the same client first, then attempt to implement the first (now-stale) transition → confirm 422 ("Lifecycle status has changed since this transition was created")
11. Click "Complete" on an implemented transition → confirm it moves to `completed` and disappears from "active transitions" on the profile tab
12. Attempt `start_restoration` on a `deregistered` entity → confirm it succeeds (documented terminal exception); attempt any other transition out of `deregistered` (e.g. `activate`) → confirm 422
13. Go to `/practice/secretarial.html` for the same client → confirm the new "Entity Lifecycle" panel shows the current status and matches
14. Go to the client's Client Detail page → confirm the Secretarial section shows the lifecycle status line
15. Create/approve a transition until it's `ready_for_review` or `approved` → go to `/practice/planning-board.html` → confirm the "🔄 Lifecycle Pending" badge appears on that client's work items
16. Go to `/practice/management-dashboard.html` → confirm the new "Entity Lifecycle" KPI section shows counts matching the Entity Lifecycle page
17. As a non-manager, attempt to create/edit a profile, transition, or checklist item → confirm 403 on each; confirm all `GET` reads still succeed
18. Log in as a different company → confirm zero cross-company profiles/transitions/checklist items/events visible
19. DevTools → Application → Storage → confirm no lifecycle data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Secretarial Calendar integration ("lifecycle transitions may create statutory obligations only where safe")
- Confirmed now: No concrete mapping from a specific lifecycle transition_type to a specific statutory obligation_type was given in the spec. Inventing one risks creating obligations the spec never asked for, and secretarial-calendar.js's own obligation model (recurrence, anchors) doesn't have an obvious one-shot "this transition created one obligation" shape without further design.
- Not yet confirmed: Whether/which lifecycle transitions (e.g. start_deregistration, start_liquidation) should auto-create a linked statutory obligation, and whether that obligation should be recurring or one-off.
- Risk: None currently — zero new writes to secretarial-calendar.js's tables from this codebox, so nothing can be wrong yet.
- Recommended next review point: If requested, scope a specific transition_type → obligation_type mapping (likely start_deregistration → a one-off CIPC deregistration-confirmation obligation) as a small, additive follow-up codebox.
```

```
FOLLOW-UP NOTE
- Area: `dormant` has no direct path back to `active`/`trading` in TRANSITION_RULES
- Confirmed now: The spec's 15 transition types don't include a "reactivate from dormant" type distinct from `activate` (which is scoped to incorporated/restored only). NEXT_ACTION_SUGGESTIONS for `dormant` documents this explicitly, suggesting `commence_trading` isn't valid from `dormant` either under the current rules (from: ['active'] only).
- Not yet confirmed: Whether practices need a dedicated way to move a dormant entity straight back to active/trading without going through incorporate/activate again (which wouldn't validate, since those require incorporated/restored as the source status).
- Risk: Low — a manager can still use `custom` (any_non_terminal_unless_exception → any) to manually record a dormant→active move if needed; it's just not a named, ruled transition_type yet.
- Recommended: If this becomes a real friction point, add a `reactivate: { from: ['dormant'], to: 'active' }` rule additively — a one-line change to TRANSITION_RULES.
```

---

## Explicit User Instruction — Push

The user's instruction attached to this codebox's spec was: **"after this one please push."** Per the "Executing actions with care" protocol, this is treated as durable, explicit pre-authorization for this specific push covering all accumulated work from Codeboxes 60-68 (nothing from this session has been committed or pushed yet). The push will be executed as the final step of this codebox's completion, per the current todo list.
