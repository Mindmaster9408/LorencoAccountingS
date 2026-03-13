# Accounting App — Client Isolation Fix

**Date:** 2026-03-13
**Fixed by:** Claude Code (Principal Engineering Session)
**Severity:** Critical — every user saw the same hardcoded fake demo data regardless of company

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:        Bank Transactions page (bank.html) and bank routes (bank.js)
- Files involved:            frontend-accounting/bank.html,
                             backend/modules/accounting/routes/bank.js
- Current incorrect behaviour: bank.html rendered 5 hardcoded demo transaction rows
                                ("Client Payment - ABC Corp", "Salary Payment - John Doe", etc.)
                                and 3 hardcoded fake bank account cards for every user of
                                every company. No API calls were made. All "save" actions
                                (manual transaction entry, CSV import, attachments) were
                                either localStorage-only or alert() stubs.
- Required behaviour:        Each company/client must see only their own bank accounts and
                             transactions, loaded from the real API and scoped to their
                             company_id via JWT.
- Risk of regression:        Low — backend was already correct. Frontend is being connected
                             to existing, tested API endpoints.
- Safe implementation:       Replace static HTML with dynamic rendering. No schema changes.
                             No auth model changes. Backend unchanged except one new endpoint.
```

---

## Root Cause

`frontend-accounting/bank.html` was a **static HTML demo page** — never connected to the real API.

Specifically:
1. The `<tbody id="transactionsBody">` was pre-populated with 5 hardcoded transaction rows in the HTML source (lines were removed in this fix).
2. The bank account cards section had 3 hardcoded fake accounts with fake balances.
3. `saveManualTransaction()` saved only to `localStorage` (`bank_manual_transactions` key) — no server call.
4. `completeImport()` showed an `alert()` instead of POSTing to `/api/bank/import`.
5. All attachment functions were `alert()` stubs.
6. localStorage keys were NOT scoped to company ID — data from different companies would mix in the same browser.

The backend (`bank.js`) was already production-ready with correct `WHERE company_id = $req.user.companyId` on every query.

---

## How Company Context Flows Into the Accounting App

```
User clicks "Open in Accounting" for a client in the ecosystem dashboard
  → SSO token issued by /api/auth/sso-launch with companyId in JWT payload
  → JWT stored as localStorage.token in the client (accounting app picks this up)
  → All API calls include Authorization: Bearer <token>
  → Backend middleware (auth.js) decodes JWT → sets req.user.companyId
  → Every bank.js query uses WHERE company_id = req.user.companyId
  → Only that client's data is returned
```

---

## What Was Fixed

### 1. Removed hardcoded demo HTML

356 lines of hardcoded `<tr>` demo rows removed from `bank.html`. The tbody now contains only the manual entry form row. A `DOMContentLoaded` handler clears any remaining non-entry rows immediately on load (belt and suspenders).

### 2. Added `getAuthHeaders()` helper

```javascript
function getAuthHeaders() {
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}
```

Every fetch call in bank.html now uses this to send the JWT, which carries `companyId`.

### 3. Added `getCompanyId()` and `storageKey()` helpers

```javascript
function getCompanyId() {
    try { return JSON.parse(atob(token.split('.')[1])).companyId; }
    catch (_) { return null; }
}

