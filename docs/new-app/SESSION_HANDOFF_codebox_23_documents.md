# Session Handoff — Codebox 23: Document Request Tracker
**Date:** 2026-06-20  
**Branch:** main  
**Status:** Complete — migration 073 pending application, do not push until applied

---

## What Was Built

Structured document request tracking across 3 DB tables, a full backend module with 20 endpoints, a standalone document-requests page, and client detail integration (Section 16).

**Not built:** No file storage. No OCR. No SharePoint. Tracking only.

---

## Files Created

| File | Purpose |
|------|---------|
| `accounting-ecosystem/backend/config/migrations/073_practice_document_requests.sql` | 3 tables, 16 indexes |
| `accounting-ecosystem/backend/modules/practice/document-requests.js` | 20 endpoints, enrichRequest(), checklist apply flow |
| `accounting-ecosystem/backend/frontend-practice/document-requests.html` | Full doc requests page |
| `accounting-ecosystem/backend/frontend-practice/js/document-requests.js` | IIFE module, no localStorage |
| `docs/new-app/23_document_request_tracker.md` | Full architecture reference |

---

## Files Modified

| File | What Changed |
|------|-------------|
| `accounting-ecosystem/backend/modules/practice/index.js` | Added `require('./document-requests')` + `router.use('/document-requests', ...)` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Documents" as 17th nav tab |
| `accounting-ecosystem/backend/frontend-practice/index.html` | Added `📄 Documents` quick-action button |
| `accounting-ecosystem/backend/frontend-practice/client-detail.html` | Added Section 16 "Document Requests" div + `addDocModal` before engagement modal |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Added 5 functions + 4 window exports; `loadClient()` reveals section, sets link, calls load function |
| `accounting-ecosystem/backend/frontend-practice/css/practice.css` | Appended ~190 lines Codebox 23 CSS |

---

## Key Design Decisions

- **Status = 'cancelled' as soft delete** — unlike communications.js (which uses `cancelled_at`), this module uses `request_status = 'cancelled'` since "cancelled" is a meaningful domain value. GET queries use `.neq('request_status', 'cancelled')`.
- **Waive vs Cancel** — `waive` = intentional business decision (doc not needed); `cancel` = request made in error. Both tracked.
- **`verifyRequestOwnership` returns full row** — saves a second DB round-trip in `PUT /:id/reminder-sent` which needs `existing.reminder_count`.
- **Checklist items auto-sort_order** — backend fetches current max + 1 when sort_order not specified.
- **Checklist panel lazy-load** — same pattern as reminders suggestions. Panel hidden by default; fires load on first toggle.
- **Route collision prevention** — `/summary` and `/checklists/*` defined before `/:id`. All 3-segment PUTs before 2-segment `PUT /:id`.
- **`?client_id=X` URL support** — pre-selects client in filter on page load.
- **client-detail.js uses Response-object pattern** — `await res.json()` to match existing code style.

---

## What Was NOT Changed

- Paytime — zero files modified
- Auth / JWT / middleware — unchanged
- Communications module — unchanged
- Any existing API endpoints — additions only

---

## Testing Required

**Step 1 — Apply migration:**
Run `accounting-ecosystem/backend/config/migrations/073_practice_document_requests.sql` in Supabase.
Expected: "Success. No rows returned."

**Step 2 — Restart server** (picks up new document-requests router)

**Step 3 — Smoke tests:**
- `/practice/document-requests.html` loads, summary shows 0s
- Create a request → appears in list
- Mark received → status updates, summary decrements
- Log reminder → status=reminder_sent, count badge shows
- Create a request with required_by_date = yesterday → overdue highlighting appears
- Waive a request → status=waived, excluded from outstanding count
- Delete a request → disappears from list
- Create checklist, add items via API or UI, apply to client → N requests created
- Client detail Section 16 shows outstanding requests
- Inline add doc modal works

**Step 4 — Rule D check:**
DevTools → Application → Local Storage → no `docreq_` or `doc_` keys.

---

## Open Follow-Up Items

| Item | Priority |
|------|----------|
| Checklist item management UI in browser (add/edit/reorder items) | Medium |
| View modal shows `related_task_id` etc. as bare numbers | Low |
| Bulk mark-received (checkbox multi-select) | Low |
| Export outstanding requests as PDF for client | Medium — future codebox |

---

## Recommended Next Session

**Codebox 24 — Annual Compliance Pack + Client Year-End Readiness**

With documents tracked, the practice can score completeness:
- Per-client readiness score for VAT / Payroll / AFS / Tax
- Document received/outstanding count per engagement
- Year-end readiness dashboard across all clients
- Integration with deadlines (is this client ready to file?)
