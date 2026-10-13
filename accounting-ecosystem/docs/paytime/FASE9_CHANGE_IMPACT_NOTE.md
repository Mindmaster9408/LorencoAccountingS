# Fase 9 — Change Impact Note (One engine; payslips, reports and Net-to-Gross from the backend)

> 2026-10-13 · Authorised by Ruan ("fase 9") · Spec: [spec/08](spec/08_PAYSLIPS.md) PS-06/09/10, [spec/10](spec/10_VERSLAE_EN_UITVOERE.md) VU-01/03/06/07/09/10, [spec/11](spec/11_NET_TO_GROSS.md) NG-01/02 · Findings K6, B5, B12

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  Every screen that still calculated payroll in the browser (frontend engine on
  browser/KV data) now shows backend figures — finalized snapshots or the backend
  engine. Shipped in three commits: 9.3, 9.1, 9.2+9.4.

9.3 Net-to-Gross (commit 9b5a2ff)
  - POST /api/payroll/calculate/net-to-gross (backend engine, period tax tables).
  - Allowances recurring by default ("Monthly" ticked); untick = once-off (B12).
    R20 000 net + R3 000 travel allowance → basic R20 051.51 (was R19 795.27).

9.1 Old Payslips page retired (commit 3cadfda)
  - payruns.html out of the menu; old links redirect to Execute Payroll;
    code kept inactive (?legacy=1) — spec PS-10.
  - Execute Payroll: payslip preview + bulk print from the frozen payslip lines
    (bulk print showed "Lorenco Accounting Services" for every company — fixed;
    medical credit no longer shown as an extra plus line).
  - Bank File from finalized net pay + DB bank details: generic CSV (any bank) and
    FNB / ABSA / Standard Bank / Nedbank layouts (unchanged layouts, new data source).
    Refused when an EFT employee lacks bank details; file total must equal the
    finalized net pay.

9.2 Reports + 9.4 frontend engine (this commit)
  - reports.html: Payroll Summary, Tax, YTD and Variance read the FINALIZED snapshots
    (were recalculated in the browser from KV). Employer UIF from the snapshot.
    Employees without a finalized payslip for a month are left out.
  - employee-detail / payroll-items no longer load the old KV tax table into the
    frontend engine; "+ Add Year" copies the latest DB year (the frontend engine's
    historical tables still have the old W2 values).

Payroll risk:     [x] HIGH (what users see and export)   Regression risk: [ ] High [x] Medium [ ] Low
Confirmed safe:
  [x] Backend engine figures unchanged — golden 0 diffs, core 15/15, payroll Jest 240
  [x] No recalculation of finalized months anywhere on these screens

Not carried over / still open:
  - Xero / Sage journal export from the old page → replaced by the Ledger Leo draft
    journal (VU-04), not built yet.
  - Sean preflight button (old page) — Sean features to be re-homed.
  - Payroll upload (old page) and historical-import.html still use the frontend
    engine → Fase 12 (import rebuild).
  - Capitec Business bank format (needs a sample file).
  - Audit-log and report-history lists in reports.html still read browser/KV → Fase 11.
  - Full 4-step layout (PS-09) — Execute Payroll covers the steps; the guided
    layout is a later UI pass.

Rollback: git revert of the three commits.
─────────────────────────────────────────────────────────────
```
