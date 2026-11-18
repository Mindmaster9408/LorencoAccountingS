# CHANGE IMPACT NOTE — PAYROLL — H1: finalize is atomic + supplemental runs can be finalized

```text
─────────────────────────────────────────────────────────────
Area being changed:
  POST /api/payroll/finalize (Execute Payroll → Finalize).

Files involved:
  EDIT backend/modules/payroll/routes/payruns.js            (finalize order + clear 409)
  EDIT backend/modules/payroll/services/PayrollHistoryService.js
       finalizePayrollRun: company filter + only a DRAFT run + keeps the DB error code
       NEW revertRunToDraft (compensation when locking fails)
  EDIT frontend-payroll/payroll-execution.html               (409 PERIOD_ALREADY_FINALIZED is not "finalized")
  NEW  backend/migrations/038_payroll_runs_allow_supplemental.sql  (drop one unique index — needs Ruan's ja)
  EDIT backend/tests/golden/fake-supabase.js                  (test-only hook to simulate a DB constraint)
  NEW  backend/tests/payroll-h1-finalize.test.js

Why this change is needed (audit OUDIT_2026-11-18, H1):
  Finalize locked the payslips FIRST and marked the run finalized SECOND. The DB allows
  one finalized run per company+period (idx_payroll_runs_finalized_unique), while /run
  deliberately allows supplemental runs (Ruan, commit e84228f, April 2026: "adding
  employees missed in the original run"). A supplemental run's finalize therefore locked
  its payslips, then failed (500) — payslips locked under a draft run, no Leo journal,
  not reversible through the run. March 2026 at companies 38/39/40 is in that state.

Is this an explicitly authorised Paytime task?
  [x] Yes — Ruan, 2026-11-18 ("gaan", fix order item 2)

Payroll risk:     [ ] CRITICAL  [x] HIGH  [ ] MEDIUM  [ ] LOW
Regression risk:  [ ] High  [x] Medium  [ ] Low

Specific payroll areas that could be affected:
  - Finalize flow (order of the two writes), Leo draft journal creation per run,
    run-level reversal (unchanged — still per run id).

Regression tests required:
  [x] TEST-PAY-09 finalized snapshot immutable
  [x] TEST-PAY-11/12 company context / multi-tenant (company filter added to the run update)
  + golden gate + full jest suite + new payroll-h1-finalize tests

Rollback strategy:
  git revert. Migration 038 only drops an index; re-create it with the statement in the
  file header if ever needed (only possible while no period has two finalized runs).

Confirmed safe:
  [x] payroll-engine.js not affected
  [x] PayrollCalculationService.js not affected
  [x] Finalized snapshot read path not affected (readers use is_locked / status, not the run)
  [x] Company context not affected (finalize run update now ALSO filters company_id)
  [x] PAYE/UIF/SDL logic not affected
─────────────────────────────────────────────────────────────
```

## New finalize order
1. Mark the run `finalized` — only if it is still `draft`, only in this company (one atomic UPDATE).
   - Unique-index violation (before migration 038: another finalized run for this month) →
     **409 `PERIOD_ALREADY_FINALIZED`**, nothing locked, run stays draft, clear guidance.
2. Lock this run's draft payslips (one UPDATE).
   - Fails → the run is put back to `draft` (compensation) → 500 "nothing was finalized".
   - Locks nothing (payslips moved to a newer run meanwhile) → run back to `draft` → 409 `RUN_SUPERSEDED`.
3. Audit + Leo draft journal (unchanged; the journal is per run, so a supplemental run gets its own draft journal).

## Why dropping the index is safe
Double payment is prevented per employee by `idx_payroll_snapshots_active_unique`
(one active payslip per company + employee + period). Every reader (YTD, recon, EMP501,
e@syFile, reports, journal, unlock, reversal) works per snapshot or per run id — none
assumes one finalized run per month (checked: `getPayrollRun` is unused; payroll-execution
lists runs individually).

## FOLLOW-UP NOTE
- Area: March 2026 runs at companies 2, 38, 39, 40 (audit M3)
- Dependency: Ruan's ja for a data fix
- What was done now: nothing — the data stays as it is
- What still needs to be checked: re-attach the locked payslips to the finalized run (or finalize their draft run once 038 has run)
- Risk if not checked: Pay Runs history shows an empty finalized run; reversing it would not reverse those payslips
- Recommended next review point: with item M3
