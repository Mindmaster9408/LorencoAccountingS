# Sean AI — Superuser Learning Approval Model

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — How superuser confirmations elevate global knowledge  
> **Last updated:** May 2026

---

## 1. Who Are Superusers

Superusers are the ecosystem operators who have the authority to promote client-specific learned patterns into globally trusted knowledge.

**Current superusers:**
- Ruan
- MJ
- Anton

Superusers are identified by role/user ID in the authentication system. This must be enforced server-side — not by any client-side flag.

---

## 2. Why Superuser Approval Matters

The core tension in a multi-tenant learning system is:

- **Client privacy:** One client's allocation patterns may contain business-sensitive mappings.
- **Ecosystem intelligence:** Good patterns should improve the experience for all clients.
- **Trust level:** Not all user actions carry equal evidential weight.

Superuser approval is the bridge: a trusted human reviews whether a pattern is genuinely generalizable and approves its promotion into the global pool.

---

## 3. How Superuser Learning Differs from Standard User Learning

### Standard (Non-Superuser) User Confirmation

When a normal accountant confirms a Sean suggestion or makes a manual allocation:

- Creates a **company-specific** learning event.
- Confidence increases within that company's private codex.
- Does NOT automatically flow into the global pattern pool.
- Contributes to a **global candidate** only after N confirmations across multiple clients (threshold TBD — suggested: 3+ distinct clients).
- Even then, the global candidate requires superuser approval before taking effect.

### Superuser Confirmation

When a superuser confirms an allocation:

- Immediately treated as a **high-confidence training event**.
- Can be directly promoted to the global pattern pool without the multi-client threshold.
- Elevates confidence baseline for that pattern significantly.
- Still logged with `confirmed_by: 'superuser'` and the user ID.

---

## 4. Approval Workflow for Global Propagation

```
Company-level learning event captured
        │
        ▼
Sean identifies pattern as cross-client candidate
(same description → same account across 3+ clients, or superuser confirms)
        │
        ▼
Global candidate queued in sean_global_candidates (future table)
        │
        ▼
Superuser review (via Sean app or future ecosystem control panel)
  ├── Review: description pattern, suggested account category, evidence
  ├── See: which clients have this pattern, any conflicting allocations
  └── Decision:
        ├── Approve → pattern enters sean_patterns_global
        │              all clients benefit from elevated confidence
        └── Reject → candidate removed, client-level learning preserved
        │
        ▼
If approved: applied per CLAUDE.md Rule B6
  ├── Only applied to clients with NO existing allocation for this pattern
  ├── Clients with conflicting existing allocations → listed as exceptions
  └── Exceptions require separate manual review (never auto-overwritten)
```

This workflow directly implements CLAUDE.md Rules B1–B9.

---

## 5. What Superusers See in the Approval UI (Future)

Each global candidate should display:

| Field | Content |
|---|---|
| Pattern | Normalized description (e.g., "FNB SERVICE FEE") |
| Proposed account category | e.g., "Bank Charges" |
| Evidence | X confirmations across Y clients |
| Sample transactions | 3–5 example transactions that triggered this |
| Conflicting clients | List of clients that already use a DIFFERENT account for this pattern |
| Proposed action | "Apply to N clients where this pattern has no existing allocation" |

Conflicting clients are shown prominently and excluded from the batch — they require separate, explicit review.

---

## 6. Cross-Client Knowledge Safety (CLAUDE.md Rule B9 Enforcement)

**Hard rule: A populated allocation for a specific client is NEVER auto-overwritten.**

Even if a superuser approves global propagation:
- Clients with an existing allocation for the pattern are excluded.
- Clients where the existing allocation differs from the global standard are flagged as exceptions.
- Exceptions are never silently dropped — they are listed in the exception report.

This preserves client-specific intentional decisions made by their accountant.

---

## 7. Tracking and Audit

Every superuser learning action must be logged:
- Superuser user ID
- Pattern that was approved or rejected
- Timestamp
- Number of clients affected
- Exception list (clients excluded)

This log must be queryable by future superusers and auditors.
