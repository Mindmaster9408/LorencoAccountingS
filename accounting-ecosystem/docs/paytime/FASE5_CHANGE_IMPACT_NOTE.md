# Fase 5 — Change Impact Note (Pro-rata and who is paid)

> 2026-10-13 · Authorised by Ruan ("fase5") · Spec: [spec/06](spec/06_BEREKENINGSENJIN.md) ENJ-20/21, [spec/03](spec/03_WERKNEMERS.md) WN-10, [spec/07](spec/07_UITVOER_EN_FINALISERING.md) UF-02 · Findings B8, V4

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  Pro-rata months (start / leave mid-month) and which employees may be paid in a period.

Files involved:
  backend/core/payroll-engine.js                     (CRITICAL) calculateProRataFactor, calculateWithProRata
  backend/modules/payroll/services/payrollEligibility.js  NEW  one pure eligibility rule
  backend/modules/payroll/routes/payruns.js          (CRITICAL) uses it; error carries code + message
  backend/modules/payroll/routes/calculate.js        (CRITICAL) single payslip refuses (422) outside employment
  frontend-payroll/employee-detail.html              (HIGH)     toast with the message
  backend/tests/golden/run-golden.js                 harness uses the same rule

What changes:
  1. ENJ-20 / B8: the pro-rata factor is no longer rounded to 2 decimals. Example:
     R20 000 from 10 Oct 2026 = 15/22 → R13 636.36 (was 0.68 → R13 600.00).
     Only rand amounts are rounded to cents (basic and allowance lines).
  2. ENJ-21 (owner-confirmed 2026-10-12): fixed (regular) allowances are pro-rated
     with the basic salary. Percentage items already follow the pro-rated basic.
     NOT pro-rated: current (once-off) inputs, overtime, multi-rate, short time, deductions.
     Example S62: R5 000 travel allowance, start 10 Oct → R3 409.09 (was the full R5 000).
  3. WN-10 / UF-02 / V4: hired AFTER the period → blocked in Execute Payroll and in the
     single payslip, message "[Name] only starts on [date]. Choose a later period, or
     change the start date if it is wrong." Terminated BEFORE the period → excluded,
     also when the employee is still flagged active. Inactive without a termination in
     the period → excluded (unchanged).

Payroll risk:     [x] CRITICAL   Regression risk: [ ] High [ ] Medium [x] Low

Expected changes (verified):
  Golden: only S60 and S62 (the two pro-rata start scenarios) — see numbers above.
  S61 (leaves 15 Oct) unchanged. Core 15/15 unchanged. Payslip lines add up 112/112.
  Production check 2026-10-13 (read-only): no employee hired/leaving in October 2026,
  none hired in November, none flagged active with an earlier termination — so no
  open payslip changes today.

Owner decision 2026-10-13 ("teen hulle normale oortyd tarief, nie verlaagte tarief nie"):
  4. In a pro-rata month overtime is paid — and short time deducted — at the NORMAL
     hourly rate from the full monthly salary (was the pro-rated salary → lower rate).
     Golden S63 added: R20 000 from 10 Oct, 4h OT + 2h short time → hourly R115.47,
     OT R692.82, short time −R230.94. Multi-rate unchanged (own rand rate).

Rollback: git revert.
─────────────────────────────────────────────────────────────
```
