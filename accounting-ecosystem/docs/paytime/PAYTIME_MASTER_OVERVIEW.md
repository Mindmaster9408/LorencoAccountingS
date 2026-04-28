# Paytime — Master Overview

> Last updated: 2026-04-29  
> This is the entry-point document for any developer who is new to Paytime.

---

## What Is Paytime?

Paytime is the payroll management application in the Lorenco accounting ecosystem. It is a South African payroll system built to calculate and manage PAYE, UIF, and SDL in full compliance with SARS requirements.

It is used by:
- **Payroll admins and accountants** — to run monthly payroll, generate payslips, and reconcile tax obligations
- **Super-admins (Infinite Legacy)** — to manage all client companies, configure tax tables, and oversee the platform

Paytime is one of several apps in the ecosystem (alongside an accounting/GL system, practice manager, and client portal). It shares the same backend infrastructure (Node.js/Express), the same PostgreSQL database (Supabase), and the same authentication system as the rest of the ecosystem.

---

## What Paytime Does

**Monthly payroll run:**
1. Select a period (e.g., April 2026)
2. Select employees to include
3. The system assembles each employee's inputs (salary, allowances, deductions, work schedule, medical members, age)
4. The calculation engine applies SA 2026/2027 SARS tax tables to produce PAYE, UIF, SDL, and net pay
5. Each result is stored as a snapshot (immutable once finalized)
6. Payslips are generated as PDFs with company branding

**Tax compliance:**
- Correct PAYE withheld per the SARS Income Tax Act (monthly and pro-rata scenarios)
- UIF at 1% (employee + employer, both calculated and output)
- SDL at 1%
- Medical tax credits (Section 6A/6B)
- Age-based rebates (primary, secondary, tertiary)

**Reconciliation:**
- Period-by-period and annual PAYE/UIF/SDL reconciliation
- EMP501 foundation data (annual per-employee totals)
- Tax year selector covering all historical data

---

## System Architecture (Summary)

```
Browser (frontend-payroll/)
        │
        │ HTTPS API calls
        ▼
Express API (backend/)
        │
  ┌─────┴──────────────────────────────────────────┐
  │  PayrollDataService              (input fetch)  │
  │  PayrollCalculationService       (orchestration)│
  │  payroll-engine.js               (calculation)  │
  │  PayrollHistoryService           (snapshots)    │
  └─────┬──────────────────────────────────────────┘
        │
        ▼
PostgreSQL (Supabase)
  - employees           (per-company, company_id tenant key)
  - payroll_snapshots   (one row per employee per period)
  - payroll_periods     (period metadata)
  - payroll_items       (earnings/deduction types)
  - employee_payroll_items  (recurring assignments)
  - payroll_period_inputs   (one-off period items)
  - payroll_overtime / payroll_short_time / payroll_multi_rate
  - payroll_kv_store_eco    (cloud-backed KV store)
  - company_payroll_settings
  - employee_work_schedules
  - employee_bank_details
  - leave_balances / leave_requests
  - payroll_transactions / payroll_historical (recon data)
```

Every request is authenticated (JWT) and scoped to a company (`company_id`). There is no shared data between companies.

For the full directory structure and request flow, see [PAYTIME_ARCHITECTURE.md](PAYTIME_ARCHITECTURE.md).

---

## The Calculation Engine

The sole authority for all PAYE/UIF/SDL calculations is:

**`backend/core/payroll-engine.js`**

- `ENGINE_VERSION: '2026-04-12-v1'`
- SA 2026/2027 tax tables (hardcoded defaults, admin-overridable via KV)
- Historical tables: 2021/2022 through 2025/2026
- Entry points: `calculateFromData()`, `calculateWithProRata()`, `calculateNetToGross()`
- Output contract: 17+ named fields — the output fields are immutable (additive only, never remove)

**Critical rule:** The engine is the only thing that calculates tax. No frontend code recalculates PAYE. Payslips display what the engine produced, not what they recalculate.

For full engine documentation, see [PAYTIME_CALCULATION_AND_TAX.md](PAYTIME_CALCULATION_AND_TAX.md).

---

## Snapshot Model

Every payroll calculation result is stored as an immutable snapshot:

- **Draft** — writable; can be replaced by a re-run
- **Finalized** — locked; cannot be changed, replaced, or deleted
- **Corrections** create new snapshots linked to the original, never mutating it

**Critical rule:** Once `is_locked = true`, the row in `payroll_snapshots` must never be updated. The lock is enforced in application code — there is no database-level constraint.

For full snapshot documentation, see [PAYTIME_SNAPSHOTS_AND_HISTORY.md](PAYTIME_SNAPSHOTS_AND_HISTORY.md).

