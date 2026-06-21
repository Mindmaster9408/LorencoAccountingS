# Codebox 23 — Document Request Tracker + Client Document Checklist Foundation

**App:** Lorenco Practice Management  
**Codebox:** 23 of ±80  
**Status:** Complete — migration 073 pending application  
**Date:** 2026-06-20

---

## Purpose

Structured document request tracking. The practice can now formally request documents from clients, track their status, log reminders, apply reusable checklist templates, and see outstanding/overdue requests per client.

**Not built:** No file storage. No OCR. No SharePoint integration. Tracking only.

---

## What Was Built

### Database — migration 073

**Table 1: `practice_document_requests`**

| Field | Type | Notes |
|-------|------|-------|
| `request_title` | TEXT NOT NULL | What is being requested |
| `document_category` | TEXT NOT NULL | From enum (identity, tax, vat, payroll, etc.) |
| `document_type` | TEXT NULL | Free-text specific label (e.g. "VAT201 Return") |
| `request_status` | TEXT DEFAULT 'requested' | requested / reminder_sent / partially_received / received / waived / cancelled |
| `requested_at` | TIMESTAMPTZ | When the request was created |
| `required_by_date` | DATE NULL | When client must provide it |
| `received_at` | TIMESTAMPTZ NULL | Stamped when status→received |
| `reminder_count` | INTEGER DEFAULT 0 | Incremented on each reminder-sent call |
| `last_reminder_at` | TIMESTAMPTZ NULL | When last reminder was logged |
| `related_workflow_run_id` | BIGINT NULL | Reference-only, no FK |
| `related_task_id` | INTEGER NULL | Reference-only, no FK |
| `related_deadline_id` | INTEGER NULL | Reference-only, no FK |
| `related_engagement_id` | INTEGER NULL | Reference-only, no FK |
| `related_communication_id` | INTEGER NULL | Reference-only, no FK |

14 indexes including partial indexes for the most common query patterns.

**Table 2: `practice_document_checklists`** — reusable template sets per company.

**Table 3: `practice_document_checklist_items`** — line items per checklist. Denormalized `company_id` for fast scoped queries without joins.

### Overdue Detection (no cron)

`is_overdue` is computed in `enrichRequest()`:
```javascript
const isOverdue = OUTSTANDING_STATUSES.includes(r.request_status) &&
    r.required_by_date &&
    r.required_by_date < today;
return { ...r, is_overdue: isOverdue };
```
`request_status` in DB stays `'requested'` or `'reminder_sent'` — no stored `overdue` value.

### Soft Cancel

`DELETE /:id` sets `request_status = 'cancelled'`. All `GET` queries exclude `request_status = 'cancelled'` via `.neq('request_status', 'cancelled')`. Rows are never physically deleted.

### Backend Endpoints (`backend/modules/practice/document-requests.js`)

Mounted at `/api/practice/document-requests`.

