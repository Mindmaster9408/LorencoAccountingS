# VAT Settings and Bank Transaction VAT — Architecture & Implementation

**Module:** Lorenco Accounting
**Prompt phase:** Prompt 1
**Implemented:** March 2026

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:       VAT foundation — company settings, VAT rate config, bank transaction VAT
- Files/services involved:
    backend/config/accounting-schema.js          — schema: new companies columns + vat_settings table
    backend/modules/accounting/routes/company.js — mapCompanyRow + PUT handler for new VAT fields
    backend/modules/accounting/routes/vat-settings.js  — NEW: CRUD for VAT type/rate catalogue
    backend/modules/accounting/routes/bank.js    — allocate endpoint: VAT splitting on ACCOUNT lines
    backend/modules/accounting/index.js          — register vat-settings route
    frontend-accounting/company.html             — VAT registration toggle + cycle type + date
    frontend-accounting/bank.html                — VAT dropdown for ACCOUNT allocations
- Current behaviour identified:
    - companies table had vat_number and vat_period but no is_vat_registered boolean
    - no vat_settings table — VAT rate hardcoded at 15% in suppliers.js
    - bank allocation sent accountId + amount only — no VAT split
    - VAT Input (1400) and VAT Output (2300) accounts already auto-seeded in COA
    - VAT reconciliation and trial balance integration already existed
- Required behaviours to preserve:
    - All existing supplier invoice VAT logic (calcLineVAT) unchanged
    - All existing customer invoice VAT GL posting unchanged
    - All existing bank allocation flow for non-VAT cases unchanged
    - VAT reconciliation/recon service unchanged
    - company.js ECO Hub sync (eco_clients) unchanged
- VAT reporting risk:      LOW — bank transaction VAT flows to 1400/2300 via journal; TB picks it up
- Posting/regression risk: LOW — VAT splitting only activates when vatSettingId provided on line
- Safe implementation plan:
    1. Schema additions are additive (ADD COLUMN IF NOT EXISTS, new table)
    2. Company route changes are backward-safe (new fields with defaults)
    3. Bank allocate: vatSettingId is optional; old callers without it are unaffected
    4. Frontend: VAT dropdown hidden by default; only appears for ACCOUNT + VAT-registered
