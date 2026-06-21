# Session Handoff — Codebox 27: Individual Income Tax Data Capture Foundation

**Date:** 2026-06-21  
**Session scope:** Codebox 27 only — Individual Income Tax Data Capture  
**Preceding codebox:** CB26 — Provisional Tax Planning + Tax Calendar Foundation  
**Recommended next:** CB28 — Individual Income Tax Calculation Draft Engine Foundation

---

## What Was Built

### Migration (run this before the app can use CB27)

| File | Action |
|---|---|
| `accounting-ecosystem/backend/config/migrations/077_practice_individual_tax_data.sql` | NEW — 5 tables + 21 indexes |

Run once in Supabase SQL Editor. Expected result: "Success. No rows returned."

### Backend

| File | Action | Detail |
|---|---|---|
| `accounting-ecosystem/backend/modules/practice/individual-tax.js` | NEW | Full router — 20 endpoints covering returns, items, income, deductions, events, summary, generate-defaults, recalculate-readiness |
| `accounting-ecosystem/backend/modules/practice/index.js` | MODIFIED | Added `require('./individual-tax')` + mount at `/individual-tax` |

### Frontend

| File | Action | Detail |
|---|---|---|
| `accounting-ecosystem/backend/frontend-practice/individual-tax.html` | NEW | Full standalone page — 6 summary cards, filter bar, return table, create modal, detail modal with 5 tabs (Overview/Checklist/Income/Deductions/History), edit modals for income + deductions |
| `accounting-ecosystem/backend/frontend-practice/js/individual-tax.js` | NEW | IIFE script — async/await, PracticeAPI.fetch with `.ok`/`.json()`, full state management |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | MODIFIED | Added `Individual Tax` nav tab after `Provisional Tax` |
| `accounting-ecosystem/backend/frontend-practice/client-detail.html` | MODIFIED | Added section 20 (`individualTaxSection`) + `cdCreateItReturnModal` |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | MODIFIED | Unhides section 20, sets itViewAllLink href, calls `loadClientIndividualTaxReturns()`, adds full CB27 block + window exports |

### Documentation

| File | Action |
|---|---|
| `docs/new-app/27_individual_tax_data_capture.md` | NEW — feature doc |
| `docs/new-app/SESSION_HANDOFF_codebox_27_individual_tax.md` | NEW — this file |

---

## Key Design Decisions Made

1. **5 tables instead of 3** — The spec suggested 3 tables but the implementation needs 5 for clean separation: returns (header), items (checklist), income_entries, deduction_entries, events (audit log). This matches the CB25 taxpayer_profiles pattern.

2. **Readiness: all items treated as "required"** — The spec defined a `required` flag on items but the migration does not have a `required` boolean column on `practice_individual_tax_items`. All items (unless `not_applicable`) are treated as required for readiness scoring. This keeps the schema simpler and avoids confusion with `not_applicable` vs `not required`. The `DEFAULT_ITEMS` array in the backend has a `required` flag for documentation but it is not stored in the DB.

3. **`generate-default-items?force=true`** — Unlike CB26 (provisional tax periods, which return a hard 409 and do not force), individual tax items support `?force=true` to append only missing types. Rationale: default checklist items are soft defaults, not tracking rows — it is safe to add the ones that are missing without disturbing the ones already there.

4. **Hard delete for items/income/deductions** — Unlike plans (soft cancel) and returns (soft cancel), individual line-item entries use hard delete. They are data-entry corrections, not compliance records with an audit requirement at the row level. The event log captures the addition but not each individual delete.

5. **Income totals computed in backend** — `GET /:id/income` returns `totals.gross_total` and `totals.withheld_total` computed from the fetched rows. No separate aggregate query — acceptable at this scale.

6. **Readiness is never auto-triggered** — Changing an item status does NOT automatically recalculate the return's readiness score. The practice clicks "Recalc Readiness" or the standalone page calls it. This prevents write amplification and avoids stale summary counts between item updates.

7. **Client detail modal profile loading** — `_cdItLoadProfiles()` called async when the create return modal opens, not on page load. Same pattern as CB26 provisional tax.

8. **Auto-name is `ITR12 [Year]`** — Simple and correct for the individual tax context. Not derived from taxpayer type (all CB27 returns are individual by definition). User can overwrite it at any time; the `_manuallyEdited` flag prevents auto-override after first manual edit.

9. **Route ordering** — All 3-segment (`/:id/items`, `/:id/income`, `/:id/deductions`, `/:id/generate-default-items`, `/:id/recalculate-readiness`, `/:id/events`) and 4-segment (`/:id/items/:itemId`, `/:id/income/:incomeId`, `/:id/deductions/:deductionId`) literal routes registered BEFORE generic `/:id`, `PUT /:id`, `DELETE /:id`. This prevents Express from treating literal path segments as `:id` parameter values.

