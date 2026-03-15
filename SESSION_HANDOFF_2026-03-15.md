# Session Handoff — 2026-03-15

## Summary

Two-session task: **Build the template-driven chart of accounts system with farming industry overlay and Sean AI extensibility.**

The core architecture was committed in the previous session context (`fe7c622`). This session completed the remaining pieces: reports.js P&L sub_type output, test fixes, and doc corrections.

---

## What Was Changed

### 1. `accounting-ecosystem/backend/config/accounting-schema.js` *(committed in fe7c622)*

**Standard SA Base expanded from 76 → 87 accounts:**
- `1030` Bank — Savings / Call Account (current_asset)
- `1800` Goodwill, `1810` Trademarks/Patents/Licences (intangibles)
- `1850` Long-term Investments
- `1900` Accum Amortisation — Intangibles
- `2050` Credit Card Payable
- `2600` Dividends Payable
- `2750` Deferred Tax Liability
- `6070` Recruitment and HR Costs
- `6140` Security and Alarm Costs
- `6330` Travel and Accommodation

**Farming SA Overlay added (34 accounts):**
- Biological assets — current (1250–1270): livestock, growing crops, nursery stock
- Biological assets — non-current (1660–1690): orchards, breeding stock, irrigation, fencing
- Accumulated depreciation on farming assets (1740–1750)
- Farming income (4050–4090): cattle, grain, fruit, nuts, dairy, game, agri-tourism, govnt grants
- Direct farming cost of sales (5050–5090): livestock purchases, feed, vet, seeds, fertiliser, harvest, packing
- Farming labour (6080–6085)
- Depreciation on farming-specific assets (7550–7570)

**Schema enhancements** (idempotent, safe on every startup):
- `coa_templates.parent_template_id` — overlay template hierarchy
- `coa_templates.sean_metadata JSONB` — Sean AI context (suggested segments, overlay flag)
- `company_template_assignments` table — tracks which templates each company provisioned
- `journal_lines.segment_value_id` — schema-ready dimensional reporting (not yet active in UI/API)
- `coa_segment_values.sort_order` + `.color` — for future segment UI

**provisionFromTemplate() fixed:**
- Now copies `vat_code` from template accounts to company accounts
- Records assignment in `company_template_assignments`

**New `applyTemplateOverlay(companyId, client, templateId)` function:**
- Adds farming (or future industry) accounts to a company that already has a base COA
- `ON CONFLICT DO NOTHING` — safe to re-apply, only inserts missing accounts
- Rejects if company has no base COA provisioned yet

---

### 2. `accounting-ecosystem/backend/modules/accounting/routes/accounts.js` *(committed in fe7c622)*

- Fixed routing order bug: `GET /templates` was defined AFTER `GET /:id` → Express was catching it as an account ID lookup. Fixed by moving template routes before `/:id`.
- Enhanced `GET /templates` response: now includes `applied_at` + `accounts_added` from `company_template_assignments` per company.
- `GET /templates/:id/accounts` — preview template accounts before provisioning (includes parent template name).
- `POST /apply-overlay/:templateId` — applies farming or other overlay to existing COA.

---

### 3. `accounting-ecosystem/frontend-accounting/accounts.html` *(committed in fe7c622)*

**Template picker** (empty state — no accounts yet):
- Fetches `GET /api/accounting/accounts/templates`
- Shows only base templates (`parent_template_id IS NULL`) as cards
- Each card: industry badge, name, description, account count, "Use this template" button
- Fallback: single "Set up Default SA Chart of Accounts" button if endpoint fails

**"Industry Templates" overlay button** (when company already has accounts):
- Hidden by default; shown once `allAccounts.length > 0`
- Opens overlay modal showing industry overlay templates
- Applied templates shown with green "Applied" badge, date applied, accounts added count
- "Apply Overlay" button calls `POST /api/accounting/accounts/apply-overlay/:templateId`
- Click outside to close

---

### 4. `accounting-ecosystem/backend/modules/accounting/routes/reports.js` *(UNCOMMITTED)*

**P&L endpoint now uses sub_type for proper SA structure:**

Before: flat `income` and `expense` arrays with a simple net profit.

