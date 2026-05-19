# Sean AI — Transaction Pattern Recognition

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — How Sean recognizes and classifies transaction descriptions  
> **Last updated:** May 2026

---

## 1. Overview

Transaction pattern recognition is the core engine that allows Sean to suggest or auto-allocate a GL account for a raw bank transaction description.

The existing `backend/sean/allocations.js` already implements a keyword-based version of this. This document describes the extended model for the Accounting App integration.

---

## 2. Recognition Pipeline

For each transaction description, Sean runs:

```
Input: raw bank description (e.g., "FNB CHEQUE ACC 0001234567 SERVICE FEE MAY26")
        │
        ▼
Step 1: Normalization
  - Uppercase
  - Remove account numbers (regex: \b\d{7,12}\b)
  - Remove date suffixes (MAY26, APR-26, 2026-05, etc.)
  - Remove amount strings embedded in description
  - Strip punctuation noise
  Result: "FNB CHEQUE ACC SERVICE FEE"
        │
        ▼
Step 2: Private Codex Lookup (client-specific)
  - Check sean_codex_private for this company
  - Exact normalized description match → high confidence
  - Fuzzy normalized description match (Levenshtein distance <= 2) → medium-high confidence
  - If found with confidence >= threshold → return immediately
        │
        ▼
Step 3: Global Pattern Lookup
  - Check sean_patterns_global (approved cross-client patterns)
  - Exact match → elevated confidence
  - Fuzzy match → medium confidence
        │
        ▼
Step 4: Keyword Engine (existing allocations.js)
  - Check against 500+ SA vendor/category keywords
  - Returns a category label (BANK_CHARGES, FUEL, etc.) and confidence
        │
        ▼
Step 5: Semantic Category → Account ID Resolution
  - Map the winning category to the client's actual GL account
  - Using sean_account_semantic_map (future) or history-based learning
        │
        ▼
Output: { accountId, accountName, confidence, confidenceSource, reasoning }
```

---

## 3. Description Normalization Rules

Normalization is critical for pattern matching accuracy. Rules (ordered by application):

| Rule | Pattern | Example |
|---|---|---|
| Uppercase all | — | "fnb fee" → "FNB FEE" |
| Remove bank account numbers | `\b\d{7,12}\b` | "0001234567" → removed |
| Remove date suffixes | `\b(JAN\|FEB\|MAR\|APR\|MAY\|JUN\|JUL\|AUG\|SEP\|OCT\|NOV\|DEC)\d{2}\b` | "MAY26" → removed |
| Remove 4-digit year references | `\b20\d{2}\b` | "2026" → removed |
| Remove embedded amounts | `\bR?\d+[.,]\d{2}\b` | "R1234.56" → removed |
| Remove trailing reference numbers | `\b\d{6,}\b` at end | long numeric suffixes removed |
| Collapse repeated whitespace | `/\s+/g` → `' '` | — |
| Trim | — | — |

These rules should be versioned. Changing normalization rules requires a re-indexing migration for existing stored patterns.

---

## 4. SA-Specific Pattern Library (Existing + Extensions)

The existing engine covers:

| Category | Examples already covered |
|---|---|
| `BANK_CHARGES` | FNB SERVICE FEE, ABSA MONTHLY, STANDARD BANK FEE |
| `TELEPHONE` | TELKOM, VODACOM, MTN, CELL C, RAIN |
| `FUEL` | ENGEN, SHELL, TOTAL, BP, SASOL, CALTEX |
| `GROCERIES` | WOOLWORTHS, CHECKERS, PICK N PAY, SHOPRITE, SPAR |
| `SALARIES` | SALARY, PAYROLL, WAGES |
| `VAT_INPUT` | SARS VAT, VAT PAYMENT, SARS VAT VENDOR |

**Extensions needed for bank allocation:**

| Category | Additional patterns to consider |
|---|---|
| `BANK_CHARGES` | Card replacement fee, overdraft charge, debit order penalty |
| `INSURANCE` | HOLLARD, OUTSURANCE, OLD MUTUAL, SANTAM, DISCOVERY |
| `RENT` | RENTAL PAYMENT, PROPERTY RENTAL, LEASE PAYMENT |
| `ELECTRICITY_UTILITIES` | ESKOM, CITY POWER, MUNICIPALITY |
| `WATER` | RAND WATER, MUNICIPALITY WATER |
| `ACCOUNTING_SERVICES` | PAYROLL SERVICE, BOOKKEEPING |
| `SOFTWARE_SUBSCRIPTIONS` | MICROSOFT, GOOGLE, XERO, SAGE, QUICKBOOKS |
| `TRANSPORT` | UBER, BOLT, TAXIFY |
| `PETTY_CASH` | PETTY CASH, CASH WITHDRAWAL |

---

## 5. Vendor Recognition

For well-known vendors, Sean should maintain a vendor registry mapping vendor name patterns to:
- Category
- VAT status (most SA vendors are VAT-registered = VAT-inclusive)
- Typical transaction direction (debit/credit)
- Confidence bonus (well-known vendor = higher starting confidence)

Example vendor registry entry:
```json
{
  "vendor": "FNB",
  "patterns": ["FNB", "FIRST NATIONAL BANK"],
  "typicalCategory": "BANK_CHARGES",
  "vatStatus": "standard_rated",
  "direction": "debit",
  "confidenceBonus": 0.10
}
```

---

## 6. Ambiguity Handling

Some descriptions are inherently ambiguous:

| Description | Could be |
|---|---|
| "CASH WITHDRAWAL" | Petty cash, personal drawing, travel cash |
| "TRANSFER" | Interbank, intercompany, loan repayment |
| "EFT PAYMENT" | Supplier payment, personal payment, refund |

For these, Sean should:
- Return multiple ranked candidates (e.g., top 3 suggestions with confidence)
- Surface them as suggestions only (never auto-allocate)
- Let the accountant choose, and learn from the choice for this client

---

## 7. Confidence Tuning by Transaction Direction

Some categories only make sense in one direction:

| Direction | Applies to |
|---|---|
| Debit (money out) | Expenses, supplier payments, drawings |
| Credit (money in) | Income, customer payments, loan receipts |

If Sean's keyword engine suggests an expense category for a credit transaction, the confidence should be penalized heavily — this is likely a misclassification.

Direction-aware confidence adjustment:
```javascript
if (txn.amount > 0 && category.typical_direction === 'debit') {
    confidence *= 0.3;  // heavy penalty
} else if (txn.amount < 0 && category.typical_direction === 'credit') {
    confidence *= 0.3;
}
```