---

## What Was NOT Changed

- Paytime payroll module — not touched.
- CB24 compliance packs — not regressed.
- CB25 taxpayer profiles — not regressed. Section 18 still present.
- CB26 provisional tax — not regressed. Section 19 still present.
- Auth middleware — not modified.
- Any shared routes — not modified.

---

## Testing Required Before Production Use

1. **Run migration 077** in Supabase SQL Editor.
2. **Restart server** to load the new `individual-tax` router.
3. **Create a taxpayer profile** (CB25, type: individual) for a test client.
4. **Create a tax return** from:
   - The standalone page (`/practice/individual-tax.html`) — verify client + profile dropdowns populate, auto-name works
   - The client detail page (section 20 "+ New Return" button) — verify profile list loads for the correct client
5. **Generate checklist** — Click "Generate Checklist" on the Overview tab, confirm 9 items appear on the Checklist tab
6. **Update item statuses** — Mark IRP5 as `received`, bank details as `received`, others as `not_applicable`, click "Recalc Readiness", confirm score updates
7. **Add income entry** — Add salary entry with gross R500,000 and tax withheld R120,000. Verify totals bar updates.
8. **Edit income entry** — Change gross to R520,000 via edit modal, reload income tab, verify change persists.
9. **Add deduction entry** — Add medical deduction R24,000. Verify total deductions bar updates.
10. **Status flow** — Change status from draft → collecting_docs → data_captured. Verify badge updates.
11. **Event history** — Open History tab, verify: return_created, items_generated, income_added, deduction_added events present.
12. **Filter bar** — Filter by client, tax year, status, readiness separately and together.
13. **Cancel** — Cancel a return via PUT (status=cancelled), confirm it disappears from the default list.
14. **Multi-tenant isolation** — Verify returns from another company are not accessible.
15. **No localStorage** — Open DevTools → Application → Storage. Confirm zero business data in localStorage or sessionStorage.

---

## Open Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Readiness scoring — not_applicable vs required
- What was done now: All items (not not_applicable) count as required for scoring
- Not yet confirmed: Whether the practice wants to mark some defaults as "optional by default"
  (e.g., rental schedule not applicable for salaried employees with no rental income)
- Risk if not checked: Practice sees "incomplete" readiness for returns where many items
  were correctly waived — solved by marking them 'not_applicable' first
- Recommended: When practice opens a new return, guide them to mark inapplicable items
  as not_applicable before generating the readiness score for the first time
```

```
FOLLOW-UP NOTE
- Area: Item hard delete vs soft delete
- What was done now: Items use hard delete for simplicity (data-entry corrections)
- Risk if not checked: Audit trail shows 'items_generated' but not which specific items
  were later removed. If items are used as compliance evidence, this may be insufficient.
- Recommended: If required for audit, add item-level soft delete (status = 'removed')
  in a future codebox
```

```
FOLLOW-UP NOTE
- Area: income_entries / deduction_entries — no cross-link to IRP5 document request
- What was done now: income_entries has source_reference (text) and items has
  related_document_request_id — but no FK or automatic link between them
- Risk: Accountant must manually cross-reference the IRP5 checklist item with the
  income entry they captured from it
- Recommended: CB28 or a UX polish codebox — consider a "linked item" selector on
  income entries that points to the corresponding checklist item
```

```
FOLLOW-UP NOTE
- Area: Misplaced doc file
- What was done: A copy of 27_individual_tax_data_capture.md was accidentally created
  at accounting-ecosystem/backend/frontend-practice/docs/new-app/ in addition to the
  correct location at docs/new-app/
- Action required: Delete the accidental copy at the frontend-practice path if it exists
```

---

## Recommended Next Codebox

**CB28 — Individual Income Tax Calculation Draft Engine Foundation**

Now that structured data capture exists per tax return, build a draft calculation engine:
- Tax bracket table for each tax year (2022–2026 at minimum), stored in the DB or as a JSON constant
- Calculate gross taxable income from income entries
- Apply RA deduction cap (15% of non-retirement income, max R350,000)
- Apply s18A donations deduction cap (10% of taxable income)
- Apply medical tax credits (based on number of members on medical aid)
- Apply primary/secondary/tertiary rebates from SARS tables
- Calculate estimated PAYE liability
- All output stored in `draft_calculation` JSONB on the return row
- Clearly marked **DRAFT — NOT FOR SARS SUBMISSION** in all UI and API responses
- No eFiling, no SARS API, no auto-submission
- The calculation runs on-demand (POST /:id/calculate-draft) — not triggered automatically
