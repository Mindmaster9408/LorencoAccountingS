# CODEBOX 15 — ENGAGEMENT → WORKFLOW GENERATION

**App:** Lorenco Practice Management  
**Codebox:** 15 of ±80  
**Date:** June 2026  
**Status:** Code complete — apply migration 066 in Supabase before using

---

## 1. Summary

Codebox 15 connects the engagement layer (Codebox 14) to the workflow engine (Codeboxes 06–09). A user can open a client engagement, preview what will be generated, and manually trigger a workflow run complete with tasks and an optional compliance deadline — all traceable back to the originating engagement.

**What was built:**

- Migration 066: 4 tables extended (12 new columns, 5 new indexes)
- `workflowService.js` enhanced: accepts `engagement_id`, `service_id`, `generation_source`
- `engagements.js` two new routes: `GET /generation-preview` and `POST /generate-workflow`
- `client-detail.html`: `#generateWorkflowModal` added (preview panel + form + result panel)
- `client-detail.js`: 5 new functions, "⚡ Generate" button on active engagement cards, 4 new window exposures

**What was NOT built (per spec):**

- No cron or scheduled automation
- No invoice generation
- No Accounting integration
- No Sean AI
- No auto-generation on page load — user must click Generate

---

## 2. Generation Architecture

```
User clicks "⚡ Generate" on engagement card
        ↓
GET /api/practice/engagements/:id/generation-preview
        ↓
Modal shows: template name, expected tasks, compliance area,
             deadline type, last generated date
        ↓
User fills in: anchor date, period start/end, due date, deadline flag, notes
        ↓
POST /api/practice/engagements/:id/generate-workflow
        ↓
    [Multi-tenant validation]
    engagement.company_id == req.companyId
    client.company_id     == req.companyId
    service.company_id    == req.companyId  (if linked)
    template.company_id   == req.companyId
        ↓
    workflowService.createRunAndGenerateTasks()
    → practice_workflow_runs  (with engagement_id, service_id, generation_source='engagement')
    → practice_workflow_run_steps  (snapshot of template steps)
    → practice_tasks  (one per step, with engagement_id, service_id)
    → practice_deadlines (optional, with engagement_id, service_id)
        ↓
    UPDATE practice_client_engagements
    SET last_generated_at, last_generated_workflow_run_id,
        last_generated_deadline_id, generation_count = count + 1
        ↓
    INSERT practice_client_engagement_events
    event_type = 'workflow_generated_from_engagement'
        ↓
Result: { workflow_run_id, task_count, deadline_id, generation_count }
        ↓
UI: success panel shown, engagement list refreshed
```

---

## 3. Database Changes (migration 066)

### `practice_client_engagements` — 4 new columns

| Column | Type | Purpose |
|---|---|---|
| `last_generated_at` | TIMESTAMPTZ null | Timestamp of most recent successful generation |
| `last_generated_workflow_run_id` | BIGINT null | FK ref to last generated workflow run |
| `last_generated_deadline_id` | INTEGER null | FK ref to last generated deadline (if any) |
| `generation_count` | INTEGER NOT NULL DEFAULT 0 | Running count of how many times generated |

Index: `idx_engagements_last_run` on `last_generated_workflow_run_id WHERE NOT NULL`

### `practice_workflow_runs` — 3 new columns

| Column | Type | Purpose |
|---|---|---|
| `engagement_id` | INTEGER null | Which engagement triggered this run |
| `service_id` | INTEGER null | Which service catalog entry is linked |
| `generation_source` | TEXT null | Origin context: manual / engagement / workflow_template / future_scheduler |

Indexes: `idx_pwr_engagement_id`, `idx_pwr_service_id` (both partial WHERE NOT NULL)

### `practice_deadlines` — 2 new columns

| Column | Type | Purpose |
|---|---|---|
| `engagement_id` | INTEGER null | Which engagement this deadline was generated from |
| `service_id` | INTEGER null | Which service catalog entry is linked |

Index: `idx_pd_engagement_id` (partial WHERE NOT NULL)

### `practice_tasks` — 2 new columns

| Column | Type | Purpose |
|---|---|---|
| `engagement_id` | INTEGER null | Which engagement these tasks were generated from |
| `service_id` | INTEGER null | Which service catalog entry is linked |

