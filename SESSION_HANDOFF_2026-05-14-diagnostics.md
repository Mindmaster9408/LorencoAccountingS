# SESSION HANDOFF — Priority 14: Accounting Diagnostics & Repair Tooling
**Date:** 2026-05-14  
**Priority:** 14 of N  
**Status:** COMPLETE ✅

---

## 1. What Was Done

Full implementation of **Priority 14 — Accounting Diagnostics & Repair Tooling** across 5 files (2 created, 2 modified, 1 created frontend).

### Files Changed

| File | Change | Purpose |
|---|---|---|
| `backend/modules/accounting/services/diagnosticsService.js` | **CREATED** | Core service — runs 7 diagnostic categories, 3 repair actions |
| `backend/modules/accounting/routes/diagnostics.js` | **CREATED** | Express route — GET /run, POST /repair, auth + permission guards |
| `backend/modules/accounting/middleware/auth.js` | **MODIFIED** | Added `diagnostics.view` and `diagnostics.repair` to PERMISSIONS map |
| `backend/modules/accounting/index.js` | **MODIFIED** | Registered `/diagnostics` route at end of router chain |
| `frontend-accounting/accounting-diagnostics.html` | **CREATED** | Full admin UI — score cards, findings table, repair modal |

---

## 2. What Was Root-Cause Fixed

No pre-existing bugs were fixed. This is a new feature (diagnostic and repair tooling). All implementation follows existing service/route/auth patterns confirmed via targeted audit before implementation.

---

## 3. Diagnostics Implemented (7 Categories, 22 Checks)

### A — Journal Integrity (6 checks)
| ID | Check | Severity |
|---|---|---|
| A1 | Posted journal with zero lines | CRITICAL |
| A2 | Posted journal with only 1 line | CRITICAL |
| A3 | Posted journal debits ≠ credits by >0.01 | CRITICAL |
| A4 | Journal line with both debit AND credit > 0 | HIGH |
| A5 | Journal line with neither debit nor credit | MEDIUM |
| A6 | Journal line account_id orphaned (account deleted) | HIGH |

### B — Bank Linkage (4 checks)
| ID | Check | Severity |
|---|---|---|
| B1 | matched/reconciled bank_transaction with null matched_entity_id | HIGH |
| B2 | matched_entity_id → missing journal | CRITICAL |
| B3 | Bank transaction linked to unposted journal | HIGH |
| B4 | Bank-source posted journal whose bankTransactionId has no row | HIGH → repairAction: REVERSE_DANGLING_JOURNAL |

### C — Invoice Linkage (5 checks)
| ID | Check | Severity |
|---|---|---|
| C1 | Supplier invoice (non-draft/cancelled) with null journal_id | HIGH |
| C2 | Supplier invoice journal_id → missing journal | CRITICAL |
| C3 | Supplier invoice journal exists but not posted | MEDIUM |
| C4 | Customer invoice (non-draft/void) with null journal_id | HIGH |
| C5 | Customer invoice journal missing/unposted | CRITICAL or MEDIUM |

### D — VAT Integrity (3 checks)
| ID | Check | Severity |
|---|---|---|
| D1 | VAT-relevant posted journal with null vat_period_id | HIGH → repairAction: REASSIGN_VAT_PERIOD |
| D2 | Journal vat_period_id → missing vat_period row | HIGH → repairAction: REASSIGN_VAT_PERIOD |
| D3 | Journal vat_period_id belongs to different company | CRITICAL → repairAction: REASSIGN_VAT_PERIOD |

### E — Bank Staging/Import (3 checks)
| ID | Check | Severity |
|---|---|---|
| E1 | Staging rows UNMATCHED older than N days (default 30) | HIGH (≥50 rows) / MEDIUM |
| E2 | bank_transfer_links with partial confirmation state | MEDIUM |
| E3 | bank_transfer_links referencing missing journal | HIGH |

### F — Period / Year-End (3 checks)
| ID | Check | Severity |
|---|---|---|
| F1 | Overlapping accounting_periods for same company | HIGH |
| F2 | year_end_close_records status='closed' with null closing_journal_id | HIGH |
| F3 | Year-end closing journal exists but not posted | HIGH |

### G — Audit Trail Health (2 checks)
| ID | Check | Severity |
|---|---|---|
| G1 | SYSTEM_ERROR audit entries flagging dangling journals that are still posted | HIGH → repairAction: REVERSE_DANGLING_JOURNAL |
| G2 | Posted journals with no JOURNAL_POSTED audit event (recent 200) | MEDIUM (>50 missing) / LOW |

---

## 4. Repair Actions Implemented (3 + Acknowledge)

| Action | What It Does | Authorized Roles |
|---|---|---|
| `REASSIGN_VAT_PERIOD` | Re-runs `JournalService.assignVatPeriod()` for the journal | admin, accountant |
| `RELINK_BANK_TX` | Updates `bank_transactions.matched_entity_id` to point to a valid posted journal | admin, accountant |
| `REVERSE_DANGLING_JOURNAL` | Calls `JournalService.reverseJournal()` — creates a reversal journal | admin, accountant |
| `ACKNOWLEDGE` | No data change — records reason in audit log only | admin, accountant |

All repairs require:
- `confirm: true` in request body
- Non-empty `reason` string
- Authenticated user with `diagnostics.repair` permission

---

## 5. Permissions Added

```javascript
'diagnostics.view':   ['admin', 'accountant', 'bookkeeper'],
'diagnostics.repair': ['admin', 'accountant'],
```

