# Opening Balance / Prior Year Trial Balance Import Engine
## Implementation Report — Migration 046

**Date:** 2026  
**Migration:** `046_opening_balances.sql`  
**Status:** Implemented — pending Supabase migration run

---

## Purpose

Provides a governed, auditable workflow for importing a prior-year or opening trial balance into the Lorenco accounting general ledger. The engine allows:

1. Creating named import batches (manual or by source: Xero, Sage, Pastel, etc.)
2. Capturing trial balance lines (source account code, name, debit/credit amounts)
3. Mapping source accounts to the company's Chart of Accounts
4. Validating that the TB is balanced (|Debits − Credits| ≤ 0.01)
5. Finalizing: creating and immediately posting a journal (`source_type = 'opening'`) in the general ledger
6. Full audit trail of every line change, mapping, finalization

---

## Database Tables

All three tables created in migration `046_opening_balances.sql`.

### `opening_balance_batches`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | Auto-generated |
| company_id | INTEGER | Multi-tenant scope |
| created_by | INTEGER | FK → users.id |
| source_type | TEXT | manual / csv_import / xero / sage / pastel / quickbooks / other |
| source_name | TEXT NOT NULL | User-provided label |
| effective_date | DATE NOT NULL | Date of the trial balance |
| description | TEXT | Optional |
| status | TEXT | CHECK: draft / validated / finalized / archived |
| debit_total | NUMERIC(18,2) | Recalculated from active lines |
| credit_total | NUMERIC(18,2) | Recalculated from active lines |
| variance | NUMERIC(18,2) | debit_total − credit_total |
| finalized_at | TIMESTAMPTZ | Set on finalization |
| finalized_by | INTEGER | User who finalized |
| journal_id | INTEGER | FK → journals.id (set on finalization) |
| created_at / updated_at | TIMESTAMPTZ | Audit timestamps |

### `opening_balance_lines`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| batch_id | UUID FK | ON DELETE CASCADE |
| company_id | INTEGER | Multi-tenant scope |
| source_account_code | TEXT | As-imported code |
| source_account_name | TEXT | As-imported name |
| mapped_account_id | INTEGER | FK → accounts.id |
| mapped_account_code | TEXT | Denormalized for display |
| mapped_account_name | TEXT | Denormalized for display |
| debit | NUMERIC(18,2) | Non-negative; only one of debit/credit may be non-zero |
| credit | NUMERIC(18,2) | Non-negative |
| line_status | TEXT | CHECK: unmapped / mapped / excluded |
| source_row_number | INTEGER | Preserves import order |
| notes | TEXT | Optional notes |

### `opening_balance_audit_log`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| company_id | INTEGER | |
| batch_id | UUID FK | ON DELETE CASCADE |
| line_id | UUID nullable | ON DELETE SET NULL |
| action | TEXT | e.g. batch_created, line_added, line_mapped, batch_finalized |
| old_value | JSONB | Previous state |
| new_value | JSONB | New state |
| performed_by | INTEGER | User ID |
| performed_at | TIMESTAMPTZ | |
| reason | TEXT | Optional |

---

## API Endpoints

Base path: `GET|POST|DELETE /api/accounting/opening-balances/...`

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| GET | `/batches` | opening_balance.view | List batches; optional `?status=` filter |
| POST | `/batches` | opening_balance.create | Create draft batch |
| GET | `/batch/:batchId` | opening_balance.view | Get single batch |
| GET | `/batch/:batchId/lines` | opening_balance.view | Get all lines for batch |
| POST | `/batch/:batchId/manual-line` | opening_balance.create | Add or update a line (upsert via `lineId`) |
| DELETE | `/batch/:batchId/line/:lineId` | opening_balance.edit | Delete a line |
| POST | `/batch/:batchId/map-line` | opening_balance.edit | Map a line to a COA account |
| POST | `/batch/:batchId/unmap-line` | opening_balance.edit | Clear mapping (also restores excluded → unmapped) |
| POST | `/batch/:batchId/exclude-line` | opening_balance.edit | Exclude a line from totals/journal |
| POST | `/batch/:batchId/validate` | opening_balance.finalize | Validate TB balance; marks batch 'validated' |
| POST | `/batch/:batchId/finalize` | opening_balance.finalize | Create + post journal; lock batch |
| POST | `/batch/:batchId/archive` | opening_balance.archive | Archive finalized batch |
| GET | `/accounts/search?q=term` | opening_balance.view | Search postable COA accounts |

---

## Permissions (middleware/auth.js)

```javascript
'opening_balance.view':     ['admin', 'accountant', 'bookkeeper', 'viewer'],
'opening_balance.create':   ['admin', 'accountant'],
'opening_balance.edit':     ['admin', 'accountant'],
'opening_balance.finalize': ['admin', 'accountant'],
'opening_balance.archive':  ['admin', 'accountant'],
```

---

## Service Class

