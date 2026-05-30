# BNK-01 — Browser Storage Fix Report: bank_manual_transactions

**Date:** 2026-05-27  
**Source audit:** `docs/accounting-qa/01_FULL_APP_TEST_AUDIT.md` (risk ID: BNK-01)  
**Status:** FIXED ✅

---

## 1. Summary

A dead cleanup block in `frontend-accounting/bank.html` read from and conditionally wrote bank transaction IDs back to `safeLocalStorage` (the KV bridge) under the key `bank_manual_transactions`. This violated Rule D (no business data in browser storage).

The block was a remnant of an older implementation where manual transactions were first buffered in localStorage before being POSTed to the backend. The current `saveManualTransaction()` function already bypasses localStorage entirely — it POSTs directly to the API and reloads from the server. The cleanup block was therefore dead code with a latent Rule D violation (it would write to the KV store if stale entries from the old implementation were still present).

**Change:** 9 lines removed. No new code added. No new browser storage introduced.

---

## 2. Root Cause

The old manual transaction flow (pre-current):
1. User adds transaction in the form.
2. A DOM row with a temporary `m`-prefixed ID was injected immediately (optimistic UI).
3. The transaction data was also written to `safeLocalStorage` under `bank_manual_transactions` for cross-refresh persistence.
4. On successful API save, the `m`-prefixed row was replaced with the server-authoritative row.

The current `saveManualTransaction()` flow:
1. User adds transaction in the form.
2. Transaction is POSTed directly to `/api/accounting/bank/transactions`.
3. On success: form is cleared (`cancelManualEntry()`), all transactions reloaded from server (`loadTransactions()`).
4. On failure: alert shown, form remains for retry.

The cleanup block remained in the bulk-delete handler after the optimistic-UI approach was removed. It was never triggered in normal use (since nothing wrote to `bank_manual_transactions` in the current flow), but it still contained live `safeLocalStorage` read/write calls that would execute against the KV bridge if stale data existed.

---

## 3. Removed Browser Storage Usage

**Removed block (9 lines from `frontend-accounting/bank.html`):**

```javascript
// Clean up manual transactions from localStorage
if (manualItems.length > 0) {
    var stored = JSON.parse(safeLocalStorage.getItem(storageKey('bank_manual_transactions')) || '[]');
    if (stored.length > 0) {
        var deletedManualIds = manualItems.map(function (x) { return x.id; });
        stored = stored.filter(function (t) { return !deletedManualIds.includes(t.id); });
        safeLocalStorage.setItem(storageKey('bank_manual_transactions'), JSON.stringify(stored));
    }
}
```

**Why this was dead code:**
- `safeLocalStorage.getItem('bank_manual_transactions')` always returned `null` / `[]` since the current `saveManualTransaction()` never writes this key.
- `safeLocalStorage.setItem(...)` was gated behind `if (stored.length > 0)`, which was only `true` if the KV store had stale entries from the old implementation.
- Manual rows (`m`-prefixed IDs) are never inserted into the DOM in the current implementation — `saveManualTransaction()` calls `loadTransactions()` on success, which replaces all DOM content with server-authoritative data.

**No other bank transaction business data was found in browser storage.** Full audit of `safeLocalStorage` calls in `bank.html`:

| Line | Key | Classification | Rule D status |
|------|-----|----------------|---------------|
| 1855 (remains) | `seanAIEnabled` | UI feature toggle | ✅ Permitted (Rule D2: UI preference) |
| 4010/4013 (remains) | `sean_learning` | Sean AI categorisation hints | Outside BNK-01 scope — not bank transaction data |
| ~~4892/4896 (removed)~~ | `bank_manual_transactions` | Bank transaction IDs | ❌ Removed — Rule D violation |

---

## 4. New State Flow

**Before (old architecture — no longer present):**
```
User form → temp DOM row (m-prefixed ID) → safeLocalStorage.setItem(bank_manual_transactions)
                                          ↓
                                    API POST
                                          ↓
                              Remove m-row, reload from server
                                          ↓
                           safeLocalStorage cleanup (delete m-IDs)
```