Index: `idx_pt_engagement_id` (partial WHERE NOT NULL)

**Total new objects:** 12 columns, 5 indexes across 4 tables.

---

## 4. Engagement → Workflow → Deadline → Task Traceability

After a successful generation:

```
practice_client_engagements
  └─ id = 42
       last_generated_workflow_run_id = 7
       last_generated_deadline_id     = 3
       generation_count               = 1

practice_workflow_runs
  └─ id = 7
       engagement_id      = 42
       service_id         = 5   (if linked via service_catalog_id)
       generation_source  = 'engagement'
       client_id          = 19
       template_id        = 2

practice_deadlines
  └─ id = 3
       engagement_id    = 42
       service_id       = 5
       workflow_run_id  = 7
       client_id        = 19

practice_tasks (N rows, one per template step)
  └─ engagement_id    = 42
     service_id       = 5
     workflow_run_id  = 7
     deadline_id      = 3
     client_id        = 19
```

This traceability chain allows future reporting: "show me all workflow runs, tasks, and deadlines generated from engagement X" via a simple `WHERE engagement_id = :id`.

---

## 5. Backend API Endpoints

### GET `/api/practice/engagements/:id/generation-preview`

**Purpose:** Read-only preview before committing to generation. No data is written.

**Response:**
```json
{
  "engagement":           { "id", "engagement_name", "service_category", "status",
                            "workflow_template_id", "last_generated_at", "generation_count" },
  "client":               { "id", "name", "client_type" },
  "template":             { "id", "name", "creates_compliance_deadline",
                            "default_compliance_area", "default_deadline_type",
                            "default_deadline_title", "default_deadline_offset_days" },
  "expected_task_count":  4,
  "will_create_deadline": true,
  "compliance_area":      "vat",
  "deadline_type":        "vat201",
  "can_generate":         true
}
```

**`can_generate` is false when:**
- Engagement is not active
- `workflow_template_id` is not set
- Template not found or belongs to different company

---

### POST `/api/practice/engagements/:id/generate-workflow`

**Purpose:** Execute the generation. Calls `workflowService.createRunAndGenerateTasks()`.

**Payload (all optional):**

| Field | Type | Purpose |
|---|---|---|
| `anchor_date` | DATE string | Anchor for task due-date offset calculation |
| `period_start` | DATE string | Compliance period start |
| `period_end` | DATE string | Compliance period end |
| `due_date` | DATE string | Deadline due date (required if creating deadline with no template offset) |
| `create_deadline` | boolean | Override template's `creates_compliance_deadline` setting |
| `deadline_title` | string | Override template's default deadline title |
| `notes` | string | Recorded in engagement event log |

**Response (201):**
```json
{
  "success":          true,
  "workflow_run_id":  7,
  "task_count":       4,
  "deadline_id":      3,
  "generation_count": 1,
  "warning":          null
}
```

**`warning` is set (non-null) when:** workflow + tasks were created successfully but deadline creation failed. The run and tasks are preserved; the warning describes what failed. This is the partial-failure path from `workflowService`.

**Error codes:**

| Condition | HTTP status |
|---|---|
| Engagement not found / wrong company | 404 |
| Engagement not active | 409 |
| No workflow_template_id | 400 |
| Client not found / wrong company | 404 |
| due_date missing when required for deadline | 400 |
| Invalid compliance_area / deadline_type | 400 |
| Template not found or wrong company | 500 (caught in workflowService) |
| DB write failure | 500 |

---

## 6. workflowService.js Enhancement

`createRunAndGenerateTasks()` now accepts three additional optional parameters:

```javascript
{
  engagement_id:     null,   // INTEGER — passed to run, tasks, deadline rows
  service_id:        null,   // INTEGER — passed to run, tasks, deadline rows
  generation_source: null    // TEXT — stored on the workflow_run row only
}
```

These are spread-injected conditionally (only when non-null) to avoid writing undefined/null into columns that may not exist on older databases:

```javascript
...(engagement_id != null ? { engagement_id: parseInt(engagement_id) } : {}),
...(service_id    != null ? { service_id:    parseInt(service_id) }    : {}),
```

**Backward compatibility:** All existing callers of `createRunAndGenerateTasks()` that do not pass these params continue to work unchanged. The new params default to `null` in the destructured signature.

