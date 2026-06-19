# CODEBOX 08 — WORKFLOW-TO-DEADLINE LINKING

**App:** Lorenco Practice Management
**Codebox:** 08 of ±80
**Date:** June 2026
**Status:** Complete — migration 059 not yet applied (user must run in Supabase)

---

## 1. Summary

Codebox 08 connects the Workflow Templates system (Codebox 06) to the Compliance Deadline Engine (Codebox 07). Workflow runs and compliance deadlines were previously separate and unlinked. After this codebox:

- A workflow template can carry default compliance metadata (area, type, due-date offset)
- Generating a workflow can optionally create a linked compliance deadline in the same request
- Every generated task is linked to both its workflow run and its deadline via typed FK columns
- Existing deadlines can be manually linked to or unlinked from a run at any time
- The `workflow-template.html` editor has been fully rebuilt with correct asset paths and a compliance defaults section
- The `workflows.html` generate modal now includes full deadline creation fields pre-filled from template defaults

**What was NOT built (excluded by CLAUDE.md permanent rules):**
- Cron/scheduler for automatic deadline generation
- SARS or CIPC API integrations
- Tax calculations
- Sean AI integrations
- Cross-app integrations beyond Practice Management

---

## 2. Database Changes (migration 059)

**File:** `backend/config/migrations/059_practice_workflow_deadline_linking.sql`
**Run after:** Migration 058 (Codebox 07)
**Safe to re-run:** All `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` — no data loss, no drops

### A. `practice_workflow_templates` — 7 new columns

| Column | Type | Purpose |
|---|---|---|
| `creates_compliance_deadline` | BOOLEAN DEFAULT FALSE | Whether generating this template should create a deadline |
| `default_compliance_area` | TEXT | Pre-fill compliance area on generate |
| `default_deadline_type` | TEXT | Pre-fill deadline type on generate |
| `default_deadline_title` | TEXT | Default deadline title (falls back to template name) |
| `default_deadline_priority` | TEXT | Default priority for generated deadlines |
| `default_deadline_offset_days` | INTEGER | Days from anchor date to auto-calculate due_date |
| `default_deadline_offset_basis` | TEXT | Basis for offset: anchor_date / period_start / period_end / financial_year_end / tax_year_end |

Index: `idx_pwt_creates_deadline` on `creates_compliance_deadline = TRUE`

### B. `practice_workflow_runs` — 6 new columns

| Column | Type | Purpose |
|---|---|---|
| `client_id` | INTEGER FK → practice_clients | Fixed bug: client_id was accepted but never persisted |
| `deadline_id` | INTEGER FK → practice_deadlines | Reverse link to the linked deadline |
| `compliance_area` | TEXT | Compliance area snapshotted at generation |
| `deadline_type` | TEXT | Deadline type snapshotted at generation |
| `period_start` | DATE | Period start snapshotted at generation |
| `period_end` | DATE | Period end snapshotted at generation |

Indexes: `idx_pwr_client_id`, `idx_pwr_deadline_id`, `idx_pwr_compliance_area`, `idx_pwr_deadline_type`

### C. `practice_tasks` — 2 new columns

| Column | Type | Purpose |
|---|---|---|
| `deadline_id` | INTEGER FK → practice_deadlines | Direct typed FK to linked compliance deadline |
| `workflow_run_id` | BIGINT FK → practice_workflow_runs | Direct typed FK to the run that generated this task (replaces loose source_id coupling) |

`workflow_run_id` is BIGINT (not INTEGER) because `practice_workflow_runs.id` is BIGSERIAL/BIGINT.

Indexes: `idx_pt_deadline_id`, `idx_pt_workflow_run_id`

---

## 3. Existing FK note

`practice_deadlines.workflow_run_id` and `practice_deadlines.task_id` were added in migration 058.
Migration 059 does NOT re-add them. It only adds the reverse link (`practice_workflow_runs.deadline_id`)
and the task-level columns.

---

