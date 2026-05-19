# Sean AI — Bank Rules vs Sean Precedence

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — Rule precedence when allocating bank transactions  
> **Last updated:** May 2026

---

## 1. The Absolute Precedence Rule

**Bank Rules ALWAYS take precedence over Sean AI. No exceptions.**

This is not a soft preference — it is a hard architectural rule.

A bank rule represents an explicit, deliberate decision by the accountant or the practice:  
"Any transaction matching [description pattern] ALWAYS goes to [account]."

Sean must never override this, regardless of confidence level.

---

## 2. Full Priority Order

```
Priority 1 — Explicit Bank Rule
  └── Description matches a saved bank rule
  └── Rule specifies: account, optional VAT treatment
  └── Sean is bypassed entirely
  └── Journal is created using rule's account
  └── Logged as: source = 'bank_rule', rule_id = [id]

Priority 2 — Sean AI
  └── No bank rule matched
  └── Sean analyses description → confidence scored
  └── If confidence >= threshold: auto-allocate (if allowed by safety gates)
  └── If confidence < threshold: suggest only
  └── Logged as: source = 'sean_auto' or 'sean_suggestion'

Priority 3 — Manual Accountant Review
  └── No bank rule matched
  └── Sean has no suggestion OR suggestion was rejected
  └── Accountant manually selects account and allocates
  └── Logged as: source = 'manual'
  └── Creates a learning event for Sean (future confidence building)
```

---

## 3. What Counts as a "Bank Rule"

The existing `bank_rules` table (already in the system) stores:
- Description pattern (exact match or keyword-based)
- Target GL account ID
- Optional VAT setting

At implementation time, review whether bank rules support:
- Regex patterns (for more flexible matching)
- Debit-only or credit-only applicability
- Amount range rules (e.g., amounts between R0 and R50 = bank charges)

These capabilities affect how precisely "no bank rule matched" is determined.

---

## 4. The No-Override Contract

Sean must check the bank rules table BEFORE running its own analysis.

Pseudocode:
```javascript
const matchedRule = await getBankRuleForTransaction(companyId, transaction);
if (matchedRule) {
    // Apply rule — do NOT invoke Sean analysis
    return applyBankRule(transaction, matchedRule);
}
// No rule matched — proceed with Sean
const seanResult = await sean.analyse(transaction, companyId);
```

This check is done server-side, not client-side, to prevent bypass.

---

## 5. Edge Cases

### 5a — Bank Rule exists but specifies a deleted account

If the bank rule references an account that no longer exists or has been deactivated:
- Do NOT fall through to Sean silently.
- Log a warning: "Bank rule [id] references deleted account [id]."
- Fall through to Sean and flag the rule as needing attention.
- Notify the accountant that the rule needs to be updated.

### 5b — Bank Rule exists but accountant wants Sean's opinion

Bank rules should have a "suggest but don't auto-apply" mode as a future option. This allows an accountant to see what Sean would have said even when a rule exists, useful for validating whether rules are still optimal.

This is a UX enhancement — it does not change the precedence model. The rule still wins; Sean's opinion is displayed as informational only.

### 5c — Sean auto-allocates, then accountant creates a bank rule that conflicts

When a bank rule is created after Sean has already auto-allocated matching transactions:
- Do NOT retroactively change those allocations.
- The bank rule applies to future transactions only.
- The accountant should manually review and correct past allocations if needed.

---

## 6. Logging Requirements

Every allocation must log its source:

| Source value | Meaning |
|---|---|
| `bank_rule` | Applied by an explicit bank rule |
| `sean_auto` | Auto-applied by Sean above confidence threshold |
| `sean_suggestion_accepted` | Sean suggested, accountant confirmed |
| `sean_suggestion_rejected` | Sean suggested, accountant picked a different account |
| `manual` | No rule, no Sean suggestion, accountant manually allocated |

This audit trail is required for:
- Post-reconciliation review
- Sean confidence model training data quality
- Client audit and compliance evidence
