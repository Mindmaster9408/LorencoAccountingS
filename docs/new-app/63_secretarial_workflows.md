# Codebox 63 — Practice Secretarial Workflows + Statutory Change Management

> App: Lorenco Practice Management
> Status: Complete — migration 120 not yet applied to Supabase — nothing committed or pushed

## Purpose

Turns Secretarial (Codebox 62) from registers into controlled statutory change management. "Every statutory change is controlled" — not "anyone can edit the register." A director appointment, resignation, share transfer, address change, etc. becomes a case with a checklist, an approval step, an effective date, and an append-only audit trail — never a direct, uncontrolled edit.

**NOT CIPC API. NOT automatic CIPC filing. NOT document generation. NOT e-signatures.** A manual internal workflow foundation — future CIPC integration must plug into this workflow, not replace it.

## Architect Freedom — Scope Decisions & Deviations

1. **Not every change_type gets an automatic register update — this is the single most important design decision in this codebox, and it's driven entirely by an audit of migration 119's actual schema.** The spec's own IMPLEMENTATION LOGIC section says "for complex cases: if payload is insufficient or ambiguous, block implement with 422 and require manual register update, never guess." Auditing `practice_secretarial_profiles` found it has `registered_address`, `postal_address`, `company_secretary`, `auditor`, and `company_status` — safe, exact-match targets. It has **no field for "public officer"** and only `financial_officer` (not the legally distinct "accounting officer"). Company **name** lives on `practice_clients.name` (client master data — explicitly out of this module's bounds per Codebox 61/62's own precedent) and **financial year-end** lives on `practice_taxpayer_profiles` (a different module's table). Rather than silently guess-map `accounting_officer_change` onto `financial_officer`, or reach into another module's table to rename a client, `secretarial-workflows.js`'s `IMPLEMENTATION_RULES` map deliberately excludes: `share_issue`, `share_cancellation`, `company_name_change`, `financial_year_end_change`, `accounting_officer_change`, `public_officer_change`, and `custom`. Attempting to implement any of these without `manual: true` + a `manual_reason` returns 422 with a clear explanation of why. This is the single source of truth for "safe vs. manual" — see the constant itself and its header comment in the router.
2. **`share_transfer` follows the spec's own offered "safer alternative" rather than its primary suggestion.** The spec text says "update shareholder transfer/status where safe... if safer, only write event and after_snapshot, do not mutate shareholder automatically." Matching a specific existing shareholder row without an explicit ID is exactly the kind of ambiguous match "never guess" warns against — so `_implShareTransfer()` only mutates `practice_company_shareholders` when `payload.shareholder_id` is explicitly provided and matches an existing row for that client; otherwise it records the event and skips the mutation, still completing the workflow (this is offered as an acceptable outcome by the spec, not a failure) with `skipped_mutation: true` in the response.
3. **The "Complex cases" 422 responses tell the manager exactly what to do next** ("update the relevant register manually, then call this endpoint with `manual: true` and a `manual_reason`") rather than a bare validation error — this keeps the case moving through the workflow (checklist, approval, audit trail all still apply) even when the actual register mutation has to happen by hand elsewhere in the practice's tools.
4. **Checklist defaults extend beyond the spec's 5 explicitly-defined sets, using a generic 4-item fallback** (Resolution/approval, Update register, CIPC filing step, Client confirmation) for the 9 change_types the spec didn't give explicit checklists for — exercising the spec's own stated permission ("Custom: no defaults unless developer adds sensible minimal items"). `custom` itself still gets zero defaults, exactly as specified; the generic set is only used for the other, named-but-unlisted change types.
5. **"Address Change" in the spec's Checklist Defaults section is read as covering both `registered_address_change` and `postal_address_change`** — the spec lists one "Address Change" checklist, and the change_type enum has two distinct address fields. Both reuse the identical default set rather than inventing a second, arbitrary variant.
6. **The workflow writes into Secretarial's EXISTING Timeline table (`practice_secretarial_events`, Codebox 62), not a second, competing timeline.** The spec's own event list for this codebox includes `timeline_event_created` as one of THIS module's own events (in `practice_secretarial_change_events`) — read literally, that's this module logging that it pushed something into the Timeline, not this module owning a second Timeline. `secretarial.js` gained one small additive export (`writeSecretarialEvent`, an alias for its existing private `_writeEvent` helper) specifically so `secretarial-workflows.js` could do this without duplicating the insert logic. `getOrInitProfile` was exported the same way, for the profile-field implementations.
7. **PUT /:id only allows `case_status` to move between `draft`/`preparing`/`awaiting_documents`** — the pre-review housekeeping states. Every other transition (submit for review, approve, reject, implement, complete, cancel) has its own dedicated endpoint with its own validation and event — this keeps "no workflow status change without event" true by construction rather than by convention, since the generic update route structurally cannot cause a workflow-significant transition.
8. **Approval's checklist-completeness check returns HTTP 400 with an `incomplete_count`, not a hard block** — the frontend surfaces this as a warning with an override-reason field rather than a dead end, matching the spec's "required checklist items should be completed OR manager override required with reason" literally: the manager can always proceed, they just have to say why.
9. **The Payload UI is a single JSON textarea with a per-change-type hint, not 16 bespoke structured forms.** The spec explicitly asks to "keep simple... otherwise allow JSON-like structured text / notes and document limitations" — building 16 different structured input sets for the < 10 fields actually read by `IMPLEMENTATION_RULES` would have been exactly the over-engineering the spec's own Implementation Priorities list warns against ("UI polish last"). The hint text under the textarea names the exact fields `IMPLEMENTATION_RULES` reads for the selected change_type, or explains why that type has no automatic implementation at all.
10. **Cases can only be created/edited/actioned by managers; reads are open to any authenticated team member** — matching the identical precedent established for Client Success and Secretarial Foundation in this session.