**Route ordering:**
1. `GET /summary` — literal, FIRST
2. All `/checklists/*` literals — before `/:id`
3. `GET /`, `POST /` — list + create
4. `GET /:id` — single
5. `PUT /:id/received`, `PUT /:id/reminder-sent`, `PUT /:id/waive` — 3-segment BEFORE `PUT /:id`
6. `PUT /:id` — generic update, LAST
7. `DELETE /:id` — soft cancel

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/summary` | Aggregate: total_active, outstanding, overdue, received, due_this_week, reminders_sent |
| GET | `/checklists` | List active checklists |
| POST | `/checklists` | Create checklist |
| GET | `/checklists/:id/items` | List items for checklist |
| POST | `/checklists/:id/items` | Add item to checklist |
| PUT | `/checklists/:id/items/:itemId` | Update item |
| DELETE | `/checklists/:id/items/:itemId` | Delete item |
| POST | `/checklists/:id/apply` | Apply checklist to client — creates N document requests |
| GET | `/checklists/:id` | Single checklist with items |
| PUT | `/checklists/:id` | Update checklist |
| DELETE | `/checklists/:id` | Deactivate checklist |
| GET | `/` | List requests (filters: status, category, client, assignee, overdue_only, search) |
| POST | `/` | Create request — parallel ownership verification for all 6 optional linked fields |
| GET | `/:id` | Single request |
| PUT | `/:id/received` | Mark received, stamps `received_at` |
| PUT | `/:id/reminder-sent` | Increment `reminder_count`, set `last_reminder_at`, status→reminder_sent |
| PUT | `/:id/waive` | Status→waived (intentional decision, tracked separately from cancel) |
| PUT | `/:id` | Generic field update |
| DELETE | `/:id` | Soft cancel: `request_status = 'cancelled'` |

### `GET /` — Status Filter

The `status` query param accepts both exact values (`requested`, `received`, etc.) and the pseudo-value `outstanding`, which maps to `IN ('requested', 'reminder_sent', 'partially_received')`.

### Checklist Apply Flow

`POST /checklists/:id/apply` with `{ client_id, required_by_date? }`:
1. Verifies checklist is active and belongs to company
2. Verifies client belongs to company
3. Fetches all items ordered by `sort_order`
4. Bulk inserts N `practice_document_requests` rows (one per item)
5. Sets `notes = "Applied from checklist: [name]"` on each created request
6. Returns `{ created: N, document_requests: [...] }`

### Waive vs Cancel

| Action | Meaning | Status set to |
|--------|---------|---------------|
| `PUT /:id/waive` | Document no longer needed — business decision, intentional | `waived` |
| `DELETE /:id` | Request made in error or voided — administrative | `cancelled` |

Both are tracked. Waived requests appear in the list (status=waived); cancelled requests are fully excluded.

### Multi-Tenant Safety

- `req.companyId` from JWT on all queries; never accepted from request body
- `verifyBelongsToCompany(cid, table, id)` — generic helper used for all 6 optional linked fields via `Promise.all` on POST
- `verifyRequestOwnership(cid, reqId)` — fetches record scoped to company, excludes cancelled, returns full row for inline use
- Text search is post-fetch server-side (no n+1 risk at current scale)

### Frontend (`document-requests.html` + `js/document-requests.js`)

**IIFE module pattern.** No business data in localStorage (Rule D compliant).

**Page structure:**
- 5 summary cards: Total Active, Outstanding, Overdue, Due This Week, Received
- Filter toolbar: Status (with "Outstanding" shorthand), Category, Client, Search
- Checklist panel (lazy-loaded on toggle — same pattern as reminders suggestions)
  - Grid of checklist cards with "Apply to Client" button each
  - "New Checklist" button → create checklist modal
- Requests table: Category badge, Title+Type, Client, Required By, Status badge + reminder count, Actions
- Row actions: ✓ Received, 🔔 Reminder, View
- Create Request modal: Client, Category, Assignee, Required By, Title, Doc Type, Notes
- View modal: full detail + Mark Received, Reminder Sent, Waive, Delete buttons
- Apply Checklist modal: Client picker + Required By Date (applied to all items)
- Create Checklist modal: Name, Category, Description

**`?client_id=X` URL param:** Pre-selects client in the filter dropdown on page load.

### Client Detail Section 16 (`client-detail.html` + `js/client-detail.js`)

Added Section 16 "Document Requests" after Section 15 "Communication History":
- Shows up to 10 outstanding requests (excludes received, waived, cancelled)
- Each row: Title, Category + due date, Status badge, ✓ quick-receive button
- Overdue rows highlighted with `.docreq-row--overdue`
- "+ Request Document" → `addDocModal` (lightweight inline modal)
- "View All →" link → `/practice/document-requests.html?client_id=X`

**`addDocModal` fields:** Category (required), Assigned To, Title (required), Doc Type, Required By Date. Assignee picker populated from `/api/practice/team` on each open.

**Functions added to `client-detail.js`:**
- `loadClientDocumentRequests()` — GET with `client_id` filter, excludes terminal statuses
- `renderDocRequestHistory(reqs)` — mini timeline
- `openAddDocModal()` — async, fetches team, shows modal
- `closeAddDocModal()`
- `submitAddDoc()` — POST with double-submit guard
- `cdDocMarkReceived(id)` — PUT received inline

**`loadClient()` updated:**
- Reveals `#docRequestsSection`
- Sets `#docReqViewAllLink.href`
- Calls `loadClientDocumentRequests()`

### Nav + Quick Access

- `layout.js` — "Documents" added as 17th nav tab
- `index.html` dashboard — `📄 Documents` quick-action link added

