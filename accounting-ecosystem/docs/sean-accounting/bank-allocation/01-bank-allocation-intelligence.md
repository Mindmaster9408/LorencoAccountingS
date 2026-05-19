# Sean AI — Bank Allocation Intelligence

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — Bank Transaction Auto-Allocation  
> **Last updated:** May 2026

---

## 1. Overview

This document describes the future Sean AI layer for the bank transaction allocation workflow.

The existing bank allocation flow (as of May 2026):
1. Accountant imports bank statement (PDF → staging → confirm → `bank_transactions`)
2. Each transaction lands with `status = 'unmatched'`
3. Accountant manually selects a GL account and clicks Allocate
4. Backend creates a journal, sets `status = 'matched'`
5. Accountant reconciles matched transactions

**Future flow with Sean active:**
After step 2, Sean analyses the transaction description and suggests (or auto-allocates) a GL account before the accountant touches it.

---

## 2. What Sean Analyses Per Transaction

For each `unmatched` bank transaction, Sean considers:

| Signal | Weight | Notes |
|---|---|---|
| Transaction description (normalized) | High | Primary signal |
| Transaction amount | Medium | Some categories correlate to amount ranges |
| Transaction direction (debit/credit) | High | Determines income vs expense accounts |
| Vendor/payee recognition | High | Known SA vendors mapped to categories |
| Historical allocations for this description | Very High | Company-specific learned patterns |
| Historical allocations for similar descriptions | Medium | Cross-client anonymized patterns |
| Bank account context | Low | Some accounts have recurring patterns |

---

## 3. What Sean Outputs

For each transaction analysis, Sean produces:

```json
{
  "transactionId": 1234,
  "suggestedAccountId": 890,
  "suggestedAccountName": "Bank Charges",
  "confidence": 0.91,
  "confidenceSource": "company_history",
  "reasoning": "Previous 14 transactions with 'FNB SERVICE FEE' allocated to Bank Charges",
  "autoApplied": true,
  "requiresReview": false,
  "vatImplication": null
}
```

- `autoApplied` = `true` only when confidence >= threshold AND no conflicting bank rule exists
- `requiresReview` = `true` when confidence < threshold
- `reasoning` is stored in the audit log (see `rules-and-precedence/04-governance-safety.md`)

---

## 4. Confidence Threshold

See `learning-model/03-confidence-threshold.md` for full details.

**Default threshold: 85%**

- `>= 85%`: Sean auto-allocates the transaction (if no bank rule exists)
- `< 85%`: Sean suggests only — accountant must confirm
- `< 50%`: Sean may not surface a suggestion at all (configurable)

---

## 5. Bank Rules vs Sean Precedence

**Bank Rules ALWAYS take precedence over Sean.**

Full precedence model documented in `rules-and-precedence/02-bank-rules-vs-sean.md`.

Summary:
1. Explicit Bank Rule → applied first, Sean skipped
2. Sean AI → applied only when no bank rule matched
3. Manual review → fallback when neither applies

---

## 6. Suggested UI Integration (Future)

When Sean is active for a company, the bank transaction row shows:

```
[ Description: FNB SERVICE FEE          | Amount: -R69.00 ]
[ Sean suggests: Bank Charges (91%)  ✓ Accept  ✗ Reject  ]
```

For auto-applied (high confidence):
```
[ Description: FNB SERVICE FEE          | Amount: -R69.00 ]
[ Sean allocated: Bank Charges (91%) — Auto  [Undo] ]
```

For manual allocation (no Sean match):
```
[ Description: CASH WITHDRAWAL ATM      | Amount: -R500.00 ]
[ Allocate: [Account Selector ▼]                          ]
```

---

## 7. Learning from Allocations

When an accountant:
- **Confirms a Sean suggestion** → strengthens Sean's confidence for this pattern
- **Rejects a Sean suggestion and picks a different account** → logs a correction learning event
- **Manually allocates (no Sean suggestion)** → creates a new learning event for this description pattern

Learning events feed into:
- Company-specific private codex (encrypted per `backend/sean/encryption.js` pattern)
- Global anonymized pattern pool (with client-sensitive data stripped)

See `learning-model/05-superuser-approval.md` for the approval flow before global learning takes effect.

---

## 8. VAT Consideration

When Sean suggests an account that is VAT-sensitive (e.g., an input tax account), Sean should also:
- Surface the existing VAT selector (already in the UI as of May 2026)
- Suggest a VAT treatment based on account type and historical usage
- NOT auto-apply VAT treatment — always require accountant to confirm VAT implication

Reason: VAT errors have compliance consequences. Sean assists but never auto-decides VAT.

---

## 9. Integration Points in Existing Code

| File | Existing Function | Future Sean Touchpoint |
|---|---|---|
| `frontend-accounting/bank.html` | `allocateTransaction()` | Check Sean suggestion before showing manual allocator |
| `frontend-accounting/bank.html` | `loadTransactions()` / `renderPage()` | Render Sean suggestion badges on rows |
| `backend/modules/accounting/routes/bank.js` | `POST /transactions/:id/allocate` | Accept optional `seanSuggestionId` to log confirmation |
| `backend/modules/accounting/routes/bank.js` | `GET /transactions` | Optionally include `seanSuggestion` field per row |
| `backend/sean/allocations.js` | `allocate()` | Primary engine for description → category matching |

---

## 10. Open Questions (Resolve at Implementation Time)

- Should Sean suggestions be computed at import time (batch) or on-demand per row?
- Should auto-applied allocations be visible in the UI before the accountant opens the page, or staged for review?
- What happens when Sean's confidence changes after a manual correction — should previous auto-allocations be flagged for review?
- Should Sean surface multiple ranked suggestions (top 3) when below threshold?