After: structured sections based on `sub_type`:
```
operatingIncome   (operating_income)
costOfSales       (cost_of_sales)         → grossProfit
otherIncome       (other_income)
operatingExpenses (operating_expense)
depreciation      (depreciation_amort)    → operatingProfit
financeCosts      (finance_cost)          → netProfit
```

Response now includes both structured sections and legacy flat `income` / `expense` arrays for backwards-compatibility with existing frontend code.

Accounts without `sub_type` fall back: income → `operating_income`, expense → `operating_expense`.

**This change is backwards-compatible** — the `income` and `expense` flat arrays are still in the response.

---

### 5. `accounting-ecosystem/backend/tests/coa-templates.test.js` *(UNCOMMITTED)*

17 tests. Fixed mock client to:
- Use prefix matching for SQL overrides (was using exact 60-char slice, causing overrides to be silently skipped)
- Store full SQL in `_log` (was slicing to 80 chars, truncating `vat_code` in INSERT statements)

All 17 tests pass.

---

### 6. `accounting-ecosystem/docs/chart-of-accounts-architecture.md` *(UNCOMMITTED)*

- Updated farming overlay count from `~37` to `~34` (actual: 34 accounts)

---

## What Was NOT Changed

- `reports.html` (P&L frontend) — not updated to consume the new structured `operatingIncome`, `costOfSales` etc. sections. It still uses the legacy flat `income`/`expense` arrays. This works but doesn't show Gross Profit, Operating Profit intermediate subtotals.
- Segment reporting API/UI — `journal_lines.segment_value_id` is schema-ready but no UI for tagging and no filter in reports API.
- `vat.html` — `loadVATReconData()` still uses `safeLocalStorage` for some values (identified issue from earlier, not in scope this session).
- Sean learning integration — not implemented in code. Architecture blueprint is in CLAUDE.md Part B.

---

## Testing Required

- [ ] Provision a new company with Standard SA Base → verify 87 accounts inserted
- [ ] Provision a new company with Standard SA Base → apply Farming SA Overlay → verify farming accounts added without duplicates
- [ ] Re-apply Farming SA Overlay to same company → verify 0 new accounts added (idempotent)
- [ ] Check `company_template_assignments` rows are created after provisioning
- [ ] P&L report for a company with posted journals → verify `grossProfit`, `operatingProfit`, `netProfit` fields are present in response
- [ ] reports.html P&L page — verify it still loads (uses legacy `income`/`expense` arrays, should be unchanged)
- [ ] `GET /api/accounting/accounts/templates` — check `applied_at` returned for provisioned templates

---

## Uncommitted Files

The following changes from this session are **NOT YET COMMITTED**:

1. `accounting-ecosystem/backend/modules/accounting/routes/reports.js` — P&L sub_type output
2. `accounting-ecosystem/backend/tests/coa-templates.test.js` — mock fix (17/17 passing)
3. `accounting-ecosystem/docs/chart-of-accounts-architecture.md` — count fix

Suggest committing as: `feat: P&L report structured output by sub_type + COA tests + docs`

---

## Follow-up Notes

```
FOLLOW-UP NOTE
- Area: P&L frontend (reports.html)
- What was done: reports.js backend now returns structured sections (grossProfit, operatingProfit, netProfit)
- What still needs to be checked: reports.html doesn't yet consume the structured data
- Risk if not checked: users see a flat list without Gross Profit / Operating Profit subtotals
- Recommended next: update reports.html to render SA 3-tier P&L with the structured response

FOLLOW-UP NOTE
- Area: Segment reporting
- What was done: schema ready (journal_lines.segment_value_id, coa_segments, coa_segment_values)
- What still needs to be checked: no UI for tagging lines, no API filter in reports
- Risk if not checked: farming clients cannot use segmented P&L (Cattle vs Macadamia)
- Recommended next: add segment_value_id to journal entry UI and a segmentValueId filter to /reports/profit-loss

FOLLOW-UP NOTE
- Area: vat.html loadVATReconData
- What was done: not touched this session
- Risk: function uses safeLocalStorage — data not in localStorage since moving to DB
- Recommended next: wire VAT recon data loading from real API endpoints
```
