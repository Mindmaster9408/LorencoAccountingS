# SESSION HANDOFF — 2026-08-24 — Firmflow (Practice module) breadth audit

## What this is

Following the same-day Accounting/Ledger Leo full-module audit (which found the
entire Accounts Payable write path in `suppliers.js` had never worked — wrong
column names, a NOT NULL violation, a wrong CHECK constraint, and a foreign
key pointing at a permanently-empty dead table), the user asked for the same
depth of audit on Firmflow (Practice module), which is ~4x larger (68 frontend
pages, 67 backend route files vs. Accounting's ~20).

Given the scale, the user chose a **breadth-first pass**: find and document
every issue across the whole module before fixing anything. Six parallel
audit agents each covered a slice of the backend route files
(`accounting-ecosystem/backend/modules/practice/`), cross-referencing every
table/column reference against the **live** PostgREST schema (not assumptions
from reading code), the same methodology that found the `suppliers.js` bugs.
No fixes have been applied yet — this document is the complete findings
inventory to work from next.

Per-group detailed findings (every table touched, real column lists, line
numbers) are in six files in the scratchpad directory:
`firmflow_audit_tax_core.md`, `firmflow_audit_tax_ops.md`,
`firmflow_audit_secretarial_engagement.md`, `firmflow_audit_workflow_client.md`,
`firmflow_audit_practice_ops_a.md`, `firmflow_audit_practice_ops_b.md`.

## CRITICAL — feature always fails (HTTP 500 or false 404), every time, for every user

1. **`individual-tax.js`, `provisional-tax.js`, `taxpayer-profiles.js`** — the
   `GET /` list and `GET /:id` detail routes all use a PostgREST
   `table!fk_column(...)` embed for client/team-member names, but the FK
   relationship doesn't resolve (`PGRST200 — no relationship found`, confirmed
   live). List routes 500; detail routes return a false 404 regardless of
   whether the record exists. This has apparently never worked.
2. **`tax-actions.js`, `tax-dashboard.js`** — same embed problem but inside the
   *primary* list queries: `GET /practice/tax-dashboard/returns` always
   returns zero rows; the Risk panel's overdue-deadlines/blocked-returns lists
   are always empty; `GET /review-queue` always drops every return/plan.
3. **`tax-bulk-operations.js`** — omits the required (NOT NULL) `source_id`
   when creating tax actions. Every "create_tax_actions" bulk operation fails,
   for every client, every time.
4. **`tax-actions.js` `POST /:id/create-task`** — omits required
   `review_required`/`approval_required` on `practice_tasks`. Always 500s.
5. **`tax-pipeline.js`** — selects `readiness_status`, which doesn't exist on
   `practice_provisional_tax_plans`. The filing-stage pipeline feature 404s
   for every provisional tax plan, always.
6. **`workflows.js`** — `PUT /templates/:templateId/steps/:stepId` (generic
   step update) is registered *before* `PUT /templates/:id/steps/reorder`.
   Both have identical segment structure, so Express matches the generic
   route first (`parseInt('reorder')` = `NaN`). The code's own comment says
   the reorder route "must be registered BEFORE" the generic one — it isn't.
   The entire "Reorder Steps" feature in Workflow Templates always 500s.
7. **`billing.js` `GET /packs` and `GET /packs/:id`** — the main billing-pack
   list and detail views. Always 500. No FK exists for
   `practice_billing_packs.client_id`, and three more embeds on
   `practice_billing_pack_lines` (`time_entry_id`/`task_id`/`workflow_run_id`)
   reference FKs that don't resolve either. The file's own `buildReportData()`
   function has a comment acknowledging this exact problem and works around
   it with manual joins — the fix was just never applied to these two
   endpoints.
8. **`document-requests.js` `GET /` and `GET /:id`** — same root cause
   (`client_id`/`assigned_team_member_id` have no resolving FK). The entire
   Document Request Tracker cannot be viewed, only created into. Always 500.
9. **`executive-reporting.js`** — `router.get('/:id', ...)` is registered at
   line 380, *before* the literal routes `GET /decisions` (791),
   `GET /actions` (929), and `GET /events` (1073). Express's generic handler
   catches all three first. All three endpoints are permanently dead code —
   always a false 404.
10. **`skills-matrix.js` `GET /skills`, `GET /team-skills`,
    `GET /team-certifications`** — `practice_skills.category_id`,
    `practice_team_skills.skill_id`, `practice_team_certifications
    .certification_id` are plain integer columns with no real FK, but the code
    assumes PostgREST embed shorthand works on them. Confirmed live
    (`PGRST200`). Always 500.

## HIGH — silently wrong or empty data, no error ever surfaced

11. **`req.userId` does not exist anywhere in the codebase** (confirmed by
    grep — the real JWT payload property is `req.user.userId`). ~10 of 11
    tax-ops files write `created_by`/`updated_by`/`actor_user_id`/etc. from
    this nonexistent property — attribution silently nulls out across almost
    the entire tax module (tasks, bulk ops, submissions, payments, disputes,
    SARS recon, pipeline stages, report snapshots). Only `tax-completion.js`
    gets it right.
12. **`practice_clients` has no `client_name`/`display_name`/`company_name` —
    only `name`.** Wrong in `tax-pipeline.js`, `tax-disputes.js`,
    `tax-completion.js`, `sars-statement-recon.js` (tax-ops group),
    `reminders.js` (workflow group), and `communications.js` (practice-ops
    group). Every one of these silently shows a null client name — no error
    ever surfaces because none of the affected code checks `.error`.