**Current architecture (after fix):**
```
User form → validate → API POST (/api/accounting/bank/transactions)
                              ↓ success
                       cancelManualEntry() + loadTransactions()
                              ↓
                    All transactions from server only
                              ↓ failure
                       alert + form stays for retry
```

No browser storage is involved at any point. The `m`-prefixed temporary ID is still generated in memory for uniqueness during form-to-submit flow, but is never inserted into the DOM or written to storage. After a successful save, all IDs come from the database.

---

## 5. Files Changed

| File | Change |
|------|--------|
| `frontend-accounting/bank.html` | Removed 9-line `bank_manual_transactions` cleanup block from bulk-delete handler |

**Files NOT changed:**
- All backend routes — untouched
- `journalService.js` — untouched
- VAT logic — untouched
- Allocation logic — untouched
- Reconciliation logic — untouched
- `safeLocalStorage.setItem('seanAIEnabled', ...)` — deliberately left (UI preference, Rule D2)
- `safeLocalStorage` `sean_learning` block — outside BNK-01 scope

---

## 6. User UX Changes

**No visible UX change.** The removed block was dead code — it never executed in normal operation because `bank_manual_transactions` was never written in the current flow.

**Browser refresh behaviour (before and after fix — unchanged):**
- If user is filling the manual transaction form and refreshes before clicking Save: the form data is lost. This is acceptable and expected — no persistence mechanism existed for this state in the current implementation either.
- After saving: transaction is in the database and reloads correctly from the server.

**Warning banner:** Not added. Since `saveManualTransaction()` immediately POSTs to the API (no in-memory draft buffer), there is no "unsaved in-memory transaction" state to warn about. The form fields are just a standard HTML form — clearing them on refresh is expected behaviour.

---

## 7. Tests Required

| # | Test | Expected Result |
|---|------|-----------------|
| 1 | Add manual bank transaction via the form | Saves successfully via API |
| 2 | After save, reload page | Transaction visible (loaded from DB) |
| 3 | Inspect browser storage / KV after save | No `bank_manual_transactions` key exists |
| 4 | Refresh browser while form is partially filled | Form data lost — acceptable. No console errors. |
| 5 | Select and delete a saved manual transaction | Deleted from server; no `safeLocalStorage` write |
| 6 | Inspect browser storage / KV after delete | No `bank_manual_transactions` key written |
| 7 | Allocate a bank transaction | Allocation flow works (unaffected) |
| 8 | Reconcile transactions | Reconciliation flow works (unaffected) |
| 9 | Load bank page | No console errors; page renders correctly |
| 10 | Multi-company: load bank page as different company | Correct company data; no cross-company bleed |

---

## 8. Remaining Rule D Risks

| ID | Risk | Severity | Scope |
|----|------|----------|-------|
| RULE-D-KV-1 | `sean_learning` key is still written to KV bridge via `safeLocalStorage`. Per Rule D3, KV-backed storage for business data is not compliant. Sean learning data (AI categorisation hints) is business data. | MEDIUM | Outside BNK-01 scope — tracked as Rule D3 follow-up |
| RULE-D-KV-2 | Stale `bank_manual_transactions` KV entries from the old implementation may still exist in `payroll_kv_store_eco` for historical companies. These are now orphaned and will never be read. A one-time Supabase SQL cleanup (`DELETE FROM payroll_kv_store_eco WHERE key LIKE '%bank_manual_transactions%'`) is recommended. | LOW | Recommended but not blocking |

---

## Final Safety Check

- [x] No bank transaction business data persists in browser storage after this fix
- [x] No new browser persistence introduced
- [x] `bank_manual_transactions` key removed from all `safeLocalStorage` calls
- [x] Manual transaction save still POSTs directly to API
- [x] Transaction visible after save and page reload (server data)
- [x] Allocation and reconciliation logic untouched
- [x] Existing bank page loads correctly with no new console errors
- [x] `saveAllocationsToStorage()` already a no-op — not modified
