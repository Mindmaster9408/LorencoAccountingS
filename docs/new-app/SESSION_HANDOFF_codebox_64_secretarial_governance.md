# Session Handoff — Codebox 64: Secretarial Resolutions + Minutes Register Foundation

> Date: 2026-07-03
> Status: COMPLETE — migration 121 NOT yet applied to Supabase — not committed or pushed
> Codeboxes 60-63 are ALSO still uncommitted from prior session turns — all five are staged together for the next push.

---

## What Was Built

### An audit that confirmed a naming lookalike was NOT a collision

Before writing migration 121, an audit for pre-existing tables (per RULE A1) found `practice_client_meetings` already exists from Codebox 61 (Client Success). This codebox's spec asks for `practice_secretarial_meetings` — a different table, but close enough in name and concept ("meetings") that it was worth explicitly confirming these are genuinely distinct business concepts before writing a line of schema: `practice_client_meetings` is relationship/communication meetings (quarterly reviews, business reviews — "which client needs me today?"), while `practice_secretarial_meetings` is formal statutory governance meetings (directors meetings, AGMs) with attendees, minutes, and linked resolutions. Both tables now exist, fully separate, with the distinction documented in the migration header so a future reader never conflates or tries to "deduplicate" them.

### Reusing the Timeline without touching Codebox 62's schema

The spec's Timeline Integration section says "if timeline is currently event-based, reuse event stream rather than duplicating a timeline table." Codebox 62's `practice_secretarial_events` table has a fixed `event_type` CHECK constraint with no resolution/meeting/decision-specific values. Rather than `ALTER`-ing an already-applied, foundational table's constraint from this unrelated, later codebox — a genuinely risky cross-codebox change — governance milestones reuse the exact same `company_detail_changed` generic bucket Codebox 63 already established for its own non-enumerated events, with descriptive `notes` text carrying the specifics ("Resolution implemented: ...", "Minutes approved: ..."). This module's own fully-typed audit trail (`practice_secretarial_governance_events`) remains the authoritative record; the Timeline push is a secondary, best-effort convenience wrapped in try/catch so it can never block the actual governance action.

### Status transitions simplified exactly where the spec invited it

The endpoint list gives no dedicated "prepare" action for resolutions or "draft minutes" action for meetings — only the named workflow-significant actions (`approve`/`sign`/`implement`; `mark-held`/`approve-minutes`). Per the spec's own permission ("Developer may simplify transitions if safer, but must document"), the pre-workflow states (`draft↔prepared`, `planned↔minutes_draft`) and the simple closures (`implemented→archived`, `minutes_approved→completed`) are reached via the generic `PUT /:id`, gated to only those specific transitions — mirroring the exact precedent Codebox 63 set for its own case's pre-review states.

### `content_snapshot` — an audit copy, not a document

