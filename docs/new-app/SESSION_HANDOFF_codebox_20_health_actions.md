# Session Handoff — Codebox 20: Client Health Actions

**Date:** 2026-06-20  
**Codeboxes in this session:** 19 (completed prior) + 20  
**Status:** Complete — not committed or pushed (per spec)  

---

## What Was Changed

### New Files

| File | Purpose |
|------|---------|
| `accounting-ecosystem/backend/config/migrations/070_practice_client_health_actions.sql` | `practice_client_health_actions` table + 7 indexes |
| `docs/new-app/20_client_health_actions.md` | Feature documentation |

### Modified Files

| File | What Changed |
|------|-------------|
| `accounting-ecosystem/backend/modules/practice/client-health.js` | Added 7 action endpoints + 4 helper functions (verifyClient, verifyAction, verifyTeamMemberLocal, RISK_TO_ACTION_TYPE map) |
| `accounting-ecosystem/backend/frontend-practice/client-health.html` | Added action quick-form + follow-up actions list section to health detail modal |
| `accounting-ecosystem/backend/frontend-practice/js/client-health.js` | Added `_teamMembers`/`_actionSubmitting` state; `loadTeamMembers`, `buildAssigneeOptions`, `loadClientActions`, `renderActionsList`, `openActionForm`, `openManualActionForm`, `cancelActionForm`, `submitActionForm`, `completeAction`, `dismissAction`; enhanced `renderHdModal` risk section; reset in `openHdModal` |
| `accounting-ecosystem/backend/frontend-practice/css/practice.css` | Added all action-related CSS classes |

---

## What Was NOT Changed

- Any Paytime file — untouched
- Any auth or middleware — untouched
- Any existing health scoring logic — untouched
- `client-detail.html` / `client-detail.js` — untouched (health card from Codebox 19 preserved)
- Route ordering: `GET /actions/summary` is 2-segment, no conflict with 1-segment `GET /:clientId`

---

## Required Before Testing

1. **Run migration 070** in Supabase SQL Editor  
   File: `accounting-ecosystem/backend/config/migrations/070_practice_client_health_actions.sql`  
   Expected: "Success. No rows returned"

2. **Restart the server** to pick up the new routes in `client-health.js`

3. **Recalculate client health** first so risk factors appear in the modal

---

## Architecture Notes

**Task creation flow** (`from-risk` + `create_task`):
```
POST /:clientId/actions/from-risk
  { risk_code, preferred_action_type: 'create_task', action_title, ... }
  ↓
  INSERT INTO practice_tasks (company_id, client_id, title, type='general', ...)
  → linked_task_id = task.id
  ↓
  INSERT INTO practice_client_health_actions (..., linked_task_id)
  ↓
  auditFromReq × 2 (task created + action created)
  ↓
  201 { action, linked_task_id }
```

**Route safety** — all action routes are multi-segment and do not conflict with the existing single-segment `GET /:clientId`:
- `/actions/summary` — 2 segments, literal first
- `/:clientId/actions` — 2 segments, wildcard first  
- `/:clientId/actions/from-risk` — 3 segments
- `/actions/:id/complete` — 3 segments (defined before 2-segment generic PUT)
- `/actions/:id/dismiss` — 3 segments
- `/actions/:id` — 2 segments generic

**Double-submit guard**: `_actionSubmitting` flag set to `true` on submit, reset on success or error. Button also disabled during request.

**Team members cache**: Loaded once at `init()` into `_teamMembers[]`. Assignee picker is rebuilt from this cache on each `openHdModal` / `openActionForm` call. No API call per modal open.

---

## Open Items / Follow-Ups

| Item | Impact |
|------|--------|
| `linked_deadline_id`, `linked_period_id`, `linked_billing_pack_id` schema fields exist but no UI sets them | Low — reserved for future direct linking |
| `GET /actions/summary` implemented but not on dashboard | Low — add a count card to dashboard in a future codebox |
| Write-off % is approximated from billing pack values | Low — tracked in Codebox 19 follow-ups |

---

## Recommended Codebox 21

**Practice Notifications + Reminder Center Foundation**

Central `/practice/reminders.html` surfacing:
- Health actions with due_date < today (overdue)
- Deadlines due in next 7/14/30 days across all clients
- Review tasks waiting > N days
- WIP packs older than 30 days
- Queued periods past period_start

Single prioritised view so the practice manager starts each day knowing exactly what needs attention.
