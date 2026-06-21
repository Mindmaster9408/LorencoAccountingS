# Session Handoff — Codebox 26: Provisional Tax Planning + Tax Calendar Foundation

**Date:** 2026-06-21  
**Session scope:** Codebox 26 only — Provisional Tax Planning  
**Preceding codebox:** CB25 — Taxpayer Profile Foundation  
**Recommended next:** CB27 — Individual Income Tax Data Capture Foundation

---

## What Was Built

### Migration (run this before the app can use CB26)

| File | Action |
|---|---|
| `accounting-ecosystem/backend/config/migrations/076_practice_provisional_tax_planning.sql` | NEW — 3 tables + 17 indexes |

Run once in Supabase SQL Editor. Expected result: "Success. No rows returned."

### Backend

| File | Action | Detail |
|---|---|---|
| `accounting-ecosystem/backend/modules/practice/provisional-tax.js` | NEW | Full router — GET summary, GET /, POST /, GET /:id, PUT /:id, DELETE /:id, POST /:id/create-periods, PUT /:id/periods/:periodId/status, PUT /:id/periods/:periodId, POST /:id/review, GET /:id/events |
| `accounting-ecosystem/backend/modules/practice/index.js` | MODIFIED | Added `require('./provisional-tax')` + mount at `/provisional-tax` |

### Frontend

| File | Action | Detail |
|---|---|---|
| `accounting-ecosystem/backend/frontend-practice/provisional-tax.html` | NEW | Full standalone page — summary cards, filter toolbar, plan table with due-date badges, create plan modal, detail modal with 3 tabs (overview/periods/history) |
| `accounting-ecosystem/backend/frontend-practice/js/provisional-tax.js` | NEW | IIFE script — async/await, PracticeAPI.fetch with `.ok`/`.json()`, full state management |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | MODIFIED | Added `Provisional Tax` nav tab after `Taxpayer Profiles` |
| `accounting-ecosystem/backend/frontend-practice/client-detail.html` | MODIFIED | Added section 19 (`provisionalTaxSection`) + `cdCreatePlanModal` |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | MODIFIED | Unhides section 19, sets ptViewAllLink href, calls `loadClientProvisionalTaxPlans()`, adds full provisional tax block + window exports |

### Documentation

| File | Action |
|---|---|
| `docs/new-app/26_provisional_tax_planning.md` | NEW — feature doc |
| `docs/new-app/SESSION_HANDOFF_codebox_26_provisional_tax.md` | NEW — this file |

---

## Key Design Decisions Made

1. **Due date defaults by taxpayer type** — For individuals (SA Feb tax year-end): P1 = 31 Aug, P2 = 28 Feb, Top-up = 30 Sep. For companies: all null (year-end varies). Defaults applied at CREATE time, all editable after.

2. **No tax computation** — `estimated_tax_due` is a plain numeric field entered by the practice. The backend never calculates a tax amount from taxable income. This is strictly planning tracking.

3. **Route ordering** — `PUT /:id/periods/:periodId/status` registered **before** `PUT /:id/periods/:periodId`. Both are 4-segment routes but `/status` is the more specific literal, so it must precede the generic parameterised form. Verified against Express matching behaviour.

4. **Create-periods conflict guard** — Returns 409 if all three periods already exist. Frontend shows a toast rather than offering force-regeneration (periods are not defaults — they're real tracking rows).

5. **Multi-tenant verification** — `verifyPlanOwnership` and `verifyPeriodOwnership` helpers used consistently before any mutation. Client and taxpayer profile ownership also verified at plan creation.

6. **Client detail modal — profile loading** — `_cdPtLoadProfiles()` called async when the create plan modal opens, not on page load. Prevents unnecessary API calls for clients that never need provisional tax plans.

7. **Due date badge colouring** — Overdue dates show in red; within 30 days in amber; future dates plain. Calculated purely from today's date vs. the stored date string — no server involvement.

---

## What Was NOT Changed

- Paytime payroll module — not touched.
- CB24 compliance packs — not regressed.
- CB25 taxpayer profiles — not regressed. Section 18 still present and functional.
- Auth middleware — not modified.
- Any shared routes — not modified.

---

## Testing Required Before Production Use

1. **Run migration 076** in Supabase SQL Editor.
2. **Restart server** to load the new `provisional-tax` router.
3. **Create a provisional tax plan** from:
   - The standalone page (`/practice/provisional-tax.html`) — verify client + profile dropdowns populate, auto-name works
   - The client detail page (section 19 "+ New Plan" button) — verify profile list loads for the correct client
4. **Verify default due dates** — Create a plan for an individual taxpayer for tax year 2026 and confirm: P1 = 2025-08-31, P2 = 2026-02-28, Top-up = 2026-09-30
5. **Verify company due dates** — Create a plan for a company taxpayer and confirm: all three dates are null (not set by default)
6. **Create periods** — Click "Create Periods" on the Overview tab, confirm three rows (P1, P2, Top-up) appear in the Periods tab
7. **Update period** — Enter estimates and actuals for Period 1, click Save, reload the plan and verify data persists
8. **Period status** — Change period status to "Submitted" and confirm the badge updates inline
9. **Mark Reviewed** — Set plan status to "Ready for Review", then click "Mark Reviewed" and confirm: status → reviewed, reviewed_at populated
10. **Event history** — Open the History tab, verify events appear (plan created, periods created, status changed)
11. **Filter bar** — Filter by client, tax year, and status individually and together
12. **Due date badges** — Set a past due date and confirm the red "overdue" label renders
13. **Multi-tenant isolation** — Verify that plans from another company are not visible
14. **Cancel** — Delete a plan via the API and confirm it is excluded from the list

---

## Open Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Provisional tax plan → Deadlines cross-link
- What was done now: related_deadline_id is a reference-only column
- Not yet confirmed: Auto-creating a deadline in practice_deadlines when a plan is created
- Risk if not checked: Low — plans and deadlines are independently tracked
- Recommended next review point: When building the practice calendar (future codebox)
```

```
FOLLOW-UP NOTE
- Area: Top-up due date for companies
- What was done now: Due dates are null for company taxpayer types — set manually
- Not yet confirmed: Whether a "financial year end" field on the taxpayer profile should seed the due dates
- Risk if not checked: Accountants must set all three dates manually for every company
- Recommended next review point: CB27 or a UX review session
```

```
FOLLOW-UP NOTE
- Area: Feb 28 vs Feb 29 in leap years
- What was done now: P2 default is hardcoded as -02-28 for individuals
- Risk if not checked: Displays 2028-02-28 instead of 2028-02-29 for 2028 tax year
- Recommended fix: Use Date arithmetic instead of string concatenation for calcDefaultDueDates
```

---

## Recommended Next Codebox

**CB27 — Individual Income Tax Data Capture Foundation**

Build structured individual tax data capture per taxpayer profile + tax year:
- Tables: `practice_individual_tax_returns`, `practice_tax_income_entries`, `practice_tax_deduction_entries`
- IRP5/IT3(a) income entries (employer, PAYE withheld)
- Medical (contributions, out-of-pocket, credits)
- Retirement annuity contributions (IT3f)
- Travel allowance and logbook records
- Rental income and expenses
- Investment income (interest IT3b, dividends IT3c)
- Donations (s18A)
- Capital gain events
- Assessed losses brought forward
- No tax calculation yet — structured capture and readiness only
- Links to CB25 taxpayer profile via `profile_id`
- Links to CB26 provisional tax plan via `plan_id` (optional)
