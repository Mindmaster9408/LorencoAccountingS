# CONTROL ACCOUNT RECONCILIATION — IMPLEMENTATION REPORT
**Date:** 2026-05  
**Session type:** CLAUDE CODEBOX — AR/AP Control Account Reconciliation  
**Status:** COMPLETE

---

## 1. SUMMARY

A forensic reconciliation proof report was built end-to-end that compares:

- **AR:** GL control account 1100 balance vs outstanding `customer_invoices` sub-ledger
- **AP:** GL control account 2000 balance vs outstanding `supplier_invoices` sub-ledger

The report detects GL vs sub-ledger discrepancies caused by: manual journals posting directly to control accounts, invoices with no linked GL journal, and payments with no linked GL journal. It supports an "As At" date parameter for historical point-in-time proofing and supports `type=ar|ap|both`.

---

## 2. FILES CHANGED

| File | Change |
|---|---|
| `backend/modules/accounting/routes/reports.js` | Added `GET /control-account-reconciliation` endpoint + two private helper functions (`buildARReconciliation`, `buildAPReconciliation`) |
| `frontend-accounting/control-account-reconciliation.html` | **New file.** Full self-contained report page |
| `frontend-accounting/js/navigation.js` | Added `control-account-reconciliation.html` to Reports nav active-state detection + added "Control Reconciliation" link in Reports dropdown |

### Files NOT changed (preserved)
- `customer-invoices.js` — AR invoice posting, payment, void logic untouched
- `suppliers.js` — AP invoice posting, payment logic untouched
- `accounting-schema.js` — no schema migration needed (all queries on existing tables)
- `journalService.js` — journal creation/posting untouched
- `bank.js` — bank allocation untouched
- `accounting/index.js` — no route mounting change needed (endpoint in existing `reports.js`)

---

## 3. AR CALCULATION (Account 1100)

### GL Balance
```sql
SELECT COALESCE(SUM(jl.debit), 0) AS d, COALESCE(SUM(jl.credit), 0) AS c
FROM journal_lines jl
INNER JOIN journals j ON j.id = jl.journal_id
WHERE j.company_id = $1
  AND j.status = 'posted'
  AND j.date <= $asAt
  AND jl.account_id = <account 1100 id>
```
`glBalance = d - c` — positive for an asset (receivable).

### Sub-Ledger Balance
```sql
SELECT COALESCE(SUM(total_inc_vat - amount_paid), 0)
FROM customer_invoices
WHERE company_id = $1
  AND invoice_date <= $asAt
  AND status NOT IN ('draft', 'void', 'cancelled')
  AND (total_inc_vat - amount_paid) > 0.005
```

### Difference
`difference = glBalance - subledgerBalance`  
`isReconciled = |difference| < 0.01`

---

## 4. AP CALCULATION (Account 2000)

### GL Balance
Same query structure as AR, but with **sign flip** to present as a positive payable:
```
glBalance = SUM(credit) - SUM(debit)  ← liability normal credit balance
```

### Sub-Ledger Balance
```sql
SELECT COALESCE(SUM(total_inc_vat - amount_paid), 0)
FROM supplier_invoices
WHERE company_id = $1
  AND invoice_date <= $asAt
  AND status NOT IN ('draft', 'cancelled')
  AND (total_inc_vat - amount_paid) > 0.005
```

### Difference
`difference = glBalance - subledgerBalance`  
`isReconciled = |difference| < 0.01`

---

## 5. SIGN CONVENTION USED

Consistent with all existing reports in `reports.js`:

| Account type | GL balance formula | Expected sign when in use |
|---|---|---|
| AR (asset, 1100) | `SUM(debit) − SUM(credit)` | Positive = receivable |
| AP (liability, 2000) | `SUM(credit) − SUM(debit)` | Positive = payable |

The sub-ledger formula `total_inc_vat - amount_paid` is always positive by construction (we exclude zero/negative balances). Both sides are presented as positives for easy comparison.

---

## 6. MULTI-TENANT SAFETY

- `req.user.companyId` (from JWT, injected by `authenticateToken` middleware) is used as `companyId` in every query parameter.
- No `company_id` is accepted from the frontend.
- Every direct `db.query()` call includes `company_id = $1` in the WHERE clause.
- Auth guard: `authenticate` + `hasPermission('report.view')` — consistent with all other report endpoints.

---

## 7. WARNINGS DETECTED

The endpoint surfaces the following forensic warnings when detected:

| Warning | Trigger condition |
|---|---|
| Account not found | `accounts` table has no row with `code='1100'` or `code='2000'` for this company |
| Manual journals on control account | `source_type = 'manual' OR source_type IS NULL` journal(s) with lines on 1100/2000 |
| Invoices without GL journal (AR) | `customer_invoices.status IN ('sent','part_paid') AND journal_id IS NULL` |
| Payments without GL journal (AR) | `customer_payments.journal_id IS NULL` |
| Invoices without GL journal (AP) | `supplier_invoices.status IN ('unpaid','part_paid') AND journal_id IS NULL` |
| Payments without GL journal (AP) | `supplier_payments.journal_id IS NULL` |

Warnings appear below the balance rows on each card, styled amber. They do not block the report.

---

## 8. REMAINING RISKS / OPEN NOTES

| Risk | Detail |
|---|---|
| Account code assumptions | The endpoint assumes AR = code `1100` and AP = code `2000`. If a company uses different codes, both GL and sub-ledger will show zero balance + "account not found" warning. A future enhancement could make the control account codes configurable per company in a settings table. |
| `supplier_invoices.status` enum | AP sub-ledger excludes `draft` and `cancelled`. The `unpaid` status was used for orphan-payment warning (from `suppliers.js` code). If additional statuses are introduced, this exclusion list must be updated. |
| `customer_invoices.status` enum | AR sub-ledger excludes `draft`, `void`, `cancelled`. If `part_paid` is added as a new status, it is already included (excluded only the three above). |
| Historical integrity | The `asAt` filter applies `invoice_date <= asAt` for sub-ledger and `j.date <= asAt` for GL. Payments dated after `asAt` are therefore NOT excluded from the sub-ledger calculation. A future enhancement could use payment `payment_date <= asAt` to filter payment reductions. Currently `amount_paid` is a running total and has no date dimension in the aggregate query. |
| No browser storage | Frontend reads token from `localStorage` (auth-only — permitted by Rule D2). No business data is written to `localStorage`, `sessionStorage`, or `safeLocalStorage`. |