## 4. Backend Changes

### `services/workflowService.js` — Full rewrite

**Added:**
- `TEMPLATE_ALLOWED_FIELDS` whitelist → `sanitizeTemplateBody()` prevents unexpected column writes
- Compliance enum constants: `COMPLIANCE_AREAS`, `DEADLINE_TYPE_EXTENDED`, `DEADLINE_PRIORITIES`, `OFFSET_BASIS_VALUES`
- `createRunAndGenerateTasks` extended with 10 new optional params:
  `create_deadline`, `deadline_title`, `compliance_area`, `deadline_type`,
  `period_start`, `period_end`, `due_date`, `priority`,
  `responsible_team_member_id`, `reviewer_team_member_id`

**Deadline creation logic in `createRunAndGenerateTasks`:**

```
Determine shouldCreateDeadline:
  ├── create_deadline === true → yes
  ├── create_deadline === false → no
  └── neither supplied + template.creates_compliance_deadline = true → yes

Resolve due_date:
  ├── provided in params → use it
  ├── not provided + template.default_deadline_offset_days set → anchor_date + offset_days
  └── neither → throw 400-style error

Execution order:
  1. Create practice_workflow_runs (with client_id, compliance context)
  2. Snapshot steps → practice_workflow_run_steps
  3. Insert practice_tasks (with workflow_run_id)
  4. If shouldCreateDeadline:
      a. Create practice_deadlines (with workflow_run_id)
      b. UPDATE practice_workflow_runs SET deadline_id = new deadline id
      c. UPDATE practice_tasks SET deadline_id = new deadline id (batch)
      d. INSERT practice_deadline_events (event_type = 'created', source = 'workflow_generate')
  5. Return { run, tasks, deadline }

Failure handling:
  - Run steps or task insert failures → clean up run and run_steps, re-throw
  - Deadline creation failure → return { run, tasks, deadline: null, warning: "..." }
    (run and tasks are preserved — user is warned, not silently failed)
```

### `modules/practice/workflows.js` — Enhanced

**Updated endpoints:**

| Method | Path | Change |
|---|---|---|
| POST | `/generate` | Now passes all 10 deadline params to service; dual-audit logs (run + deadline if created); returns `deadline` in response; `warning` in response if deadline failed |

**New endpoints:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/runs/:id/deadline` | Fetch the compliance deadline linked to a run |
| PUT | `/runs/:id/link-deadline` | Link an existing deadline to a run (updates both sides; validates ownership; cannot link cancelled deadline) |
| PUT | `/runs/:id/unlink-deadline` | Remove the link (clears both sides; only clears back-link if it still points to this run; logs `workflow_unlinked` event) |

---

## 5. Frontend Changes

### `workflow-template.html` — Complete rewrite

Previous state: Broken. Used `/css/site.css`, `/js/auth.js`, `/js/layout.js` — all wrong paths. Missing `#app-topbar`, `#app-nav`, `#toast`.

New state: Full dark-native Practice Management layout with:
- `#app-topbar`, `#app-nav`, `#toast`
- All scripts from `/practice/js/`
- Correct stylesheet `/practice/css/practice.css`
- **Basic Info section** — name, category, priority, description
- **Compliance Deadline Defaults section** — toggle checkbox + 7 compliance fields (hidden until checked)
- **Steps section** (hidden until template saved with ID) — card list with ↑/↓ reorder, Edit/Delete buttons per step
- **Add/Edit Step modal** — title, description, due_offset_days, priority

### `js/workflow-editor.js` — Full rewrite

Previous bugs fixed:
- `LAYOUT.init('tasks')` → `LAYOUT.init('workflows')`
- `card`, `card-body`, `card-title` CSS classes replaced with practice.css-native classes
- `openNewTemplate` was undefined (now defined in workflows.js where it belongs)
- Inline form injection replaced with proper `#stepModal` dialog
- `editStep` re-fetched all steps to find one — now uses same pattern but opens modal

