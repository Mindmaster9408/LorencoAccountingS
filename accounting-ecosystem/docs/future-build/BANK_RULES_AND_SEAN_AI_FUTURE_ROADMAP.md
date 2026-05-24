# Bank Rules & Sean AI — Future Build Roadmap

**Status:** Phase 1 shipped. This document captures the planned Phase 2–4 work.  
**Last updated:** May 2026  
**Author:** Bank Rules Phase 1 implementation session

---

## 1. Architecture Vision

The bank rules engine is an intelligence pipeline with three layers:

```
Layer 1 — Company Bank Rules (Phase 1, SHIPPED)
  - Deterministic, user-defined, per-company
  - Always fires before AI
  - Confidence: 100 (exact user intent)

Layer 2 — Sean AI Suggestion (Phase 2)
  - Probabilistic, learned from allocation history
  - Fires only when Layer 1 produces no match
  - Confidence: variable (0–95)

Layer 3 — Manual (always available)
  - Accountant selects account manually
  - Overrides layers 1 and 2
```

**Priority in suggestion pipeline:**  
`Company Rule → Sean AI → Manual`

No layer may auto-post. All suggestions are user-confirmed before allocation.

---

## 2. Phase 1 — Shipped (May 2026)

### Delivered
- `bank_allocation_rules` table (migration 048)
- `bankDescriptionNormalizer.js` — canonical normaliser (single source of truth)
- `bankRules.js` — full CRUD API + `/suggest` endpoint (3-pass: exact → contains → starts_with)
- `bank.html` — suggestion prefill with override detection, `appliedRuleId` passed to allocation
- `bank.js` allocation endpoint — `appliedRuleId` validation + `BANK_RULE_ACCEPTED` audit event
- `bank-rules.html` — management UI (create, edit, deactivate, apply_count display)

### Constraints
- Match types: `exact`, `contains`, `starts_with` only
- No regex in Phase 1
- `allocation_type`: `account` only (no CUSTOMER/SUPPLIER split rules)
- No split-line rules (one rule = one account, not split across multiple)
- Rules are suggest-only — no auto-post path exists

---

## 3. Phase 2 — Sean AI Suggestion Integration

### Goal
When no company rule matches, Sean AI analyses the normalised description and suggests an account based on historical allocations across all trusted sources (PDF, API imports).

### Key design decisions

**Suggestion source field:** The existing `suggestion.source` field in the suggest response uses `'bank_rule'` for Phase 1. Sean AI will return `'sean_ai'` for Phase 2. The `bank.html` prefill logic checks `source === 'bank_rule'` — extend to also accept `source === 'sean_ai'` with a visually distinct banner (blue vs green).

**Two-stage pipeline in `/suggest`:**
```javascript
// Current (Phase 1):
const ruleMatch = await matchBankRules(companyId, normalised);
if (ruleMatch) return { suggestion: { source: 'bank_rule', ...ruleMatch } };
return res.status(404).json({ message: 'No suggestion available' });

// Phase 2 addition:
const ruleMatch = await matchBankRules(companyId, normalised);
if (ruleMatch) return { suggestion: { source: 'bank_rule', ...ruleMatch } };

const aiMatch = await SeanBankAI.suggest(companyId, normalised, bankTxn.description);
if (aiMatch) return { suggestion: { source: 'sean_ai', ...aiMatch } };

return res.status(404).json({ message: 'No suggestion available' });
```

**Confidence field:** Sean AI suggestions should include `confidence: 0–95`. Rules always return `confidence: 100`.

**UI distinction:**
- Rule suggestion banner: green (`#f0f9f0`, border `#34a853`) — already implemented
- Sean AI suggestion banner: blue (`#eff6ff`, border `#0066cc`) — add in Phase 2

### Sean learning data required

Sean needs per-company historical allocation data to make suggestions. The `recordBankAllocationEvent` function in `bank-learning.js` already captures this data for trusted import sources (PDF, API). Phase 2 must:

1. Extend `bankLearning.getSuggestion(companyId, normalisedDescription)` to return structured suggestion
2. Minimum confidence threshold: `>= 70` before surfacing to UI (configurable per company)
3. Weight recent allocations higher than old ones

### Open questions for Phase 2 design

- Should Sean AI suggestions fire only when confidence >= 70 (default), or always with confidence displayed?
- Should Sean suggestions cross-company (ecosystem pattern learning) or remain per-company only?
- How does Sean handle conflicting patterns? (Same normalised string mapped to different accounts across history)

---

## 4. Phase 3 — Split-Line Rules

### Goal
Allow one rule to suggest multiple allocation lines (e.g. insurance payment split between admin expense and prepaid asset).

### Schema change required

```sql
CREATE TABLE bank_rule_split_lines (
  id          SERIAL PRIMARY KEY,
  rule_id     INTEGER NOT NULL REFERENCES bank_allocation_rules(id) ON DELETE CASCADE,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  percentage  NUMERIC(5,2) NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
```

### API change

`/suggest` response when rule has split lines:
```json
{
  "suggestion": {
    "source": "bank_rule",
    "ruleId": 12,
    "lines": [
      { "accountId": 45, "accountCode": "7100", "accountName": "Insurance", "percentage": 80 },
      { "accountId": 88, "accountCode": "1300", "accountName": "Prepaid", "percentage": 20 }
    ]
  }
}
```

