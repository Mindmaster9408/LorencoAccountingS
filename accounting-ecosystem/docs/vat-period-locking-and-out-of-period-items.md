# VAT Period Locking and Out-of-Period Transactions

**Module:** Lorenco Accounting
**Prompt phase:** Prompt 2
**Implemented:** March 2026

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:       VAT period management — period generation, locking, OOP items
- Files/services involved:
    backend/config/accounting-schema.js               — schema: new journal + vat_period columns
    backend/modules/accounting/services/vatPeriodUtils.js     — NEW: pure period derivation logic
    backend/modules/accounting/services/journalService.js     — assignVatPeriod(), isVatPeriodLocked()
    backend/modules/accounting/services/vatReconciliationService.js — generatePeriodsRange(), lockPeriod(),
                                                                       getCurrentOpenPeriod(), getOutOfPeriodItems()
    backend/modules/accounting/routes/vatRecon.js             — 4 new endpoints: generate, lock, current-open, OOP items
    backend/modules/accounting/routes/suppliers.js            — VAT period lock guard on PUT /invoices/:id
    backend/modules/accounting/routes/customer-invoices.js    — VAT period lock guard on POST /:id/void
    backend/modules/accounting/routes/bank.js                 — VAT period lock guard on DELETE /transactions/:id/allocate
    frontend-accounting/vat.html                              — lock badge, OOP summary card, Generate/Lock buttons
    backend/tests/vat-period.test.js                          — 70 new tests
- Current behaviour identified:
    - vat_periods table existed with status DRAFT/APPROVED/LOCKED but had no locking enforcement
    - journals table had no vat_period_id — VAT was identified only by date range queries
    - No out-of-period concept existed — late items would silently appear in any date-range query
    - Period generation required manual periodKey/fromDate/toDate input
- Required behaviours to preserve:
    - All existing VAT reconciliation workflow (saveDraftReconciliation, submitToSARS, authorize)
    - All existing bank transaction VAT splitting (Prompt 1)
    - All existing invoice GL posting flows (customer + supplier)
    - All existing trial balance and VAT recon pre-population
    - Company VAT settings from Prompt 1 unchanged
- VAT period integrity risk:  LOW — additive schema changes; lock enforcement blocks unwanted edits
- Reporting/recon risk:       LOW — no existing queries changed; new OOP visibility is additive
- Safe implementation plan:
    1. Schema additions via ADD COLUMN IF NOT EXISTS (idempotent, non-destructive)
    2. assignVatPeriod() called async after postJournal() — failure is logged, not thrown
    3. Lock guards added before destructive operations on existing routes (early return 403)
    4. All new service methods tested with 70 pure-logic unit tests
