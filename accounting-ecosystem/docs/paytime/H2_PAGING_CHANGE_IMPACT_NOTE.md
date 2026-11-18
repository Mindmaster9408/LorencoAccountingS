# CHANGE IMPACT NOTE — PAYROLL — H2: read every row (Supabase 1000-row cap)

```text
─────────────────────────────────────────────────────────────
Area being changed:
  PAYE recon (tax years, summary/EMP201, EMP501, e@syFile), annual analysis report,
  historical-import batches / undo / duplicate check.

Files involved:
  NEW  backend/modules/payroll/services/fetchAllRows.js
  EDIT backend/modules/payroll/routes/recon.js        (7 reads → fetchAllRows)
  EDIT backend/modules/payroll/routes/reports.js      (1 read  → fetchAllRows)
  EDIT backend/modules/payroll/services/historicalImport.js (4 reads → fetchAllRows; undo updates in chunks of 200)
  EDIT backend/tests/golden/fake-supabase.js          (test-only: range() + optional __maxRows cap)
  NEW  backend/tests/payroll-h2-paging.test.js

Why this change is needed (audit OUDIT_2026-11-18, H2):
  Supabase returns at most 1000 rows per request, also with .limit(5000) (proved:
  23 126 audit rows → 1000). These reads loaded all payslips of a company for a tax year
  in one request, so a company with more than ~83 employees got silently low EMP201,
  EMP501, IRP5 and report figures.

Is this an explicitly authorised Paytime task?
  [x] Yes — Ruan, 2026-11-18 ("gaan", fix order item 3)

Payroll risk:     [ ] CRITICAL  [ ] HIGH  [x] MEDIUM  [ ] LOW
Regression risk:  [ ] High  [ ] Medium  [x] Low

Specific payroll areas that could be affected:
  Read paths only (same filters, same rows — now all of them). Undo-import writes in chunks.

Regression tests required:
  [x] TEST-PAY-14 PAYE recon totals match snapshot data (new test: 10 payslips, 4-row cap)
  [x] TEST-PAY-12 multi-tenant (filters apply on every page — tested)
  + golden gate + full suite

Rollback strategy:  git revert (no data or schema change).

Confirmed safe:
  [x] payroll-engine.js not affected
  [x] PayrollCalculationService.js not affected
  [x] Finalized snapshot read path not affected (same rows, all pages)
  [x] Company context not affected
  [x] PAYE/UIF/SDL logic not affected
─────────────────────────────────────────────────────────────
```

## How fetchAllRows works
Pages ordered by `id` (stable, no row skipped or read twice), advancing by the rows actually
returned and stopping on an empty page — so it is also correct if the server's cap is ever
set lower than the page size. Costs one extra small request per read. Errors are returned,
never swallowed. Hard stop at 500 000 rows.

## Verified live (read-only, company 51)
`/recon/summary` 2026/2027 per month = direct SQL sums (Mar 47 447,09 … Jul 48 247,09, 4 payslips each);
EMP501 4 employees; annual analysis, tax years and import batches 200.

## Not changed
Per-run reads (≤ 200 employees per run: finalize, journal, run review) and the employee name
lookups (a company would need > 1000 employees) — no truncation possible today.