---

## 7. Frontend Changes

### New: `⚡ Generate` button on engagement cards

Appears only when:
- `e.status === 'active'`
- `e.workflow_template_id` is set (template is linked)

Rendered as `btn-primary` to distinguish it from the ghost action buttons.

### New: `#generateWorkflowModal`

**Three states:**
1. **Loading** — shown while `generation-preview` fetch is in flight
2. **Preview + form** — info panel (read-only) + date/deadline fields
3. **Result panel** — replaces form on success; shows run ID, task count, deadline ID

**Key behaviours:**
- Submit button is disabled until preview loads successfully and `can_generate === true`
- Double-submit prevented: button disabled immediately on click
- `Create Compliance Deadline` checkbox pre-checked when `will_create_deadline === true` from template
- `Deadline Title` field shown/hidden by checkbox (`toggleGenDeadlineTitle()`)
- On success: form replaced by result panel, engagement list refreshed, toast shown
- On error: button re-enabled, error toast shown — user can correct and retry

### New functions (all via `window.*`):

| Function | Purpose |
|---|---|
| `openGenerateModal(engId)` | Fetch preview, reset + open modal |
| `closeGenerateModal()` | Hide modal |
| `submitGenerateWorkflow(e)` | POST generate, show result |
| `toggleGenDeadlineTitle()` | Show/hide deadline title field |

### New event labels added to `ENG_EVENT_LABELS`:

- `workflow_generated_from_engagement` → `'Workflow Generated'`
- `workflow_generation_failed` → `'Workflow Generation Failed'`

These now appear correctly in the engagement History modal.

---

## 8. Validation Rules

| Condition | Enforced at |
|---|---|
| Engagement must belong to `req.companyId` | Backend via `fetchEngagement()` |
| Engagement must be `status = 'active'` | Backend — 409 if not |
| `workflow_template_id` must be set | Backend — 400 if missing |
| Client must belong to `req.companyId` | Backend — Supabase query with `eq('company_id', req.companyId)` |
| Service catalog entry (if linked) must belong to `req.companyId` | Backend |
| Template must belong to `req.companyId` | `workflowService` — throws if not found |
| `due_date` required when creating deadline with no template offset | `workflowService` — 400 |
| `period_start` must be ≤ `period_end` | `workflowService` — 400 |
| Valid `compliance_area` and `deadline_type` values | `workflowService` — 400 |
| `generation_count` always server-computed | Never trusted from body |
| `engagement_id` in all DB writes always from `eng.id` | Never trusted from body |

---

## 9. Manual-Only Limitation

**This is manual generation only. There is no cron, no auto-trigger, no scheduler.**

- `auto_create_workflow` on the engagement/catalog is stored but never executed
- Nothing runs automatically on page load or schedule
- The only way to generate is: user opens modal → fills form → submits

The `generation_source = 'engagement'` column and the `future_scheduler` allowed value exist to support a future scheduler without schema changes. That scheduler does not exist yet.

---

## 10. localStorage / KV Audit

**CLEAN — no violations.**

| Location | Usage | Permitted? |
|---|---|---|
| `openGenerateModal()` | `_generateEngagementId` — JS runtime variable only | N/A (not browser storage) |
| `_generatePreviewData` | JS runtime variable only | N/A |
| All generation payload and results | Via `PracticeAPI.fetch()` — no localStorage | Compliant |
| Preview data | Fetched from API on each modal open — not cached in storage | Compliant |

No engagement names, workflow run IDs, task counts, or deadline IDs ever touch browser storage.

---

## 11. Multi-Tenant Safety Review

| Check | How verified |
|---|---|
| Engagement ownership | `fetchEngagement(req.companyId, id)` — returns null if wrong company |
| Client ownership | `.eq('company_id', req.companyId)` on practice_clients select |
| Service catalog ownership | `.eq('company_id', req.companyId)` on practice_service_catalog select |
| Template ownership | `workflowService` queries `practice_workflow_templates` with `company_id = req.companyId` |
| Deadline creation | `workflowService` inserts `company_id = req.companyId` |
| Task creation | `workflowService` inserts `company_id = req.companyId` on every task |
| Engagement update | `eq('company_id', req.companyId)` on UPDATE |
| Event log | Inserts `company_id` from `req.companyId` — never from body |
| `engagement_id` in run/tasks/deadline | Sourced from `eng.id` (already company-verified) — never from body |

