# Fase 1 — Change Impact Note (Tax tables per tax year)

> 2026-10-13 · Authorised by Ruan ("jy kan hom doen dan is hy klaar") · Spec: [spec/02](spec/02_BELASTINGTABELLE.md) · Findings K1, W1, W2, W3, B10

```text
CHANGE IMPACT NOTE — PAYROLL
─────────────────────────────────────────────────────────────
Area being changed:
  Where PAYE tax tables come from, and how a pay period picks its table.
  Old model: ONE global "active year" in KV (tax_config / tax_years_v2), used for
  every period of every year. New model: one DB row per SARS tax year; every
  period automatically uses the row of ITS OWN tax year. No "active year".

Files involved:
  backend/migrations/027_payroll_tax_tables.sql          NEW  table + seed 2021/22–2026/27 (all confirmed)
  backend/modules/payroll/services/taxTables.js          NEW  getTaxConfigForPeriod, validation, legacy fallback
  backend/modules/payroll/routes/tax-tables.js           NEW  GET (all payroll users) / PUT (super user, authority co.)
  backend/modules/payroll/index.js                       (CRITICAL) mounts /api/payroll/tax-tables
  backend/modules/payroll/routes/calculate.js            (CRITICAL) KV lookup → getTaxConfigForPeriod
  backend/modules/payroll/routes/payruns.js              (CRITICAL) same; loaded BEFORE the run header is created
  backend/modules/payroll/routes/voluntary-tax.js        (CRITICAL) same, for the bonus month's year
  backend/core/payroll-engine.js                         (CRITICAL) code-default tables + override rule
  frontend-payroll/payroll-items.html                    Tax Configuration section rewritten on the API
  backend/tests/*                                        golden harness per period, new tests, fake upsert

What changes:
  1. Every calculation (single payslip, Execute Payroll, bonus-spread calculator) loads
     the table of the period's own tax year from payroll_tax_tables. Feb 2027 → 2026/27,
     Mar 2027 → 2027/28, even on the same day.
  2. A missing or unconfirmed year → HTTP 422 TAX_TABLES_MISSING with a clear message.
     Never a silent guess (it used to fall back to the newest known table).
  3. Bracket convention = SARS wording: min = previous max (B10). Validation rejects
     the old "+1" form, a top bracket with a maximum, a rate typed as 26 instead of 0.26.
  4. Code defaults: TAX_YEAR 2026/2027 with the 2027 SARS figures (were 2025/26 figures
     labelled as the current year — W1/K1); 2022/23 + 2023/24 rebates and medical
     credits corrected (W2). HISTORICAL_TABLES now mirror migration 027 exactly
     (a test enforces this).
  5. Engine: an override is used only for ITS OWN tax year (W3). A legacy KV table
     labelled 2026/2027 no longer taxes a February-2026-or-earlier period; that period
     uses its historical table. Unlabelled overrides are still trusted (old callers).
  6. Payroll Items → Tax Configuration: tabs per year, "Save draft", "Confirm (checked
     against SARS)", "Unconfirm to edit", "+ Add Year". "Set as Active Year" removed.
     Min column is automatic. Edit buttons only when the server says can_edit
     (super_admin in the global payroll authority company); everyone else read-only.
     No more tax_years_v2 / tax_config writes from the browser (Part D).
  7. Every PUT is audited with old and new row. Confirming the CURRENT year also mirrors
     it to KV __global__ tax_config so legacy frontend-engine pages (Fase 9) match.

Deployment order (safe either way):
  Code first: until migration 027 runs, the loader sees "table missing" and uses the
  old KV tax_config exactly as before — the only live change is point 5 (back periods
  use their own year), which is correct. Then run migration 027 in Supabase.

Payroll risk:     [x] CRITICAL
Regression risk:  [ ] High  [x] Medium  [ ] Low

Expected changes (verified):
  Golden set: 43 period rows change, ONLY paye / paye_base / net:
    - +R0.02 … +R0.26 per month for incomes above the first bracket (B10: the R1 offset
      × marginal rate; bonus months up to R0.26). First bracket unchanged.
    - S70 (code defaults, Oct 2026): −R102.06 — defaults are now really 2027.
    - S71 (2024-06 with the 2026/27 KV override): +R102.10 — now uses the 2024/25 table
      (= S72). W3 fixed.
  Core regression (period 2026-04, code defaults): 9 scenarios move to the correct
  2027 values, e.g. R20 000 + 1 medical member: R1 819.06 → R1 739.00
  (240 000 × 18% − 17 820 = 25 380 ÷ 12 = 2 115 − 376). These baselines had been
  calculated on the 2024/25 tables for an April-2026 period.

Regression tests run:
  TEST-PAY-01/03/04/05/06/07/08/10 via golden set (S01–S72, M01–M11), core 15/15,
  tests/payroll-tax-tables.test.js (25), period-sequence, recon-uif, overtime-shorttime.
  TEST-PAY-09 (locked snapshots) — not touched: a locked period is returned before any
  table is loaded. TEST-PAY-13 — the page no longer writes tax tables to browser/KV.

Rollback strategy:
  git revert of the Fase 1 commit. The table can stay (nothing reads it after revert).

Confirmed safe:
  [x] Finalized snapshot read path not affected (locked check happens first)
  [x] Company context not affected (tables are ecosystem-wide, read-only for clients)
  [x] UIF/SDL logic not changed (same rates/cap in every year)
  [ ] PAYE changes by design — see expected changes
─────────────────────────────────────────────────────────────
```

## Open after Fase 1
- **BT-08** — warning from 1 February when next year's table is not confirmed yet (March is already blocked by BT-15).
- **BT-09 / step 1.4** — snapshot stores `tax_year` but no hash/id of the exact table row → with Fase 6.
- **Fase 9** — the frontend engine (`frontend-payroll/js/payroll-engine.js`, payruns.html, reports, net-to-gross) still reads the KV mirror for the current year only.
