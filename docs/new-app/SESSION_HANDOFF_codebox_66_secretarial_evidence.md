# Session Handoff — Codebox 66: Secretarial Document Checklist + Governance Evidence Requests

> Date: 2026-07-03
> Status: COMPLETE — migration 124 NOT yet applied to Supabase — not committed or pushed
> Codeboxes 60-65 and 67 are ALSO still uncommitted from prior session turns — all eight are staged together for the next push.
> **User note**: Codebox 67 (Statutory Calendar) was delivered before this codebox by mistake in the prompt sequence. Migration 123 was already applied to the user's live Supabase for that content before this correction arrived. This handoff explains exactly how the two were reconciled.

---

## What Was Built

### The migration numbering collision, resolved without touching what's already live

This codebox's spec literally asked for `123_practice_secretarial_evidence.sql`. That number was already taken — Codebox 67's `123_practice_secretarial_calendar.sql` had been built AND applied to the user's Supabase in the prior turn. Overwriting or renaming that file would have desynced the repo's migration history from what's actually been run against the live database — a real, avoidable risk. The fix: this codebox's migration became `124_practice_secretarial_evidence.sql`, the next available number, with the renumbering explained in the migration's own header comment so a future reader (or the user themselves) never wonders why "66" produced migration "124." Content-wise, everything else follows the spec exactly.

### A predicted gap, closed on schedule

When Codebox 67 was built, `secretarial-calendar.js` shipped with a documented follow-up: `'evidence_complete'` dependencies "always require manager confirmation... revisit when a document/evidence checklist module is eventually built." That was written not knowing exactly when such a module would arrive — and it arrived in this very session, one turn later (after the numbering correction). `_isDependencySatisfied()` was updated to check a linked evidence checklist's live readiness via this codebox's new `getChecklistReadiness()` export, exactly as that earlier follow-up note anticipated. This is a genuine case of the session's own documentation predicting and then resolving its own gap.

### "No duplicate readiness logic" resolved by delegation, not by rebuilding

An audit of `practice_bo_readiness_items` (Codebox 65) confirmed it already IS a complete, evidence-style checklist purpose-built for Beneficial Ownership — the exact same shape (required/verification/status/notes) this codebox's own evidence items would otherwise duplicate. Rather than build a second, parallel evidence-tracking system for BO, a `bo_verification` checklist in this codebox exists only as a thin reference row — its real items and readiness are delegated entirely to `beneficial-ownership.js`. One new, purely additive export (`generateReadinessItems`) was all that was needed on that already-working file.

### Document Requests integration without touching Document Requests

An audit of `document-requests.js` confirmed it exports nothing beyond its Express router and has no event hook — there's no way to have it "push" a completion notification into this new module without modifying that file. Rather than risk changing a working, existing module for this integration, the reverse was implemented: this module pulls the current status of any linked document request live, every time a checklist or item is read. `document-requests.js` itself was never touched.

### Backend — `secretarial-evidence.js` (~20 endpoints)

**Verification is never inferred, only ever an explicit manager action.** When a linked document request becomes `received`, the evidence item's own status becomes `received` too — never silently jumped to `verified`, even for items that don't require verification. `PUT /items/:id/verify` is the only path to `verified`, always attributable to a specific reviewer team member.

**Default templates are a persisted, editable version of a pattern already proven in Codebox 63.** The 14 named evidence sets (Director Appointment, Resignation, Share Transfer, etc.) mirror Codebox 63's hardcoded `CHECKLIST_DEFAULTS` JS constant, now real database rows a practice can tailor — seeded once per company, idempotently, never overwriting a manager's own subsequent edits.

**A real, minor bug was caught and cleaned up during self-review**: an early draft of `_syncItemFromDocumentRequest()` had a dead-code branch (`docReq.request_status === 'received' → mapped = item.verification_required ? 'received' : 'received'`) where both sides of the ternary produced the same value — a leftover from an earlier design that briefly considered auto-verifying non-verification-required items before deciding against it. Simplified to a plain assignment with a clarifying comment.

### Frontend — `secretarial-evidence.html` + `js/secretarial-evidence.js` (prefix `se`)

