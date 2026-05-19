# Sean AI — Accounting Integration: Architecture & Design Notes

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Created:** May 2026  
> **Purpose:** Preserve architectural decisions, business rules, and intelligence model ideas for the future Sean AI integration into the Accounting App.

---

## What This Folder Contains

This documentation area captures all design decisions, precedence rules, confidence logic, and learning model architecture discussed during accounting workflow planning.

**Nothing in this folder has been implemented yet.**  
These are future-design memory notes only.

---

## Folder Index

| Subfolder | Contents |
|---|---|
| `bank-allocation/` | Bank statement auto-allocation design, workflow, and rule precedence |
| `chart-of-accounts/` | Semantic account linking, COA AI assist, account description model |
| `learning-model/` | How Sean learns: confidence scoring, superuser approval, cross-client knowledge |
| `rules-and-precedence/` | Bank Rules vs Sean precedence, governance, audit, safety |

---

## Top-Level Summary

Sean AI's accounting integration extends the existing Sean engine (already operational in `frontend-sean/` and `backend/sean/`) into the Accounting App's core workflows:

1. **Bank Statement Allocation** — Sean assists (or auto-allocates) bank transactions to GL accounts
2. **Chart of Accounts Semantic Layer** — Sean understands account meaning, not just account codes
3. **Client-Specific Intelligence** — Sean learns per-client patterns without leaking context across tenants
4. **Superuser-Controlled Global Learning** — Confirmed knowledge propagates across the ecosystem under controlled approval

---

## Related Existing Documentation

| File | Notes |
|---|---|
| `SEAN-INTEGRATION.md` (repo root) | Existing Sean engine — fully implemented |
| `docs/sean-app-learning-module-visibility.md` | App-specific module visibility model |
| `docs/sean-payroll-sync-and-transaction-store.md` | Sean payroll sync (existing) |
| `database/sean-schema.sql` | Existing Sean DB schema (8 tables) |
| `CLAUDE.md §4 (Part B)` | Sean controlled learning and global propagation rules |

---

## Implementation Note

When implementation begins, follow CLAUDE.md Part B rules:
- Rules B1–B11 govern Sean learning, propagation, and approval flows.
- No global changes without explicit authorization (Rule B2).
- Client-specific data must never be auto-propagated without the safe-propagation rules (Rule B6).