New features:
- `populateForm(t)` — fills all fields from template object including 7 compliance defaults
- `toggleDeadlineDefaults()` — shows/hides compliance fields when checkbox toggled
- `saveTemplate()` — sends all 7 compliance default fields; redirects to edit URL after create
- Step modal with Add + Edit modes via `_editingStepId` state
- Debounced reorder via `sendReorder()` (700ms delay, locks controls during save)
- Overlay click closes step modal

### `workflows.html` — Enhanced generate modal

Added:
- `<div id="toast"></div>`
- Generate modal expanded with deadline creation fields:
  - Toggle checkbox "Create a compliance deadline for this workflow"
  - Deadline title, compliance area, deadline type
  - Period start, period end, due date
  - Priority, responsible team member
- Template defaults info banner (`#tplDefaultsNote`)
- Compliance category badges on template cards

### `js/workflows.js` — Enhanced

Previous bugs fixed:
- `openNewTemplate()` was not defined → now defined (navigates to workflow-template.html with no ID)
- Modal open/close used `.classList.add('show')` — preserved (matches practice.css `.modal-overlay.show`)

New features:
- `loadTeamMembers()` — populates responsible team member dropdown
- `renderTemplates()` — shows compliance badges (Creates Deadline / area / category)
- `openGenerateModal(templateId)` — finds template in `_templates` cache; pre-fills compliance defaults; auto-ticks checkbox if `creates_compliance_deadline = true`; shows template defaults banner
- `toggleDeadlineSection()` — shows/hides deadline fields; shows/hides due date required asterisk
- `submitGenerate()` — sends all deadline params; validates due_date if required; shows task count + "compliance deadline" in success toast; shows warning if deadline creation partially failed

---

## 6. Validation and Error Handling

### Backend validation in `workflowService.js`

- `compliance_area` must be in `COMPLIANCE_AREAS` if provided
- `deadline_type` must be in `DEADLINE_TYPE_EXTENDED` if provided
- `priority` must be in `DEADLINE_PRIORITIES` (defaults to 'normal')
- `period_start ≤ period_end` if both provided
- `due_date` required when creating deadline unless `template.default_deadline_offset_days` is set
- `create_deadline = false` explicitly suppresses deadline even if template defaults it on

### Frontend validation in `submitGenerate()`

- If creating deadline and no `due_date` entered and template has no offset → blocks submit with toast
- Disables submit button during API call to prevent double-submit

### `PUT /runs/:id/link-deadline` validation

- Run must exist and belong to `req.companyId`
- Deadline must exist and belong to `req.companyId`
- Deadline must not be cancelled (`is_active = true`)

---

## 7. Multi-Tenant Safety Review

All new routes and service methods are scoped by `req.companyId`:

- Every Supabase query uses `.eq('company_id', req.companyId)`
- `company_id` is never accepted from request body — always sourced from JWT
- FK ownership verified before linking: run and deadline must both belong to same company
- Back-link clear on unlink uses `.eq('workflow_run_id', runId)` guard — prevents clearing a deadline's workflow link if it has since been re-linked to a different run

**localStorage/browser storage audit: CLEAN — no violations in any new code.**

---

## 8. Audit Trail

| Event | audit_log | practice_deadline_events |
|---|---|---|
| Workflow run generated (no deadline) | ✅ CREATE practice_workflow_run | — |
| Workflow run generated (with deadline) | ✅ CREATE practice_workflow_run + CREATE practice_deadline | ✅ `created` (source: workflow_generate) |
| Deadline manually linked to run | ✅ UPDATE practice_workflow_run | ✅ `workflow_linked` |
| Deadline manually unlinked from run | ✅ UPDATE practice_workflow_run | ✅ `workflow_unlinked` |

---

## 9. Manual Verification Checklist

