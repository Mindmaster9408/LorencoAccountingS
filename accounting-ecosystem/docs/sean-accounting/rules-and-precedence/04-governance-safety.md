# Sean AI — Governance, Safety, and Audit Rules

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — All Sean actions must be auditable, reversible, and safe  
> **Last updated:** May 2026

---

## 1. Core Governance Principles

These principles govern every Sean action in the Accounting App. They are not optional.

1. **Every Sean action must be auditable.**  
   No black-box allocation. Every suggestion and auto-allocation records confidence, source, and reasoning.

2. **Human override must always be possible.**  
   Any Sean-applied allocation can be undone by the accountant. Sean's decision is never final.

3. **Bank Rules override Sean, always.**  
   No confidence level, superuser confirmation, or training frequency changes this.
   See `rules-and-precedence/02-bank-rules-vs-sean.md`.

4. **No destructive action without approval.**  
   Sean never deletes data. Sean never reverses a journal. Sean never changes account mappings for other transactions retroactively.

5. **Client isolation is absolute.**  
   Client-specific patterns are encrypted and never flow to other clients automatically.
   See `learning-model/06-client-specific-learning.md`.

6. **Global propagation requires superuser approval.**  
   Sean may identify candidates for global promotion but may never apply them without explicit authorization.
   See `learning-model/05-superuser-approval.md` and CLAUDE.md Rules B2, B6.

---

## 2. Audit Log Requirements

Every allocation action (whether rule-based, Sean auto-applied, Sean suggestion confirmed, or manual) must be logged with:

| Field | Required | Notes |
|---|---|---|
| `transaction_id` | Yes | Which bank transaction was allocated |
| `company_id` | Yes | Tenant isolation |
| `account_id` | Yes | Which GL account was used |
| `source` | Yes | `bank_rule` / `sean_auto` / `sean_suggestion_accepted` / `sean_suggestion_rejected` / `manual` |
| `confidence` | If Sean | Numeric confidence score at time of action |
| `confidence_sources` | If Sean | Array of contributing signals |
| `reasoning` | If Sean | Human-readable explanation |
| `rule_id` | If bank rule | Which bank rule was applied |
| `sean_suggestion_id` | If Sean | Link to the suggestion record |
| `performed_by_user_id` | Yes | Who performed the action (or `SEAN_AUTO` for fully automatic) |
| `timestamp` | Yes | When the action occurred |
| `reversed` | Yes | Whether this allocation was later undone |
| `reversed_at` | If reversed | When it was undone |
| `reversed_by_user_id` | If reversed | Who undid it |

---

## 3. What Sean Must NOT Do (Hard Rules)

| Prohibited action | Reason |
|---|---|
| Auto-allocate when a bank rule exists | Bank rules always take precedence |
| Auto-allocate with confidence < threshold | Below threshold = suggestion only |
| Overwrite an existing matched transaction | Transactions in `status='matched'` or `'reconciled'` must not be re-allocated automatically |
| Propagate client-specific patterns globally without approval | CLAUDE.md Rule B2 |
| Overwrite an existing client allocation with a global pattern | CLAUDE.md Rule B9 |
| Skip the audit log for any action | Every action must be traceable |
| Auto-apply VAT treatment | VAT has compliance consequences — always human-confirmed |
| Modify finalized (reconciled) transactions | Finalized transactions are immutable |

---

## 4. Rollback / Undo Requirements

When an accountant undoes a Sean-applied allocation:

1. The journal created by the allocation is reversed (existing "Undo Allocation" flow already handles this in `DELETE /transactions/:id/allocate`).
2. The bank transaction returns to `status = 'unmatched'`.
3. The audit log records the reversal.
4. A negative learning signal is logged: "This description → this account was rejected for this company."
5. The confidence for this pattern is reduced for this client.

The undo flow already exists in the backend. Sean integration must hook into the existing undo mechanism, not build a parallel one.

---

## 5. Client Data Isolation

The following must be enforced at every Sean data operation:

- Every read from `sean_codex_private` must filter by `company_id`.
- Every write to `sean_codex_private` must include the `company_id`.
- The `company_id` must come from `req.user.companyId` (JWT-sourced), never from the request body.
- Cross-company reads are forbidden except via the superuser approval workflow.
- Anonymized global patterns must have all company-identifying information stripped before storage.

---

## 6. What Makes a Suggestion "Safe" to Auto-Apply

A Sean auto-allocation is safe only when ALL of the following are true:

- [ ] Sean is activated for this company
- [ ] Confidence >= configured threshold (default 85%)
- [ ] No bank rule exists for this transaction description
- [ ] Transaction is in `status = 'unmatched'`
- [ ] Suggested account exists and is active in this company's COA
- [ ] Suggested account is not a control account (debtors, creditors, bank)
- [ ] Transaction is not part of a transfer pair (transfer pairs have their own flow)
- [ ] Account does not require mandatory VAT treatment selection
- [ ] No previous failed allocation exists for this transaction

If any check fails → suggestion only, no auto-application.

---

## 7. Sean's Role in Practice

To summarize Sean's governance position in the accounting workflow:

```
Sean is an assistant, not an authority.

Sean suggests based on evidence.
Sean auto-applies only when highly confident and all safety gates pass.
Sean learns from human confirmation.
Sean never overrides deliberate human or rule-based decisions.
Sean's actions are always visible, always reversible, and always logged.
```
