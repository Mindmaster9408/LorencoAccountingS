# Codebox 78 — Practice Automation Foundation + Workflow Orchestration

> App: Lorenco Practice Management
> Status: Complete — migration 135 not yet applied to Supabase — nothing committed or pushed

## Purpose

The nervous system of Practice Management — safe, deterministic, manager-controlled rules that react to a trigger and run a small, explicitly-supported set of actions ("When a pricing review is approved, create an executive action to confirm the implementation plan").

**This is NOT AI, NOT autonomous decision making, NOT cron-heavy background processing, NOT workflow replacement, NOT task engine replacement, NOT external integration automation.**

**Scope note (read before anything else):** this codebox builds the rule register, condition engine, action engine, and manual execution only. No existing module (pricing-review.js, executive-reporting.js, secretarial-workflows.js, etc.) was modified to automatically fire a trigger. `trigger_type` on a rule is metadata describing what the rule is for; the only way a rule executes in this codebox is `POST .../test` (always a dry run) or `POST .../run` (a manager explicitly running it now, supplying the trigger context by hand). Per the spec's own "Do not wire every module yet" instruction — real module-to-module event firing is deferred to a future codebox.

## Mandatory Pre-Build Audit — Key Findings

No pre-existing automation-rule/run table exists anywhere. Confirmed reuse targets — every one called by the action engine, never reimplemented:

- `notifications.js` exports `notify()` (Codebox 54) — the **only** path `create_notification` uses to write a row into `practice_notifications`. Automation never inserts into that table directly, so `notify()`'s dedup/assignment-resolution logic is never duplicated.
- `reminders.js` has **no exported creation function** — its own `POST /` route's insert shape (`practice_reminders`: `reminder_type`, `source_type`, `source_id`, `assigned_team_member_id`, `title`, `message`, `severity`, `due_date`, `metadata`) was confirmed stable and safe, and is reused directly by `create_reminder` via the identical column set — never a new reminder concept.
- `executive-reporting.js` (Codebox 77) owns `practice_executive_action_register` — `report_id` is `NOT NULL` on that table by Codebox 77's own design, so `create_executive_action` **requires** a resolvable `report_id` in the trigger context (`action.report_id` or `action.report_id_field` resolved against the context) and fails safely — a clear error, never a guessed fallback, never a `practice_task` created instead.
- `practice_secretarial_workflows`, `practice_secretarial_integrity_findings` (Codebox 69), `practice_onboarding_profiles` (Codebox 70), `practice_risks` (Codebox 49), `practice_quality_findings` (Codebox 48), `practice_pricing_reviews` (Codebox 74) are all **read-only trigger-context sources** for manual test/run calls — none of their own write paths, status machines, or scoring are touched.
- `lib/team-access.js` (this session's canonical helper) gates every mutating route — no new authorization logic was written.

## Architect Freedom — Scope Decisions & Deviations

1. **`REMINDER_TYPES`/`REMINDER_SEVERITIES` are a small, documented, manually-mirrored copy of `reminders.js`'s own constants** (that module exports neither) — a deliberate, minimal duplication of an allow-list, not of logic. If `reminders.js`'s list changes, this copy needs a manual follow-up update (documented as a follow-up note).
2. **`add_note_event` and `flag_for_review` never mutate a source record** — per the spec's own instruction, they write only to `practice_automation_events`/an optional notification. There is no generic "write a note onto any table" capability, by design — that would be exactly the kind of "hidden logic"/uncontrolled write surface the spec explicitly forbids.
3. **A `_StopRun` sentinel class is used internally** to unwind `evaluateAutomationRule()`'s try block early (safety-check failure, invalid actions, idempotent duplicate, conditions not met) without treating a deliberate, already-recorded stop as an unexpected error — the catch block only pushes a new error/sets `failed` when the exception is NOT a `_StopRun`. This keeps every stop reason traceable to a specific, already-persisted run step rather than a generic 500.
4. **`create_reminder` was implemented as a real action (not a dry-run-only placeholder)**, since the spec's own "if unsure, create a documented placeholder" fallback only applies when the reuse path is unclear — the exact insert shape was confirmed safe by reading `reminders.js`'s own `POST /` handler directly.
5. **Both dry-run and live runs write a full run + step + event trail** — the spec's own "no run without run record / no action without run step" rule applies identically whether or not real side effects occurred, so a dry run is exactly as inspectable as a live one.
6. **A rule can be edited (name/description/next_review_date/settings) in ANY non-terminal status**, but its `conditions`/`actions`/`safety_level`/`idempotency_key_template` can only change while `draft`/`paused`/`disabled` — never on an `active` rule, closing the gap where an active rule's behavior could silently change without a pause-first step.
7. **`archive` is a distinct action from the soft-cancel `DELETE`** — matching Codebox 77's precedent: archive retires a paused/disabled rule that served its purpose; cancel (with a required reason) withdraws a rule that should never have existed/run, from any non-terminal status.
8. **Manager-gating was applied to every mutating route from the start** (unlike Codebox 77's initial draft, which had to be corrected mid-build) — this module was written after that lesson, so `_requireManager()` → `teamAccess.requireManager()` was in place on all 20 mutating routes (create/update/cancel/approve/activate/pause/disable/archive/test/run/seed) from the first pass.

## Database — Migration 135

Four new tables: `practice_automation_rules`, `practice_automation_runs`, `practice_automation_run_steps`, `practice_automation_events` (append-only, same convention as Codeboxes 76/77). No changes to any existing table.

## Backend — `automation.js`

Full CRUD on rules, 5 workflow transitions (approve/activate/pause/disable/archive) plus soft-cancel DELETE, manual test/run execution, run/step/event listing (company-wide and rule-scoped), a static catalogue endpoint, and idempotent seed-defaults insertion.

### Condition Engine

11 deterministic operators (`equals`/`not_equals`/`exists`/`not_exists`/`greater_than`/`greater_or_equal`/`less_than`/`less_or_equal`/`contains`/`in`/`not_in`) against 5 allowed field roots (`source`/`rule`/`context`/`company`/`user`) resolved via a safe dot-path walker (`_getPath()`) — no `eval`, no dynamic code, no arbitrary JavaScript anywhere in the engine. AND semantics only; an empty conditions array always passes (an explicitly unconditional rule, never an implicit undocumented default). Unknown field roots are rejected at both rule-create/update time and again at activation time.

### Action Engine

5 supported actions exactly per spec: `create_notification`, `create_reminder`, `create_executive_action`, `add_note_event`, `flag_for_review`. The 7 explicitly named forbidden actions (`send_email`, `create_invoice`, `submit_to_sars`, `submit_to_cipc`, `update_accounting`, `auto_assign_work`, `change_engagement_fee`) get a specific, named rejection message rather than a generic "unknown action" error — an author trying one of these gets told exactly why it's out of scope for this codebox. String interpolation (`{{source.report_title}}`-style tokens) is supported for action text fields via the same safe dot-path resolver — never string concatenation of untrusted input into a code path, never `eval`.

### Automation Engine — `evaluateAutomationRule()`

Runs safety checks → idempotency check → conditions → actions, writing one persisted step per stage (one row per condition, one row per action) so every run is fully inspectable after the fact. Dry runs simulate every action (`step_status: 'passed'`) without a single real write; live runs actually execute (`step_status: 'completed'`/`'failed'`/`'warning'`). Returns `{ run, warnings, errors, action_results }`.

## Idempotency Logic

`_renderIdempotencyKey()` defaults to `{company_id}:{rule_id}:{trigger_type}:{source_type}:{source_id}` or a rule-supplied `idempotency_key_template` (simple `{token}` substitution, no eval). Dry runs never consume or check idempotency, per spec, verbatim. A live run whose key matches an already-`completed`/`completed_with_warnings` run is marked `skipped` and performs zero actions — never a duplicate notification/reminder/executive action.

## Safety Logic

- `high`/`critical` safety_level rules are forced to `requires_approval = true` at creation, regardless of what the caller passed.
- A rule cannot activate while `requires_approval && !approved_at`.
- A rule cannot activate with invalid conditions or unsupported/forbidden actions (validated fresh at activation time, not just at last edit).
- A live run additionally re-validates actions at execution time (defense in depth) and refuses to run at all unless `rule_status === 'active'`.
- Every mutating route — all 20 of them — requires manager role via `lib/team-access.js`.

## Seed Rules

4 draft-only example rules (`POST /seed-defaults`, idempotent by `rule_key`, never auto-activated): executive report published → notify partners; pricing review approved → confirm implementation plan (medium safety, requires approval); secretarial integrity critical finding → notify manager (high safety, requires approval); onboarding completed → notify assigned partner. All ship as `draft` with `rule_status` untouched by the seed call.

## Integrations

- **Management Dashboard**: new `automation` block in `computeSummary()` — active rules / failed runs (recent) / runs with warnings (recent), direct count-only queries, same pattern as every prior KPI block; no require of `automation.js` at all (keeps `computeSummary()` self-contained, consistent with the Executive Reporting integration's reasoning).
- **Notifications**: every `create_notification` action call goes through `notify()` — no direct insert.
- Executive Reporting/Strategic Planning/Pricing/Secretarial/Onboarding/Risk/QMS are **not** wired to auto-fire triggers in this codebox, per spec.

## Frontend

`automation.html` + `js/automation.js` (prefix `auto`): 4 top-level tabs (Rules/Run History/Events/Catalogue-Help), a Rule Detail modal (Overview/Events) with context-sensitive workflow buttons, a Create/Edit Rule modal (raw-JSON conditions/actions editors — a visual builder is explicitly a future-enhancement item, not built now), a Test/Run modal that clearly separates "Test (Dry Run)" from "Run Live Now" (including a native confirm() before any live execution), and a Run Detail modal showing every step with its status and captured output. Dangerous/unsupported/requires-approval states are all visibly badged, per the spec's UX requirement.

## localStorage Findings

Zero matches across the migration, `automation.js`, both new frontend files, and every edited file. Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`; every INSERT sets `company_id` explicitly; every UPDATE/SELECT chains `.eq('company_id', cid)`. Verified line-by-line, same method as Codebox 77's audit.

## Files Created

| File | Purpose |
| --- | --- |
| `accounting-ecosystem/backend/config/migrations/135_practice_automation_foundation.sql` | 4 tables: rules, runs, run steps, append-only events |
| `accounting-ecosystem/backend/modules/practice/automation.js` | Router + condition engine + action engine + `evaluateAutomationRule()` |
| `accounting-ecosystem/backend/frontend-practice/automation.html` | Automation UI |
| `accounting-ecosystem/backend/frontend-practice/js/automation.js` | Automation UI logic |
| `docs/new-app/78_automation_foundation.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_78_automation.md` | Handoff |

## Files Modified

| File | Change |
| --- | --- |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `automation.js` router at `/automation`, right after Executive Reporting |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | Added `automation` block to `computeSummary()` (direct count queries) |
| `accounting-ecosystem/backend/frontend-practice/js/management-dashboard.js` | Rendered the new KPI card |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added the "Automation" KPI grid container |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added the "Automation" nav entry |
