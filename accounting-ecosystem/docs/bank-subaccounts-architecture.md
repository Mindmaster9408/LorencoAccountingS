# Bank Subaccounts Architecture
## Multiple Bank Accounts Under the Same COA Parent

---

## CHANGE IMPACT NOTE

- **Area being changed:** Chart of Accounts bank-account linking; bank account creation/edit endpoints; Trial Balance and Balance Sheet rendering
- **Files involved:** `backend/modules/accounting/routes/bank.js`, `frontend-accounting/trial-balance.html`, `frontend-accounting/balance-sheet.html`, `frontend-accounting/bank.html`
- **Current behaviour identified:** Each bank account links directly to a COA account (`ledger_account_id`). If two bank accounts point to the same COA account, all their transactions post to a single GL line — they are indistinguishable in reports.
- **Required behaviours to preserve:** Bank-account linking, PDF statement import, CSV import, bank transaction allocation, journal auto-posting, Trial Balance, Balance Sheet, all existing single-bank-account clients
- **Bank import regression risk:** NONE — the import flow (`POST /bank/import`) writes to `bank_transactions` using `bank_account_id`. Since `bank_account.ledger_account_id` now points to a subaccount instead of the parent, the allocation engine correctly posts to the right subaccount. No code in the import path was changed.
- **Reporting risk:** LOW — reports already show all accounts individually sorted by code. Subaccounts (e.g. `1010-01`) naturally sort immediately after their parent (`1010`) due to string ordering. Frontend now visually groups children under parents.
- **Safe implementation plan:** Additive only. New helper `resolveOrCreateSubaccount()` runs on POST/PUT bank account. Existing data never modified. Subaccounts are only created when a conflict is detected.

---

## 1. Audit Findings

### 1.1 accounts table (existing)
```sql
CREATE TABLE accounts (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL,
  code        VARCHAR(20) NOT NULL,
  name        VARCHAR(255) NOT NULL,
  type        VARCHAR(50) NOT NULL,
  parent_id   INTEGER REFERENCES accounts(id),   -- ALREADY EXISTS
  sub_type    VARCHAR(50),
  ...
  UNIQUE(company_id, code)
);
```

**`parent_id` already exists as a nullable self-referential FK.** No schema migration needed.

### 1.2 bank_accounts table (existing)
```sql
CREATE TABLE bank_accounts (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL,
  name                  VARCHAR(255) NOT NULL,
  bank_name             VARCHAR(255),
  account_number_masked VARCHAR(50),
  ledger_account_id     INTEGER REFERENCES accounts(id),  -- FK to COA
  ...
);
```

`ledger_account_id` is the single source of truth for GL posting.

### 1.3 Allocation engine
`POST /bank/transactions/:id/allocate` reads `bank_accounts.ledger_account_id` and uses it as the bank-side GL account in the journal entry. If `ledger_account_id` is null, allocation fails with 400.

### 1.4 Reports
Both Trial Balance and Balance Sheet query **all** accounts individually and include `parent_id` in their response payload. The frontend was not previously using `parent_id` for visual grouping — this has now been added.

### 1.5 PDF / CSV import
`POST /bank/import` inserts `bank_account_id` and `company_id` on every transaction row. It never reads or sets `ledger_account_id` — that mapping happens at allocation time. PDF import is completely unaffected by this change.

### 1.6 Bank account COA codes (Standard SA Base)
| Code | Name | Type |
|------|------|------|
| 1000 | Cash on Hand | current_asset / bank_cash |
| 1010 | Bank — Cheque Account | current_asset / bank_cash |
| 1020 | Petty Cash | current_asset / bank_cash |
| 1030 | Bank — Savings / Call Account | current_asset / bank_cash |
| 2110 | Bank Overdraft | current_liability / bank_cash |

---

## 2. Parent-Child Bank Account Model

### 2.1 When does a subaccount get created?

A subaccount is created automatically when:
1. A new bank account is created (or an existing one is edited to change its ledger account), AND
2. The selected `ledger_account_id` is **already linked** to another active bank account in the same company

When the selected account is free (only one bank account uses it), it is used directly — **no subaccount is created**. This preserves all existing behaviour for clients with a single cheque account and a single savings account.

### 2.2 Example: First cheque account
Client creates "ABSA Main Cheque" and selects `1010 Bank — Cheque Account`:

```
COA:           1010  Bank — Cheque Account
bank_accounts: ABSA Main Cheque  → ledger_account_id = id_of_1010
```

No conflict → no subaccount. Backward-compatible. All existing clients with a single account remain unchanged.

### 2.3 Example: Second cheque account
Client adds "ABSA Payroll Cheque" and again selects `1010 Bank — Cheque Account`:

Conflict detected (ABSA Main Cheque already owns 1010).

System auto-creates:
```
COA:  1010-01  Bank — Cheque Account — ABSA Payroll Cheque
                parent_id = id_of_1010
```

New bank account links to `1010-01`.

```
COA:
  1010    Bank — Cheque Account          (owned by ABSA Main Cheque)
  1010-01 Bank — Cheque Account — ABSA Payroll Cheque  (new, parent=1010)

bank_accounts:
  ABSA Main Cheque    → ledger_account_id = id_of_1010
  ABSA Payroll Cheque → ledger_account_id = id_of_1010-01
```

