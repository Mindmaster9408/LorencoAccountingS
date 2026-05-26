# Codebox 03 — Testing Report
**Date:** June 2026

---

## TEST MATRIX

### Core CRUD

| # | Test | Expected | Risk |
|---|---|---|---|
| T01 | Create full count session → 200, session_number SC-YYYYMMDD-XXXX | Lines generated matching all company items | Lines don't filter by company_id |
| T02 | Create cycle count (category=raw_material) | Only raw_material lines created | Category join fails |
| T03 | Create spot count (item_ids=[1,2,3]) | Exactly 3 lines | Extra lines from wrong company |
| T04 | Create low_stock count | Only items where current_stock ≤ reorder_point | Definition of low_stock varies |
| T05 | PATCH counted_quantity on in_progress session | Line updated, counted_quantity persisted | Update applies to wrong company_id |

### Submit + Variance Calculation

| # | Test | Expected | Risk |
|---|---|---|---|
| T06 | Submit with all lines counted | Status → 'submitted', variance_quantity = counted − system, variance_value = varQty × avg_cost | Float rounding errors |
| T07 | Submit with one line missing counted_quantity | 400 error, list of uncounted lines | Missing items not identified |
| T08 | Submit already-submitted session | 400 error "Session not in editable state" | Double-submit |

### Approve / Reject / Recount

| # | Test | Expected | Risk |
|---|---|---|---|
| T09 | Approve session | stock_count_approvals row inserted, status → 'approved' | Status not updated |
| T10 | Reject session | stock_count_approvals row inserted, status → 'rejected' | No stock change on reject |
| T11 | Recount_required | stock_count_approvals row inserted, status → 'in_progress' | Status not reverted |

### Apply Variance

| # | Test | Expected | Risk |
|---|---|---|---|
| T12 | Apply approved session with gain (+5 units) | stock_movements row: type='count_adjustment_in', qty=5; current_stock increases by 5 | Wrong movement direction |
| T13 | Apply approved session with loss (−3 units) | stock_movements row: type='count_adjustment_out', qty=3; current_stock decreases by 3 | Direct stock write attempted |
| T14 | Apply approved session with zero-variance lines | Zero-variance lines skipped (no movement); result.skipped > 0 | Zero line creates empty movement |
| T15 | Double-apply (call /apply twice on same session) | Second call returns idempotency response, no duplicate movements | Duplicate stock adjustments |

### Security & Isolation

| # | Test | Expected | Risk |
|---|---|---|---|
| T16 | Request session from Company A while authenticated as Company B | 404 Not Found | Cross-company data leakage |
| T17 | PATCH line with sessionId from different company | 404 | Company isolation bypass |
| T18 | Call /apply on rejected session | 400 "Session must be approved before applying" | Status guard bypassed |
| T19 | Call /apply on already-applied session | Idempotency response, no new movements | Re-apply creates duplicate movements |

### Blind Count

| # | Test | Expected | Risk |
|---|---|---|---|
| T20 | GET session with blind_count=true (status=in_progress) | system_quantity=null, variance_quantity=null, variance_value=null in all lines | System quantity leaked |
| T21 | GET same session after status=submitted | system_quantity visible, variance visible | Blind not lifted on submit |

### Reports

| # | Test | Expected | Risk |
|---|---|---|---|
| T22 | GET /reports/stock-counts | Sessions with line_count, counted_count, total_variance_value; summary totals | Wrong summary aggregation |
| T23 | GET /reports/variance-summary | by_reason, by_item_type, top_variance_items populated correctly | Cross-company data in top_variance_items |

---

## PAYROLL REGRESSION GATE (FROM CLAUDE.md RULE E3)

Changes in this Codebox are **inventory-only** and do not touch any auto-trigger payroll files.  
Payroll regression tests TEST-PAY-01 through TEST-PAY-14 are **not required** for Codebox 03.

Confirmed untouched files:
- `frontend-payroll/js/payroll-engine.js` — not touched
- `backend/modules/payroll/**` — not touched
- `backend/middleware/auth.js` — not touched
- `backend/config/permissions.js` — not touched (read-only audit)
- `backend/shared/routes/auth.js` — not touched