---

## No localStorage Rule

Business data is never stored in `localStorage`. This is an explicit, hard-coded system rule.

`polyfills.js` monkey-patches all localStorage calls in the frontend. Any `setItem` for business data is automatically routed to the cloud KV store (`payroll_kv_store_eco` table) instead of native browser storage.

**Why this matters:** localStorage is browser-local, tab-local, device-local, and can be cleared at any time. Business data (payroll calculations, employee records, payslip results) stored there would be inaccessible or lost for other users and devices.

For the full rule and details, see [PAYTIME_NO_LOCALSTORAGE_RULE.md](PAYTIME_NO_LOCALSTORAGE_RULE.md).

---

## Current Status (April 2026)

### What is fully working

- PAYE, UIF, SDL calculation (all scenarios: standard, pro-rata, overtime, multi-rate, net-to-gross)
- Employee management (create, edit, bank details) — all saving to SQL
- Payroll execution (run, re-run, finalize, snapshot creation)
- Payslip PDF generation with branding
- PAYE reconciliation by tax year
- EMP501 foundation data
- Leave management
- User management and access control

### What is partial or has known gaps

- Historical import: write path is broken (goes to KV not SQL)
- Reports page: localStorage-based, not API-backed
- IRP5 codes on payroll items: UI exists; completeness and correctness not enforced
- Sean AI IRP5 learning: event capture exists; approval/propagation workflow not built
- Voluntary over-deduction: persistence path needs audit

### What is not built

- EMP201 monthly payment file
- EMP501 XML submission file
- IRP5 / IT3(a) certificate generation
- UIF return file (UIF-19)
- Correction snapshot workflow
- YTD cumulative PAYE method

For the full status matrix, see [PAYTIME_CAPABILITIES.md](PAYTIME_CAPABILITIES.md).  
For what needs to be built, see [PAYTIME_ROADMAP.md](PAYTIME_ROADMAP.md).  
For known risks and fragile areas, see [PAYTIME_RISKS_AND_PROTECTED_AREAS.md](PAYTIME_RISKS_AND_PROTECTED_AREAS.md).

---

## Key Non-Negotiable Rules

1. **Engine is the only authority.** Never calculate PAYE outside `payroll-engine.js`.
2. **Finalized snapshots are immutable.** Never update `payroll_snapshots` where `is_locked = true`.
3. **No business data in localStorage.** All business data goes to SQL tables via API.
4. **Every query must include `company_id`.** Multi-tenant isolation is mandatory on every DB call.
5. **Required output fields are additive only.** New fields can be added to the engine output; existing fields can never be removed or renamed.
6. **Sean global changes require explicit authorization.** Learning events are captured automatically; propagation requires human approval.

---

## Deployment

Paytime is deployed on Zeabur via Docker.

**Critical rules:**
- `accounting-ecosystem/zbpack.json` must NEVER exist (it breaks the build)
- `accounting-ecosystem/Dockerfile` is the only build config
- `WORKDIR /app` is required (server.js serves frontends from `/app/frontend-*/`)

For full deployment rules, see CLAUDE.md Part C.

---

## Where to Start

| You want to... | Start here |
|---|---|
| Understand the full system | [PAYTIME_ARCHITECTURE.md](PAYTIME_ARCHITECTURE.md) |
| Understand the tax calculation | [PAYTIME_CALCULATION_AND_TAX.md](PAYTIME_CALCULATION_AND_TAX.md) |
| Learn how snapshots work | [PAYTIME_SNAPSHOTS_AND_HISTORY.md](PAYTIME_SNAPSHOTS_AND_HISTORY.md) |
| Learn the no-localStorage rule | [PAYTIME_NO_LOCALSTORAGE_RULE.md](PAYTIME_NO_LOCALSTORAGE_RULE.md) |
| Know what works and what doesn't | [PAYTIME_CAPABILITIES.md](PAYTIME_CAPABILITIES.md) |
| Run payroll step by step | [PAYTIME_WORKFLOWS.md](PAYTIME_WORKFLOWS.md) |
| Know what not to break | [PAYTIME_RISKS_AND_PROTECTED_AREAS.md](PAYTIME_RISKS_AND_PROTECTED_AREAS.md) |
| Know what to build next | [PAYTIME_ROADMAP.md](PAYTIME_ROADMAP.md) |
| See all docs in one place | [README.md](README.md) |

---

## Audit Basis

This documentation suite was created in April 2026 based on direct source code reads of all key backend services, route files, the payroll engine, and frontend pages. It reflects the state of the codebase as of commit `1353f39` (pushed April 28, 2026).

Do not guess at status — read the actual files. This documentation may be updated as the system evolves.
