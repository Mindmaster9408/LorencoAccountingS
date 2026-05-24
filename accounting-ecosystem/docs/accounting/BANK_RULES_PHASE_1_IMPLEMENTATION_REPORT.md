# Bank Rules Phase 1 — Implementation Report

**Date:** May 2026  
**Status:** Complete and pushed  
**Preceding audit:** `BANK_RULES_FORENSIC_AUDIT.md`  
**Related roadmap:** `docs/future-build/BANK_RULES_AND_SEAN_AI_FUTURE_ROADMAP.md`

---

## 1. Executive Summary

This report documents the Phase 1 implementation of the Bank Allocation Rules engine. The forensic audit (`BANK_RULES_FORENSIC_AUDIT.md`) identified that no bank rules table existed, allocation drafts were persisted in `safeLocalStorage` (RULE D3 violation), and there was no deterministic suggestion mechanism for unallocated bank transactions.

Phase 1 delivers a complete, production-ready bank rules system: per-company rules, canonical normalisation, a 3-pass matching pipeline, a management UI, and full audit trail integration. Rules are suggest-only — no auto-post path was created.

---

## 2. Files Created

| File | Purpose |
|---|---|
| `database/migrations/048_bank_allocation_rules.sql` | Creates `bank_allocation_rules` table with indexes and trigger |
| `backend/modules/accounting/services/bankDescriptionNormalizer.js` | Canonical normaliser — single source of truth for all new bank rules code |
| `backend/modules/accounting/routes/bankRules.js` | Full CRUD API + `/suggest` endpoint |
| `frontend-accounting/bank-rules.html` | Management UI — create, edit, deactivate, apply_count display |
| `docs/future-build/BANK_RULES_AND_SEAN_AI_FUTURE_ROADMAP.md` | Phase 2–7 roadmap |

---

## 3. Files Modified

| File | Change |
|---|---|
| `backend/modules/accounting/index.js` | Mounted `/bank/rules` BEFORE `/bank` to prevent Express routing conflict |
| `backend/modules/accounting/routes/bank.js` | Added `appliedRuleId` validation and `BANK_RULE_ACCEPTED` audit event to allocation endpoint |
| `frontend-accounting/bank.html` | Removed safeLocalStorage allocation draft persistence; added suggestion prefill + override detection |
| `frontend-accounting/js/navigation.js` | Updated Bank Rules nav link from `#` to `/accounting/bank-rules.html` |

---

## 4. Database Schema (Migration 048)

```sql
CREATE TABLE bank_allocation_rules (
  id                   SERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  match_type           VARCHAR(20) NOT NULL DEFAULT 'contains'
                       CHECK (match_type IN ('exact', 'contains', 'starts_with')),
  match_pattern        TEXT NOT NULL,
  normalized_pattern   TEXT NOT NULL,
  allocation_type      VARCHAR(30) NOT NULL DEFAULT 'account'
                       CHECK (allocation_type IN ('account')),
  account_id           INTEGER NOT NULL REFERENCES accounts(id),
  vat_setting_id       INTEGER NULL REFERENCES vat_settings(id) ON DELETE SET NULL,
  priority             INTEGER NOT NULL DEFAULT 100,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  source               VARCHAR(30) NOT NULL DEFAULT 'user'
                       CHECK (source IN ('user', 'manual')),
  created_by_user_id   INTEGER REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_applied_at      TIMESTAMPTZ,
  apply_count          INTEGER NOT NULL DEFAULT 0
);
```

Three indexes: `idx_bank_rules_company_active`, `idx_bank_rules_priority`, `idx_bank_rules_normalized` (partial on active rules only).

---

## 5. Canonical Normaliser

`bankDescriptionNormalizer.js` strips:
- Sequences of 4+ digits (account numbers, reference numbers)
- Date patterns (DD/MM/YY, DD/MM/YYYY)
- Rand amounts (R followed by digits/commas)
- All punctuation except spaces

Then lowercases and trims. So `"ESKOM 202405 REF 123456789 R1,250.00"` normalises to `"eskom ref"` — matching a rule with pattern `"eskom"` via `contains`.

**This normaliser is applied at both rule creation and rule matching.** Rules therefore match structurally, not character-for-character.

---

## 6. Suggestion Pipeline (3-Pass)

The `/suggest` endpoint for a given `bankTransactionId`:

1. Fetch the transaction (must be `unmatched` and company-scoped)
2. Fetch all active rules for the company, ordered by `priority ASC`, `updated_at DESC` (most recent tie-break)
3. Normalise the transaction description with `normalizeBankDescription()`
4. **Pass 1:** Exact match — `normalised_txn === rule.normalized_pattern`
5. **Pass 2:** Contains — `normalised_txn.includes(rule.normalized_pattern)`
6. **Pass 3:** Starts-with — `normalised_txn.startsWith(rule.normalized_pattern)`
7. On first match: verify the rule's account is still active and postable (guard)
8. Update `apply_count` and `last_applied_at` (non-blocking)
9. Log `BANK_RULE_SUGGESTED` audit event (non-blocking)
10. Return `{ suggestion: { source: 'bank_rule', ruleId, matchPattern, matchType, accountId, accountCode, accountName, vatSettingId, vatSettingCode, vatSettingName, confidence: 100, reason } }`

If no rule matches: `404 { message: 'No rule matches this transaction' }`.

---

## 7. CRUD API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/accounting/bank/rules` | List all rules for company (includes account/VAT joins) |
| `POST` | `/api/accounting/bank/rules` | Create rule — validates account (postable, active, company-scoped), normalises pattern |
| `PUT` | `/api/accounting/bank/rules/:id` | Update rule — re-normalises pattern if match_pattern changes |
| `DELETE` | `/api/accounting/bank/rules/:id` | Soft deactivate — sets `is_active=false`, returns 409 if already inactive |
| `GET` | `/api/accounting/bank/rules/suggest?bankTransactionId=` | 3-pass matching, returns suggestion or 404 |

