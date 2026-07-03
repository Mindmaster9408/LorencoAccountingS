# Session Handoff — Codebox 63: Practice Secretarial Workflows + Statutory Change Management

> Date: 2026-07-03
> Status: COMPLETE — migration 120 NOT yet applied to Supabase — not committed or pushed
> Codeboxes 60 (Learning Centre), 61 (Client Success), and 62 (Secretarial Foundation) are ALSO still uncommitted from prior session turns — all four are staged together for the next push.

---

## What Was Built

### The audit that decided which change types get automatic register updates — the most consequential design decision in this codebox

Before writing any implementation logic, an audit of migration 119's actual `practice_secretarial_profiles` schema (per RULE A1 and the codebox's own "Audit first" instruction) found it has `registered_address`, `postal_address`, `company_secretary`, `auditor`, and `company_status` — exact-match, safe targets. It has **no field for "public officer"** at all, and only `financial_officer` (not the legally distinct "accounting officer"). Company **name** lives on `practice_clients.name` — client master data, explicitly out of this module's bounds per the precedent set in Codeboxes 61-62. **Financial year-end** lives on `practice_taxpayer_profiles` — a different module's table entirely. The spec's own instruction ("if payload is insufficient or ambiguous, block implement with 422... never guess") made the right call obvious once these facts were confirmed: `share_issue`, `share_cancellation`, `company_name_change`, `financial_year_end_change`, `accounting_officer_change`, `public_officer_change`, and `custom` are deliberately **excluded** from `IMPLEMENTATION_RULES` — attempting to implement one always returns 422 with a clear explanation, unless the caller explicitly passes `manual: true` + a `manual_reason`, in which case the case still progresses to `implemented` without any register mutation. This map is the single source of truth for "safe vs. manual," documented identically in the migration header and the router's own comment block so the two can never drift out of sync.

### `share_transfer` takes the spec's own offered "safer alternative"

The spec text explicitly offers two options for share transfers: mutate the shareholder register, or "if safer, only write event and after_snapshot, do not mutate shareholder automatically." Matching a specific shareholder row without an explicit ID would be exactly the kind of ambiguous guess the rest of the spec warns against — so `_implShareTransfer()` only mutates when `payload.shareholder_id` is explicitly provided and resolves to a real row for that client. Without it, the case still completes successfully (`skipped_mutation: true` in the response) — this is the spec's own accepted outcome, not a failure state.

### Reusing Secretarial's existing Timeline instead of building a second one