### CSS (`practice.css`)

Appended ~190 lines: `.docreq-summary`, `.docreq-card`, `.docreq-card--*`, `.docreq-toolbar`, `.docreq-search`, `.docreq-checklist-*`, `.docreq-cl-*`, `.docreq-table`, `.col-dr*`, `.docreq-cat-badge`, `.docreq-status-badge`, `.drs-*`, `.docreq-rem-count`, `.docreq-overdue-tag`, `.docreq-apply-desc`, `.cd-docreq-section`, `.doc-hist-*`, responsive breakpoints.

---

## Audit Logging

| Event | Trigger |
|-------|---------|
| `document_requested` | `POST /` |
| `document_received` | `PUT /:id/received` |
| `document_reminder_sent` | `PUT /:id/reminder-sent` |
| `document_waived` | `PUT /:id/waive` |
| `document_request_cancelled` | `DELETE /:id` |
| `checklist_applied` | `POST /checklists/:id/apply` |

---

## Testing Checklist

- [ ] Run migration 073 — "Success. No rows returned"
- [ ] Restart server to load document-requests router
- [ ] `/practice/document-requests.html` — 5 summary cards show 0s
- [ ] Create request: Client, Category=VAT, Title="VAT201 June 2026" → appears in list
- [ ] Filter by Status=Requested → only that request shown
- [ ] Filter by Category=VAT → filtered correctly
- [ ] Click ✓ → status changes to Received, summary updates
- [ ] Create another request with Required By Date = yesterday → `is_overdue: true` → row highlighted red
- [ ] Click 🔔 → status changes to Reminder Sent, reminder_count=1 badge shown
- [ ] Click View → full detail modal, Mark Received / Waive / Delete buttons
- [ ] Waive → status=waived, removed from outstanding count
- [ ] Delete → request disappears from list
- [ ] Create checklist: Name="Monthly VAT Pack", Category=VAT
- [ ] Toggle checklist panel → checklist card appears
- [ ] Apply checklist to a client → N request records created, confirm count
- [ ] `/practice/document-requests.html?client_id=5` → client pre-selected in filter
- [ ] Open client detail page → Section 16 visible
- [ ] "+Request Document" inline modal → submit → appears in Section 16
- [ ] ✓ quick-receive on Section 16 row → request disappears from outstanding list
- [ ] No document data in localStorage (Rule D)
- [ ] Switch company → no cross-company data

---

## Architecture Notes

**No FK on `related_*` fields:** Document requests are historical records. If a linked task/deadline/engagement is deleted, the request row survives with a stale reference.

**Status vs cancel field:** This module uses `request_status = 'cancelled'` for soft delete (unlike communications.js which uses `cancelled_at TIMESTAMPTZ`). This is intentional — `cancelled` is a meaningful status value listed in the business domain. The GET list excludes it via `.neq('request_status', 'cancelled')`.

**`verifyRequestOwnership` returns the full row:** Unlike `verifyBelongsToCompany` which returns boolean, `verifyRequestOwnership` returns the full row (or null). This lets `PUT /:id/reminder-sent` read `existing.reminder_count` without a second DB round-trip.

**Checklist items sort_order auto-increment:** When adding items without specifying `sort_order`, the backend fetches the current max and adds 1. This avoids gaps and maintains intuitive ordering.

---

## Follow-Up Notes

| Item | Priority |
|------|----------|
| Checklist item management UI (add/edit/delete items from a checklist in the browser) | Medium — currently only via API; a checklist editor UI would allow practice to maintain their own templates |
| `related_*` fields shown as bare IDs in view modal (not linked to source records) | Low |
| `visibility` field on checklists not implemented | Low — currently all checklists visible to whole practice |
| Bulk mark-received (select multiple rows) | Low |
| Export outstanding requests to CSV/PDF for client handout | Medium — future codebox candidate |

---

## Recommended Codebox 24

**Annual Compliance Pack + Client Year-End Readiness Foundation**

With documents tracked, the practice can build completeness scoring:
- Per-client readiness score for VAT / Payroll / AFS / Tax Return
- Checklist of required documents + received/outstanding count
- Year-end readiness dashboard across all clients
- Structured pack assembly (which documents have been received for this period)
- Integration with deadlines (is this client ready to file?)