```

---

## 1. Company VAT Registration Settings

### New database columns (companies table)

| Column | Type | Purpose |
|---|---|---|
| `is_vat_registered` | BOOLEAN DEFAULT false | Master switch — controls VAT feature availability |
| `vat_cycle_type` | VARCHAR(20) | `'even'` or `'odd'` — for bi-monthly filers |
| `vat_registered_date` | DATE | Effective start date of VAT registration |

The existing `vat_number` and `vat_period` columns are retained.

### API fields (company.js)

| API field | DB column | Notes |
|---|---|---|
| `isVatRegistered` | `is_vat_registered` | Boolean; explicit false is stored correctly |
| `vatCycleType` | `vat_cycle_type` | `'even'` or `'odd'` |
| `vatRegisteredDate` | `vat_registered_date` | ISO date string |

### Frontend (company.html)

- **VAT Registered toggle** (checkbox styled as slider) — master on/off
- When toggled OFF: VAT Number, VAT Frequency, Cycle Type, and Registration Date fields are hidden
- When toggled ON: all four fields are shown; VAT Number is visually required
- **VAT Submission Frequency** replaces the old "VAT Period" select (same `vatPeriod` field, new label):
  - Monthly
  - Every 2 Months (Bi-Monthly)
  - Quarterly
  - Annually
- **Bi-Monthly Cycle** shown only when frequency = bi-monthly:
  - Even months (Feb, Apr, Jun, Aug, Oct, Dec)
  - Odd months (Jan, Mar, May, Jul, Sep, Nov)
- **VAT Registration Date** — optional date picker

---

## 2. VAT Cycle / Frequency Model

### What "bi-monthly" means

South African VAT vendors with a Category B or C tax period submit every two months.
The cycle determines which months form a period end:

| Cycle | Period end months |
|---|---|
| Even | February, April, June, August, October, December |
| Odd | January, March, May, July, September, November |

### How it works in the system

`vat_period` stores the filing frequency (monthly / bi-monthly / quarterly / annually).
`vat_cycle_type` stores the bi-monthly variant (even / odd).

The VAT period creation logic in `vatReconciliationService.js` uses `filing_frequency` on the `vat_periods` table (already existing). The new `vat_cycle_type` field on companies gives the system what it needs to auto-generate the correct period dates in a future implementation.

---

## 3. VAT Rate / Category Configuration (vat_settings table)

### Table structure

```sql
vat_settings (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code           VARCHAR(30) NOT NULL,
  name           VARCHAR(100) NOT NULL,
  rate           NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_capital     BOOLEAN DEFAULT false,
  is_active      BOOLEAN DEFAULT true,
  effective_from DATE NOT NULL DEFAULT '1990-01-01',
  effective_to   DATE,
  sort_order     INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, code, effective_from)
)
```

### SA default categories (seeded via POST /api/accounting/vat-settings/seed-defaults)

| Code | Name | Rate | Capital | Active |
|---|---|---|---|---|
| `standard` | Standard Rate (15%) | 15% | No | Yes |
| `standard_capital` | Standard Rate — Capital (15%) | 15% | Yes | Yes |
| `zero` | Zero Rated (0%) | 0% | No | Yes |
| `exempt` | Exempt | 0% | No | Yes |
| `old_rate` | Old Rate (14%) | 14% | No | No |
| `old_rate_capital` | Old Rate — Capital (14%) | 14% | Yes | No |

### Historical rate support

The `UNIQUE(company_id, code, effective_from)` constraint allows multiple entries per code, one per rate era:

```
code='standard', rate=14, effective_from='1990-01-01', effective_to='2018-03-31'
code='standard', rate=15, effective_from='2018-04-01', effective_to=NULL
```

This ensures old transactions can reference the correct historical rate, and future rate changes can be pre-loaded.

---

## 4. VAT Settings API

**Base URL:** `/api/accounting/vat-settings`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | any authenticated user | List all VAT settings for company |
| GET | `/active?date=YYYY-MM-DD` | any authenticated user | Active settings for a given date (defaults today) |
| POST | `/seed-defaults` | admin / accountant | Seed SA standard categories (idempotent) |
| POST | `/` | admin / accountant | Create a new VAT category |
| PUT | `/:id` | admin / accountant | Update a VAT category |
| DELETE | `/:id` | admin only | Deactivate (soft delete) — never hard-deletes historical records |

---

## 5. Bank Transaction VAT Eligibility Rules

### The critical rule

**VAT may only be applied in bank transactions when allocation type = ACCOUNT.**

| Allocation type | VAT allowed? | Reason |
|---|---|---|
| `account` | YES (if company VAT registered) | Direct GL expense/income — VAT belongs here |
| `customer` | NO | Settling a customer invoice — VAT already posted on invoice |
| `supplier` | NO | Settling a supplier invoice — VAT already posted on invoice |
| `transfer` | NO | Bank-to-bank transfer — no VAT |
| `vat` | NO | This type is for paying SARS directly — not a VAT-bearing purchase |

This prevents double-counting: if VAT was posted when the invoice was created, it must not be posted again when the payment is received or made.

### Frontend guard

In `bank.html`, the VAT dropdown (`vatSelectWrap_${txnId}`) is shown only when:
1. `allocation.type === 'account'`, AND
2. `window._companyIsVatRegistered === true` (loaded from `/api/accounting/vat-settings/active`)

The `window._companyIsVatRegistered` flag is set to `true` if the company has any active VAT settings. Companies that have not seeded their VAT settings will see no VAT dropdown.

---

## 6. Bank Transaction VAT Calculation

### Convention: VAT-inclusive (gross amount)

Bank statement amounts are always gross. If you see "Bank Charges R115" on your statement, R115 left your account — that is the gross VAT-inclusive amount.

Therefore: **the default is `vatInclusive: true`** for bank transaction allocations.

### Calculation (15% inclusive example)

```
Gross amount:  R115.00
Ex-VAT amount: R115 / 1.15 = R100.00
VAT amount:    R115 - R100 = R15.00
```

### Journal entries produced

**Payment OUT (money leaving bank) — expense with VAT:**

| Account | Debit | Credit |
|---|---|---|
| Bank account (e.g. 1010) | — | R115.00 |
| Bank Charges (e.g. 6100) | R100.00 | — |
| VAT Input — 1400 | R15.00 | — |

**Receipt IN (money entering bank) — income with VAT:**

| Account | Debit | Credit |
|---|---|---|
| Bank account (e.g. 1010) | R115.00 | — |
| Rental Income (e.g. 4600) | — | R100.00 |
| VAT Output — 2300 | — | R15.00 |

### Zero-rated and exempt

If the selected VAT category has rate = 0%, no VAT journal line is created. The full gross amount goes to the allocation account. This is correct for zero-rated supplies and exempt items.

---

## 7. VAT Flow into Reports and Reconciliation

### How it works

The bank transaction VAT amount is posted to account **1400** (VAT Input) or **2300** (VAT Output) via the journal entry. These accounts are part of the Chart of Accounts and are included in the Trial Balance.

The existing VAT reconciliation infrastructure (`/api/accounting/vat-recon/trial-balance`) already reads these accounts from the GL. So by correctly posting to 1400/2300, the VAT value **automatically flows into the VAT reconciliation trial balance** — no additional wiring needed.

The flow:
```
Bank allocation with VAT
  → Journal posted atomically (bank.js allocate)
  → VAT amount in account 1400 or 2300
  → Trial Balance includes 1400/2300
  → VAT Recon pre-population picks up TB amounts
  → VAT 201 filing reflects correct totals