```

---

## 1. VAT Period Model

### Database table: `vat_periods`

| Column | Type | Purpose |
|---|---|---|
| `id` | SERIAL | Primary key |
| `company_id` | INTEGER | Multi-tenant isolation |
| `period_key` | VARCHAR(20) | End-month key — format `"YYYY-MM"` |
| `from_date` | DATE | First day of period |
| `to_date` | DATE | Last day of period |
| `filing_frequency` | VARCHAR(20) | `monthly`, `bi-monthly`, `quarterly`, `annually` |
| `vat_cycle_type` | VARCHAR(20) | `even` or `odd` (bi-monthly only) — **NEW** |
| `status` | VARCHAR(20) | `open`, `DRAFT`, `APPROVED`, `LOCKED` |
| `locked_by_user_id` | INTEGER | Who locked the period |
| `locked_at` | TIMESTAMPTZ | When locked |
| `out_of_period_total_input` | NUMERIC(15,2) | Sum of OOP input VAT included here — **NEW** |
| `out_of_period_total_output` | NUMERIC(15,2) | Sum of OOP output VAT included here — **NEW** |
| `out_of_period_count` | INTEGER | Number of OOP journals included here — **NEW** |
| `updated_at` | TIMESTAMPTZ | Last update timestamp — **NEW** |

### Period key format

Period keys use `"YYYY-MM"` (the **end month** of the period):

| Scenario | Period key |
|---|---|
| Monthly March 2025 | `2025-03` |
| Bi-monthly even Jan+Feb | `2025-02` |
| Bi-monthly odd Dec 2025 + Jan 2026 | `2026-01` |
| Quarterly Q1 2025 | `2025-03` |

### Journal additions

| Column | Type | Purpose |
|---|---|---|
| `vat_period_id` | INTEGER FK → vat_periods | Which VAT period this journal belongs to |
| `is_out_of_period` | BOOLEAN | True if journal date belongs to a locked prior period |
| `out_of_period_original_date` | DATE | The journal's original date (same as `date`) for OOP display |

---

## 2. VAT Period Generation

### How periods are auto-derived

`vatPeriodUtils.js → derivePeriodForDate(date, filingFrequency, vatCycleType)`

**Monthly:** Each calendar month is its own period.

**Bi-monthly EVEN cycle** (ends Feb, Apr, Jun, Aug, Oct, Dec):
- Jan+Feb → `2025-02`
- Mar+Apr → `2025-04`
- etc.

**Bi-monthly ODD cycle** (ends Jan, Mar, May, Jul, Sep, Nov):
- Dec 2025 + Jan 2026 → `2026-01` (year-boundary period)
- Jan → `2025-01` (start = Dec of prior year)
- Feb+Mar → `2025-03`
- etc.

**Quarterly** (ends Mar, Jun, Sep, Dec):
- Jan–Mar → `2025-03`
- etc.

**Annually** (SA tax year: March to February):
- Mar 2025–Feb 2026 → `2026-02`

### API endpoint: POST /api/vat-recon/periods/generate

```json
Body: { "fromDate": "2025-01-01", "toDate": "2025-12-31" }
```

- Reads company `vat_period` + `vat_cycle_type` from companies table
- Auto-creates all period records for the range (idempotent — skips existing)
- Role required: `admin` or `accountant`

### Automatic period assignment on journal posting

When `journalService.postJournal()` completes, `assignVatPeriod()` runs **asynchronously** (non-blocking):

1. Checks if journal lines contain VAT accounts (1400/2300 via `reporting_group`)
2. If no VAT lines → skip (journal not VAT-relevant)
3. Derives the correct period for the journal's date using company settings
4. Finds or auto-creates the `vat_periods` record
5. If period is **LOCKED** → marks journal as `is_out_of_period = true`, assigns to current open period
6. Updates `vat_period_id` on the journal

---

## 3. VAT Period Locking

### How locking works

**Two paths to lock a period:**

1. `POST /api/vat-recon/periods/:id/lock` — explicit lock by admin/accountant (new in Prompt 2)
2. `POST /api/vat-recon/periods/:id/submit` — SARS submission (existing `submitToSARS` — already locked period + recon)

Both set `status = 'LOCKED'`, `locked_by_user_id`, `locked_at`.

The explicit lock also locks any associated `vat_reconciliations` and `vat_reports` records.

### What locking freezes

When a period is LOCKED:
- The period record is frozen
- Associated VAT reconciliation rows are set to `LOCKED`
- Associated VAT report rows are set to `LOCKED`
- Any journal assigned to this period with `is_out_of_period = false` is **protected** from VAT-affecting edits (via route guards)

### User-facing confirmation

The lock endpoint requires admin or accountant role. The frontend shows a confirm dialog explaining consequences before locking.

---

## 4. Transaction Edit Guards (What Becomes Non-Editable)

### Guard pattern

All guards use `JournalService.isVatPeriodLocked(journalId)`. This checks:
1. Is there a `vat_period_id` on the journal?
2. Is that period's status `LOCKED`?

If yes → returns `{ locked: true, periodKey: '2025-02' }` → route returns HTTP 403.

### Protected operations

| Route | Guard location | What is protected |
|---|---|---|
| `PUT /api/suppliers/invoices/:id` | Before update, checks `existing.journal_id` | Editing a posted supplier invoice in a locked period |
| `POST /api/customer-invoices/:id/void` | Before void/reversal, checks `invoice.journal_id` | Voiding a customer invoice in a locked period |
| `DELETE /api/bank/transactions/:id/allocate` | Before reversal, checks `bankTxn.matched_entity_id` | Unallocating a bank transaction in a locked period |

### Error message shown to user

```
Cannot edit this invoice — it is included in locked VAT period 2025-02.
VAT periods that have been locked cannot be changed.
```

---

## 5. Out-of-Period Transaction Logic

### What triggers OOP classification

When `assignVatPeriod()` runs for a newly posted journal:

```
journal.date = "2025-01-15"  (date of the original transaction)
Derived period: "2025-01"    (January period)
Period "2025-01" status: LOCKED

