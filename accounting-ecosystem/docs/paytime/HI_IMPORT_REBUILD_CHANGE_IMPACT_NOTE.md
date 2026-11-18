# CHANGE IMPACT NOTE — PAYROLL — Historical import rebuild (spec 12, HI-01/02/03/05/06/07/09/12)

```text
─────────────────────────────────────────────────────────────
Area being changed:
  Paytime historical import (CSV/Excel tab) + End of Service reinstatement.

Files involved:
  NEW  backend/modules/payroll/services/historicalImport.js   (pure builder + DB writer)
  NEW  backend/modules/payroll/routes/historical-import.js     (POST import / dry run, batches, undo)
  EDIT backend/modules/payroll/index.js                        (mount /historical-import)
  EDIT backend/modules/payroll/routes/unlock.js                (refuse unlocking imported months — HI-05)
  EDIT backend/shared/routes/employees.js                      (POST /:id/reinstate)
  EDIT frontend-payroll/historical-import.html                 (CSV tab → backend; column→item mapping; no KV)
  EDIT frontend-payroll/js/bulk-import-utils.js                (CSV read as text; Excel serial periods)
  EDIT frontend-payroll/js/data-access.js                      (reinstateEmployee — additive)
  EDIT frontend-payroll/employee-management.html               (Reinstate button on ended employees)
  NEW  backend/tests/payroll-historical-import.test.js

Why this change is needed:
  Bug report 2026-11-18: Confirm Import kept only basic salary. Root cause: the screen
  wrote the full row to the KV bridge (Part D violation) and only gross/PAYE/UIF/net to
  payroll_historical, while the payslip, YTD, recon and EMP501 all read payroll_snapshots.
  The payslip therefore showed a fresh live calculation (UIF = 1% of basic).
  Spec 12 already lists this as HI-01/02/03/06/07/12 ❌.

Is this an explicitly authorised Paytime task?
  [x] Yes — Ruan, 2026-11-18 ("doen dit laat die goed kan werk")

Payroll risk:            [ ] CRITICAL  [x] HIGH  [ ] MEDIUM  [ ] LOW
Regression risk:         [ ] High  [x] Medium  [ ] Low

Specific payroll areas that could be affected:
  - YTD PAYE for months after an imported month (reads locked snapshots: periodicTaxableGross,
    onceOffTaxableGross, paye_base — the import fills all three).
  - PAYE recon / EMP201 / EMP501 (read snapshots; imported snapshots carry uif_employer, sdl,
    and regular_inputs with master_item_id + irp5_code so easyfileExport splits by code).
  - Unlock: imported snapshots (source *_import) can no longer be unlocked → "Undo import".

Regression tests required:
  [x] TEST-PAY-09 finalized snapshot immutable (unlock refusal)
  [x] TEST-PAY-11/12 company context, multi-tenant (all queries filtered by req.companyId)
  [x] TEST-PAY-13 no payroll data in browser storage (KV writes removed from CSV path)
  [x] TEST-PAY-14 recon totals match snapshot data
  + golden gate (backend/tests/golden) + full jest suite

Rollback strategy:
  Code: git revert. Data: every imported row is a payroll_snapshots row with
  source='screen_import' and calculation_input._import.batch_id → "Undo import" reverses a
  batch (status reversed, is_locked false, reversed_at/by), same as a pay-run reversal.

Confirmed safe:
  [x] payroll-engine.js not affected (only PayrollEngine.r2/checkPayslipLines are called)
  [x] PayrollCalculationService.js not affected
  [x] Finalized snapshot read path not affected (imported rows store payslip_lines, so
      formatForResponse returns them as-is; never rebuilt)
  [x] Company context not affected (req.companyId everywhere, employee ownership checked)
  [x] PAYE/UIF/SDL logic not affected (imported figures are stored, never calculated —
      except SDL when the file has no sdl column: 1% of gross if the company is SDL-registered,
      flagged sdl_source='derived')
─────────────────────────────────────────────────────────────
```

## Design decisions

| Topic | Decision |
|---|---|
| Storage | Locked `payroll_snapshots`, `source='screen_import'`, no `payroll_run_id` (the unique finalized-run-per-period index makes per-batch runs impossible — same as the scripts). |
| Existing snapshot | Locked → row skipped as "already finalized". Unlocked draft → replaced (same as Execute Payroll). |
| Totals | gross, PAYE, UIF, net are authoritative. gross may be omitted (derived from lines). PAYE and UIF columns are required. |
| Lines | Every `allowance_*` / `deduction_*` / `employer_*` column becomes a payslip line, **negative amounts kept**. Each column is mapped to a Payroll Item (IRP5 code), to Overtime, to Short time, or kept unlinked (EMP501 then flags the missing code — IT-05). |
| overtime_hours | Information only (shown on the overtime line). Never creates a calculated amount — the amount comes from the mapped column. |
| Lines ≠ gross | Earnings difference → "Not allocated" earning line (HI-08). Lines above gross → row rejected. |
| Net check (HI-09) | gross − PAYE − UIF − deductions must equal net within R0.01. Mismatching rows are listed; the user can import them anyway, and the gap becomes a "Not allocated" deduction line. |
| Taxable income | `taxable_gross` column if supplied; else gross − non-taxable portions (item is_taxable / taxable_percentage) − pre-tax deductions. Once-off = items with paye_projection_type ONCE_OFF. |
| UIF employer | `uif_employer` column, else = employee UIF. |
| Inactive employees | Allowed unless the period is after the termination date or before the hire date. |
| Future periods | Refused. Later finalized Paytime months in the same tax year → warning (their PAYE was calculated without the imported month). |
| Undo (HI-05) | Per batch, reason required, audited. Blocked per employee when a later Paytime-calculated month in the same tax year is finalized. |
| Mapping memory | Last batch's column→item mapping is stored in `calculation_input._import.mapping` and offered as the default next time. |

## FOLLOW-UP NOTE
- Area: Historical import
- Dependency: PDF tab and Manual grid tab still use the old KV path.
- What was done now: CSV/Excel tab moved to the snapshot path.
- What still needs to be checked: rebuild PDF + manual tabs on the same endpoint (HI-13/14).
- Risk if not checked: those two tabs still produce payslips the app does not read.
- Recommended next review point: next Paytime phase.

## FOLLOW-UP NOTE
- Area: Turkstra (company 7) leftovers from the broken screen import
- Dependency: Ruan's go-ahead to delete
- What was done now: nothing deleted. 234 `payroll_historical` rows (source csv_import, 2026-03..2026-10) and ~250 `emp_historical_7_*` KV keys remain.
- What still needs to be checked: delete them after Aug–Oct are re-imported via the new path (Mar–Jul already exist as locked simplepay_import snapshots and will be skipped).
- Risk if not checked: recon uses payroll_historical for months without snapshots — harmless once snapshots exist, but confusing.
- Recommended next review point: after the re-import.
