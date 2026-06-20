# SESSION HANDOFF — Codebox 15: Engagement → Workflow Generation

**Date:** 2026-06-20  
**Status:** Code complete — apply migration 066 in Supabase before using  
**Do not commit or push until cloud verification is complete**

---

## What Was Changed

### `backend/config/migrations/066_practice_engagement_workflow_generation.sql` — NEW
Extends 4 existing tables:

- `practice_client_engagements`: `last_generated_at`, `last_generated_workflow_run_id`, `last_generated_deadline_id`, `generation_count`
- `practice_workflow_runs`: `engagement_id`, `service_id`, `generation_source`
- `practice_deadlines`: `engagement_id`, `service_id`
- `practice_tasks`: `engagement_id`, `service_id`
- 5 partial indexes (all WHERE NOT NULL)

Migration uses `ADD COLUMN IF NOT EXISTS` throughout — safe to re-run.

---

### `backend/modules/practice/services/workflowService.js` — MODIFIED
`createRunAndGenerateTasks()` enhanced with 3 new optional params:

```javascript
engagement_id     = null,   // passed into run, tasks, deadline rows
service_id        = null,   // passed into run, tasks, deadline rows
generation_source = null    // stored on workflow_run only
```

Spread-injected conditionally using `...(x != null ? { x: parseInt(x) } : {})` — backward compatible, existing callers unaffected.

Three edit locations:
1. Function signature (new params after `source_type`)
2. `runRow` object (3 spread conditions after `period_end`)
3. Task map return object (2 spread conditions after `qa_status`)
4. `deadlineRow` object (2 spread conditions after `created_by`)

---

### `backend/modules/practice/engagements.js` — MODIFIED
Added `workflowService` require (line 20):
```javascript
const workflowService = require('./services/workflowService');
```

Added 2 new routes before `module.exports`:

**`GET /engagements/:id/generation-preview`**
- Fetches engagement, client, workflow template, and step count
- Returns preview payload including `can_generate`, `will_create_deadline`, `expected_task_count`
- Read-only — no writes

**`POST /engagements/:id/generate-workflow`**
- Full multi-tenant validation (engagement → client → service → template all verified against `req.companyId`)
- Calls `workflowService.createRunAndGenerateTasks()` with `engagement_id`, `service_id`, `generation_source = 'engagement'`
- Updates engagement tracking fields (`last_generated_at`, `last_generated_workflow_run_id`, `last_generated_deadline_id`, `generation_count`)
- Logs `workflow_generated_from_engagement` event (non-fatal)
- Logs `workflow_generation_failed` event on catch (non-fatal)
- Propagates partial-failure `warning` from workflowService if deadline creation failed

---

### `backend/frontend-practice/client-detail.html` — MODIFIED
Added `#generateWorkflowModal` before `<div class="toast">`:

Modal structure:
- `#genPreviewLoading` — spinner shown while preview fetch is in flight
- `#genPreviewError` — shown if preview fetch fails
- `#genPreviewContent` — info panel + form (revealed after preview loads)
  - `#genPreviewPanel` / `#genPreviewInfo` — template name, task count, compliance area etc.
  - `#generateWorkflowForm` — anchor date, due date, period start/end, deadline checkbox + title, notes
  - `#genSubmitBtn` — disabled until `can_generate === true`
- `#genResultPanel` — replaces form on success

---

### `backend/frontend-practice/js/client-detail.js` — MODIFIED

**1. `ENG_EVENT_LABELS` — 2 new entries added:**
```javascript
workflow_generated_from_engagement: 'Workflow Generated',
workflow_generation_failed:         'Workflow Generation Failed'
```

**2. `renderEngagements()` — new button added to card actions:**
```javascript
(e.status === 'active' && e.workflow_template_id
  ? '<button ... onclick="openGenerateModal(' + e.id + ')">⚡ Generate</button>'
  : '')
```
Appears only for active engagements with a linked workflow template.

**3. New module-level variables:**
- `_generateEngagementId` — which engagement is being generated for
- `_generatePreviewData` — cached preview response (runtime only, never localStorage)

**4. New functions (5 total), all exposed via `window.*`:**

| Function | Lines added before "Expose globals" |
|---|---|
| `openGenerateModal(engId)` | Resets state, fetches preview, opens modal |
| `_renderGeneratePreview(d)` | Renders info panel from preview response |
| `toggleGenDeadlineTitle()` | Show/hide deadline title field on checkbox toggle |
| `closeGenerateModal()` | Removes `.show` from modal overlay |
| `submitGenerateWorkflow(e)` | POST generate, shows result panel, refreshes list |

**5. Window exposures added:**
```javascript
window.openGenerateModal      = openGenerateModal;
window.closeGenerateModal     = closeGenerateModal;
window.submitGenerateWorkflow = submitGenerateWorkflow;
window.toggleGenDeadlineTitle = toggleGenDeadlineTitle;
```

---

### `docs/new-app/15_engagement_to_workflow_generation.md` — NEW
Full architecture doc including generation flow, validation rules, traceability schema, API reference, localStorage audit, multi-tenant safety, manual-only limitation, future scheduler readiness, migration verification SQL, and manual test steps.

---

## What Was NOT Changed