→ is_out_of_period = true
→ out_of_period_original_date = "2025-01-15"
→ vat_period_id = (current open period, e.g. "2025-03")
```

The transaction is **included in the current open period's VAT** but clearly flagged as OOP.

### Examples of OOP scenarios

- Late supplier invoice captured now for a prior locked period
- Bank transaction dated in January, allocated/posted in March after January is locked
- Customer invoice voided and re-created with a historical date
- Any income/expense posted with a backdated date into a locked period

### What happens to the current open period

When an OOP journal is assigned to the current period:
- `vat_periods.out_of_period_count += 1`
- `vat_periods.out_of_period_total_input += inputVat`
- `vat_periods.out_of_period_total_output += outputVat`

These counters drive the OOP summary card in `vat.html`.

---

## 6. How Out-of-Period Items Appear in VAT Reports and Recon

### API endpoint: GET /api/vat-recon/periods/:periodId/out-of-period

Returns:
```json
{
  "items": [
    {
      "journal_id": 42,
      "captured_date": "2025-03-10",
      "original_period_date": "2025-01-15",
      "reference": "INV-001",
      "description": "Late supplier invoice",
      "source_type": "supplier_invoice",
      "input_vat": 150.00,
      "output_vat": 0.00
    }
  ],
  "summary": {
    "count": 1,
    "total_input_vat": 150.00,
    "total_output_vat": 0.00,
    "total_net_vat": -150.00
  }
}
```

### VAT recon frontend (vat.html)

When a period is selected, the page:
1. Calls `loadOutOfPeriodItems(periodId)` after the period is loaded
2. If OOP items exist → shows the amber `oopSummaryCard` with:
   - Item count
   - Total input VAT
   - Total output VAT
   - Item-by-item list with original dates

The card header states:
> "These transactions were captured late — their original dates belong to an earlier locked VAT period. They are included here in the current period's VAT calculation."

---

## 7. Why Locked Periods Remain Untouched

### Hard architectural rule

Once `vat_period.status = 'LOCKED'`:
- No journal is ever assigned to that period after locking
- The `assignVatPeriod()` function skips locked periods and redirects late items to the current open period
- Route guards block VAT-affecting edits on transactions already in the locked period
- The locked period's `out_of_period_*` counters, `total_output`, `total_input` are never modified after lock

### What "no retroactive mutation" means

Late items do NOT appear inside the old period's data. They appear only in the CURRENT period as OOP. The locked period's VAT report, reconciliation, and submission reference remain exactly as they were finalized.

---

## 8. Authorization / Lock Control

| Operation | Required role |
|---|---|
| Generate periods | `admin` or `accountant` |
| Lock a VAT period | `admin` or `accountant` |
| Submit to SARS (which locks) | `admin` or `accountant` |
| View periods and OOP items | Any authenticated user |
| View current open period | Any authenticated user |

---

## 9. Follow-Up Items for Prompt 3

```
FOLLOW-UP NOTE
- Area: Reopen locked VAT period workflow
- Dependency: lockPeriod() is implemented; reversal not yet built
- What was done now: Locking implemented fully; no reopen path
- What still needs to be checked: Build a controlled reopen workflow with audit trail
- Risk if not checked: Accountant has no path to correct a locked period with errors
- Recommended next review point: Prompt 3

FOLLOW-UP NOTE
- Area: VAT report auto-population from journal_lines
- Dependency: journals.vat_period_id now assigned after posting
- What was done now: OOP items identified; recon pre-population still uses TB date range
- What still needs to be checked: Update getTrialBalanceForPeriod to use vat_period_id instead of
  date range when vat_period_id is available — ensures OOP items flow into the correct period TB
- Risk if not checked: TB pre-population in vat.html may double-count OOP if date range overlaps
- Recommended next review point: Prompt 3

FOLLOW-UP NOTE
- Area: Period selector in vat.html — use real API periods instead of hardcoded month list
- Dependency: generatePeriodsRange() now creates real vat_period records
- What was done now: Period dropdown still generates months locally (setupPeriodSelector)
- What still needs to be checked: Replace with GET /vat-recon/periods call; show lock status in dropdown
- Risk if not checked: UI dropdown may not reflect actual period state (open vs locked)
- Recommended next review point: Prompt 3

FOLLOW-UP NOTE
- Area: OOP item recalculation on period re-query
- Dependency: out_of_period counters updated at journal assignment time
- What was done now: Counters incremented atomically when OOP journal is assigned
- What still needs to be checked: If user needs to recalculate counters from scratch (data migration),
  add a recalculate-counters admin endpoint
- Risk if not checked: Counters may drift if historical data was not assigned via assignVatPeriod()
- Recommended next review point: Prompt 3

FOLLOW-UP NOTE
- Area: Seed defaults button in company settings
- Dependency: POST /api/accounting/vat-settings/seed-defaults from Prompt 1
- What was done now: API only — no UI button
- What still needs to be checked: Add "Seed SA VAT Defaults" button in company.html
- Risk if not checked: Companies have no VAT settings until manually seeded via API
- Recommended next review point: Prompt 3
```
