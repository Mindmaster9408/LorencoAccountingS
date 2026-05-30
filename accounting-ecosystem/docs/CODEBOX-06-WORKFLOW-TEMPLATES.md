# Codebox 06 — Workflow Templates

Status: UI + backend generation implemented; migration `057_practice_workflow_templates.sql` already applied in Supabase (DO NOT re-run).

Overview

- Purpose: workflow templates allow practice teams to define repeatable task flows and generate task runs for clients or ad-hoc.

- Multi-tenant: all tables and API calls require `company_id` (scoped from JWT / `req.companyId`).

Key DB tables (created by migration 057):

- `practice_workflow_templates`
- `practice_workflow_template_steps`
- `practice_workflow_runs`
- `practice_workflow_run_steps`
- `practice_tasks` (existing table — generation writes `source_type='workflow_template'` and `source_id=run.id`)

APIs

- `GET /api/practice/workflows/templates` — list templates
- `POST /api/practice/workflows/templates` — create template
- `GET /api/practice/workflows/templates/:id` — get template
- `PUT /api/practice/workflows/templates/:id` — update template
- `DELETE /api/practice/workflows/templates/:id` — deactivate template
- `GET /api/practice/workflows/templates/:id/steps` — list steps
- `POST /api/practice/workflows/templates/:id/steps` — create step
- `PUT /api/practice/workflows/templates/:id/steps/:stepId` — update step
- `DELETE /api/practice/workflows/templates/:id/steps/:stepId` — delete step
- `POST /api/practice/workflows/generate` — create a run and generate tasks from a template. Body: `{ template_id, client_id|null, start_date (ISO) }`. Returns `{ run, tasks }` on success.
- `GET /api/practice/workflows/runs` — list runs
- `GET /api/practice/workflows/runs/:id` — run details (includes snapshot of steps)

Frontend

- Pages added/updated:
  - `/practice/workflows.html` — list templates, open generate modal, navigate to template editor
  - `/practice/workflow-template.html` — template editor and step editor

- JS modules:
  - `/js/workflows.js` — template list, generate modal
  - `/js/workflow-editor.js` — template create/edit and step CRUD UI

Rule D (browser storage):

- No business data is stored in browser storage or KV. The frontend UI calls server APIs; all templates, steps, runs, and generated tasks are persisted in the database.

Session handoff

- Migration `057_practice_workflow_templates.sql` already applied in Supabase — DO NOT re-run locally or in production.

- Backend service: `backend/modules/practice/services/workflowService.js` (template/steps CRUD, run generation)

- Router: `backend/modules/practice/workflows.js`

- Frontend: `frontend-practice/workflows.html`, `frontend-practice/workflow-template.html`, `frontend-practice/js/workflows.js`, `frontend-practice/js/workflow-editor.js`

Testing checklist

1. Create template via UI or API.
2. Add steps via template editor.
3. Generate run using modal (specify `start_date`).
4. Verify `practice_workflow_runs`, `practice_workflow_run_steps`, and `practice_tasks` rows exist for the company.
5. Verify `practice_tasks.source_type = 'workflow_template'` and `source_id = <run.id>`.
6. Verify audit events recorded for create/update/delete actions.
7. Attempt generation with invalid data to confirm rollback/cleanup.

Follow-ups

- Add reorder endpoint and UI drag-reorder for template steps.
- Add run lifecycle management (start/complete/cancel) and UI.
- Add permissions checks (role-based) for templates and generation.
- Add unit/integration tests for generation and cleanup logic.
