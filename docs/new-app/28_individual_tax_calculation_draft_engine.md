# Codebox 28 — Individual Income Tax Calculation Draft Engine Foundation

**Status:** Complete  
**Date:** 2026-06-21  
**Module:** Practice Management — `/api/practice/individual-tax` (calculations sub-routes)

---

## What This Is

A draft calculation engine for individual income tax (ITR12) estimates.  
Takes captured income and deduction data from CB27 and produces a transparent, versioned draft estimate.

**This is NOT:**
- SARS-final tax calculation
- eFiling integration
- Tax advice automation
- Legally compliant output
- Fully complete tax law (deduction caps, secondary rebates, medical credits not fully enforced)

**This IS:**
- Backend-derived draft estimate (frontend totals never trusted)
- Versioned calculations per return (v1, v2, v3 as data is updated)
- Transparent calculation lines stored in JSONB (visible to accountant)
- Explicit warning flags for any unsupported or missing data
- Explicit assumption list stored with every calculation
- Review workflow: draft → ready_for_review → reviewed/approved/rejected
- Audit event log per calculation
- Every UI screen shows the DRAFT ESTIMATE warning

---

## Database (Migration 078)

Run `accounting-ecosystem/backend/config/migrations/078_practice_individual_tax_calculations.sql` once in Supabase SQL Editor.

### Tables Created

| Table | Purpose |
|---|---|
| `practice_individual_tax_calculations` | One draft calculation record per run, versioned |
| `practice_individual_tax_calculation_events` | Audit event log per calculation |

---

## Tax Constants Module

File: `accounting-ecosystem/backend/modules/practice/individual-tax-constants.js`

Contains `TAX_YEAR_CONSTANTS` for 2023–2026 with SA SARS tables (DRAFT — verify annually).

Helpers:
- `getConstants(taxYear)` — returns constant set, falls back to `DEFAULT_TAX_YEAR` (2026)
- `computeTaxFromBrackets(taxableIncome, brackets)` — applies bracket math

---

## Backend Routes

File: `accounting-ecosystem/backend/modules/practice/individual-tax-calculations.js`  
Mounted at: `/api/practice/individual-tax` (second mount — Express falls through from CB27 router)

```
GET    /calculations/:id/events              Calculation audit log
POST   /calculations/:id/submit-review       draft/rejected → ready_for_review
POST   /calculations/:id/approve             ready_for_review/reviewed → approved
POST   /calculations/:id/reject              ready_for_review/reviewed → rejected
POST   /:returnId/calculations/run-draft     Run new draft calculation (versioned)
GET    /calculations/:id                     Get one calculation (full detail)
PUT    /calculations/:id                     Update: provisional_tax_paid, notes, name
GET    /:returnId/calculations               List non-cancelled calculations for a return
```

---

## Calculation Logic

```
gross_income_total         = SUM(income_entries.gross_amount)
paye_withheld              = SUM(income_entries.tax_withheld)
deduction_total            = SUM(deduction_entries.amount)  [caps NOT applied — CB29]
taxable_after_deductions   = MAX(0, gross - deductions)
normal_tax_before_rebates  = tax brackets[taxYear]
tax_after_rebates          = MAX(0, normal_tax - primary_rebate)  [primary only — CB29 adds secondary/tertiary]
estimated_tax_payable      = MAX(0, tax_after_rebates - paye_withheld)
estimated_refund           = MAX(0, paye_withheld - tax_after_rebates)
```

All warning flags, calculation lines, and assumptions stored in JSONB on every calculation row.

Warning flags always included: `DRAFT_TAX_TABLE_REQUIRES_REVIEW`, `REVIEW_REQUIRED`

---

## Frontend

6th tab added to the detail modal: **Calculations**  
- DRAFT ESTIMATE warning banner (permanent)
- Run Draft Calculation button
- Calculation cards (name, version, status, amounts)
- Calculation Detail Modal — lines table, warning chips, assumptions, approve/reject workflow

---

## Multi-Tenant Safety

Every route scoped to `req.companyId`. Return and calculation ownership verified before every operation.

---

## No Browser Storage

Zero `localStorage`, `sessionStorage`, or `safeLocalStorage` for calculation data.

---

## Recommended Next Codebox

**Codebox 29 — Tax Constant Tables + SARS Tax Year Configuration Foundation**  
Move tax constants from JS file into versioned DB tables. Add cap enforcement (RA, s18A, travel). Add secondary/tertiary rebates via age field. Add medical credits via member count.