The spec lists `timeline_event_created` as one of THIS codebox's own event types (in `practice_secretarial_change_events`) — read literally, that's this module logging that it pushed something into *the* Timeline, not owning a second one. `secretarial.js` (Codebox 62) gained two small, purely additive exports — `writeSecretarialEvent` (an alias for its existing private `_writeEvent` helper) and `getOrInitProfile` — so `secretarial-workflows.js` could write into `practice_secretarial_events` (Codebox 62's Timeline table) on every successful implementation, without duplicating any insert logic or creating a second, competing timeline surface. Zero behavior change to any of Codebox 62's existing routes.

### The workflow state machine makes "no status change without event" true by construction, not convention

`PUT /:id` (the generic case-editing route) can only move `case_status` between `draft`/`preparing`/`awaiting_documents` — the three pre-review housekeeping states. Every workflow-significant transition (submit-review, approve, reject, implement, complete, the soft-cancel `DELETE`) has its own dedicated endpoint, and every one of them writes its event inside the same handler, before responding. There is structurally no code path in this router that can change `case_status` to a review/approval/implementation state without a matching row in `practice_secretarial_change_events`.

### Backend — `secretarial-workflows.js` (~17 endpoints)

Key judgment calls:

**Checklist defaults extend beyond the spec's 5 explicit sets, using a generic 4-item fallback** for the 9 change_types the spec didn't name checklists for — exercising the spec's own stated permission ("Custom: no defaults unless developer adds sensible minimal items"). `custom` itself still gets zero defaults exactly as specified.

**Approval's checklist gate returns a soft warning, not a dead end.** If required checklist items are incomplete, `PUT /:id/approve` returns 400 with an `incomplete_count` rather than silently blocking forever — the frontend surfaces this with an override-reason field, matching "required checklist items should be completed OR manager override required with reason" literally.

**The implement route's response booleans (`register_updated`/`skipped_mutation`) were caught and fixed during self-review before this handoff was written** — an early draft computed `register_updated` with a confusing, operator-precedence-broken expression (`!manual && !after === false`) that didn't reliably reflect whether a real mutation happened. This was replaced with a single `skippedMutation` boolean threaded explicitly through both the manual and automatic implementation paths, making the final response unambiguous.

### Frontend — `secretarial-workflows.html` + `js/secretarial-workflows.js` (prefix `sw`)

- Summary cards, a filterable case list (status/change_type)
- Create Case modal — client picker, change_type, title/summary, dates, and a single JSON payload textarea with a live, change_type-specific hint of exactly which fields `IMPLEMENTATION_RULES` reads (see Architect Freedom #9 in the docs — deliberately not 16 bespoke structured forms, matching the spec's "keep simple... UI polish last")
- Detail modal — 3 tabs (Checklist / Change Details / Events) plus a context-sensitive action bar that only shows the actions valid for the case's current status
- No chart library, no AI, matching every codebox this session

### Integrations

**Secretarial page** (Codebox 62): a "Recent Statutory Changes" panel + a "Manage Changes →" deep link carrying the selected client.
**Client Detail**: Section 22 (added in Codebox 62) now also lists the 3 most recent change cases.
**Planning Board**: a `pending_statutory_change` flag (case in `ready_for_review`/`approved` for that client) via the same lightweight-direct-query pattern as the at-risk-client (Codebox 61) and annual-return-due (Codebox 62) badges.
**Notifications**: low-risk, `.catch()`-wrapped `notify()` calls on approve, implement, and complete only — never on the earlier, noisier draft states.

---

## Nothing Regressed

- `secretarial.js`'s existing ~17 endpoints, `getCorporateProfile()`, and `getGovernanceSummary()` are unchanged in behavior — the only addition is two new exports (`writeSecretarialEvent`, `getOrInitProfile`) aliasing existing private functions.
- `planning-board.js`'s `_buildTeamItemPool()` — the existing `workQueue.buildActiveQueue()` reuse chain, cache invalidation, and the Codebox 61/62 `at_risk_client`/`annual_return_due` flags are unchanged; `pending_statutory_change` is a new, additive field.
- `client-detail.js`'s Section 22 and `loadClientSecretarial()` (Codebox 62) — the existing summary line is unchanged; the recent-changes line is a new, additively-appended block wrapped in its own try/catch so a failure here can never break the rest of the section.
- `client-health.js`, `client-success.js`, `work-queue.js`, `capacity.js`, `delegation.js`, `skills-matrix.js`, `learning-centre.js`, `notifications.js` — completely untouched.
- `node --check` passes on every new/modified JS file.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run, in order:
1. `117_practice_learning_centre.sql` (still pending)
2. `118_practice_client_success.sql` (still pending)
3. `119_practice_secretarial_foundation.sql` (still pending)
4. `120_practice_secretarial_workflows.sql`

Expected: "Success. No rows returned." for each.

No seeding step is required or provided — change cases, checklist items, and events all start empty and are created entirely by managers as needed.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migrations 117, 118, 119, and 120 to Supabase
2. Navigate to `/practice/secretarial-workflows.html` — should show zeroed summary cards and an empty case list
3. Create a Director Appointment case with `payload: {"director_name": "J. Smith", "role": "executive"}` → confirm it appears with status "Draft"
4. Click "Generate Checklist" → confirm the 6 Director Appointment items appear (Signed consent, ID document, Resolution, Update director register, CIPC filing step, Client confirmation), all required
5. Mark all 6 checklist items complete → click "Submit for Review" → confirm status becomes "Ready for Review"
6. Click "Approve" with no override reason → confirm it succeeds (checklist fully complete, no warning shown)
7. Click "Implement" with an effective date → confirm a NEW director row appears in `/practice/secretarial.html`'s Director Register for that client with status "Active"; confirm the Secretarial page's own Timeline shows a "Director Appointed" entry; confirm the case's own Events tab shows `change_implemented`, `register_updated`, and `timeline_event_created`
8. Click "Complete" → confirm status becomes "Completed"
9. Create a Director Resignation case for an existing director, with `payload: {"director_id": <id>}` → generate checklist, submit, approve, implement with an effective date → confirm that EXACT existing director row now shows status "Resigned" with the resignation date set (not a new row)
10. Create a Registered Address Change case with `payload: {"registered_address": "123 New St"}` → implement → confirm the Secretarial page's Corporate Profile tab shows the updated address
11. Create a Company Name Change case → attempt to implement WITHOUT `manual: true` → confirm 422 with a clear message; tick "Implement manually" with a reason → confirm it succeeds and moves to "Implemented" with no register mutation
12. Create a case, submit for review, then click "Reject" with a reason → confirm status becomes "Rejected" and no further action buttons appear except nothing (terminal state)
13. Create a draft case, click "Cancel Case" → confirm status becomes "Cancelled"; attempt to cancel a Completed case → confirm it's blocked
14. Create a case with incomplete required checklist items, submit for review, attempt to approve WITHOUT an override reason → confirm 400 with `incomplete_count`; retry WITH a reason → confirm it succeeds
15. Go to `/practice/planning-board.html` for a client with a case in "Ready for Review" or "Approved" → confirm the "🗂 Pending Statutory Change" badge appears on that client's work items
16. Go to `/practice/client-detail.html?id=<clientId>` for a client with recent change cases → confirm the Secretarial section shows "Latest changes: ..." with titles and statuses
17. As a non-manager, attempt to create/edit/approve/reject/implement/complete/cancel a case → confirm 403 on each; confirm all `GET` reads still succeed
18. Log in as a different company → confirm zero cross-company change cases/checklist items/events visible
19. DevTools → Application → Storage → confirm no secretarial-workflow data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: 7 change_types (share_issue, share_cancellation, company_name_change, financial_year_end_change, accounting_officer_change, public_officer_change, custom) have no automatic register update — always require manual: true + manual_reason
- Confirmed now: This is a deliberate, audited decision (see docs/new-app/63_secretarial_workflows.md Architect Freedom #1), not an oversight. Each has a concrete, documented reason: no matching field exists, the field belongs to a different module's table, or (for custom) no fixed target could exist by definition.
- Not yet confirmed: Whether practices will want financial_year_end_change to write into practice_taxpayer_profiles after all (a cross-module write to the one authoritative field, rather than always-manual) once real usage patterns emerge.
- Risk: Low — the current behavior is safe-by-default (never guesses); loosening it later to add one more safe rule to IMPLEMENTATION_RULES is a small, additive, well-contained change.
- Recommended: If this becomes a real friction point, revisit financial_year_end_change specifically (its target field and table are unambiguous, unlike the officer-role fields) rather than loosening all 7 at once.
```

```
FOLLOW-UP NOTE
- Area: No document attachment for checklist items (e.g. "Signed consent" or "Proof of address" have no file upload)
- Confirmed now: Explicitly out of scope per the spec's Future Enhancements section ("document generation" listed as NOT to build) and Architecture Boundaries ("This is NOT document generation... NOT e-signatures"). checklist_item_type = 'document' items are tracked as a checkbox + notes only.
- Not yet confirmed: Whether a lightweight cross-reference to document-requests.js (already flagged as a Codebox 62 follow-up) should be built once Codebox 64's resolutions/minutes register exists, giving statutory changes a natural place to point at supporting paperwork.
- Risk: Low — no functionality is broken; this is a workflow-completeness gap, not a data-integrity one.
- Recommended: Revisit alongside the Codebox 62 document-requests follow-up once Codebox 64 (Resolutions + Minutes) exists — a resolution is exactly the kind of document a director appointment case would want to link to.
```

```
FOLLOW-UP NOTE
- Area: Approval's checklist-completeness check counts only `required` items; there's no concept of "recommended but skippable" beyond the existing required=false flag
- Confirmed now: This is the full extent of what the spec asked for ("required checklist items should be completed OR manager override required") — required=false items were already supported at the schema level for any manually-added item, no gap here.
- Not yet confirmed: N/A — this is confirmed complete as specified.
- Risk: None.
- Recommended: None needed; noted only for completeness of this handoff's audit trail.
```