`backend/modules/accounting/services/openingBalancesService.js`

### Key Business Rules Enforced

1. **No auto-balancing** — if Debits ≠ Credits the batch cannot be finalized. No suspense entries.
2. **No sign flipping** — debit/credit amounts pass through to journal lines exactly as entered.
3. **Postable accounts only** — `_validatePostableAccount()` rejects inactive or non-postable (`is_postable = false`) accounts.
4. **Finalized batch is immutable** — all mutation methods check `status !== 'finalized'` (and `!== 'archived'`) before proceeding.
5. **Excluded lines excluded** — lines with `line_status = 'excluded'` are not included in totals, validation, or journal lines.
6. **Period lock respected** — `finalizeBatch()` calls `JournalService.isPeriodLocked()` before creating the journal.
7. **One journal per batch** — finalization creates exactly one journal with `source_type = 'opening'`, immediately posted.
8. **Totals auto-refreshed** — `_refreshBatchTotals()` is called after every mutation that changes line amounts.
9. **All queries company-scoped** — every read and write includes `company_id` from `req.user.companyId`.
10. **Validation must precede finalization** — batch must be in `'validated'` status to finalize.

### Journal Integration

```
finalizeBatch()
  → validateBatch() (re-validates before posting)
  → JournalService.isPeriodLocked(companyId, effectiveDate)
  → JournalService.createDraftJournal({
       reference: 'OB-{batchId[0:8]}',
       sourceType: 'opening',
       lines: [ { accountId, debit, credit } × all mapped non-excluded lines ]
     })
  → JournalService.postJournal(journalId, companyId, userId)
  → UPDATE opening_balance_batches SET status='finalized', journal_id=...
```

---

## Debit/Credit Convention

`journal_lines` uses **separate `debit` and `credit` DECIMAL columns** (not a signed amount column). Opening balance lines mirror this: each line has a separate `debit` and `credit` amount, and exactly one must be non-zero. No sign transformation occurs at any point in the pipeline.

---

## Frontend

`frontend-accounting/opening-balances.html`

### Layout
- **Batch list view** — sortable by status filter; shows debit total, credit total, variance per batch
- **Batch detail view** — inline line entry form; variance panel always visible; progress summary (mapped/unmapped/excluded counts)

### Variance Panel
Always visible when viewing a batch. Shows Debits, Credits, Variance. Variance cell turns red if `|variance| > 0.01` and a blocking alert banner appears. Finalize button is disabled until batch is `'validated'` AND variance ≤ 0.01 AND no unmapped lines remain.

### Account Mapping
Each unmapped line has an inline search input with debounced typeahead (300ms). Results show account code + name. Non-postable (parent) accounts are shown greyed-out and non-selectable. Selecting an account calls the `map-line` endpoint and refreshes.

### Nav
Added "Opening Balances" link under the **Historical** section in `frontend-accounting/js/navigation.js`.

---

## How to Apply the Migration

Run the following in Supabase SQL editor (or via the migration runner):

```sql
-- File: accounting-ecosystem/database/migrations/046_opening_balances.sql
```

Tables created:
- `opening_balance_batches`
- `opening_balance_lines`
- `opening_balance_audit_log`

RLS is enabled on all three tables. Service-role key bypasses RLS; all server-side queries run as service-role.

---

## Files Changed / Created

| File | Change |
|------|--------|
| `database/migrations/046_opening_balances.sql` | Created — 3 tables, indexes, RLS |
| `backend/modules/accounting/services/openingBalancesService.js` | Created — full service class |
| `backend/modules/accounting/routes/openingBalances.js` | Created — 13 API endpoints |
| `backend/modules/accounting/middleware/auth.js` | 5 new `opening_balance.*` permissions added |
| `backend/modules/accounting/index.js` | Route mounted at `/opening-balances` |
| `frontend-accounting/opening-balances.html` | Created — full UI |
| `frontend-accounting/js/navigation.js` | "Opening Balances" added to Historical nav section |

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Migration
- What must be checked: Run 046_opening_balances.sql against the Supabase database
- Risk if not done: All API endpoints will return 500 (tables do not exist)
- Recommended next step: Run the migration in Supabase SQL editor before deploying

FOLLOW-UP NOTE
- Area: CSV Import
- What was done now: source_type = 'csv_import' is supported as an enum value
- What still needs to be checked: No actual CSV parsing/upload endpoint is built yet; it is a manual entry engine only
- Risk if wrong: Low — UI shows manual line entry only; CSV parsing is a future feature

FOLLOW-UP NOTE
- Area: IRP5 / Opening Balance Tax Implications
- What was done now: Opening balance journal is posted with source_type = 'opening'
- What still needs to be checked: Whether the opening balance date needs to align with a specific tax period or accounting period start — no period-creation enforcement is done here (period lock is checked, but period must already exist)
- Recommended next check: Confirm the effective_date falls within an unlocked accounting period before production use
```
