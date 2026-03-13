# Bank Transactions Screen — Feature Documentation

**File:** `frontend-accounting/bank.html`
**Backend:** `backend/modules/accounting/routes/bank.js`
**Last updated:** March 2026

---

## Overview

The Bank Transactions screen allows accountants to view, allocate, reconcile, and manage bank transactions for a client company. It supports:

- Manual transaction entry
- Bulk import via CSV
- Transaction allocation to ledger accounts (with optional VAT calculation)
- AI-powered match suggestions (Sean AI)
- Attachment uploads per transaction
- Reviewed/New tabbed workflow
- Reconciliation state tracking

---

## Column Layout

The transaction table uses `table-layout: fixed` with the following column widths:

| # | Column             | Width  |
|---|--------------------|--------|
| 1 | Checkbox           | 40px   |
| 2 | Date               | 90px   |
| 3 | Description        | auto (min 180px) |
| 4 | Reference          | 95px   |
| 5 | Money In           | 105px  |
| 6 | Money Out          | 105px  |
| 7 | Balance            | 105px  |
| 8 | Transaction Type   | 185px  |
| 9 | Account            | 210px  |
| 10| Status             | 95px   |
| 11| Upload             | 55px   |
| 12| Attachments        | 95px   |
| 13| Actions            | 85px   |
| 14| AI                 | 85px   |

> **Note:** Columns 8 and 9 were widened from 135px/150px to 185px/210px in March 2026 to prevent the Transaction Type and Account dropdowns from visually overlapping.

The `.allocation-select` CSS uses `width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box` to ensure dropdown elements always fit within their column and never overflow into adjacent cells.

---

## Manual Transaction Entry

### How It Works

A fixed "NEW" entry row is always visible at the top of the transactions table. Users fill in the fields and click **Save** to create a new manual transaction.

### Fields

| Field           | Required | Notes |
|-----------------|----------|-------|
| Date            | Yes      | Defaults to today, editable |
| Description     | Yes      | Free text |
| Reference       | No       | Free text |
| Money In        | Conditional | Use for income/credits. Mutually exclusive with Money Out |
| Money Out       | Conditional | Use for expenses/debits. Mutually exclusive with Money In |
| Transaction Type| No       | Customer Payment / Supplier Payment / Transfer / VAT Payment / Account |
| Account         | No       | Populated dynamically based on Transaction Type via `updateManualAccountOptions()` |

### Validation Rules

1. **Description** is required — field turns red if empty on Save.
2. **Exactly one** of Money In or Money Out must have a value — both blank or both filled triggers an error.
3. When Money In is typed, Money Out is automatically disabled (and vice versa).

### Save Behaviour

When **Save** is clicked:
- Validates inputs (see above)
- Generates a unique string ID: `'m' + Date.now() + sequence`
- Builds a new transaction row using the same 14-column structure as imported transactions
- Inserts the row immediately below the manual entry form row
- Creates a paired AI suggestion row (hidden by default)
- Initialises the `transactionAllocations` record if an account was selected
- Persists to `safeLocalStorage` under key `bank_manual_transactions` as a JSON array
- Resets the form to its empty/default state

### Cancel Behaviour

Clears all fields and resets the date to today.

### Architecture Note

Manual transactions use the same data model as imported transactions. Their row structure is identical (14 columns, same CSS classes, same `data-txn-id` pattern) so that:
- `getTransactionData(id)` works correctly on them
- `allocateTransaction(id)` can post them to journal entries
- The tab filter (New/Reviewed) applies normally
- Sean AI analysis can be run on them

The manual entry form row has class `.manual-entry-row` and `id="manualEntryRow"`. All existing `querySelectorAll` row selectors exclude it via `:not(.manual-entry-row)` to preserve index-based transaction lookups.

---

## Delete Selected Transactions

### How It Works

1. User selects one or more transaction rows via checkboxes
2. User clicks **Delete Selected** in the bulk actions bar
3. System performs safety checks
4. A custom confirmation modal is shown
5. On confirm, rows are removed from the DOM and storage is updated

### Safety Rules

| Transaction Status | Behaviour |
|--------------------|-----------|
| `status-reconciled` | **Blocked.** Cannot delete. Users must reverse reconciliation first. |
| `status-matched` (allocated) | **Warning shown** in the confirmation modal. Deletion is permitted but user is clearly informed that the journal entry will be left without a linked bank transaction. |
| `status-unmatched` | Permitted without warning. |

### What Gets Cleaned Up