13. **`tax-reports.js`** selects `tax_return_id` instead of
    `company_tax_return_id` on `practice_company_tax_review_packs` — every
    ready-for-review company return is falsely flagged "missing review pack"
    on the Risk Summary.
14. **`company-tax-review-packs.js`** — `category` should be
    `adjustment_category`; `item_label`/`item_status` should be
    `item_name`/`status`. Every company-tax review pack ever generated has
    shipped with an empty adjustments table and a broken readiness section —
    silently, HTTP 201 still returned.
15. **`individual-tax-review-packs.js`** — client select uses
    `display_name`/`company_name` (real: `name`); profile select uses
    `income_tax_number`/`date_of_birth`/`age_at_year_end` (none exist on that
    table). Every individual-tax review pack has permanently blank client
    name, DOB, age, and tax reference.
16. **`tax-config.js` `/seed-from-js`** — reads
    `consts.medical_credits_monthly.main_member/first_dependent/
    additional_dep` and `consts.thresholds.under_65/'65_to_74'/'75_plus'`, but
    the real exported constant names (`individual-tax-constants.js`) are
    `main_and_first_dependant`/`additional_dependant` and
    `below_65`/`age_65_74`/`age_75_plus`. All 6 fields silently seed NULL for
    every tax year.
17. **`auditFromReq()` called with the wrong signature at 23 call sites
    across 6 tax-core files.** Real signature is
    `(req, actionType, entityType, entityId, extra)`; these calls pass
    `(req, eventName, {someObject})`. Doesn't error — PostgREST stringifies
    the object into the `entity_type` varchar column and `entity_id` is
    always NULL, corrupting the ecosystem-wide `audit_log` table (each
    module's own separate domain event log is unaffected).
18. **`dashboard.js`** — `total_value` doesn't exist on
    `practice_billing_packs` (real: `billable_value`/`recoverable_value`/etc.);
    `created_by` doesn't exist on either event table (real:
    `actor_user_id`). The Risk and Activity dashboard sections return `200`
    with permanently empty arrays — no error, just quietly wrong.
19. **`skills-matrix.js`'s `getCompetency()` helper** — same broken-embed
    root cause as finding #10, but this one never checks `.error`, so instead
    of throwing it silently returns empty competency data for every team
    member. Every caller — Delegation, Planning Board, Resource Forecast, and
    `partner-scorecards.js`'s Learning scorecard component — has been
    silently scoring "zero skill gaps" for all staff regardless of actual
    data.

## Confirmed clean (no action needed)

- **Entire Secretarial/Engagement group** (12 files: `secretarial.js` +5
  secretarial-* files, `beneficial-ownership.js`, `entity-lifecycle.js`,
  `engagements.js`, `engagement-periods.js`, `engagement-management.js`,
  `compliance-packs.js`) — zero mismatches. Every status/enum constant was
  live-probed against real CHECK constraints and all passed. This module
  appears to have been built and tested against the real schema from the
  outset. Only 3 cosmetic nits (garbled error-message text, duplicate
  delete/archive route pairs, one dead enum value) — see the detail file if
  interested, none need fixing urgently.
- **Entire Workflow/Client group except the 2 items above** (11 of 13 files:
  `services/workflowService.js`, `work-queue.js`, `work-authorization.js`,
  `delegation.js`, `planning-board.js`, `automation.js`, `notifications.js`,
  `alert-rules.js`, `client-onboarding.js`, `client-success.js`,
  `client-health.js`).
- **`company-tax.js`, `company-tax-calculations.js`** (tax-core group).
- **`knowledge-base.js`, `practice-sop.js`, `quality-management.js`,
  `risk-register.js`, `kpi-history.js`, `partner-review-packs.js`**
  (practice-ops-a group).
- **`profitability.js`, `resource-forecasting.js`, `pricing-review.js`,
  `partner-scorecards.js` (aside from consuming the broken
  `getCompetency()`), `strategic-planning.js`, `operational-health.js`,
  `pilot-readiness.js`, `management-dashboard.js`, `lib/team-access.js`, and
  `index.js`'s router mount table** (all 60 required sub-router files exist;
  no cross-router shadowing) (practice-ops-b group).

## Important open question before writing any migrations

Two separate audit agents independently flagged the same caveat: this
codebase has a **documented history of PostgREST schema-cache staleness**
elsewhere in the ecosystem (a real FK can exist in Postgres but PostgREST's
in-memory schema cache hasn't picked it up yet, which looks identical to a
genuinely-missing FK from the API side — `PGRST200` either way). Before
treating every "missing FK" finding above (#1, #2, #7, #8, #10, #19 — 6 of
the 10 critical findings) as needing a schema migration, it's worth first
trying the cheap, safe, reversible fix: reloading PostgREST's schema cache
(`NOTIFY pgrst, 'reload schema';` in the Supabase SQL editor, or via the
Supabase dashboard's "reload schema" button if one exists for this project).
If that alone fixes some of these, the actual required fix is far smaller
than it currently looks. **Recommend trying this first**, then re-running
the specific broken-embed probes to see which ones are now resolved before
scoping any FK-adding migrations for the rest.

Direct-Postgres CHECK-constraint verification (the same class of check that
found the `supplier_invoices.status` bug) could not be run for this batch —
this sandbox's direct Postgres connection times out, confirmed independently
by two of the six agents (same limitation documented in the Accounting audit
handoff).

## Next step

This is a findings inventory only — nothing has been fixed. Given the volume
(10 critical + 9 high-severity findings across a very large module), the next
conversation should decide how to prioritize the fix pass: critical
(500-causing) items first, or everything in one pass like the Accounting
audit, and whether to try the schema-cache-reload theory first before
committing to migrations for the missing-FK findings.
