# Sean AI — Future Auto-Allocation Workflow Vision

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — End-to-End Bank Allocation with Sean  
> **Last updated:** May 2026

---

## 1. The Vision

The ideal end state is a bank statement import that requires minimal manual allocation by the accountant. For repeat clients with established patterns, the vast majority of transactions should be auto-allocated or pre-suggested by Sean, leaving only genuinely ambiguous transactions for human review.

---

## 2. Full Workflow (Future)

```
Import Bank Statement (PDF / CSV)
        │
        ▼
Bank Staging (existing — migration 020)
  ├── Transfer detection (existing)
  ├── Duplicate detection (existing)
  └── Confirm to bank_transactions (existing)
        │
        ▼
Sean Analysis Pass (FUTURE)
  For each unmatched transaction:
  ├── Check: does a Bank Rule match this description?
  │     YES → apply rule, mark status='matched', log as rule-based
  │     NO  → continue to Sean
  ├── Sean engine: description → GL account candidate
  ├── Score confidence (0.0–1.0)
  ├── Confidence >= 85%?
  │     YES → auto-allocate
  │             create journal (POST /transactions/:id/allocate)
  │             status = 'matched'
  │             log: source='sean_auto', confidence, reasoning
  │     NO  → attach suggestion to transaction row
  │             status stays 'unmatched'
  │             UI shows "Sean suggests: [Account] (NN%)"
  └── No suggestion (confidence < 50% or no category found)
        → leave unmatched, manual allocator shown
        │
        ▼
Accountant Reviews Page
  ├── Matched (auto-applied) → visible in Reviewed tab with "Auto" badge
  ├── Suggested (needs confirm) → visible in New tab with Sean suggestion UI
  └── Unmatched (manual needed) → visible in New tab with manual allocator
        │
        ▼
Accountant Actions
  ├── Accept suggestion → creates journal, moves to Reviewed
  ├── Reject suggestion, pick different account → creates journal + logs correction
  ├── Undo auto-allocation → reverses journal, moves back to unmatched
  └── Manual allocate → standard flow
        │
        ▼
Learning Events Captured
  ├── Confirmation → +confidence for this pattern
  ├── Rejection + correction → logs override, adjusts model
  └── New manual allocation → new pattern candidate
        │
        ▼
Superuser Review (if global propagation triggered)
  └── See learning-model/05-superuser-approval.md
        │
        ▼
Reconcile
  Accountant selects all matched transactions → Reconcile
  status = 'reconciled'
```

---

## 3. Batch Analysis vs On-Demand

Two possible approaches:

### Option A — Batch (at confirm-from-staging time)
- When accountant clicks "Confirm" in staging, Sean analyses all confirmed transactions immediately.
- Results stored as suggestion records in a `sean_suggestions` table.
- When accountant opens the bank page, suggestions are pre-loaded.
- **Pros:** Faster UI, predictions ready on page load.
- **Cons:** Stale if model changes between confirm and review.

### Option B — On-Demand (when accountant opens the bank page)
- Sean analysis triggered per-page-load or per-transaction on render.
- Results not persisted — re-computed each time.
- **Pros:** Always uses latest model.
- **Cons:** Latency on page load, repeated computation.

### Recommended (decide at implementation time)
Hybrid: batch analysis at confirm time, with a "Re-analyse" button for the accountant to trigger a fresh pass.

---

## 4. Auto-Allocation Safety Gates

Even when confidence is above threshold, auto-allocation must NOT proceed if any of these conditions are true:

| Gate | Reason |
|---|---|
| Bank Rule exists for this description | Rules always override Sean |
| Transaction already has `status != 'unmatched'` | Never reallocate already-processed transactions |
| Suggested account is a balance sheet control account | Too risky to auto-post to control accounts |
| Suggested account requires manual VAT selection | VAT must always be human-confirmed |
| Sean activation is off for this company | Obvious |
| The transaction is part of a detected transfer pair | Transfer pairs have a separate confirmation flow |

---

## 5. Rollout Consideration

When this feature is implemented, recommend a soft-launch phase:
- Phase 1: Sean suggests only (no auto-allocation) — accountants build trust in suggestions
- Phase 2: Auto-allocation enabled for high-confidence (>=95%) patterns — limited blast radius
- Phase 3: Full auto-allocation at 85% threshold after confidence is validated in production

Superusers can control the threshold and the current phase per company.