## Database — Migration 120

Three tables: `practice_secretarial_change_cases`, `practice_secretarial_change_checklist_items`, and the append-only `practice_secretarial_change_events`. Full field-by-field rationale, and the definitive record of which change_types are safe to auto-implement, is in the migration's own header comment (kept in sync with the router's `IMPLEMENTATION_RULES` constant — see Architect Freedom #1).

## Backend — `secretarial-workflows.js`

### Endpoints (~17)

`GET /summary`, `GET /` (filtered list: client_id/change_type/case_status/effective_from/effective_to/page/limit), `GET /:id`, `POST /`, `PUT /:id` (pre-review fields only), `DELETE /:id` (soft cancel only), `POST /:id/generate-checklist`, `GET /:id/checklist`, `PUT /:id/checklist/:itemId`, `PUT /:id/submit-review`, `PUT /:id/approve`, `PUT /:id/reject`, `PUT /:id/implement`, `PUT /:id/complete`, `GET /:id/events`.

### Workflow Logic

State machine: `draft/preparing/awaiting_documents` → (submit-review) → `ready_for_review` → (approve) → `approved` → (implement) → `implemented` → (complete) → `completed`. `reject` is available any time before `implemented`; `cancel` (soft, via `DELETE`) is available any time before `completed`. Every transition writes its own case event before responding — there is no code path that changes `case_status` without a matching row in `practice_secretarial_change_events`.

### Checklist Logic

`POST /:id/generate-checklist` looks up `CHECKLIST_DEFAULTS[change_type]` and bulk-inserts the items (blocked if a checklist already exists, unless `?force=true` clears and rebuilds). See Architect Freedom #4-#5 for the exact default sets and the generic fallback.

### Implementation / Register-Update Logic

`PUT /:id/implement` requires `case_status = 'approved'` and an `effective_date` (on the case or in the request). For change_types in `IMPLEMENTATION_RULES`, it calls the matching handler, which either mutates the relevant Codebox 62 register and returns a before/after snapshot, or returns `{ error }` — which the route turns into a 422, leaving the case still `approved` (no state was changed, nothing to undo). For change_types NOT in the map, or when the caller explicitly passes `manual: true` + `manual_reason`, the case moves to `implemented` without any register mutation, recording the manager's stated reason instead. Every successful implementation also writes into Secretarial's own Timeline (see Architect Freedom #6) and fires a low-risk `notify()` (swallowed on failure).

## Secretarial Integration

- **Secretarial page** (`secretarial.html`): a "Recent Statutory Changes" panel on the Corporate Profile tab (reusing `GET /secretarial-workflows?client_id=`) plus a "Manage Changes →" link that carries the selected client through via `?client_id=`.
- **Client Detail**: the existing Section 22 (Secretarial, from Codebox 62) now also shows the client's 3 most recent change cases and titles/statuses, reusing the same endpoint — no duplicate case logic in `client-detail.js`.
- **Planning Board**: `_buildTeamItemPool()` attaches a `pending_statutory_change` boolean (a case in `ready_for_review` or `approved` for that client) via the same lightweight-direct-query pattern as the at-risk-client and annual-return-due badges, rendered as a soft "🗂 Pending Statutory Change" badge.
- **Notifications**: low-risk `notify()` calls (all wrapped in `.catch()`) fire on approve, implement, and complete — never on draft/preparing/rejected/cancelled, keeping noise low per the spec's "do not overbuild."

## Frontend

`secretarial-workflows.html` + `js/secretarial-workflows.js` (prefix `sw`): summary cards, a filterable case list (status/change_type), a Create Case modal (client + change_type + title/summary + dates + JSON payload with a live hint), and a detail modal with 3 tabs (Checklist / Change Details / Events) plus a context-sensitive action bar (Generate Checklist, Submit for Review, Approve, Reject, Implement, Complete, Cancel — only the actions valid for the case's current status are shown). No chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `secretarial-workflows.js`, both new frontend files, and every edited file (`secretarial.js`, `index.js`, `layout.js`, `planning-board.js`, `js/planning-board.js`, `secretarial.html`, `js/secretarial.js`, `js/client-detail.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. Reads unrestricted per-user (matching the established precedent for client-level, non-personal data); all writes and workflow actions manager-gated via the standard `_myTeamMember`/`_isManager`/`_requireManager` triage.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/120_practice_secretarial_workflows.sql` | 3 tables |
| `accounting-ecosystem/backend/modules/practice/secretarial-workflows.js` | Router + workflow engine + register-update implementations |
| `accounting-ecosystem/backend/frontend-practice/secretarial-workflows.html` | Secretarial Changes UI |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial-workflows.js` | Secretarial Changes UI logic |
| `docs/new-app/63_secretarial_workflows.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_63_secretarial_workflows.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/secretarial.js` | Added `writeSecretarialEvent`/`getOrInitProfile` exports (purely additive) |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `secretarial-workflows` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Secretarial Changes" nav entry, placed after Secretarial |
| `accounting-ecosystem/backend/frontend-practice/secretarial.html` | Added "Recent Statutory Changes" panel + "Manage Changes →" link |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial.js` | Loads recent change cases per selected client; sets the Manage Changes link |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Section 22 now also shows latest statutory changes |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | `_buildTeamItemPool()` attaches `pending_statutory_change` flag per item |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Renders the "Pending Statutory Change" badge on work items |