- The transaction `<tr>` is removed from the DOM
- The paired AI suggestion `<tr>` is also removed
- The entry in `transactionAllocations[id]` is deleted
- `saveAllocationsToStorage()` is called to persist the updated allocation state
- `updateBulkActions()` is called to reset the bulk action bar
- If the deleted row was a manual transaction (ID starts with `'m'`), it is removed from `bank_manual_transactions` in safeLocalStorage

### Confirmation Modal

The modal shows:
- Count of transactions to be deleted
- Warning block if any are allocated (matched) to journal entries
- **Cancel** and **Delete** buttons

Example warning:
> ⚠️ **2 allocated transaction(s)** have journal entries assigned. Deleting will leave those journal entries without a linked bank transaction.

---

## Backend API: DELETE /api/bank/transactions/:id

### Route

```
DELETE /api/bank/transactions/:id
```

### Authentication

Requires `bank.manage` permission.

### Query Parameters

| Parameter | Type    | Description |
|-----------|---------|-------------|
| `force`   | `'1'`   | Required to delete an `matched` (allocated) transaction. Without it, a 409 is returned. |

### Responses

| Status | Meaning |
|--------|---------|
| 200    | `{ success: true, message: 'Transaction deleted' }` |
| 404    | Transaction not found or belongs to a different company |
| 403    | Transaction is reconciled — deletion blocked |
| 409    | Transaction is allocated — add `?force=1` to override |
| 500    | Internal server error |

### Error Codes

| `code`         | Meaning |
|----------------|---------|
| `RECONCILED`   | Transaction has been through reconciliation — cannot delete |
| `ALLOCATED`    | Transaction has a matched journal entry — requires `?force=1` |

### What the Route Does

1. Verifies the transaction exists and belongs to `req.user.companyId`
2. Checks status — blocks `reconciled`, warns on `matched`
3. Deletes all file attachments from disk
4. Deletes attachment records from `bank_transaction_attachments`
5. Deletes the transaction from `bank_transactions`
6. Writes an audit log entry via `AuditLogger`

> **Note (March 2026):** The frontend currently works with static HTML rows and does not call this endpoint. The endpoint is architecturally complete for when the frontend is upgraded to load transactions from the API.

---

## Transaction Status Flow

```
unmatched → (allocate to account) → matched → (reconcile) → reconciled
```

- **Unmatched** — transaction exists, no account allocation yet
- **Matched** — allocated to a ledger account, draft journal entry created
- **Reconciled** — confirmed against bank statement, journal posted

---

## Transaction Data Model

Fields stored per transaction (both imported and manual):

| Field             | Type      | Notes |
|-------------------|-----------|-------|
| `date`            | DATE      | Transaction date |
| `description`     | TEXT      | Narrative |
| `reference`       | TEXT      | Reference number |
| `moneyIn`         | NUMERIC   | Credit amount (positive) |
| `moneyOut`        | NUMERIC   | Debit amount (positive) |
| `type`            | TEXT      | customer / supplier / transfer / vat / account |
| `accountCode`     | TEXT      | Linked ledger account code |
| `accountName`     | TEXT      | Linked ledger account display name |
| `status`          | TEXT      | unmatched / matched / reconciled |

---

## Account Dropdown Population

The Account dropdown is dynamically populated by `updateAccountOptions(row, type, id)` based on the selected Transaction Type:

| Type             | Accounts shown |
|------------------|----------------|
| Customer Payment | Income accounts + Accounts Receivable (1100) |
| Supplier Payment | Expense accounts + Accounts Payable (2000) |
| VAT Payment      | VAT Payable (2300) + VAT Input (2310) |
| Transfer         | Bank accounts (codes starting with `10`) |
| Account / blank  | All accounts grouped by type |

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Manual transactions — backend persistence
- What was done: Manual transactions saved to safeLocalStorage (bank_manual_transactions)
- What still needs to be done: When bank.html is upgraded to load transactions from
  API via GET /api/bank/transactions, POST /api/bank/transactions endpoint needs to
  be created for manual entry, replacing the current localStorage approach.
- Risk: Manual transactions currently lost on new device / browser clear

FOLLOW-UP NOTE
- Area: Delete frontend — API integration
- What was done: DELETE /api/bank/transactions/:id backend route implemented
- What still needs to be done: Frontend bulkDelete() currently removes from DOM only.
  When real backend data is loaded, API call DELETE /api/bank/transactions/:id should
  be made with ?force=1 when a matched transaction is confirmed for deletion.

FOLLOW-UP NOTE
- Area: Status badge for matched (allocated) transactions
- What was done: Delete checks for .status-matched CSS class to identify allocated txns
- What to verify: Ensure any transaction allocated via allocateTransaction() receives
  .status-matched class correctly. Verified in allocateTransaction() at line ~2640 —
  confirmed it updates badge to "Allocated" (status-matched class).
```