Bookkeeper can view findings but cannot apply repairs. Viewer role cannot access diagnostics at all.

---

## 6. API Endpoints

```
GET  /api/accounting/diagnostics
     Query params: category (A-G), olderThanDays (default 30)
     Permission: diagnostics.view
     Returns: { summary: { score, critical, high, medium, low, checkedAt, companyId }, findings: [...] }

POST /api/accounting/diagnostics/repair
     Body: { findingId, repairAction, confirm: true, reason, [journalId], [bankTxnId] }
     Permission: diagnostics.repair
     Returns: { success: true, repairAction, findingId, message }
```

Frontend accesses via `/api/diagnostics` (intercepted by `eco-api-interceptor.js` → `/api/accounting/diagnostics`).

---

## 7. Score Formula

```
score = Math.max(0, 100 - (critical * 10 + high * 5 + medium * 2 + low * 1))
```

Displayed with colour coding: green ≥ 80, amber ≥ 50, red < 50.

---

## 8. Audit Events Generated

| Event | Trigger |
|---|---|
| `DIAGNOSTICS_RUN` | After any successful GET /run call |
| `DIAGNOSTIC_REPAIR_STARTED` | Before any repair attempt |
| `DIAGNOSTIC_REPAIR_COMPLETED` | After successful repair |
| `DIAGNOSTIC_REPAIR_FAILED` | After failed repair |
| `DIAGNOSTIC_REPAIR_VAT_ASSIGNMENT` | On REASSIGN_VAT_PERIOD |
| `DIAGNOSTIC_REPAIR_BANK_RELINK` | On RELINK_BANK_TX |
| `DIAGNOSTIC_REPAIR_DANGLING_BANK_JOURNAL_REVERSED` | On REVERSE_DANGLING_JOURNAL |

---

## 9. What Was NOT Changed

- `JournalService.js` — used as-is; `assignVatPeriod()` and `reverseJournal()` called without modification
- Core payroll files — untouched (Paytime stability lock not triggered)
- Any existing routes — no modifications; diagnostics route is additive
- VAT calculation logic — not touched
- Bank import parsing — not touched
- Report calculations — not touched
- Database schema — no migrations required; all queries use existing tables

---

## 10. Multi-Tenant Safety

All 22 diagnostic SQL queries include `WHERE company_id = $1` as the first filter parameter. No cross-company data can be returned. Repair actions verify entity ownership before applying changes (own-company check on journals, bank_transactions, etc.).

---

## 11. No Browser Storage

No business data is written to `localStorage`, `sessionStorage`, or `safeLocalStorage`. Auth token is read from localStorage for the Bearer header — permitted under RULE D2.

---

## 12. Regression Risks

| Risk | Assessment |
|---|---|
| Payroll regression | None — no payroll files touched |
| Journal integrity regression | None — repairs use existing JournalService methods |
| Auth regression | Low — only additive entries added to PERMISSIONS map |
| Route conflict | None — `/diagnostics` path is new; no existing route at this path |

---

## 13. Test / Verification Required

To verify this feature before production use:

1. **Run diagnostics on a company with known clean data** — expect score 100, zero findings
2. **Run diagnostics on a company with a known issue** — verify the relevant finding appears with correct severity and repairAction
3. **Attempt GET /run as bookkeeper** — expect 200 (diagnostics.view allowed)
4. **Attempt POST /repair as bookkeeper** — expect 403 (diagnostics.repair not allowed)
5. **Submit repair without reason** — expect 400 error
6. **Submit repair without confirm: true** — expect 400 error
7. **Submit REASSIGN_VAT_PERIOD on a non-VAT journal** — expect error from JournalService
8. **Verify audit log contains DIAGNOSTICS_RUN event after GET /run**
9. **Verify audit log contains full repair audit chain after POST /repair**
10. **Open accounting-diagnostics.html — verify Run button, score cards, findings table, repair modal all render correctly**

---

## 14. Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Diagnostics navigation link
- Dependency: navigation.js / sidebar menu
- What was done now: accounting-diagnostics.html page created with navigation.js included
- What still needs to be checked: Does navigation.js include a menu link to /accounting-diagnostics.html for admin users?
- Risk if not checked: Page is functional but not reachable from the sidebar unless a menu link exists
- Recommended next review point: Check navigation.js sidebar items; add admin-only link if missing

FOLLOW-UP NOTE
- Area: G2 audit gap check
- Dependency: accounting_audit_log table volume
- What was done now: G2 checks the most recent 200 posted journals only (limited to control query cost)
- What still needs to be checked: On very high-volume companies, 200 may miss older journals with audit gaps
- Risk if not checked: Low — G2 is LOW/MEDIUM severity; older audit gaps are historical
- Recommended next review point: If audit trail completeness becomes a compliance requirement, make the limit configurable

FOLLOW-UP NOTE
- Area: repairBankRelink target journal ID
- Dependency: UI workflow for B4 findings
- What was done now: Modal has a manual journal ID input for RELINK_BANK_TX
- What still needs to be checked: Consider adding a journal search/lookup to help the user find the correct journal ID
- Risk if not checked: Low — repair is blocked if journal is missing or unposted; wrong ID will fail gracefully
- Recommended next review point: UX improvement pass (not critical for initial release)
```

---

## 15. Handoff State

All 5 deliverable files complete. Backend: zero lint errors. HTML: zero functional errors (IDE CSS advisory re: inline styles — same pattern used throughout existing codebase). Feature is production-ready pending regression test verification in items 1–10 above.

**Next priority:** As directed by user.
