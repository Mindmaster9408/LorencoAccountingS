# Paytime — Capabilities Reference

> Last updated: 2026-04-29  
> Status legend: ✅ Built and working | ⚠️ Partial / known gaps | ❌ Not built

This document is an honest record of what Paytime can and cannot do as of April 2026. It is written for future developers who need to understand the current state before building new features or fixing bugs.

---

## 1. Core Payroll Calculation

| Capability | Status | Notes |
|---|---|---|
| Monthly PAYE calculation (SA SARS brackets) | ✅ | Backend engine. 2026/2027 tables + historical 2021–2025 |
| UIF calculation (1%, capped) | ✅ | Respects is_director flag and company uif_registered flag |
| SDL calculation (1%) | ✅ | Respects company sdl_registered flag |
| Medical tax credit (Section 6A/6B) | ✅ | Main member + first dep (R364) + additional (R246) |
| Age rebates (primary/secondary/tertiary) | ✅ | Age derived from dob or SA ID at SA tax year end date |
| Pre-tax deductions (pension, RA) | ✅ | tax_treatment = 'pre_tax' reduces taxableGross |
| Net-only deductions (medical aid, garnishee) | ✅ | tax_treatment = 'net_only' reduces net only |
| Pro-rata calculation (mid-month hire/termination) | ✅ | Working days ratio × basic salary |
| Overtime calculation | ✅ | Hours × hourly rate × rate multiplier |
| Short-time deduction | ✅ | Hours missed × hourly rate |
| Multi-rate hours | ✅ | Separate rate multiplier per entry |
| Once-off bonus/income (non-annualised) | ✅ | Handled as once-off taxable gross |
| Voluntary tax over-deduction | ⚠️ | Engine supports it; frontend persistence needs audit |
| Net-to-gross reverse calculation | ✅ | Binary search to find gross that yields target net |
| YTD cumulative PAYE method | ❌ | Not implemented; ytdData always null in current code |
| Global tax config admin override | ✅ | Super-admin KV override; overrides current year only |

---

## 2. Employee Management

| Capability | Status | Notes |
|---|---|---|
| Create employee | ✅ | Via employee-management.html |
| Edit employee core details | ✅ | Fixed Apr 2026 — writes to employees SQL table |
| Edit payroll details (salary, tax directive, medical) | ✅ | Part of employee-detail save (Apr 2026 fix) |
| Edit bank details | ✅ | Saves to employee_bank_details + mirrors on employees row |
| Hire date / termination date | ✅ | hire_date column (frontend uses date_appointed alias) |
| SA ID number | ✅ | Stored on employees; used for age derivation if dob absent |
| Tax number | ✅ | Required field |
| Employee work schedule | ✅ | Per-employee Mon–Sun day/hour configuration |
| Leave management (annual, sick, family) | ✅ | API-backed; statutory defaults created on first access |
| Deactivate / terminate employee | ✅ | Status/termination_date on employees row |
| Employee search / filter | ✅ | On employee-management.html |
| Employee classification (director, part-time, etc.) | ✅ | is_director flag; affects UIF |
| ETI (Employment Tax Incentive) | ⚠️ | Field exists on engine; full ETI workflow not confirmed |
| UIF declaration fields | ⚠️ | Basic UIF calculated; UIF submission file not built |

---

## 3. Payroll Items

| Capability | Status | Notes |
|---|---|---|
| Create payroll items (earnings/deductions) | ✅ | payroll-items.html |
| Assign items to employees (recurring) | ✅ | employee_payroll_items table |
| Add one-off period items | ✅ | payroll_period_inputs table |
| IRP5 code assignment | ⚠️ | UI exists; IRP5 code field on payroll_items; Sean learning integration exists but mapping completeness not confirmed |
| Tax treatment (pre-tax vs net-only) | ✅ | tax_treatment field on payroll_items |
| Item categories (earnings, deductions, benefits) | ✅ | item_category field |

---

## 4. Payroll Execution

| Capability | Status | Notes |
|---|---|---|
| Run payroll for one or more employees | ✅ | POST /api/payroll/run; max 200 employees per run |
| Period selection (YYYY-MM) | ✅ | Auto-creates period record if absent |
| Re-run (replace draft snapshot) | ✅ | Upsert on draft snapshots |
| Protect finalized payslips from re-run | ✅ | Finalized snapshots are skipped; reported in errors |
| Finalize payroll period | ✅ | POST /api/payroll/finalize; locks all draft snapshots |
| Per-employee payslip calculation (preview) | ✅ | POST /api/payroll/calculate; returns engine output |
| Payroll run results display | ✅ | payroll-execution.html shows processed + errors |
| Run history (per period) | ✅ | GET /api/payroll/history |
| Employee period history | ✅ | GET /api/payroll/calculate/history/:emp/:period |
| Payslip PDF generation | ✅ | Client-side, js/pdf-branding.js |
| Payslip PDF branding (logo, company details) | ✅ | Configurable per company |
| Banking file (EFT) export | ✅ | js/banking-formats.js |