- Summary cards, 3 tabs (Templates / Evidence Checklists / Events)
- Checklist detail view clearly labels BO-delegated checklists as such and shows no duplicate items for them
- Inline actions per evidence item: link to an existing document request, create a new one, verify, waive
- No document viewer, no file upload UI, no chart library, no AI

### Integrations

**Management Dashboard**: a new "Evidence Readiness" KPI section, reusing `getEvidenceSummary()` (extracted from the router's own summary logic, not duplicated).
**Planning Board**: an `evidence_blocked` flag (blocked, required items only — the same lightweight direct-query pattern as every other badge this session), rendered as a "📎 Evidence Blocked" badge.
**Statutory Calendar**: `evidence_complete` dependencies now resolve automatically, closing the predicted gap.

---

## Nothing Regressed

- `beneficial-ownership.js`'s existing ~26 endpoints, `getBeneficialOwnershipProfile()`, and `_generateReadinessItems()`'s internal behavior are unchanged — the only addition is one new export aliasing the existing private function.
- `secretarial-calendar.js`'s existing ~20 endpoints, `buildStatutoryCalendar()`, and recurrence engine (Codebox 67) are unchanged — the only additions are the `evidence_complete` branch in `_isDependencySatisfied()` (previously always returned unsatisfied — now can resolve automatically, a strict improvement, never a regression) and accepting one new optional field on `POST /dependencies`.
- `management-dashboard.js`'s `computeSummary()` — every existing key (including `statutory_compliance` from Codebox 67) is unchanged; `evidence_readiness` is a new, additive key wrapped in its own try/catch.
- `planning-board.js`'s `_buildTeamItemPool()` — the existing at-risk-client, annual-return-due, pending-statutory-change, BO-readiness-concern, and statutory-workload flags are unchanged; `evidence_blocked` is a new, additive field.
- `document-requests.js` (migration 073) — completely untouched, read from and inserted into only via its exact existing column shape.
- `secretarial-workflows.js` (Codebox 63), `secretarial-governance.js` (Codebox 64) — completely untouched; neither is required by this module.
- `secretarial.js` (Codebox 62), `client-health.js`, `client-success.js`, `work-queue.js`, `capacity.js`, `delegation.js`, `skills-matrix.js`, `learning-centre.js`, `notifications.js` — completely untouched.
- `node --check` passes on every new/modified JS file.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run, in order:
1. `117_practice_learning_centre.sql` (still pending)
2. `118_practice_client_success.sql` (still pending)
3. `119_practice_secretarial_foundation.sql` (still pending)
4. `120_practice_secretarial_workflows.sql` (still pending)
5. `121_practice_secretarial_resolutions_minutes.sql` (still pending)
6. `122_practice_secretarial_beneficial_ownership.sql` (still pending)
7. `123_practice_secretarial_calendar.sql` — **already applied per the user's note; do not re-run.**
8. `124_practice_secretarial_evidence.sql` — this codebox, not yet applied.

Expected: "Success. No rows returned." for migration 124.

No seeding step is required beyond the automatic, idempotent template seeding built into the router itself (`_ensureDefaultTemplates()`, triggered the first time `GET /templates` or `POST /checklists/generate` runs for a company) — checklists and items all start empty and are created entirely by managers/workflows as needed.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migration 124 to Supabase (migrations 117-123 remain pending from prior turns, per their own handoffs)
2. Navigate to `/practice/secretarial-evidence.html` — should show zeroed summary cards
3. Open the Templates tab → confirm the 14 default templates appear automatically (seeded on first load) with their evidence item counts matching the spec's examples
4. Generate a checklist for a client with `source_type: manual`, no template specified → confirm it resolves to the `custom` template (empty evidence list) and creates a checklist with zero items
5. Generate a checklist with `source_type: change_case` for an existing Director Appointment change case (Codebox 63) → confirm it resolves the `director_appointment` template and creates 3 items (signed consent, ID document, resolution)
6. Attempt to generate a SECOND checklist for the SAME `source_type`+`source_id` → confirm 400 with a message pointing to the regenerate endpoint
7. On one item, click "Link to Document Request" with no existing ID → confirm a NEW row appears in `practice_document_requests` (check `/practice/document-requests.html`) and the item's status becomes "Requested"
8. Manually mark that document request as "Received" (via the Document Requests page) → reload the evidence checklist → confirm the item's status auto-synced to "Received" (pull-based, live on read)
9. Click "Verify" on that item with a note → confirm status becomes "Verified" and a reviewer is recorded
10. Generate a checklist with `source_type: bo_verification` for a client → confirm the checklist row is created but the detail view shows "delegated to Beneficial Ownership" with no separate items; confirm new rows appeared in `practice_bo_readiness_items` instead (check `/practice/beneficial-ownership.html`)
11. Click "Regenerate" on a checklist after manually adding a new relevant record (e.g. add a new director, then regenerate a director-related checklist) → confirm only the missing item(s) are added, existing item statuses untouched
12. Go to `/practice/secretarial-calendar.html`, create a statutory dependency with `depends_on_type: evidence_complete` and a `depends_on_checklist_id` pointing at an incomplete checklist → confirm the schedule item shows as "Blocked"/"Waiting" depending on due date; complete/verify/waive all required items on that checklist until it reaches "Ready" → confirm the dependency now resolves as satisfied without a manager override
13. Go to `/practice/management-dashboard.html` → confirm the new "Evidence Readiness" KPI section shows counts matching the Evidence page
14. Go to `/practice/planning-board.html` for a client with a blocked, required evidence item → confirm the "📎 Evidence Blocked" badge appears
15. As a non-manager, attempt to create/edit any template/checklist/item, link/create a document request, verify, or waive → confirm 403 on each; confirm all `GET` reads still succeed
16. Attempt to link an item to a document request belonging to a DIFFERENT client → confirm 400
17. Log in as a different company → confirm zero cross-company templates/checklists/items/events visible; confirm default templates seed independently per company
18. DevTools → Application → Storage → confirm no evidence data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: 'governance_complete' statutory dependencies remain manual-only (no automatic check), unlike 'evidence_complete' and 'bo_review'
- Confirmed now: Codebox 64's resolutions/meetings have their own workflow-status lifecycle (draft/approved/signed/implemented) — a different concept from "evidence of this resolution has been received/verified." Wiring governance workflow status into the dependency check was judged out of scope for this codebox's explicit Document Request Integration focus. The 'resolution'/'minutes' evidence templates DO track real evidence items independent of the resolution's own status.
- Not yet confirmed: Whether practices want 'governance_complete' dependencies to check the resolution/meeting's own workflow status (e.g. "resolution must be signed") in addition to, or instead of, its evidence checklist.
- Risk: None currently — safe-by-default (never fakes satisfaction), manager override always available.
- Recommended: If requested, add a governance-status check to secretarial-calendar.js's _isDependencySatisfied() reusing secretarial-governance.js's existing resolution/meeting status fields directly (no new logic needed, just a read).
```

```
FOLLOW-UP NOTE
- Area: Evidence checklist "Templates" are company-wide, not client-specific or industry-specific
- Confirmed now: Matches the spec's framing ("Director Appointment... Custom" listed as universal template examples, no mention of per-industry variants) and mirrors Codebox 63's own CHECKLIST_DEFAULTS being a single, universal set per change_type.
- Not yet confirmed: Whether some practices will want different evidence requirements for, say, a Pty Ltd vs. a Trust's director appointment.
- Risk: Low — templates are already fully manager-editable per company; a practice with mixed entity types can simply edit required_evidence per case if needed, or the recommended_document_category can vary per generated item without changing the template itself.
- Recommended: Revisit only if this becomes a real friction point — could add an optional owner_type/company_type filter to template resolution later, additively.
```

```
FOLLOW-UP NOTE
- Area: The migration renumbering (123 → 124) means the physical migration file number no longer matches "Codebox 66" as cleanly as prior codeboxes' numbers matched their content
- Confirmed now: This is purely a bookkeeping quirk caused by the out-of-order delivery, documented in three places (migration header, this handoff, and 66_secretarial_evidence.md) so it's never mysterious to a future reader.
- Not yet confirmed: N/A — fully explained, no ambiguity remains.
- Risk: None.
- Recommended: None needed.
```