Signing a resolution captures a structured JSON snapshot of its key fields at that exact moment. This directly serves "governance record integrity" (Implementation Priority #1) without crossing into PDF generation or e-signature (neither exists in this codebox) — it exists purely so a later edit to a resolution's notes can never quietly rewrite what was actually approved and signed off.

### Backend — `secretarial-governance.js` (~24 endpoints)

Key judgment calls:

**Attendee removal is the one real (hard) delete in this codebox.** Every other entity only ever soft-cancels — but an attendee record ("was this person invited, did they attend") is a correctable data-entry detail, not governance evidence in its own right, unlike cancelling a resolution or a meeting.

**No frontend `company_id` is ever trusted.** Every linked ID (client, change_case_id, meeting_id, resolution_id) is independently re-verified server-side against `req.companyId` (and the matching `client_id`, where relevant) before being accepted on create — a plain existence-and-ownership lookup, not a call into another module's business logic, matching the session's established "lightweight direct query" pattern.

**Decisions support three independent, optional links** (meeting, resolution, change case) exactly as specified — none implies or requires another.

### Frontend — `secretarial-governance.html` + `js/secretarial-governance.js` (prefix `sg`)

- Summary cards, 4 tabs (Resolutions / Meetings / Decisions / Events)
- Each of the first three tabs: filterable list, create modal, detail modal with a status-aware action bar
- Meeting detail additionally manages attendees inline
- Supports `?create=resolution|meeting&client_id=&change_case_id=` deep-linking — **a timing bug was caught and fixed during self-review**: the deep-link handler originally tried to pre-select a client dropdown before the async client list had finished loading (setting `.value` on a `<select>` with no matching `<option>` yet silently fails). Fixed by making `_loadClientOptions()` return its promise and chaining the deep-link handler onto it (`_loadClientOptions().then(_handleDeepLink)`), so the client dropdown is always populated before any pre-fill is attempted.
- No chart library, no AI, matching every codebox this session

### Integrations

**Secretarial Workflows** (Codebox 63): a new "Governance" tab in the Change Case detail modal lists linked resolutions/meetings/decisions (read-only, reused via `change_case_id` filters), plus "+ Create Resolution"/"+ Create Meeting" quick-action buttons that deep-link into Secretarial Governance with the client and case pre-filled.
**Secretarial page** (Codebox 62): a "Governance" panel alongside the existing "Recent Statutory Changes" panel (Codebox 63), showing the selected client's most recent governance records.
**Client Detail**: Section 22 (Secretarial, extended in Codebox 63) now also shows a "Latest governance" summary line.

---

## Nothing Regressed

- `secretarial.js`'s existing exports (`getCorporateProfile`, `getGovernanceSummary`, `writeSecretarialEvent`, `getOrInitProfile` — the latter two added in Codebox 63) are unchanged; this codebox only calls the already-additive `writeSecretarialEvent`.
- `secretarial-workflows.js`'s existing ~17 endpoints and workflow logic (Codebox 63) are unchanged — the only additions are a new "Governance" detail tab (read-only) and two new action buttons that navigate away via `window.location.href`, nothing more.
- `secretarial.html`/`js` (Codebox 62-63) — the existing Corporate Profile/Directors/Shareholders/Annual Returns/Timeline tabs and the "Recent Statutory Changes" panel are unchanged; the new "Governance" panel is purely additive.
- `client-detail.js`'s Section 22 and `loadClientSecretarial()` (Codebox 62, extended Codebox 63) — the existing summary line and latest-changes line are unchanged; the governance line is a new, additively-appended block wrapped in its own try/catch.
- `client-success.js`, `planning-board.js`, `client-health.js`, `work-queue.js`, `capacity.js`, `delegation.js`, `skills-matrix.js`, `learning-centre.js`, `notifications.js` — completely untouched.
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
5. `121_practice_secretarial_resolutions_minutes.sql`

Expected: "Success. No rows returned." for each.

No seeding step is required or provided — resolutions, meetings, attendees, and decisions all start empty and are created entirely by managers as needed.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migrations 117 through 121 to Supabase
2. Navigate to `/practice/secretarial-governance.html` — should show zeroed summary cards and empty lists across all 3 register tabs
3. Create a Directors Resolution for a client → confirm it appears with status "Draft"
4. Click "Approve" → confirm status becomes "Approved" with `approved_by`/`approved_at` set
5. Click "Sign" → confirm status becomes "Signed" and a `content_snapshot` JSON block appears in the detail view
6. Click "Implement" → confirm status becomes "Implemented"; confirm the Secretarial page's own Timeline shows a "Resolution implemented" entry for that client
7. Create a Directors Meeting → click "Mark Held" → confirm status becomes "Held"
8. Add 2-3 attendees with different `attendance_status` values → confirm they appear correctly labeled in the meeting detail
9. Click "Approve Minutes" → confirm status becomes "Minutes Approved"; edit the meeting via PUT to set `meeting_status: completed` (or use a future UI action) → confirm it becomes "Completed"
10. Create a Decision linked to the meeting from step 7-9 (via `meeting_id`) AND a change case (via `change_case_id`) → confirm both links are validated (try an invalid ID for each — confirm 400)
11. Approve then implement the decision → confirm status transitions correctly and events are logged
12. Go to `/practice/secretarial-workflows.html`, open a change case detail, click "+ Create Resolution" → confirm it navigates to Secretarial Governance with the client and change_case_id pre-filled in the Create Resolution modal
13. On that same change case's detail, check the new "Governance" tab → confirm the resolution/meeting/decision created against that `change_case_id` all appear listed
14. Go to `/practice/secretarial.html`, select a client with governance records → confirm the new "Governance" panel shows the client's recent resolutions/meetings/decisions and the "Manage Governance →" link carries the client through
15. Go to `/practice/client-detail.html?id=<clientId>` for that client → confirm the Secretarial section's summary line now includes "Latest governance: ..."
16. As a non-manager, attempt to create/edit/approve/sign/implement/cancel any resolution/meeting/decision, or add/edit/delete an attendee → confirm 403 on each; confirm all `GET` reads still succeed
17. Attempt to create a resolution/meeting/decision with a `change_case_id`/`meeting_id`/`resolution_id` belonging to a DIFFERENT client → confirm 400 (linking validation rejects mismatched client_id)
18. Log in as a different company → confirm zero cross-company resolutions/meetings/attendees/decisions/events visible
19. DevTools → Application → Storage → confirm no governance data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Governance events reuse Secretarial's generic 'company_detail_changed' Timeline event type rather than dedicated resolution/meeting/decision event types
- Confirmed now: Deliberate — extending Codebox 62's already-applied event_type CHECK constraint from this later, unrelated codebox was judged too invasive (RULE A4). This module's own practice_secretarial_governance_events table IS fully typed with the exact 18 event types the spec lists — nothing is lost, the generic bucket is only used for the secondary Timeline push.
- Not yet confirmed: Whether practices will want the Timeline itself to distinguish governance events from other secretarial changes at a glance (currently they all show the same generic label with differing notes text).
- Risk: Low — purely a Timeline-display nicety; the authoritative, fully-typed record is intact in this module's own events table regardless.
- Recommended: If this becomes a real friction point, a future codebox could do a single, careful, additive ALTER TABLE on practice_secretarial_events to extend its event_type enum — but only as its own deliberate, audited change, not smuggled in here.
```

```
FOLLOW-UP NOTE
- Area: No document attachment for resolutions/meetings (e.g. no way to attach the actual signed PDF once one exists)
- Confirmed now: Explicitly out of scope per this codebox's own Architecture Boundaries ("NOT document storage") and Future Enhancements ("PDF generation... meeting pack exports" listed as NOT to build now). content_snapshot is a structured audit copy, not a document.
- Not yet confirmed: How a future PDF/e-signature codebox should attach its output back onto these records — likely a simple document_reference/document_url field added later, or integration with document-requests.js (already flagged as a cross-module follow-up in Codebox 62/63).
- Risk: Low — no functionality is broken; this is a forward-compatibility question the codebox explicitly deferred.
- Recommended: When PDF generation/e-signature is eventually built (not yet scheduled per the roadmap), design its output-attachment point against these existing resolution/meeting records rather than replacing them, per this codebox's own stated principle ("Future PDF/e-signature must plug into these records").
```

```
FOLLOW-UP NOTE
- Area: Decision responsible_team_member_id is stored but not validated against practice_team_members
- Confirmed now: Unlike client/meeting/resolution/change_case links (all independently verified), responsible_team_member_id is accepted as-is. This mirrors several other modules this session (e.g. Client Success's relationship_owner_team_member_id) where team-member references are treated as soft display hints rather than hard-gated foreign keys.
- Not yet confirmed: Whether this should be tightened to a real existence check.
- Risk: Low — an invalid ID would simply fail to resolve to a display name in the UI, not cause data corruption or cross-tenant leakage (company_id scoping is unaffected).
- Recommended: Low priority; revisit only if a real support issue surfaces from a genuinely invalid ID being stored.
```