---

## 5. Reconciliation and Reporting

| Capability | Status | Notes |
|---|---|---|
| PAYE / UIF / SDL reconciliation by tax year | ✅ | paye-reconciliation.html + /api/payroll/recon/summary |
| Tax year selector (auto-populated from data) | ✅ | /api/payroll/recon/tax-years |
| EMP501 foundation data (per-employee annual aggregates) | ✅ | /api/payroll/recon/emp501 — data only, not a SARS submission |
| Historical payroll import (prior periods) | ⚠️ | Import UI works; data goes to localStorage/KV, NOT payroll_historical table |
| Earnings summary report | ⚠️ | reports.html reads from localStorage — not API-backed |
| Per-employee breakdown report | ⚠️ | Same — localStorage-based |
| SARS EMP201 submission file | ❌ | Not built |
| SARS EMP501 XML submission file | ❌ | Not built |
| IRP5 / IT3(a) XML submission | ❌ | Not built |
| UIF return file | ❌ | Not built |

---

## 6. Company and Configuration

| Capability | Status | Notes |
|---|---|---|
| Company payroll settings (PAYE ref, UIF ref, SDL ref) | ✅ | company-details.html |
| Company bank details | ✅ | Stored on companies table |
| Pay frequency configuration | ✅ | Monthly, weekly, bi-weekly supported |
| Pay schedule management | ✅ | /api/payroll/pay-schedules |
| SDL / UIF registration flags | ✅ | companies.sdl_registered, uif_registered |
| Directors list | ✅ | Managed via company-details.html |
| Tax configuration (tax tables admin override) | ✅ | Super-admin only; payroll-items.html tax config panel |

---

## 7. Access Control

| Capability | Status | Notes |
|---|---|---|
| JWT-based auth | ✅ | Shared with all ecosystem apps |
| Multi-tenant company isolation | ✅ | company_id enforced on every query |
| Role-based permissions (PAYROLL.VIEW, RUN, APPROVE, ADMIN) | ✅ | requirePermission middleware |
| Employee visibility scoping (restricted Paytime users) | ✅ | paytimeAccess.js — specific employees only |
| User management (create/edit Paytime users) | ✅ | users.html |
| Super-admin access (Infinite Legacy) | ✅ | super-admin-dashboard.html |

---

## 8. Ancillary Features

| Capability | Status | Notes |
|---|---|---|
| Attendance tracking (clock in/out) | ✅ | attendance.html |
| Leave requests and balances | ✅ | API-backed (fixed Mar 2026) |
| Net-to-gross calculator | ✅ | net-to-gross.html (standalone tool) |
| Client-side audit log | ✅ | Rolling 1000-entry buffer stored in KV |
| Sean AI IRP5 code learning | ⚠️ | Learning event capture exists (sean-integration.js); approval workflow not built |
| Password reset (self-service) | ✅ | Fixed Mar 2026 — no email token; requires email + new password only |
| Dark mode | ✅ | theme-guard.js |
| Mobile layout | ⚠️ | mobile-utils.js exists; not fully tested across all pages |

---

## 9. Compliance Status

Paytime currently covers the payroll CALCULATION requirements for SARS compliance. It does not yet cover the FILING requirements.

| SARS obligation | Coverage |
|---|---|
| Correct PAYE amounts withheld | ✅ |
| Correct UIF amounts withheld | ✅ |
| Correct SDL amounts | ✅ |
| Monthly EMP201 payment | Data available; file not generated |
| Annual EMP501 reconciliation | Foundation data only; XML not generated |
| IRP5 / IT3(a) to SARS | ❌ Not built |
| IRP5 to employees | ❌ Not built (PDF payslip only) |

---

## Related Documents

- [PAYTIME_ROADMAP.md](PAYTIME_ROADMAP.md) — What needs to be built
- [PAYTIME_RISKS_AND_PROTECTED_AREAS.md](PAYTIME_RISKS_AND_PROTECTED_AREAS.md) — Known gaps and protected areas
- [PAYTIME_WORKFLOWS.md](PAYTIME_WORKFLOWS.md) — How the working features are used