### 2.4 Example: Third cheque account
Another conflict with `1010`. Next subaccount:
```
1010-02  Bank — Cheque Account — Third Account   parent_id = id_of_1010
```

---

## 3. Subaccount Code Format

```
[parent_code]-[sequence]

Sequence: 2-digit zero-padded integer, starting at 01

Examples:
  1010     → parent (Bank — Cheque Account)
  1010-01  → first child
  1010-02  → second child

  1030     → parent (Bank — Savings / Call Account)
  1030-01  → first savings child
  1030-02  → second savings child
```

### Why this format is safe
- `UNIQUE(company_id, code)` treats `1010` and `1010-01` as different strings → both can coexist
- `VARCHAR(20)` comfortably fits codes like `1010-01`
- String sort order places `1010-01` immediately after `1010` → natural visual grouping in reports

---

## 4. Subaccount Inheritance

When a subaccount is created, it inherits from its parent:
- `type` (asset/liability/equity/income/expense)
- `sub_type` (current_asset, etc.)
- `reporting_group` (bank_cash, etc.)
- `sort_order` (parent.sort_order + sequence number)
- `is_active = true`
- `is_system = false` (user-removable if no longer needed)

Name format: `{parent.name} — {bankAccountName}`

---

## 5. Reporting Behaviour

### 5.1 Trial Balance
Accounts are sorted by code (`localeCompare`). Since `1010-01` sorts after `1010`, subaccounts naturally appear directly below their parent.

Rendering rules:
- Account has children (`parent_id` referenced by at least one sibling) → **bolded** (parent header)
- Account has `parent_id` set → **indented** with `↳` marker, slightly smaller font
- All other accounts → normal rendering

This is purely visual — the underlying numbers are not affected. Each account's debit/credit totals reflect only its own journal entries.

### 5.2 Balance Sheet
Same visual grouping rules as Trial Balance. Parent account shown in bold with its own balance. Children indented beneath it.

**Important:** If a client has been using `1010` directly (before a second account was added), `1010` will show the historical balance and any new first-account transactions. `1010-01` will show the second account's transactions from when it was created. This is correct accounting — no backdating or migration occurs.

### 5.3 General Ledger
Not explicitly modified — the GL already shows journal entries per account. Subaccounts each get their own GL lines since they are distinct accounts.

---

## 6. PDF and CSV Import Compatibility

**No changes were made to the import flow.**

The import chain:
1. `POST /bank/import/pdf` — parses PDF, returns transaction list (no DB write)
2. `POST /bank/import` — user confirms; inserts rows into `bank_transactions` with `bank_account_id` and `company_id`
3. `POST /bank/transactions/:id/allocate` — reads `bank_accounts.ledger_account_id` → posts to GL

After this change, step 3 simply reads the `ledger_account_id` which may now point to a subaccount (`1010-01`) instead of the parent (`1010`). The journal entry is correctly posted to the subaccount's GL. Everything else is identical.

**PDF import safety guarantee:** The import endpoint never reads or interprets `ledger_account_id`. It only sets `bank_account_id`. The GL mapping is entirely deferred to the allocation step.

---

## 7. Backward Compatibility

| Scenario | Behaviour after this change |
|---|---|
| Client with 1 cheque account | No change. `bank_account.ledger_account_id` still points to `1010` directly. No subaccount created. |
| Client with 2 cheque accounts (new) | First account keeps `1010`. Second gets auto-created `1010-01`. |
| Existing journal entries posted to `1010` | Not touched. Continue to show under `1010` in all reports. |
| Allocation on existing transactions | Works identically. `ledger_account_id` resolution unchanged. |
| PDF / CSV import | Unchanged. |
| `bank_accounts.ledger_account_id = null` | Unchanged — allocation still returns 400 if no ledger account linked. |

---

## 8. Helper Function: resolveOrCreateSubaccount

Implemented in `backend/modules/accounting/routes/bank.js`.

Called in:
- `POST /bank/accounts` — before inserting the new bank account row
- `PUT /bank/accounts/:id` — only when `ledgerAccountId` changes to a different value

Logic:
1. Query `bank_accounts` for other active accounts in the same company with `ledger_account_id = requestedId`
2. If none → return `requestedId` unchanged
3. If found → fetch parent account, count existing subaccounts, create next `[code]-NN` child, return child id

The caller receives `{ ledgerAccountId, subaccountCreated }`. If `subaccountCreated` is non-null, the API response includes it and the frontend shows an informational alert.

---

## 9. Follow-Up Work (Recommended)

| Item | Priority | Notes |
|---|---|---|
| "Promote existing account to subaccount" tool | Medium | If a client already has two bank accounts both pointing to `1010`, a manual promotion tool would let them clean up the mapping without touching journal entries |
| Parent account balance aggregation in reports | Low | Currently parent accounts show only their own direct journal entries. A future "group total" row could sum parent + all children for a cleaner Balance Sheet view |
| GL view filtered by bank account | Medium | Allow filtering the GL view by bank account (not just COA account) — useful when a bank account's subaccount code is not known to the user |
| Subaccount name edit | Low | Currently the name is auto-generated. Allowing rename via the bank account edit modal (which already feeds the `name` field to the helper) is straightforward |
| dark-theme CSS for `.account-parent` / `.account-child` rows | Low | Current CSS uses inline colours for child rows — add dark theme overrides in `css/dark-theme.css` |
