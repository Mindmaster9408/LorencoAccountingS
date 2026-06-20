# Session Handoff — Codebox 21: Practice Reminder Center

**Date:** 2026-06-20  
**Codeboxes in this session:** 21  
**Status:** Complete — not committed or pushed (per spec)

---

## What Was Changed

### New Files

| File | Purpose |
|------|---------|
| `accounting-ecosystem/backend/config/migrations/071_practice_reminder_center.sql` | `practice_reminders` table + 10 indexes |
| `accounting-ecosystem/backend/modules/practice/reminders.js` | Full reminders module — 10 endpoints incl. suggestions engine |
| `accounting-ecosystem/backend/frontend-practice/reminders.html` | Reminder center page |
| `accounting-ecosystem/backend/frontend-practice/js/reminders.js` | IIFE frontend module |
| `docs/new-app/21_practice_reminder_center.md` | Feature documentation |
| `docs/new-app/SESSION_HANDOFF_codebox_21_reminders.md` | This file |

### Modified Files

| File | What Changed |
|------|-------------|
| `accounting-ecosystem/backend/modules/practice/index.js` | Added `const remindersRouter = require('./reminders')` + `router.use('/reminders', remindersRouter)` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added 15th nav tab: `{ key: 'reminders', label: 'Reminders', href: '/practice/reminders.html' }` |
| `accounting-ecosystem/backend/frontend-practice/index.html` | Added `🔔 Reminders` quick-action button |
| `accounting-ecosystem/backend/frontend-practice/css/practice.css` | Appended all reminder CSS classes (summary cards, toolbar, table, severity dots, type/status badges, suggestion panel, snooze quick-buttons, responsive) |

---

## What Was NOT Changed

- Any Paytime file — untouched
- Any auth or middleware — untouched
- Any existing health scoring logic — untouched
- Any client-health codebox 20 code — untouched
- Route ordering in index.js: `remindersRouter` mounted between `clientHealthRouter` and `dashboardRouter` — no conflicts

---

## Route Ordering Safety

Inside `reminders.js`:
1. `GET /summary` — literal, before `/:id`
2. `GET /suggestions` — literal, before `/:id`
3. `GET /` — list
4. `POST /create-from-suggestion` — literal, before `/:id`
5. `POST /` — create
6. `PUT /:id/snooze` — 3-segment, before 2-segment PUT `/:id`
7. `PUT /:id/complete` — 3-segment
8. `PUT /:id/dismiss` — 3-segment
9. `PUT /:id` — 2-segment generic
10. `DELETE /:id`

No wildcard conflicts possible in this ordering.

---

## Required Before Testing

1. **Run migration 071** in Supabase SQL Editor  
   File: `accounting-ecosystem/backend/config/migrations/071_practice_reminder_center.sql`  
   Expected: "Success. No rows returned"

2. **Restart the server** to pick up the new `reminders` router in `index.js`

---

## Architecture Notes

**Suggestions engine** (`GET /suggestions`): 10 parallel Supabase queries. Panel is collapsed by default and loads only when the user clicks "💡 Suggestions". This avoids an expensive 10-query call on every page load.

**Duplicate prevention**: Before adding a suggestion to the response, the engine checks:
- DB dedup set (existing open/snoozed reminders with same `source_type:source_id:reminder_type`)
- Local `addedKeys` set (prevents the same engagement from producing two `engagement_setup` suggestions in a single response)

**Soft delete**: `DELETE /:id` → `status = 'cancelled'`. Rows are never physically removed.

**No FK on source_id**: Reference-only. Source records (deadlines, tasks, etc.) can be deleted without cascading to the reminders table.

**capacity_is_active** (from migration 068): Capacity warning suggestions use `capacity_is_active = true` to match the capacity page filter. Members with `capacity_is_active = false` are excluded from overload suggestions.

---

## Open Items / Follow-Ups

| Item | Impact |
|------|--------|
| No "re-open" button to unsnooze a reminder back to `open` | Low — users can complete/dismiss; add Re-open in future if needed |
| Suggestion panel shows client_id-based names only if `_clients` loaded successfully | Low — if clients fail to load, "Client X" fallback shown |
| `action_url` on suggestions are list pages, not deep links to specific records | Low — adequate; deep linking can be added later |
| Suggestions are capped at 200/100 rows per category | Low — adequate for current scale |

---

## Recommended Codebox 22

**Compliance Automation — SARS Calendar Intelligence**

Build on the deadline and reminder infrastructure to add:
- Auto-populate SARS statutory deadlines for the current tax year per client
- Configurable lead-time warnings (30/14/7 days before)
- Bulk deadline creation for the whole practice from SARS calendar templates
- Link compliance calendar entries to `practice_deadlines` and `practice_reminders`