function storageKey(key) {
    const cid = getCompanyId();
    return cid ? ('company_' + cid + '_' + key) : key;
}
```

All localStorage keys are now namespaced to the company ID. Cross-client data bleed via localStorage is prevented.

### 4. Added `loadBankAccounts()` — replaces static hardcoded cards

```javascript
async function loadBankAccounts() {
    const res = await fetch('/api/bank/accounts', { headers: getAuthHeaders() });
    // Renders actual company bank account cards dynamically
}
```

Automatically selects the first account and populates the PDF import modal dropdown.

### 5. Added `loadTransactions()` — replaces static hardcoded rows

```javascript
async function loadTransactions() {
    const params = new URLSearchParams();
    if (selectedBankAccountId) params.set('bankAccountId', selectedBankAccountId);
    // ... fromDate, toDate, status filters ...
    const res = await fetch('/api/bank/transactions?' + params, { headers: getAuthHeaders() });
    // Renders real transaction rows dynamically
}
```

Called on page load and whenever filters or selected account changes.

### 6. Fixed `selectAccount()` — now actually switches account and reloads

```javascript
function selectAccount(card, accountId) {
    document.querySelectorAll('.bank-account-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    selectedBankAccountId = accountId || null;
    loadTransactions(); // Re-fetches transactions filtered to this account
}
```

### 7. Fixed `applyFilters()` — was an alert() stub

```javascript
function applyFilters() {
    loadTransactions(); // Now actually filters from API
}
```

### 8. Fixed `saveManualTransaction()` — now POSTs to API

```javascript
async function saveManualTransaction() {
    // ... validation ...
    const res = await fetch('/api/bank/transactions', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ bankAccountId: selectedBankAccountId, date, description, reference, amount })
    });
    // On success: cancelManualEntry() + loadTransactions()
}
```

Requires a bank account to be selected first. On success, reloads transactions from the server.

### 9. Fixed `completeImport()` CSV path — now POSTs to API

```javascript
async function completeImport() {
    // ... parse CSV rows to transaction objects ...
    const res = await fetch('/api/bank/import', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ bankAccountId: selectedBankAccountId, transactions })
    });
    // On success: closeImportModal() + loadTransactions()
}
```

### 10. Added `POST /api/bank/transactions` backend endpoint (manual creation)

`bank.js` — new endpoint:
```
POST /api/bank/transactions
Requires: bank.manage permission
Body: { bankAccountId, date, description, reference?, amount, balance? }
- Verifies bankAccountId belongs to req.user.companyId
- Inserts with company_id = req.user.companyId and status = 'unmatched'
- Audit-logged
```

### 11. Scoped all localStorage keys to company ID

| Old key | New key |
|---------|---------|
| `lorenco_bank_allocations` | `company_{id}_bank_allocations` |
| `bank_manual_transactions` | `company_{id}_bank_manual_transactions` |
| `reviewedTransactions` | `company_{id}_reviewedTransactions` |
| `lorenco_sean_learning` | `company_{id}_sean_learning` |

---

## How Company Switching Clears Stale Data

When a user switches from Client A to Client B:

1. SSO issues a new JWT with Client B's `companyId`
2. `localStorage.token` is updated to the new JWT
3. `bank.html` re-loads → `getCompanyId()` returns Client B's ID
4. `loadBankAccounts()` fetches Client B's bank accounts from the API
5. `loadTransactions()` fetches Client B's transactions (filtered by JWT companyId)
6. Client A's data is never shown — it's not in Client B's API response
7. localStorage keys use Client B's company ID prefix — Client A's cached UI state is ignored

**The API is the source of truth. UI state is never shared between companies.**

---

## How Demo/Default Data Is Isolated

- No demo data is hardcoded in `bank.html` anymore
- The backend never returns demo transactions — all queries are scoped to `company_id`
- If a company has no bank transactions, the UI shows "No transactions found for the selected filters"
- If a company has no bank accounts, the UI shows a helpful "Add a bank account in Settings" message
- The SSO demo mode (if still active) only affects the ecosystem dashboard — not the accounting app

---

## Whether Data Cleanup/Migration Is Needed

**No database cleanup needed.**

The issue was purely frontend — the static HTML was rendering fake data instead of fetching real data from the database. The database already contained correct `company_id` on all records. No transactions were mis-saved with wrong company ownership.

However:
- Any `bank_manual_transactions` data previously saved to localStorage (under the non-scoped key) is now orphaned — those fake manual transactions exist only in the browser's localStorage and can be safely ignored. They were never in the database.
- The new non-scoped localStorage keys (`lorenco_bank_allocations`, etc.) in old browser sessions may still hold stale data. This is harmless — the accounting state is now driven by the API.

---

## Files Changed

| File | Type | Purpose |
|------|------|---------|
| `frontend-accounting/bank.html` | Modified | Connected to real API — removed all demo HTML, added loadBankAccounts/loadTransactions/getAuthHeaders, fixed saveManualTransaction/completeImport, scoped localStorage |
| `backend/modules/accounting/routes/bank.js` | Modified | Added `POST /api/bank/transactions` endpoint for manual transaction creation |

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Bank Transactions — allocation UI
- What was done now: Save/import now POST to real API
- What still needs checking: The "Allocate" / journal creation flow in the UI
  (allocateTransaction() function) still calls the client-side LedgerSystem.
  This should be wired to POST /api/bank/transactions/:id/allocate.
- Risk if not checked: Journal entries created via UI allocation may not be
  persisted to the database.
- Recommended next review: Wire allocateTransaction() to POST /api/bank/transactions/:id/allocate.

FOLLOW-UP NOTE
- Area: Bank Transactions — attachments
- What was done now: UI attachment upload/download functions remain as alert() stubs.
- What still needs checking: These should call POST /api/bank/transactions/:id/attachments
  and GET /api/bank/attachments/:id/download.
- Risk if not checked: Users cannot attach documents to transactions.
- Recommended next review: Wire attachment functions to real API endpoints.

FOLLOW-UP NOTE
- Area: Accounting — other pages (dashboard, journals, reports, chart of accounts)
- What was done now: Only bank.html was fixed.
- What still needs checking: Other accounting pages may have the same static demo pattern.
  Run a similar audit on dashboard.html, journal.html, reports.html, etc.
- Risk if not checked: Other pages may also show static demo data instead of company data.
- Recommended next review: Audit all remaining frontend-accounting/*.html pages.
```

---

## Safeguards Against Future Cross-Client Data Leakage

1. **All API endpoints enforce `company_id = req.user.companyId`** — verified in this audit.
2. **JWT carries `companyId`** — set at SSO launch time, cannot be changed client-side without invalidating the token.
3. **All localStorage keys are now company-scoped** — `storageKey()` helper ensures this.
4. **No hardcoded demo data in bank.html** — demo rows permanently removed.
5. **`loadTransactions()` always fetches fresh from API** — no in-memory cache that persists across company switches.
6. **`selectedBankAccountId` resets on `loadBankAccounts()`** — company switch triggers full re-initialization.