---

## 12. Partial-Failure Handling

**workflowService** handles deadline creation failure gracefully: if the run and tasks were inserted successfully but the deadline INSERT fails, it returns `{ run, tasks, deadline: null, warning: '...' }` instead of throwing.

The generate-workflow route propagates this: the 201 response includes a non-null `warning` field with the failure message. The frontend shows the warning in the result panel so the user knows to create the deadline manually.

**Engagement tracking update** (last_generated_at, generation_count) is best-effort — if it fails, the generation was still successful and the response is 201.

**Event logging** is non-fatal (wrapped in `logEngagementEvent`'s try/catch).

---

## 13. Future Scheduler Readiness

The schema is ready for a future non-cron manual period queue (Codebox 16) or a full scheduler:

- `generation_source` TEXT column can hold: `manual`, `engagement`, `workflow_template`, `future_scheduler`
- `engagement_id` on all generated rows enables "show all runs for this engagement"
- `generation_count` enables "generate #5 for this engagement" audit trail
- `last_generated_at` enables "last generated X days ago" — useful for queue prioritisation

The scheduler will call `workflowService.createRunAndGenerateTasks()` with `generation_source = 'future_scheduler'` and the same engagement traceability fields. No schema changes required.

---

## 14. Migration Verification SQL

Apply migration 066 in Supabase SQL editor, then run:

```sql
-- 1. Confirm all new columns exist (expect 12 rows)
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name IN (
  'practice_client_engagements',
  'practice_workflow_runs',
  'practice_deadlines',
  'practice_tasks'
)
  AND column_name IN (
    'last_generated_at', 'last_generated_workflow_run_id', 'last_generated_deadline_id',
    'generation_count', 'engagement_id', 'service_id', 'generation_source'
  )
ORDER BY table_name, column_name;

-- 2. Confirm all 5 indexes exist
SELECT indexname, tablename FROM pg_indexes
WHERE indexname IN (
  'idx_engagements_last_run',
  'idx_pwr_engagement_id', 'idx_pwr_service_id',
  'idx_pd_engagement_id',
  'idx_pt_engagement_id'
)
ORDER BY tablename, indexname;
```

---

## 15. Manual Tests

1. Apply migration 066 in Supabase SQL editor
2. Verify with SQL above — expect 12 columns, 5 indexes
3. Restart backend server — verify no require errors
4. Navigate to a client with an active engagement that has `workflow_template_id` set
5. Confirm "⚡ Generate" button appears on that card (and NOT on paused/ended cards)
6. Click "⚡ Generate" — modal opens in loading state, then preview appears
7. Preview shows: template name, expected task count, last generated info, compliance area
8. If template has `creates_compliance_deadline = true` → checkbox pre-ticked
9. Submit without anchor date → tasks created with due dates based on today
10. Check `practice_workflow_runs` — new row with `engagement_id` = engagement ID, `generation_source = 'engagement'`
11. Check `practice_tasks` — all tasks have `engagement_id` = engagement ID
12. Engagement card refreshes — `last_generated_at` now shown on preview
13. Generate again — `generation_count` increments to 2 on next preview open
14. Test with `create_deadline = true` + `due_date` → verify deadline row has `engagement_id`
15. Test with `create_deadline = true` + NO `due_date` + template has no offset → expect 400 error with clear message
16. Verify no `engagement_id` data in DevTools localStorage

---

## 16. Remaining Risks

- `generation_count` read from DB at request time — under concurrent requests for the same engagement the count could be off by one (acceptable for an audit counter; not a financial field)
- Engagement tracking update (generation_count etc.) is best-effort — a DB failure there returns 201 but with stale tracking data; the actual generation succeeded
- `workflow_template_id` on the engagement is not validated as a FK at the DB level (documented risk from Codebox 14) — an invalid template ID fails gracefully in workflowService with a 404-style error
- No UI link to navigate directly to the generated workflow run or tasks — user must navigate to Workflows / Tasks pages to find them by run ID; future: add clickable link
- History modal shows "Workflow Generated" event but does not render `metadata.task_count` or `metadata.workflow_run_id` inline — future: enrich event display