All routes: company-scoped via `req.user.companyId`, authenticated, require `bank.allocate` permission (list/suggest: `bank.view`).

---

## 8. RULE D1/D3 Compliance Fix

### Before
```javascript
// RULE D3 VIOLATION — allocation drafts persisted to KV bridge
let transactionAllocations = JSON.parse(safeLocalStorage.getItem(storageKey('bank_allocations')) || '{}');
function saveAllocationsToStorage() {
    safeLocalStorage.setItem(storageKey('bank_allocations'), JSON.stringify(transactionAllocations));
}
```

### After
```javascript
// In-memory only — RULE D1/D3 compliant
let transactionAllocations = {};
function saveAllocationsToStorage() {
    // No-op: allocation draft state is in-memory only (RULE D1 compliance)
}
```

All 13 call sites to `saveAllocationsToStorage()` are preserved as no-ops. No call sites were removed. The function signature was kept to avoid regressions in the many places it is called.

---

## 9. bank.html Suggestion Prefill

After each page render in `renderPage()`, `prefillRuleSuggestions(slice)` fires asynchronously (non-blocking — never fails page render):

- For each unmatched transaction on the current page, calls `/api/accounting/bank/rules/suggest?bankTransactionId=X`
- Only prefills if the user has not already made a selection for that row (`transactionAllocations[id].type` absent)
- Prefills: type select → `account`, account select → `rule.accountCode`, VAT select → `rule.vatSettingId`
- Shows a green banner row: "✓ Suggested by bank rule: [pattern] → [accountCode] [accountName]"
- `transactionAllocations[id].appliedRuleId` is set so the allocation call passes it to the backend

### Override detection
When the user manually changes the type or account select after a rule suggestion:
- `transactionAllocations[id].appliedRuleId` is cleared
- `transactionAllocations[id]._fromRule` is set to `false`
- Banner updates to: "Rule suggestion overridden." (muted/italic)

### Allocation propagation
Both row-level `allocateTransaction()` and bulk `bulkAllocate()` pass `appliedRuleId` (if set) in the POST body.

---

## 10. bank.js Allocation Endpoint Changes

### appliedRuleId validation
```javascript
if (appliedRuleId != null) {
  const { data: ruleRow } = await supabase
    .from('bank_allocation_rules')
    .select('id, is_active')
    .eq('id', appliedRuleId)
    .eq('company_id', req.user.companyId)
    .maybeSingle();
  if (!ruleRow) return 422 INVALID_RULE_ID;
  if (!ruleRow.is_active) return 422 INACTIVE_RULE;
}
```

### Journal metadata
`appliedRuleId` is included in journal metadata when set:
```javascript
metadata: Object.assign(
  { bankTransactionId: bankTxn.id },
  appliedRuleId != null ? { appliedRuleId } : {}
)
```

### BANK_RULE_ACCEPTED audit event
Fires after successful allocation when `appliedRuleId` is set. Non-blocking (errors are swallowed to never fail the allocation response).

---

## 11. Audit Events

| Event | When |
|---|---|
| `BANK_RULE_SUGGESTED` | `/suggest` returns a match. Increments `apply_count`, updates `last_applied_at`. |
| `BANK_RULE_ACCEPTED` | Allocation completes with `appliedRuleId` set. |
| `CREATE` on `BANK_ALLOCATION_RULE` | Standard AuditLogger event on rule create. |
| `UPDATE` on `BANK_ALLOCATION_RULE` | Standard AuditLogger event on rule edit. |
| `DEACTIVATE` on `BANK_ALLOCATION_RULE` | Logged on soft-delete. |

---

## 12. Constraints Confirmed (As Scoped)

| Constraint | Status |
|---|---|
| Rules are suggest-only | Confirmed — no auto-post path in Phase 1 |
| No Sean AI dependency | Confirmed — `/suggest` is rule-only in Phase 1 |
| No split-line rules | Confirmed — Phase 3 |
| No regex match type | Confirmed — Phase 4 |
| No CUSTOMER/SUPPLIER allocation_type | Confirmed — Phase 5 |
| Multi-tenant scoped | Confirmed — all queries `.eq('company_id', companyId)` |
| No parent/non-postable accounts in rules | Confirmed — API validates `is_postable` and `is_active` at creation |

---

## 13. Manual Steps Required Before Going Live

1. **Run migration 048 in Supabase SQL Editor:**
   ```
   accounting-ecosystem/database/migrations/048_bank_allocation_rules.sql
   ```

2. **Verify the `update_updated_at_column()` function exists** (created in migration 020 — prerequisite).

3. **Test in staging:** Create a bank rule for a known pattern (e.g. "ESKOM"), import a bank statement with a matching transaction, confirm the suggestion appears on the unmatched row.

---

## 14. Known Open Items (Non-Blocking)

| Item | Tracking |
|---|---|
| `sean_learning_*` still in `safeLocalStorage` | Future migration to `sean_knowledge_mappings` SQL table |
| `bank_manual_transactions` still in `safeLocalStorage` | Future migration to `bank_transactions` with `source: manual` |
| `prefillRuleSuggestions` fires N API calls (one per unmatched row per page) | Batch endpoint to be added in Phase 2 |
| `BANK_RULE_OVERRIDDEN` audit event not yet implemented | Phase 7 — override count tracking |

---

*Implementation complete. Migration 048 must be applied manually in the Supabase SQL Editor before bank rules can be created or matched.*
