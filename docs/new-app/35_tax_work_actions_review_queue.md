# Codebox 35 — Tax Work Follow-Up Actions + Review Queue Controls

**Module:** Lorenco Practice Management  
**Date:** June 2026  
**Status:** Complete

---

## Purpose

Turn the Tax Dashboard (CB34) from visibility into action. CB35 adds:

- A **follow-up action tracking system** (`practice_tax_work_actions` table)
- A **review queue** panel on the Tax Dashboard showing all `ready_for_review` items
- An **action creation modal** triggered from Tax Dashboard risk panels
- A **standalone Tax Actions page** (`/practice/tax-actions.html`) for managing all actions

This is NOT tax calculation. NOT SARS/eFiling integration. NOT automation. NOT Sean AI. Purely operational follow-up tracking.

---

## What Was Built

### Migration: `084_practice_tax_work_actions.sql`

Two tables:

**`practice_tax_work_actions`**  
Stores follow-up actions created from tax dashboard risk items.

| Field | Purpose |
|---|---|
| `company_id` | Multi-tenant isolation |
| `client_id` | Optional link to practice client |
| `source_type` | What kind of tax item triggered this action |
| `source_id` | ID of the source row |
| `action_type` | Category of action (create_task, assign_reviewer, etc.) |
| `action_title` | Human-readable description |
| `action_status` | open → in_progress → completed / dismissed / cancelled |
| `assigned_team_member_id` | Who should action this |
| `due_date` | Optional deadline |
| `linked_task_id` | Set when a practice_task is created |
| `linked_document_request_id` | Set when a doc request is created |
| `linked_review_pack_id` | Set when a review pack is linked |

**`practice_tax_work_action_events`**  
Append-only audit log. Every status change, creation, and execution is recorded.

---

### Backend: `tax-actions.js`

12 endpoints mounted at `/api/practice/tax-actions`:

| Route | Purpose |
|---|---|
| `GET /review-queue` | 7-parallel-query fetch of all ready_for_review items across all tax tables |
| `POST /from-dashboard-risk` | Create action from a risk panel item (validates source ownership) |
| `POST /:id/create-task` | Creates a `practice_tasks` row and links it to the action |
| `POST /:id/create-document-request` | Creates a `practice_document_requests` row and links it |
| `POST /:id/assign-reviewer` | Sets `reviewer_team_member_id` on the source return/plan |
| `POST /:id/mark-ready-review` | Sets status to `ready_for_review` on the source table |
| `PUT /:id/complete` | Marks action completed, logs event |
| `PUT /:id/dismiss` | Marks action dismissed, logs event |
| `GET /` | List with filters (source_type, action_status, assigned_team_member_id, client_id, due_from, due_to, page, limit) |
| `POST /` | Create action directly |
| `PUT /:id` | Update action fields |
| `DELETE /:id` | Soft cancel |

**Route ordering:** Literal routes (`/review-queue`, `/from-dashboard-risk`) registered before `/:id`. Three-segment routes (`/:id/create-task`, `/:id/complete`) registered before two-segment (`/:id`). This prevents Express from matching literal paths as `:id` parameters.

**Source types supported:**
`individual_return`, `company_return`, `provisional_plan`, `individual_calculation`, `company_calculation`, `individual_review_pack`, `company_review_pack`, `compliance_deadline`, `document_request`, `tax_dashboard_risk`

**Action types supported:**
`create_task`, `assign_owner`, `assign_reviewer`, `request_document`, `generate_review_pack`, `run_calculation`, `submit_for_review`, `general_followup`

---

### Tax Dashboard Enhancements (`tax-dashboard.html` + `tax-dashboard.js`)

**Review Queue Panel** — shows all work items currently in `ready_for_review` status across individual returns, company returns, provisional plans, calculations, and review packs. Filterable by source type and reviewer.

**Action Creation Modal** — triggered by `+ Action` buttons on risk panel rows. Pre-fills source type, source ID, client ID, and a suggested title from the risk item. Posts to `POST /api/practice/tax-actions/from-dashboard-risk`.

**Risk row action buttons** — each risk item in the overdue deadlines, blocked returns, provisional periods due, and calc warning panels now has a `+ Action` button and an `Open →` link. Uses `data-stype`, `data-sid`, `data-cid`, `data-title` attributes to avoid inline-onclick quoting issues.

**Backend: `client_id` added to risk responses** — the `/risk` endpoint now includes `client_id` in overdue deadlines, blocked individual returns, and blocked company returns, so the action modal can pass it through to the API.

---

### Standalone Tax Actions Page (`tax-actions.html` + `tax-actions.js`)

Simple CRUD list of all tax actions for the company. Features:
- Filter by status, source type, assignee, due date range
- Inline Complete / Dismiss buttons per action
- Pagination (50 per page)
- No localStorage — all data from `/api/practice/tax-actions`

---

### Router Mount (`index.js`)

```js
const taxActionsRouter = require('./tax-actions');
router.use('/tax-actions', taxActionsRouter);
```

### Navigation (`layout.js`)

```js
{ key: 'tax-actions', label: 'Tax Actions', href: '/practice/tax-actions.html' }
```
Placed after Tax Dashboard in the nav.

---

## Data Flow

```
Tax Dashboard risk panel
        ↓
User clicks "+ Action" button
        ↓
tdOpenActionModal(sourceType, sourceId, clientId, title)
        ↓
User fills modal → tdSubmitAction()
        ↓
POST /api/practice/tax-actions/from-dashboard-risk
        ↓
Backend: validates source ownership, inserts practice_tax_work_actions row
        ↓
Logs tax_action_created event to practice_tax_work_action_events
        ↓
Action visible on /practice/tax-actions.html
```

---

## Multi-Tenant Safety

Every query is scoped by `req.companyId` from the JWT. The `/from-dashboard-risk` endpoint verifies that the source item (`source_type` + `source_id`) belongs to `req.companyId` before creating the action. No cross-company data leakage is possible.

---

## What This Is NOT

- Not a SARS integration
- Not eFiling automation
- Not a cron-based scheduler
- Not Sean AI
- Not tax calculation

Actions are manually created by practice staff in response to risk signals from the Tax Dashboard.

---

## Migration Required

Run `084_practice_tax_work_actions.sql` in Supabase SQL Editor before using CB35 features.

Expected result: `Success. No rows returned`

---

## Files Changed / Created

| File | Change |
|---|---|
| `backend/config/migrations/084_practice_tax_work_actions.sql` | NEW — two tables + 10 indexes |
| `backend/modules/practice/tax-actions.js` | NEW — 12 endpoints |
| `backend/modules/practice/tax-dashboard.js` | MODIFIED — `client_id` added to risk SELECT queries |
| `backend/modules/practice/index.js` | MODIFIED — mounts taxActionsRouter |
| `backend/frontend-practice/tax-dashboard.html` | MODIFIED — Review Queue panel + Action Modal HTML + CSS + accessibility fixes |
| `backend/frontend-practice/js/tax-dashboard.js` | REWRITTEN — adds `_loadReviewQueue()`, `tdOpenActionModal()`, `tdCloseActionModal()`, `tdSubmitAction()`, `tdRiskActionBtn()`, risk row action buttons |
| `backend/frontend-practice/tax-actions.html` | NEW — standalone actions list page |
| `backend/frontend-practice/js/tax-actions.js` | NEW — standalone page IIFE JS |
| `backend/frontend-practice/js/layout.js` | MODIFIED — Tax Actions nav entry added |
