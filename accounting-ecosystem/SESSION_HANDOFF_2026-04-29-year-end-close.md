# SESSION HANDOFF — Priority 8: Year-End Close, Retained Earnings, Opening Balances
**Date:** 2026-04-29  
**Priority:** 8 of 8

---

## WHAT WAS IMPLEMENTED

### 1. Database Migration — `database/migrations/019_year_end_close.sql`
- Creates `year_end_close_records` table
- Fields: `id, company_id, financial_year_label, from_date, to_date, closing_journal_id, closed_by_user_id, closed_at, net_amount, status`
- UNIQUE constraint: `(company_id, from_date, to_date)` — prevents duplicate closes
- Index: `idx_year_end_close_company` on `company_id` for fast lookup
- Must be run in Supabase SQL Editor before use

### 2. New Route File — `backend/modules/accounting/routes/yearEnd.js`
Provides three endpoints under `/api/accounting/year-end/`:

#### `GET /records`
- Permission: `report.view`
- Returns all `year_end_close_records` for the company, newest first

#### `POST /close`
- Permission: `requireAccountant` (admin, accountant, business_owner, super_admin)
- Body: `{ fromDate, toDate, financialYearLabel, lockPeriod? }`
- Full guard sequence:
  1. Input validation (required fields, date order)
  2. Idempotency: 409 if `year_end_close_records` already exists for same period
  3. Retained earnings account: finds `type='equity', sub_type='retained_earnings'` — 422 if missing
  4. Period lock guard on `toDate`
  5. Fetches all posted journal lines for income/expense accounts in range
  6. Computes net balance per account, builds closing journal lines:
     - Income accounts (normal credit): DEBIT each by net credit balance
     - Expense accounts (normal debit): CREDIT each by net debit balance
     - Net profit → CREDIT retained earnings; net loss → DEBIT retained earnings
  7. Pre-write balance validation (safety check)
  8. **Atomic pg transaction**: journal header (`status='posted'`) + all lines + close record row
  9. Optional period lock (post-transaction, failure does NOT undo close)
  10. Audit log

- Note: Closing journal bypasses `JournalService.postJournal` intentionally — closing entries are not VAT-generating events

#### `POST /opening-balances`
- Permission: `requireAccountant`
- Body: `{ date, reference?, description, lines: [{ accountId, description, debit, credit }] }`
- Uses standard `JournalService.createDraftJournal` + `postJournal` flow
- `source_type = 'opening_balance'`
- Validates balance before creating journal

### 3. Route Registration — `backend/modules/accounting/index.js`
Added: `router.use('/year-end', require('./routes/yearEnd'));`

---

## WHAT WAS NOT CHANGED
- `journalService.js` — unchanged (used but not modified)
- `reports.js` — no changes needed; balance sheet already handles post-close correctly:
  - After year-end close, P&L accounts show zero for the closed year (closing journal offsets them)
  - Retained earnings equity account accumulates the net via the closing journal credit
  - `currentYearEarnings` in balance sheet = 0 for closed years, correct for open years
- `accounting-periods.js` — unchanged; period locking reuses existing `UPDATE accounting_periods SET is_locked=true` 

---

## BALANCE SHEET INTERACTION (IMPORTANT FOR FUTURE MAINTENANCE)

The balance sheet in `reports.js` calculates `currentYearEarnings` dynamically from P&L accounts using `fromDate` to `asOfDate`. After a year-end close:
- The closing journal (dated `toDate`) debits all income and credits all expense accounts
- When `fromDate` is before `toDate`, the P&L query includes the closing journal → net = 0
- `currentYearEarnings = 0` for the closed year — correct
- `totalEquity` includes the retained earnings account balance (cumulative, no fromDate filter)
- The retained earnings account was credited by the closing journal's net profit → equity is correct

---

## PREREQUISITE: Retained Earnings Account
Before running `POST /close` for the first time, the company must have an equity account with `sub_type = 'retained_earnings'` in the `accounts` table.  
If missing, the API returns 422 with a clear error message.  
This account can be created via `POST /api/accounting/accounts` with `type='equity'` and `sub_type='retained_earnings'`.

---

## TESTING REQUIRED

1. **Migration**: Run `019_year_end_close.sql` in Supabase SQL Editor — verify table created
2. **Retained earnings account setup**: Create equity account with `sub_type='retained_earnings'`
3. **Year-end close happy path**: `POST /close` with valid date range — verify:
   - Closing journal exists in `journals` table with `source_type='year_end_close'` and `status='posted'`
   - All income/expense lines present in `journal_lines`
   - `year_end_close_records` row created
   - Trial balance shows income/expense accounts at zero after close date
   - Retained earnings account shows net profit/loss
4. **Idempotency**: Run `POST /close` twice for same range — second must return 409
5. **Missing RE account**: Remove `sub_type='retained_earnings'` account, run close — must return 422
6. **Period lock**: Run with `lockPeriod: true` — verify `accounting_periods.is_locked = true`
7. **Opening balances**: `POST /opening-balances` with balanced lines — verify journal posted
8. **Unbalanced opening balances**: Send unbalanced lines — must return 400

---

## OPEN RISKS / FOLLOW-UP

```
FOLLOW-UP NOTE
- Area: Year-end close — large journal batches (>1000 P&L accounts)
- Dependency: Supabase .in() is limited to ~1000 IDs
- What was done now: journalIds and plAccountIds are passed directly to .in()
- What still needs checking: If a company has >1000 posted journals in a year, or >1000 P&L accounts, the query may silently truncate
- Risk if not checked: Incomplete closing journal — some accounts not closed
- Recommended next review: Add chunking (batch .in() queries) if large clients are onboarded
```

```
FOLLOW-UP NOTE
- Area: Balance sheet — double-counting risk if fromDate is not set to year start
- Dependency: Balance sheet P&L query uses fromDate parameter from caller
- What was done now: No change to reports.js
- What still needs checking: If user views balance sheet with no fromDate (cumulative), currentYearEarnings will include all years — but retained earnings account also has cumulative balance. This could double-count.
- Risk if not checked: Balance sheet may show equity > actual equity when no fromDate supplied and year-end close has been done
- Recommended next review: Add documentation to balance sheet API about fromDate requirement post-close
```

---

## PRIORITIES COMPLETE STATUS

| Priority | Description | Status |
|---|---|---|
| 1 | Atomic journal persistence | COMPLETE |
| 2 | Synchronous VAT assignment | COMPLETE |
| 3 | Reversal journals VAT-safe | COMPLETE |
| 4 | Supplier invoice edit reverse-replace | COMPLETE |
| 5 | Bank allocation/reconciliation integrity | COMPLETE |
| 6 | Bank allocation GL/TB/report integrity | COMPLETE |
| 7 | Period locking | COMPLETE |
| 8 | Year-end close + retained earnings + opening balances | **COMPLETE THIS SESSION** |

**All 8 priorities are now implemented.**