- All Codebox 14 routes (service catalog, engagement CRUD, history): unchanged
- All Codebox 11–13 billing routes: unchanged
- All other client detail sections (contacts, compliance suggestions): unchanged
- `practice.css`: no new rules needed (modal reuses existing classes)
- `layout.js`: no changes (no new nav item for this codebox)
- `services.html` / `js/services.js`: no changes
- `workflows.html` / `js/workflows.js`: no changes
- Payroll module: not touched
- No cron or scheduler built

---

## Migration Must Be Applied Before Use

Migration 066 is **NOT yet applied** to Supabase. The code will fail at runtime if used before the migration is applied:

- The `generate-workflow` endpoint will fail when trying to UPDATE `last_generated_at` on `practice_client_engagements` (column does not yet exist)
- `workflowService.createRunAndGenerateTasks()` will fail when inserting `engagement_id` into `practice_workflow_runs`

**Apply migration 066 in Supabase SQL Editor before testing or deploying.**

---

## Audit Findings

### localStorage — CLEAN
- `_generateEngagementId` and `_generatePreviewData` are JavaScript runtime variables — not browser storage
- No generation payload, run IDs, task counts, or deadline IDs written to localStorage, sessionStorage, or KV

### Multi-tenant safety — VERIFIED
- `fetchEngagement()` always checks `company_id = req.companyId`
- Client, service catalog, and template each verified with `.eq('company_id', req.companyId)` before use
- `engagement_id` written to all rows sourced from `eng.id` (already company-verified), never from request body

### Existing behaviour preserved
- `createRunAndGenerateTasks()` backward compatible — all 3 new params default to null
- Existing callers (`/workflows/:templateId/generate` etc.) pass no `engagement_id` → columns stay null
- `renderEngagements()` — only new line is the Generate button; all existing button logic unchanged
- Engagement history modal renders the 2 new event types with correct labels

---

## Supabase Migration SQL (apply in order)

```sql
-- Run in Supabase SQL Editor
-- 066_practice_engagement_workflow_generation.sql
-- See full SQL at: accounting-ecosystem/backend/config/migrations/066_practice_engagement_workflow_generation.sql
```

Verification after applying:
```sql
-- Expect 12 rows
SELECT table_name, column_name FROM information_schema.columns
WHERE table_name IN (
  'practice_client_engagements','practice_workflow_runs',
  'practice_deadlines','practice_tasks'
)
AND column_name IN (
  'last_generated_at','last_generated_workflow_run_id','last_generated_deadline_id',
  'generation_count','engagement_id','service_id','generation_source'
)
ORDER BY table_name, column_name;

-- Expect 5 rows
SELECT indexname, tablename FROM pg_indexes
WHERE indexname IN (
  'idx_engagements_last_run','idx_pwr_engagement_id','idx_pwr_service_id',
  'idx_pd_engagement_id','idx_pt_engagement_id'
)
ORDER BY tablename;
```

---

## Testing Steps

1. Apply migration 066 in Supabase SQL Editor
2. Run verification SQL above — expect 12 columns, 5 indexes
3. Restart local backend (`npm run dev`)
4. Open a client that has an active engagement with `workflow_template_id` set
5. Confirm "⚡ Generate" button appears on that card
6. Confirm button does NOT appear on paused, ended, or cancelled engagements
7. Confirm button does NOT appear on engagements with no `workflow_template_id`
8. Click "⚡ Generate" → loading spinner → preview panel appears
9. Preview shows: template name, expected task count, last generated (Never), `can_generate: true`
10. If template has `creates_compliance_deadline: true` → checkbox pre-checked, deadline title field visible
11. Submit without dates → 201 response → result panel: task count, run ID
12. Close modal → engagement card still shows; re-open → preview shows "Last generated: today (1 runs total)"
13. Open Supabase → `practice_workflow_runs` → new row: `engagement_id` = correct ID, `generation_source = 'engagement'`
14. `practice_tasks` → all generated tasks have `engagement_id`
15. Click History on engagement → "Workflow Generated" event visible
16. Test deadline: check "Create Compliance Deadline", add due date → submit → `practice_deadlines` new row with `engagement_id`
17. Test error: check deadline checkbox, leave due date blank, template has no offset → expect 400 "due_date is required"
18. DevTools → Application → Local Storage → no engagement or generation data

---

## Remaining Risks

- `generation_count` increment is best-effort (not transactional with the workflow generation) — under concurrent requests it may be off by one (acceptable audit counter, not financial)
- Engagement tracking update failures silently return 201 — the workflow was generated but `last_generated_at` may not update
- No direct navigation link in the result panel to the generated workflow run or tasks — user must go to Workflows/Tasks pages manually
- History modal does not render `metadata.task_count` or `metadata.workflow_run_id` from the event — future enhancement
- `workflow_template_id` not FK-constrained at DB level — invalid IDs fail gracefully in workflowService with a descriptive error

---

## Recommended Codebox 16

**Engagement Recurrence Rules + Manual Period Queue**

After manual generation works, users need to know: *what periods are coming up for each engagement, and which ones haven't been generated yet?*

Codebox 16 should add:
- A per-engagement recurrence rule (monthly, quarterly, annual, custom) stored on `practice_client_engagements`
- A lightweight period queue table (`practice_engagement_periods`) — computed periods (2026-07, 2026-08, etc.) with status: pending / generated / skipped
- A queue view in the client detail page: upcoming periods with a "Generate" button per row
- No cron — the queue is pre-populated by the user or auto-derived from recurrence rules on demand

This closes the loop between the engagement/service agreement layer and the workflow execution layer, enabling full recurring engagement management without requiring automation infrastructure.
