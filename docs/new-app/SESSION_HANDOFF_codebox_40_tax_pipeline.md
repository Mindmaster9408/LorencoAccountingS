# Session Handoff — Codebox 40: Tax Filing Pipeline Foundation

> Date: 2026-06-22
> Status: COMPLETE — migration NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Migration 088

**Must be applied to Supabase before the frontend will work.**

Creates:
- `practice_tax_pipeline_events` — append-only event log (all stage changes)

Alters (additive only — no existing columns changed):
- `practice_individual_tax_returns` — adds `filing_stage`, `filing_stage_updated_at`, `filing_stage_updated_by`
- `practice_company_tax_returns` — same three columns
- `practice_provisional_tax_plans` — same three columns

All existing rows default to `filing_stage = 'not_started'`. Safe to run on live data.

### Backend Router — `tax-pipeline.js`

4 endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/summary` | Stage counts across all 3 entity types |
| GET | `/` | Combined filtered list |
| GET | `/:sourceType/:sourceId` | Detail + history + allowed next stages |
| PUT | `/:sourceType/:sourceId/stage` | Stage change with full validation |

Route ordering: `/summary` registered first, then `/`, then `/:sourceType/:sourceId`, then `/:sourceType/:sourceId/stage`. No route conflicts.

Key validation logic:
- `_isAllowedTransition()` — structural move check (forward/backward/cancel rules)
- `_runAutoChecks()` — business precondition checks per stage
- `_cfg(sourceType)` — source-type config (table names, FK names, hasCalc/hasPack flags)

**Asymmetry handled:** Company review packs use `company_tax_return_id` as FK (not `tax_return_id`). The `_cfg()` function encapsulates this per-type.

**Provisional tax plans:** `hasCalc: false, hasPack: false` — skips all auto-validation checks.

### Frontend

`tax-pipeline.html` — dark-native, no white/light colors.
`js/tax-pipeline.js` — IIFE, all window.* exports, no localStorage/KV.

Features:
- Board view: 10 kanban columns, horizontal scroll, cancelled items excluded
- List view: table toggle
- Summary cards: click-to-filter by stage
- Detail modal: current stage, history with arrow notation, allowed next stages
- Stage change modal: allowed stages only, notes required indicator, double-submit prevention

### index.js + layout.js

`index.js`: router mount added after tax-reports block.
`layout.js`: "Tax Pipeline" nav entry added between tax-reports and tax-configs.

---

## Nothing Regressed

- `practice_individual_tax_returns.status`: unchanged — `filing_stage` is additive
- `practice_company_tax_returns.status`: unchanged
- `practice_provisional_tax_plans.status`: unchanged
- All existing practice routers: not touched
- Paytime: not touched — no auto-trigger files affected

---

## IMPORTANT: Migration 088 Must Be Applied

**The pipeline will fail at runtime if migration 088 is not applied.**

The three `filing_stage` columns won't exist, and `practice_tax_pipeline_events` won't exist.

Apply in Supabase SQL Editor → New Query → paste `088_practice_tax_filing_pipeline.sql` → Run.

Expected: "Success. No rows returned"

---

## Testing Required

1. Apply migration 088 to Supabase
2. Navigate to `/practice/tax-pipeline.html`
3. Verify summary cards show stage counts (all should show 0 for new records, or `not_started` for existing)
4. Toggle Board → List — verify both render
5. Click a summary card → verify filter applied to board
6. Create/find an Individual Tax Return
7. Open its pipeline detail — verify `not_started` stage shown
8. Change stage to `docs_requested` — verify success toast + history entry
9. Try jumping from `docs_requested` to `submitted` — verify 422 blocked
10. Try moving `docs_requested` → `not_started` (invalid backward) — verify blocked
11. Move to `under_review`, then backward to `review_pack_generated` — verify allowed (with notes)
12. Cancel a return — verify notes required
13. Verify cancelled item excluded from board columns
14. Verify `GET /summary` counts update after stage changes
15. Log in as different company — verify no cross-company items appear in pipeline

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Member name display in pipeline cards
- Dependency: practice_team_members table (or equivalent)
- Confirmed now: Cards show "#ID" for responsible_team_member_id — no name join
- Not yet confirmed: team member name fetch endpoint exists for pipeline enrichment
- Risk if wrong: Cards show "#123" instead of "John Smith" — functional but not ideal
- Recommended next check: Codebox 41 or later — add team member name enrichment to _fetchTableItems()
```

```
FOLLOW-UP NOTE
- Area: Client name enrichment for provisional tax plans
- Dependency: provisional_tax_plans.client_id field existence
- Confirmed now: _fetchTableItems() selects client_id and enriches via practice_clients
- Not yet confirmed: provisional_tax_plans actually has a client_id column (migration 076)
- Risk if wrong: client_name will show null for provisional items — not a blocker, enrichment is optional
- Recommended next check: grep migration 076 for client_id; add if missing in a follow-up migration
```

```
FOLLOW-UP NOTE
- Area: Backward move notes enforcement
- Current: Frontend shows "required" indicator; backend enforces via 400
- Not yet confirmed: UX flow when notes textarea is empty + required — error message clear enough?
- Risk: Low — message "Notes are required for backward stage moves" is explicit
```

---

## Recommended Codebox 41

**Tax Submission Register + Evidence Tracking Foundation**

After the pipeline stages exist, the practice needs formal proof-of-submission tracking:
- Submission reference numbers (e.g. eFiling case numbers — entered manually, not auto-filed)
- Submission dates
- Submission method (eFiling, walk-in, post)
- Acknowledgement document uploads (PDF evidence links)
- A submission register queryable by period, client, tax type
- SARS assessment received date (when applicable)

This is not SARS integration — it is internal record-keeping of what was submitted and when, with supporting evidence attached. The pipeline's `submitted` stage triggers the creation of a submission register entry.
