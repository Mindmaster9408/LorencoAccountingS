# Session Handoff — Codebox 25: Taxpayer Profile Foundation

**Date:** 2026-06-21  
**Session scope:** Codebox 25 only — Taxpayer Profile Foundation  
**Preceding codebox:** CB24 — Annual Compliance Pack + Client Year-End Readiness Foundation  
**Recommended next:** CB26 — Provisional Tax Planning + Tax Calendar Foundation

---

## What Was Built

### Migration (run this before the app can use CB25)

| File | Action |
|---|---|
| `accounting-ecosystem/backend/config/migrations/075_practice_taxpayer_profiles.sql` | NEW — creates 4 tables + 14 indexes |

Run once in Supabase SQL Editor. Expected result: "Success. No rows returned."

### Backend

| File | Action | Detail |
|---|---|---|
| `accounting-ecosystem/backend/modules/practice/taxpayer-profiles.js` | NEW | Full router — 18 endpoints for profiles, income sources, deductions, readiness |
| `accounting-ecosystem/backend/modules/practice/index.js` | MODIFIED | Added `require('./taxpayer-profiles')` + mount at `/taxpayer-profiles` |

### Frontend

| File | Action | Detail |
|---|---|---|
| `accounting-ecosystem/backend/frontend-practice/taxpayer-profiles.html` | NEW | Full standalone page — summary cards, filter bar, profile table, 4-tab detail modal, 3 sub-modals |
| `accounting-ecosystem/backend/frontend-practice/js/taxpayer-profiles.js` | NEW | IIFE script — all async/await, PracticeAPI.fetch pattern with `.ok`/`.json()` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | MODIFIED | Added `Taxpayer Profiles` nav tab after `Compliance Packs` |
| `accounting-ecosystem/backend/frontend-practice/client-detail.html` | MODIFIED | Added section 18 (`taxpayerProfilesSection`) + `cdCreateProfileModal` |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | MODIFIED | Unhides section 18, sets tpViewAllLink href, calls `loadClientTaxpayerProfiles()`, adds full taxpayer profiles block + window exports |

### Documentation

| File | Action |
|---|---|
| `docs/new-app/25_taxpayer_profile_foundation.md` | NEW — feature doc |
| `docs/new-app/SESSION_HANDOFF_codebox_25_taxpayer_profiles.md` | NEW — this file |

---

## Root Causes Fixed / Design Decisions Made

1. **PracticeAPI.fetch pattern** — Uses `async/await` + `res.ok` + `res.json()`, consistent with all other files in the module (compliance-packs.js, client-detail.js, etc.). An earlier draft incorrectly used a `.then(data => ...)` pattern treating the Response as pre-parsed JSON — corrected before delivery.

2. **Soft deletes everywhere** — Income sources and deductions are marked `active = false` instead of hard-deleted, preserving audit trail and allowing future recovery.

3. **Readiness score null vs 0** — `null` explicitly means "never calculated"; `0` means "calculated, all items outstanding". Both convey different information to the practice.

4. **Route ordering** — All literal sub-routes (`/summary`, `/:id/income-sources`, etc.) registered before generic parameterized routes to prevent Express matching `/summary` as an `:id` value.

5. **409 + force flag on generate-default-items** — Backend returns 409 if a profile already has items. Frontend confirms with user before retrying with `?force=true`. Prevents accidental duplication.

6. **Multi-tenant hard-scoped** — Every Supabase query includes `.eq('company_id', req.companyId)`. `companyId` sourced from JWT only, never from request body.

---

## What Was NOT Changed

- Paytime payroll module — not touched.
- CB24 compliance-packs functionality — not regressed (only CB24 section was already present; CB25 added after it in `client-detail.html`).
- Auth middleware — not modified.
- Any shared routes — not modified.

---

## Testing Required Before Production Use

1. **Run migration 075** in Supabase SQL Editor.
2. **Server restart** to pick up the new `taxpayer-profiles` router.
3. **Create a taxpayer profile** from:
   - The standalone page (`/practice/taxpayer-profiles.html`)
   - The client detail page (section 18 "+ New Profile" button)
4. **Verify generate-default-items** creates the correct checklist for each taxpayer type (individual → 6 items, company → 5, trust → 4, partnership → 4, cc → 5).
5. **Mark readiness items** as Received / Done / Blocked / Waived and verify the score recalculates correctly.
6. **Verify 409 guard** — generate defaults a second time and confirm the confirm dialog appears before force-regenerating.
7. **Add income source and deduction** and verify they appear in the detail modal tabs.
8. **Remove income source** and verify it disappears from the list (soft delete — `active = false`).
9. **Filter bar** — verify filtering by type, status, readiness, and client all work independently and in combination.
10. **"View All →" link** from client detail — verify it opens the profiles page pre-filtered to that client.

---

## Open Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Taxpayer profile → Document Requests cross-link
- What was done now: `related_document_request_id` column exists on readiness items (reference only — no FK)
- Not yet confirmed: Automatically linking readiness items to existing document requests for the same client
- Risk if not checked: Manual entry only; no auto-population from CB23 document requests
- Recommended next review point: CB26 or a dedicated "link readiness to docs" sub-task
```

```
FOLLOW-UP NOTE
- Area: CB25 readiness score vs CB24 compliance pack readiness
- What was done now: Both systems have independent readiness scores (per profile vs per pack)
- Not yet confirmed: Whether a future "client tax readiness dashboard" should aggregate both scores
- Risk if not checked: Low — both are independently correct
- Recommended next review point: When building a practice-wide readiness overview
```

---

## Recommended Next Codebox

**CB26 — Provisional Tax Planning + Tax Calendar Foundation**

- Tables: `practice_provisional_tax_plans`, `practice_tax_calendar_events`
- One provisional plan per taxpayer profile + tax year
- Tracks: estimated taxable income, first/second provisional payment dates, actual payments made
- Tax calendar: deadline store keyed by client + event type + date (IRP5, VAT returns, income tax, CIPC)
- No tax calculation — planning and tracking only
- Links to taxpayer profile via `profile_id`
