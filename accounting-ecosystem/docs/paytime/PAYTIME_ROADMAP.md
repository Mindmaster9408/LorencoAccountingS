# Paytime — Roadmap

> Last updated: 2026-04-29  
> This document lists what needs to be built or fixed in Paytime, prioritised by impact and urgency.

This is not a product wishlist — it is an engineering roadmap based on known gaps identified through direct source audits (March–April 2026). Every item here corresponds to a real gap documented in the codebase.

---

## Priority 1 — Data Integrity Fixes (Critical)

These items represent situations where data can be silently lost or where reported values may not match the underlying database. Fix before adding any new features.

### P1-A: Historical Import — Write to SQL, Not KV

**File:** `accounting-ecosystem/frontend-payroll/historical-import.html`  
**Related docs:** PAYTIME_RISKS_AND_PROTECTED_AREAS.md §2.1

**Problem:**  
When a company imports historical payroll records (prior to going live on Paytime), the data is written to `safeLocalStorage` (KV store), not to the `payroll_historical` SQL table. The PAYE reconciliation backend (`/api/payroll/recon/summary`) reads from `payroll_historical` and `payroll_transactions`. Historical imports are therefore invisible to the backend recon.

**Required fix:**  
- Import commit phase must call `POST /api/payroll/historical` (or equivalent) for each imported row, writing to `payroll_historical` table
- Remove the safeLocalStorage write from the commit flow
- Ensure the import validation and error reporting still works correctly

**Related tables:**  
- `payroll_historical` — receives per-employee period totals (gross, paye, uif, sdl, net, period_key)

---

### P1-B: Reports Page — Load from API, Not localStorage

**File:** `accounting-ecosystem/frontend-payroll/reports.html`  
**Related docs:** PAYTIME_RISKS_AND_PROTECTED_AREAS.md §2.2

**Problem:**  
`reports.html` and `ReconService` read all report data from `safeLocalStorage`. If localStorage is cleared or the user accesses reports from a different device, the data is missing. This is also the same failure mode as the historical import problem — data exists in the database but the reports page doesn't read it from there.

**Required fix:**  
- Rewrite `reports.html` data loading to call API endpoints:
  - Employee list: `GET /api/employees`
  - Payroll snapshots: `GET /api/payroll/history`
  - Payroll transactions: `GET /api/payroll/transactions`
- Remove the localStorage-based aggregation from the report generation path
- Preserve all existing report output formats (the data → report transformation logic can stay)

---

### P1-C: Voluntary Tax Over-Deduction — Audit and Fix Persistence

**Related docs:** PAYTIME_RISKS_AND_PROTECTED_AREAS.md §2.3

**Problem:**  
The engine supports `voluntary_overdeduction` as an input. The frontend has UI for entering it. It is not confirmed where this value is stored per employee — it may be in KV instead of a SQL column.

**Required fix:**  
- Audit the frontend-to-backend path for voluntary over-deduction entry
- If stored in KV: add `voluntary_overdeduction` column to `employees` table (via `payroll-schema.js`) and migrate the data path
- If already stored in SQL: document and close this gap

---

## Priority 2 — SARS Compliance Filing

These items are required for full SARS compliance. Without them, accountants must manually capture Paytime's calculated figures into SARS eFiling. The calculated amounts are correct; only the file generation is missing.

### P2-A: EMP201 Monthly Declaration

**Problem:** Accountants currently manually capture monthly PAYE/UIF/SDL totals from the recon page and enter them into SARS eFiling.

**Required:**  
Generate a downloadable EMP201-format file (CSV or printable PDF) per tax period containing:
- Total PAYE
- Total UIF (employer + employee)
- Total SDL
- Company PAYE/UIF/SDL reference numbers
- Period reference

**Data source:** `payroll_transactions` + `payroll_snapshots`

---

### P2-B: EMP501 Annual Reconciliation

**Problem:** The `/api/payroll/recon/emp501` endpoint returns the foundation data. No submission file is generated.

**Required:**  
SARS e@syFile compatible EMP501 import file (XML format) containing per-employee annual:
- IRP5 codes and amounts
- Total PAYE per employee
- Total UIF per employee
- Employee tax number, ID number
- Company details

**Prerequisite:** IRP5 codes must be populated on all payroll items (see P3-A below)

---

### P2-C: IRP5 / IT3(a) to Employees

**Problem:** Employees currently receive payslips only. IRP5 tax certificates (annual) are not generated.

**Required:**  
- Annual IRP5 certificate per employee (PDF) 
- IRP5 XML file for SARS submission
- Employee-facing download or email flow

**Prerequisite:** IRP5 codes must be complete (P3-A)

---

### P2-D: UIF Return File (UIF-19 format)

**Problem:** UIF contributions are calculated correctly but no UIF submission file is generated.

**Required:**  
- Monthly UIF-19 format export per company
- Required fields: employee UIF reference, SA ID, employment type, UIF amount per employee

---

## Priority 3 — Sean AI Learning