### UI change

`bank.html` allocation row must support multi-line prefill. Currently rows support single `accountId`. Phase 3 adds:
- "Split" toggle on the allocation row
- Multiple account select rows rendered dynamically
- Percentage inputs per line (must total 100%)
- `appliedRuleId` still passed to single allocation call, but `lines` array has multiple entries

### Constraint
Phase 3 does NOT change the allocation endpoint's core journal-building logic — it already supports multi-line `lines` arrays. Only the UI and rule schema change.

---

## 5. Phase 4 — Regex Match Type

### Goal
Allow rules with pattern type `regex` for power users who need pattern matching beyond `contains`/`starts_with`/`exact`.

### Scope
- Add `regex` as a valid `match_type` in the migration (alter check constraint)
- In `bankRules.js` suggest endpoint, add a fourth pass: `regex` rules where `new RegExp(r.normalized_pattern).test(normalised)`
- `bank-rules.html` UI: add regex input with test button (live preview against a sample description)
- Warn users that regex patterns are not normalised before saving (raw pattern stored as-is)

### Safety
- Wrap regex execution in try/catch (malformed regex must not crash the suggest endpoint)
- Limit regex execution time (prevent ReDoS) — use a simple character limit check on regex patterns at creation time

---

## 6. Phase 5 — Customer / Supplier Payment Rules

### Goal
Allow rules to suggest `allocation_type: 'customer'` or `allocation_type: 'supplier'` — i.e. auto-link a transaction to a known customer or supplier rather than a GL account.

### Schema change
```sql
ALTER TABLE bank_allocation_rules
  ALTER COLUMN allocation_type TYPE VARCHAR(30),
  DROP CONSTRAINT bank_allocation_rules_allocation_type_check,
  ADD CONSTRAINT bank_allocation_rules_allocation_type_check
    CHECK (allocation_type IN ('account', 'customer', 'supplier'));

ALTER TABLE bank_allocation_rules
  ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;
```

### Constraint
`account_id` becomes nullable when `allocation_type` is `customer` or `supplier`.

---

## 7. Phase 6 — Rule Promotion from Manual Allocation

### Goal
After an accountant manually allocates a transaction, offer "Create rule from this?" with one click — pre-populated with the description and account.

### Implementation
After successful `/allocate` response in `bank.html`, if no `appliedRuleId` was on the allocation:
```
Show toast: "Allocated to [Account]. Create a bank rule for similar transactions? [Create Rule]"
```
Clicking "Create Rule" opens `bank-rules.html` in a modal with pre-filled fields.

---

## 8. Phase 7 — Rule Confidence Tracking & Auto-Promote

### Goal
Track how often each rule suggestion is accepted vs. overridden. Use this to score rule quality.

### Schema addition
```sql
ALTER TABLE bank_allocation_rules
  ADD COLUMN override_count INTEGER NOT NULL DEFAULT 0;
```

`BANK_RULE_ACCEPTED` increments `apply_count`. A new `BANK_RULE_OVERRIDDEN` audit event increments `override_count`.

High override rate (e.g. > 30%) = rule flagged for review in `bank-rules.html` with a warning badge.

---

## 9. Open Technical Debt (Phase 1)

| Item | Risk | Status |
|---|---|---|
| `seanLearning` data still in `safeLocalStorage` (`sean_learning_*` key) | RULE D3 violation | Tracked follow-up — migrate to `sean_knowledge_mappings` SQL table |
| `bank_manual_transactions` still in `safeLocalStorage` | RULE D3 violation | Tracked follow-up — migrate to `bank_transactions` with `source: manual` |
| `prefillRuleSuggestions` fires N API calls per page render (one per unmatched row) | Performance — acceptable for Phase 1, batch endpoint in Phase 2 | Tracked follow-up |
| No test for normaliser edge cases (Afrikaans descriptions, special chars) | Test coverage gap | Tracked follow-up |

---

## 10. Canonical Normaliser — Single Source of Truth

`bankDescriptionNormalizer.js` is the canonical normaliser for all new bank rules code.

**Do not** use the normalisers in `bank-learning.js` or `allocations.js` for bank rules matching. Those are separate concerns and their normalisation logic differs.

When Phase 2 Sean AI suggestion is implemented, it must also use `bankDescriptionNormalizer.js`.

---

## 11. Audit Event Reference

| Event | Entity Type | When fired |
|---|---|---|
| `BANK_RULE_SUGGESTED` | `BANK_ALLOCATION_RULE` | When `/suggest` fires and returns a rule match (non-blocking, logged async) |
| `BANK_RULE_ACCEPTED` | `BANK_ALLOCATION_RULE` | When allocation completes with `appliedRuleId` set |
| `BANK_RULE_OVERRIDDEN` | (Phase 7) | When user changes account/type after a rule suggestion |
| `CREATE` on `BANK_ALLOCATION_RULE` | Standard audit | Rule created |
| `UPDATE` on `BANK_ALLOCATION_RULE` | Standard audit | Rule edited |
| `DEACTIVATE` on `BANK_ALLOCATION_RULE` | Standard audit | Rule deactivated (soft delete) |

---

*This roadmap is a living document. Update it when phases are scoped, started, or completed.*
