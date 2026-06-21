# SESSION HANDOFF — Codebox 29 — Tax Year Configuration Foundation

**Date:** 2026-06-21  
**Session:** CB29  
**Status:** COMPLETE — all files written, no commit performed

---

## What Was Built

CB29 moves SA individual tax constants out of hardcoded JS into a controlled, versioned database configuration system. The calculation engine now uses DB configs when available, and falls back to JS constants with an explicit warning flag.

Also cleaned up tracked items from CB27/CB28: deleted two accidentally-created duplicate doc files at wrong path.

---

## Cleanup Performed

| Action | File |
|---|---|
| DELETED (wrong path duplicate) | `accounting-ecosystem/backend/frontend-practice/docs/new-app/27_individual_tax_data_capture.md` |
| DELETED (wrong path duplicate) | `accounting-ecosystem/backend/frontend-practice/docs/new-app/28_individual_tax_calculation_draft_engine.md` |
| Confirmed correct originals exist at | `docs/new-app/27_individual_tax_data_capture.md` and `docs/new-app/28_individual_tax_calculation_draft_engine.md` |

---

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/079_practice_tax_year_configuration.sql` | 3 tables (configs, brackets, events), 13 indexes — NOT YET RUN |
| `accounting-ecosystem/backend/modules/practice/tax-config.js` | 13-endpoint backend router |
| `accounting-ecosystem/backend/frontend-practice/tax-configs.html` | Tax Config page (5-tab detail modal) |
| `accounting-ecosystem/backend/frontend-practice/js/tax-configs.js` | Frontend IIFE module |
| `docs/new-app/29_tax_year_configuration.md` | Feature documentation |
| `docs/new-app/SESSION_HANDOFF_codebox_29_tax_config.md` | This file |

---

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Added `taxConfigRouter` import; mounted at `/tax-configs` |
| `accounting-ecosystem/backend/modules/practice/individual-tax-calculations.js` | `runDraftCalculation()` updated: tries DB active config first, falls through to JS constants with `DB_TAX_CONFIG_NOT_FOUND_USING_JS_FALLBACK` warning; `tax_table_version` now prefixed with `[DB]` or `[JS]` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added `tax-configs` nav entry |

---

## Migration Status

**Migration 079 has NOT been run yet.**  
Run in Supabase SQL Editor before using Tax Config page or the seed endpoint.  
Expected result: "Success. No rows returned"

---

## Testing Required

### Migration
1. Run migration 079 in Supabase SQL Editor — confirm success

### Seed
2. Open Tax Config page → click "Seed from JS Constants"
3. Confirm 4 draft configs created (2023, 2024, 2025, 2026) with correct bracket counts
4. Click seed again → all 4 show "skipped" (no duplicates)

### Config lifecycle
5. Open a config → verify brackets, rebates, medical credits match SARS published values
6. Activate a config → status changes to active
7. Activate second config for same year → first gets automatically archived
8. Lock a config → brackets become non-editable, save buttons blocked on backend

### Calculation engine
9. Run a draft calculation (Individual Tax page) for a tax year that has an active DB config
10. Confirm `tax_table_version` starts with `[DB]`
11. No `DB_TAX_CONFIG_NOT_FOUND_USING_JS_FALLBACK` warning in that calculation
12. Archive the active config → run calculation again → `[JS]` prefix and fallback warning appear

### Multi-tenant
13. Confirm a config created in Company A is not visible or modifiable from Company B's token

---

## Known Gaps / Tracked for Future

| Gap | Future CB |
|---|---|
| RA deduction cap not yet enforced in calculations | CB31 or later |
| s18A cap not yet enforced | CB31 or later |
| Secondary/tertiary rebates not applied (age not captured) | CB31 or later |
| Medical tax credits not applied (member count not captured) | CB31 or later |
| Company-specific override configs not yet surfaced in UI | Future |
| `individual-tax-constants.js` still in use as fallback — can be deprecated once all years have active DB configs | After CB30 |

---

## Notes on individual-tax-constants.js

The JS constants file (`individual-tax-constants.js`) is **still required** as a fallback. Do not delete it until all tax years in use have active DB configs. The calculation engine gracefully falls back to it with a warning flag.

---

## Next Session

**Codebox 30 — Individual Tax Review Pack + Draft Tax Report Foundation**

Create a printable/exportable review pack per tax return:
- Taxpayer details summary
- Income and deductions summary
- Draft calculation section (lines, warning flags, assumptions)
- Reviewer sign-off (name, date, notes)
- Status history trail
- Print-friendly HTML view or PDF export