These items implement the controlled learning and IRP5 standardization system described in CLAUDE.md §4 (Rules B1–B11).

### P3-A: IRP5 Code Completeness and Learning Workflow

**Related:** CLAUDE.md Rules B1–B11

**Problem:**  
Payroll items can have IRP5 codes but coverage is not enforced or validated. Sean's learning event capture (`sean-integration.js`) exists but the approval and propagation flow is not built.

**Required components (see CLAUDE.md §4 Rule B11 for full spec):**

| Component | Description |
|---|---|
| Learning Event Capture | Already partially built in `sean-integration.js`. Review and confirm correctness. |
| Knowledge Store | Structured table for confirmed standard mappings (item meaning → IRP5 code) |
| Proposal Engine | Identify clients with matching items that have missing IRP5 codes |
| Approval Workflow | UI for Infinite Legacy super-admin to review and approve propagation |
| Propagation Engine | Apply approved mappings only where IRP5 code is null/blank |
| Exception Reporter | Flag clients with conflicting codes — never auto-overwrite them |
| Audit Trail | Record every propagation action with who approved and what changed |

**Hard rule (non-negotiable):**  
Populated IRP5 codes on any client MUST NEVER be overwritten automatically — even during an approved batch propagation. Only null/blank codes may receive the standard mapping.

---

## Priority 4 — Payroll Corrections Workflow

### P4-A: Correction Snapshot Flow

**Problem:**  
When a finalized payslip needs to be corrected (e.g., wrong salary, missed deduction), there is no supported correction flow. The `/api/payroll/unlock` endpoint exists, but a proper correction workflow is not built.

**Required:**  
1. Admin requests unlock via a deliberate correction flow (not a raw unlock)
2. A correction reason is required and recorded
3. A new snapshot is created (linked to the original via a `correction_of` reference)
4. The original snapshot is marked as superseded, not deleted
5. Both the original and the correction appear in the employee's history
6. An audit trail entry is created

This is the SARS-correct approach to payroll corrections: additive, never destructive.

---

## Priority 5 — Enhanced Calculations

### P5-A: YTD Cumulative PAYE Method

**Problem:**  
The current engine annualises monthly income by × 12 (projection method). The SARS-preferred method for employees with variable income is the YTD cumulative method: sum all income and tax for the tax year to date, then determine the marginal rate for the annual projection of the cumulative income.

**Impact:** For commission-heavy employees, monthly PAYE will be slightly different under each method. Annual totals reconcile correctly either way. However, the YTD method reduces over/under-deduction through the year.

**Required:**  
- `ytdData` parameter is already part of the engine's input contract (`calculateFromData()`)
- `PayrollDataService` needs to fetch and pass year-to-date snapshots for the tax year
- `PayrollCalculationService` needs to populate `ytdData` from fetched snapshots
- The engine already has the calculation path — it's the data supply that's missing

---

### P5-B: ETI (Employment Tax Incentive)

**Problem:**  
Engine fields for ETI exist. Full ETI calculation workflow (qualifying employees, monthly ETI reduction on PAYE, 6-month phase, re-entry, etc.) is not confirmed as implemented.

**Required:**  
- Audit whether ETI inputs and outputs are correctly wired end-to-end
- Add ETI qualifying employee flag to employee setup
- ETI is reflected in PAYE remittance (reduces EMP201 amount)
- ETI must appear on EMP501

---

## Priority 6 — UI and UX Improvements

These are lower-priority but will affect day-to-day usability.

### P6-A: Standardise payruns.html vs payroll-execution.html

Audit the overlap between these two pages. If `payruns.html` is superseded, mark it as deprecated in code comments and in this doc. If it serves a distinct purpose, document it clearly.

### P6-B: Mobile Layout Audit

`mobile-utils.js` exists but mobile layout across all pages has not been fully tested. A systematic mobile audit would identify layout breaks on smaller screens.

### P6-C: Payslip Email Distribution

Currently payslips are downloaded as PDF. An email distribution flow (send payslip to employee's email on file) would save accountant time.

---

## Not on Roadmap (By Design)

The following are explicitly out of scope for the Paytime roadmap:

- **Multi-currency support** — Paytime is SA-only (ZAR)
- **Non-SA tax systems** — Out of scope
- **Leave calculation integration into payroll** — Leave balances are tracked; leave deduction from salary is not an automatic calculation (manual adjustments only)
- **Time and attendance → payroll auto-integration** — Attendance tracking exists but is not wired to automatically populate overtime or short-time in payroll runs

---

## Related Documents

- [PAYTIME_CAPABILITIES.md](PAYTIME_CAPABILITIES.md) — Current capability status
- [PAYTIME_RISKS_AND_PROTECTED_AREAS.md](PAYTIME_RISKS_AND_PROTECTED_AREAS.md) — Known gaps in detail
- [PAYTIME_ARCHITECTURE.md](PAYTIME_ARCHITECTURE.md) — System structure
- CLAUDE.md §4 — Sean controlled learning rules (B1–B11)
