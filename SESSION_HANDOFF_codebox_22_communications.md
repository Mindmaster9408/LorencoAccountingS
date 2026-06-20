# Session Handoff — Codebox 22: Client Communication Log
**Date:** 2026-06-20  
**Branch:** main  
**Status:** Complete — do not commit or push until migration 072 is applied and tested

---

## What Was Built

Codebox 22 adds a manual communication history to the practice management system. The practice can now log calls, email notes, WhatsApp notes, meetings, document requests, SARS/CIPC/billing follow-ups, and internal notes — with response tracking and follow-up creation (reminder or task).

**Not built (by design):** No email sending, no WhatsApp integration, no Gmail/Outlook, no Sean AI, no cron automation.

---

## Files Created

| File | Purpose |
|------|---------|
| `accounting-ecosystem/backend/config/migrations/072_practice_client_communication_log.sql` | `practice_client_communications` table, 13 indexes |
| `accounting-ecosystem/backend/modules/practice/communications.js` | 10 endpoints, multi-tenant safe, overdue computed in enrichComm() |
| `accounting-ecosystem/backend/frontend-practice/communications.html` | Full communications page: summary cards, filter toolbar, table, log modal, view modal |
| `accounting-ecosystem/backend/frontend-practice/js/communications.js` | IIFE frontend module, no localStorage |
| `docs/new-app/22_client_communication_log.md` | Full architecture reference |

---

## Files Modified

| File | What Changed |
|------|-------------|
| `accounting-ecosystem/backend/modules/practice/index.js` | Added `require('./communications')` and `router.use('/communications', communicationsRouter)` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Communications" as 16th nav tab |
| `accounting-ecosystem/backend/frontend-practice/index.html` | Added `💬 Communications` quick-action button |
| `accounting-ecosystem/backend/frontend-practice/client-detail.html` | Added Section 15 "Communication History" div + `addCommModal` (lightweight inline modal) before engagement modal |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Added 7 communication functions + 5 window exports; updated `loadClient()` to reveal communicationsSection and call `loadClientCommunications()` |
| `accounting-ecosystem/backend/frontend-practice/css/practice.css` | Appended ~190 lines of Codebox 22 CSS — communication cards, badges, table columns, view modal layout, client-detail mini-history, `addCommModal` styles |

---

## Root Causes Fixed / Key Decisions

- **Overdue without cron:** `response_status` stays `'waiting'` in DB. Backend `enrichComm()` computes `effective_response_status = 'overdue'` when `response_due_date < today`. No scheduled job needed.
- **No FK on linked fields:** `related_task_id`, `related_deadline_id`, `related_engagement_id`, `related_reminder_id`, `related_health_action_id` are reference-only. Communications are historical records — they survive even if the linked task/deadline is deleted.
- **Soft delete:** `cancelled_at TIMESTAMPTZ NULL`. `GET /` excludes cancelled records. `GET /:id` returns them. Never physically deleted.
- **Route ordering:** `GET /summary` defined before `GET /:id`; all `PUT /:id/verb` before `PUT /:id` — same discipline as reminders.js.
- **client-detail.js pattern:** Functions added use `await PracticeAPI.fetch(...); await res.json()` to match the existing older pattern in that file (not the auto-parsed pattern used in newer IIFE pages).
- **-webkit-user-select added** on `.comm-checkbox-label` for Safari 3+ support (linter fix).

---

## What Was NOT Changed

- **Existing client-detail sections 1–14** — health, contacts, engagements untouched.
- **Paytime** — zero files modified.
- **Auth / JWT / middleware** — unchanged.
- **Any existing API routes** — no modifications to existing endpoints; only new routes added.

---

## Testing Required Before Push

**Step 1 — Apply migration:**
Run `accounting-ecosystem/backend/config/migrations/072_practice_client_communication_log.sql` in Supabase.  
Expected: "Success. No rows returned."

**Step 2 — Restart server** to pick up the new communications router.

**Step 3 — Smoke tests:**
- `/practice/communications.html` loads, 5 summary cards show `0`
- Log a Call → appears in list
- Log a Document Request with response required → status "Waiting"
- Mark as Received → status updates
- View modal opens, "Create Reminder" and "Create Task" work
- Delete → soft cancelled, disappears from list
- Client detail page: Section 15 visible, last 10 comms shown
- `+ Log Communication` in client detail → modal opens, submit works
- Filter by type, direction, response status all work
- Company switching → no cross-company data

**Step 4 — Rule D check:**
Open DevTools → Application → Local Storage → confirm no `practice_` or `comm_` keys written.

---

## Open Follow-Up Items

| Item | Priority |
|------|----------|
| View modal shows `related_task_id` as a bare ID, not a hyperlink to the task | Low |
| Full create modal has no pick-list for related task/deadline/engagement (user must know IDs) | Low |
| `visibility: manager_only / partner_only` stored but not enforced in GET endpoint | Low |
| Client history shows last 10 only — no pagination in client detail | Low (View All link works around it) |

---

## Recommended Next Session

**Codebox 23 — Document Request Tracker + Client Document Checklist**

The practice now logs communications (including document requests), but has no structured way to track what documents were requested, what arrived, and what is still missing. Codebox 23 should build:
- Per-client document checklist (VAT, AFS, payroll, SARS, etc.)
- Document request records (what asked, when, by whom, due date)
- Document received tracking (what came in, when, who uploaded note)
- Outstanding document view across all clients
- Bulk document request templates (pre-built sets for common engagements)
- Linked to deadlines, engagements, tax year, communications
