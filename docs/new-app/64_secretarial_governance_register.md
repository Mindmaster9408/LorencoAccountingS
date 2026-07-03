# Codebox 64 — Secretarial Resolutions + Minutes Register Foundation

> App: Lorenco Practice Management
> Status: Complete — migration 121 not yet applied to Supabase — nothing committed or pushed

## Purpose

Creates the governance decision register behind Codebox 63's statutory change workflow. Answers "who approved what, when, under which authority, and which resolution/meeting supports it." Resolutions, meetings (with attendees), and written decisions, all optionally linked to a client, a statutory change case, and each other.

**NOT PDF generation. NOT e-signature. NOT CIPC submission. NOT document storage.** Structured governance record keeping only — future PDF/e-signature must plug into these records, not replace them.

## Architect Freedom — Scope Decisions & Deviations

1. **`practice_secretarial_meetings` is a deliberately distinct concept from `practice_client_meetings` (Codebox 61, Client Success), not a naming collision or an oversight.** An audit confirmed `practice_client_meetings` already exists — it stores relationship/communication meetings (quarterly reviews, business reviews) for Client Success's "which client needs me today?" purpose. This codebox's meetings are STATUTORY governance meetings (directors meetings, AGMs) with formal attendees, minutes, and linked resolutions/decisions — a completely different business concept that happens to share the English word "meeting." The two tables are never merged, joined, or cross-referenced; keeping them fully separate was the correct call, not a missed reuse opportunity.
2. **Governance events are pushed into Secretarial's EXISTING Timeline (`practice_secretarial_events`, Codebox 62) using the same general-purpose `company_detail_changed` event type Codebox 63 already established for its own non-enumerated events**, rather than extending migration 119's `event_type` CHECK constraint with resolution/meeting/decision-specific values. Altering an already-applied, foundational table's constraint from a later, unrelated codebox would have been exactly the kind of invasive cross-codebox change RULE A4 warns against — reusing the existing generic bucket (with descriptive `notes` text carrying the specifics) satisfies the spec's "reuse event stream rather than duplicating a timeline table" instruction without touching Codebox 62's schema at all. This module's OWN detailed audit trail (`practice_secretarial_governance_events`) is unaffected and remains the authoritative, fully-typed record — the Timeline push is a secondary, best-effort convenience (wrapped in try/catch, never blocking the actual governance action).
3. **Status transitions were simplified exactly where the spec permits it** ("Developer may simplify transitions if safer, but must document"): the endpoint list gives no dedicated "prepare a resolution" or "draft a meeting's minutes" action — only `approve`/`sign`/`implement` for resolutions and `mark-held`/`approve-minutes` for meetings. `draft ↔ prepared` (resolutions) and `planned ↔ minutes_draft` (meetings) are therefore reached via the generic `PUT /:id`, gated to only those specific pre-workflow states — exactly mirroring the precedent Codebox 63 set for its own pre-review states. `resolution_status = 'archived'` (only reachable from `implemented`) and `meeting_status = 'completed'` (only reachable from `minutes_approved`) are likewise handled as a plain, gated `PUT` rather than invented dedicated endpoints, since the spec's endpoint list has no "archive"/"complete" action for these and both are simple closures, not decisions requiring their own validation logic.
4. **`resolution_status = 'signed'` captures a `content_snapshot`** — a structured, JSON copy of the resolution's key fields (type, title, summary, dates, approver, timestamps) taken at the exact moment of signing. This is explicitly NOT a generated or signed document (no PDF/e-signature exists in this codebox) — it exists so that later edits to a resolution's notes or summary can never quietly rewrite what was actually approved and signed off, satisfying "governance record integrity" (the spec's #1 Implementation Priority) with a plain JSONB column rather than a document.
5. **Attendee removal (`DELETE /attendees/:attendeeId`) is a real, hard delete — the only hard delete in this codebox.** Every other entity (resolutions, meetings, decisions) only ever soft-cancels. An attendee record is a much lighter-weight, correctable data-entry detail (was this person invited or not; did they attend) rather than governance evidence in its own right — removing one added by mistake isn't erasing evidence of a decision, the way cancelling a resolution or meeting would be.
6. **Linking validation (client/change_case/meeting/resolution) is a plain existence-and-ownership lookup, not a call into another module's engine** — matching the exact "lightweight direct query, not a call into someone else's business logic" pattern used throughout this session (Skills Matrix badges, Client Success's at-risk flag, Secretarial Workflows' pending-change flag). No frontend-supplied `company_id` is ever trusted; every linked ID is re-verified against `req.companyId` (and the same `client_id`, where applicable) before being accepted.
7. **Decisions carry three independent, optional links (meeting, resolution, change case)** exactly as specified, each validated separately — a decision can stand alone, follow directly from a meeting, formalize a resolution, support a statutory change, or any combination, without one link implying or requiring another.
8. **The Secretarial Workflows "Create Resolution"/"Create Meeting" quick actions are plain deep links with query-string pre-fill (`?create=resolution|meeting&client_id=&change_case_id=`), not an embedded create form inside the Change Case detail modal.** This keeps Codebox 63's file untouched beyond two new action buttons and a "Governance" tab that reads (never writes) linked records — all actual creation and editing logic lives only in `secretarial-governance.js`/`.html`, avoiding a second, parallel resolution/meeting creation UI.

## Database — Migration 121

Five tables: `practice_secretarial_resolutions`, `practice_secretarial_meetings`, `practice_secretarial_meeting_attendees`, `practice_secretarial_decisions`, and the append-only `practice_secretarial_governance_events`. Full field-by-field rationale in the migration's own header and per-table comments.

## Backend — `secretarial-governance.js`

### Endpoints (~24)

Summary; full CRUD for Resolutions (+ `approve`/`sign`/`implement`), Meetings (+ `mark-held`/`approve-minutes`), Attendees (nested under a meeting), and Decisions (+ `approve`/`implement`); a global Events feed and a per-source-record Events feed (`GET /:sourceType/:sourceId/events`).

## Resolution Logic

`draft/prepared → approved → signed → implemented → archived`, with `cancelled` available any time before `implemented`. `sign` captures the `content_snapshot` audit copy (see Architect Freedom #4). Every transition writes its own governance event before responding.

## Meeting/Minutes Logic

`planned → held → minutes_draft/minutes_approved → completed`, with `cancelled` available any time before `completed`. Attendees are a simple nested CRUD under a meeting (`attendee_type`/`attendance_status` enums enforced), with real deletion permitted (see Architect Freedom #5).

## Decision Logic

`draft → approved → implemented`, with `cancelled` available any time before `implemented`. Optionally linked to a meeting, a resolution, and/or a statutory change case — each link independently validated (see Architect Freedom #6-#7). Supports `follow_up_required`/`follow_up_due_date` for simple manager reminders, surfaced in the summary as an overdue count.

## Secretarial Workflow Integration

- **Secretarial Change Case detail** (Codebox 63): a new "Governance" tab lists linked resolutions/meetings/decisions (read-only, reused via `change_case_id` filters — no duplicate logic), plus two quick-action buttons ("+ Create Resolution", "+ Create Meeting") that deep-link into `secretarial-governance.html` with the client and change case pre-filled.
- **Secretarial page** (Codebox 62): a new "Governance" panel alongside the existing "Recent Statutory Changes" panel, showing the selected client's most recent resolutions/meetings/decisions, plus a "Manage Governance →" link.
- **Client Detail**: Section 22 (Secretarial, from Codebox 62, already extended by Codebox 63) now also shows a "Latest governance" line summarizing the client's most recent resolutions and meetings.
- **Timeline**: governance milestones (cancellation, implementation, minutes approval) are pushed into Secretarial's existing Timeline — see Architect Freedom #2.

## Frontend

`secretarial-governance.html` + `js/secretarial-governance.js` (prefix `sg`): summary cards, a 4-tab layout (Resolutions / Meetings / Decisions / Events). Each of the first three tabs has a filterable list, a create modal, and a detail modal with a context-sensitive action bar. The Meeting detail modal additionally manages attendees inline. Supports `?create=resolution|meeting&client_id=&change_case_id=` deep-linking from Secretarial Workflows. No chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `secretarial-governance.js`, both new frontend files, and every edited file (`index.js`, `layout.js`, `secretarial.html`, `js/secretarial.js`, `js/secretarial-workflows.js`, `js/client-detail.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. No frontend-supplied `company_id` is ever trusted for a linked record — client, change case, meeting, and resolution links are each independently re-verified server-side (see Architect Freedom #6). Reads unrestricted per-user; all writes and workflow actions manager-gated.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/121_practice_secretarial_resolutions_minutes.sql` | 5 tables |
| `accounting-ecosystem/backend/modules/practice/secretarial-governance.js` | Router — resolutions/meetings/attendees/decisions + workflow actions |
| `accounting-ecosystem/backend/frontend-practice/secretarial-governance.html` | Secretarial Governance UI |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial-governance.js` | Secretarial Governance UI logic |
| `docs/new-app/64_secretarial_governance_register.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_64_secretarial_governance.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `secretarial-governance` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Secretarial Governance" nav entry, placed after Secretarial Changes |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial-workflows.js` | Added a "Governance" tab (linked resolutions/meetings/decisions) + quick-create action buttons to the Change Case detail modal |
| `accounting-ecosystem/backend/frontend-practice/secretarial.html` | Added a "Governance" panel |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial.js` | Loads recent governance records per selected client; sets the Manage Governance link |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Section 22 now also shows latest governance records |