```

---

## 8. Permissions and Authorization

| Operation | Required role |
|---|---|
| View VAT settings | Any authenticated user |
| Create / update VAT settings | `admin` or `accountant` |
| Deactivate VAT setting | `admin` only |
| Seed SA defaults | `admin` or `accountant` |
| Update company VAT registration | `admin` or `accountant` (via company.js authorize) |

Historical VAT rates are never hard-deleted. The DELETE route soft-deactivates only.

---

## 9. How to Set Up a New VAT-Registered Company

1. Go to **Company Settings** → Tax Information
2. Toggle **VAT Registered?** to Yes
3. Enter the **VAT Number** (required)
4. Set **VAT Submission Frequency** (monthly / bi-monthly / quarterly)
5. If bi-monthly: select **Even** or **Odd** cycle
6. Optionally enter **VAT Registration Date**
7. Save
8. Call `POST /api/accounting/vat-settings/seed-defaults` (or an admin UI button in a future prompt) to seed the SA standard VAT categories
9. VAT dropdowns will now appear in bank transaction ACCOUNT allocations

---

## 10. Follow-Up Items for Prompt 2

```
FOLLOW-UP NOTE
- Area: VAT settings administration UI
- Dependency: vat-settings.js route is complete; no dedicated admin page yet
- What was done now: API is complete; seed-defaults endpoint exists
- What still needs to be checked: Build a VAT Settings admin page (list, add, edit, deactivate rates)
- Risk if not checked: Users must call the API directly to seed defaults — no UI path
- Recommended next review point: Prompt 2 VAT admin UI

FOLLOW-UP NOTE
- Area: VAT recon auto-population from GL
- Dependency: Trial balance already wired; but reconciliation lines need auto-fill from bank+invoice journals
- What was done now: Bank transaction VAT posts to 1400/2300 — TB picks it up
- What still needs to be checked: Implement auto-population of VAT recon lines from journal data grouped by VAT category
- Risk if not checked: Accountant still manually enters values in recon rows
- Recommended next review point: Prompt 2 or 3

FOLLOW-UP NOTE
- Area: VAT period auto-generation using vat_cycle_type
- Dependency: vat_cycle_type now stored on companies
- What was done now: Field is stored; logic not yet implemented
- What still needs to be checked: vatReconciliationService createOrGetPeriod should use vat_cycle_type to auto-calculate period dates
- Risk if not checked: Period dates still entered manually
- Recommended next review point: Prompt 2

FOLLOW-UP NOTE
- Area: Seed defaults — no UI trigger yet
- Dependency: POST /api/accounting/vat-settings/seed-defaults exists
- What was done now: API only
- What still needs to be checked: Add a "Seed SA VAT Defaults" button in Company Settings or VAT Settings page
- Risk if not checked: Companies have no VAT settings until manually seeded via API
- Recommended next review point: Prompt 2

FOLLOW-UP NOTE
- Area: VAT on bank transactions — ex-VAT mode
- Dependency: vatInclusive flag supported in API
- What was done now: Default is vatInclusive=true; vatInclusive=false also works
- What still needs to be checked: Consider adding a toggle in bank.html allocation UI for inc/ex-VAT mode
- Risk if not checked: Minor UX limitation — all bank allocations default to inc-VAT
- Recommended next review point: Prompt 2
```