1. Run migration 059 in Supabase SQL Editor
2. Confirm verification query returns all expected columns
3. Restart the backend server
4. Open `/practice/workflows.html`
   - Confirm page loads (correct nav highlighting on Workflows tab)
   - Confirm `+ New Template` button navigates to `workflow-template.html` (no JS error)
   - Confirm "Generate" button on existing templates opens the generate modal
5. Open Generate modal on a template with `creates_compliance_deadline = false`
   - Confirm deadline checkbox is unchecked
   - Confirm deadline fields are hidden
   - Tick checkbox → confirm fields appear
   - Generate without deadline → confirm toast shows task count only
6. Open a template with `creates_compliance_deadline = true` and compliance defaults set
   - Confirm checkbox is pre-ticked, fields are visible and pre-filled
   - Confirm info banner shows offset note
   - Enter a due date → generate → confirm toast shows "X tasks + compliance deadline"
   - Confirm deadline appears in `/practice/compliance.html` calendar
7. Open `GET /api/practice/workflows/runs/:id/deadline` for the new run → confirm deadline returned
8. Open `/practice/workflow-template.html` (no id) — confirm editor loads (not broken path)
   - Confirm page title "New Workflow Template"
   - Compliance Deadline Defaults section present, hidden by default
   - Tick "auto-create" checkbox → confirm compliance fields appear
   - Fill in name → click "Create Template" → confirm redirect to `?id=...`
   - Confirm compliance defaults saved (reload page, check fields populated)
9. On loaded template editor → add a step → confirm step appears in list
   - Move step ↑/↓ → confirm reorder toast after 700ms
   - Edit step → confirm modal pre-fills → save
   - Delete step → confirm removed from list
10. Test `PUT /runs/:id/link-deadline` with valid IDs → confirm both sides updated
11. Test `PUT /runs/:id/unlink-deadline` → confirm both sides cleared
12. Confirm no business data in browser localStorage (DevTools → Application → Local Storage)

---

## 10. Risks and Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Tasks page / runs view
- Dependency: practice_tasks.workflow_run_id typed FK column (migration 059)
- What was done now: tasks table gets workflow_run_id populated at generate time
- What still needs to be checked: Tasks list page does not yet display which workflow run or deadline a task belongs to
- Risk if not checked: Low (data is persisted correctly; display is missing only)
- Recommended next review point: Codebox 09 — Tasks enhancement
```

```
FOLLOW-UP NOTE
- Area: Compliance calendar (compliance.html)
- Dependency: practice_deadlines.workflow_run_id
- What was done now: Deadlines created from workflow generate carry workflow_run_id
- What still needs to be checked: Compliance calendar does not yet show a "has workflow" indicator on deadlines
- Risk if not checked: Low — data is correct, visual indicator is missing only
- Recommended next review point: Codebox 10 — Compliance calendar enhancement
```

```
FOLLOW-UP NOTE
- Area: PUT /runs/:id/link-deadline
- Dependency: practice_deadlines.reviewer_team_member_id
- What was done now: reviewer_team_member_id not exposed in generate modal (only responsible)
- What still needs to be checked: Reviewer is accepted by service but not surfaced in UI
- Risk if not checked: Low — field exists in DB and API; UI gap only
- Recommended next review point: Add reviewer select to generate modal if needed
```

---

## 11. Files Changed

| File | Action |
|---|---|
| `backend/config/migrations/059_practice_workflow_deadline_linking.sql` | NEW — DB migration |
| `backend/modules/practice/services/workflowService.js` | REWRITTEN — full deadline creation + sanitizer |
| `backend/modules/practice/workflows.js` | ENHANCED — generate params + 3 new run/deadline endpoints |
| `backend/frontend-practice/workflow-template.html` | REWRITTEN — correct paths + compliance section |
| `backend/frontend-practice/js/workflow-editor.js` | REWRITTEN — fixed nav + modal UX + compliance fields |
| `backend/frontend-practice/workflows.html` | ENHANCED — toast + expanded generate modal |
| `backend/frontend-practice/js/workflows.js` | ENHANCED — openNewTemplate + deadline fields + template defaults |
