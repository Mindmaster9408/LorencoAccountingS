# Codebox 30 — Individual Tax Review Pack + Draft Tax Report PDF

**App:** Lorenco Practice Management  
**Date:** 2026-06-21  
**Status:** Implemented

---

## Purpose

Provides accountants with a structured, reviewable snapshot of an individual tax return:
taxpayer details, captured income, deductions, checklist readiness, draft calculation
summary, warning flags, assumptions, and a reviewer sign-off section.

**This is NOT SARS-final. NOT eFiling. NOT tax advice.**  
It is an internal review/reporting pack only. All output requires accountant review.

---

## What Was Built

### Database (Migration 080)

| Table | Purpose |
|---|---|
| `practice_individual_tax_review_packs` | One row per generated review pack. Stores immutable `report_snapshot` JSONB. |
| `practice_individual_tax_review_pack_events` | Audit log — every status transition and report view is recorded. |

**Key design decision — `report_snapshot`:**  
At generation time, all source data (return, client, profile, income, deductions,
items, calculation) is snapshotted into `report_snapshot` JSONB. All subsequent
report renders read from this snapshot only. Source data changes after generation
do NOT affect the pack — the pack is a point-in-time document.

### Backend (`individual-tax-review-packs.js`)

Mounted at `/api/practice/individual-tax` as a third router (after `individual-tax.js`
and `individual-tax-calculations.js`). Express falls through to it for unmatched routes.

| Endpoint | Purpose |
|---|---|
| `GET /:returnId/review-packs` | List all non-cancelled packs for a return |
| `POST /:returnId/review-packs/generate` | Build snapshot + create pack (status: generated) |
| `GET /review-packs/:id` | Get single pack |
| `GET /review-packs/:id/report-data` | Get structured snapshot data (JSON) |
| `GET /review-packs/:id/report-html` | Full HTML report rendered from snapshot |
| `GET /review-packs/:id/report-pdf` | PDF streamed via PDFKit from snapshot |
| `PUT /review-packs/:id/submit-review` | Transition: generated/draft/rejected → ready_for_review |
| `PUT /review-packs/:id/approve` | Transition: ready_for_review/reviewed → approved |
| `PUT /review-packs/:id/reject` | Transition: ready_for_review/reviewed → rejected |
| `GET /review-packs/:id/events` | Audit event log for this pack |

**Route ordering is critical:** 3-segment routes (`/review-packs/:id/report-html`, etc.)
are registered before 2-segment routes (`/review-packs/:id`) to prevent premature matching.

### PDF

Uses PDFKit v0.13.0 (already installed). Streamed directly via `res.pipe(doc)` — no
temp files. If PDFKit is absent, a 501 error is returned and the HTML report remains
available.

### Frontend

**`individual-tax.html`** — Added:
- Review Packs CSS (`.it-rp-card`, `.it-rps-*` status badges, event rows)
- "Review Packs" tab button in the detail modal tab bar
- `itTabReviewPacks` tab panel with draft warning banner
- Review Pack Events modal (`itRpEventsModal`)
- Reject reason modal (`itRpRejectModal`)

**`js/individual-tax.js`** — Added:
- `loadReviewPacks()` — loads packs for active return
- `itGenerateReviewPack()` — POST generate endpoint
- `viewRpReport(packId, format)` — fetch → blob URL (handles auth headers; PDF downloads, HTML opens in new tab)
- `itSubmitPackForReview()`, `itApproveReviewPack()`, `itConfirmRejectPack()` — lifecycle transitions
- `loadRpEvents(packId)` — event history modal
- Patched `window.itSwitchTab` to trigger `loadReviewPacks()` on tab activation
- Added `'review-packs': 'itTabReviewPacks'` to the existing `panelMap` in `itSwitchTab`

---

## Pack Status Lifecycle

```
draft → generated → ready_for_review → approved
                                     → rejected → ready_for_review (resubmit)
```

---

## Report Content (10 Sections)

1. Header — practice branding, draft warning, pack metadata
2. Client / Taxpayer Details — name, type, ID/passport, tax reference, tax year
3. Tax Return Readiness — score %, status, item counts, blocked items
4. Captured Income — table with gross amounts and PAYE withheld
5. Captured Deductions — table with deduction amounts
6. Draft Calculation Summary — full calculation lines + payable/refund highlights
7. Warning Flags — all flags from the calculation (or `NO_CALCULATION_AVAILABLE`)
8. Tax Config Source — DB vs JS fallback, version, assumptions applied
9. Reviewer Sign-off — prepared by / reviewed by / date fields + approval notes
10. Disclaimer — permanent draft/non-SARS warning

---

## Multi-Tenant Safety

- Every query filters on `company_id = req.companyId`
- Client, profile, and return ownership are verified before snapshot build
- Calculation ID is validated against both `company_id` and `tax_return_id`
- No cross-company data can appear in any snapshot

## No Browser Storage

No `localStorage`, `sessionStorage`, or KV bridge is used for any pack data.
All data flows through `/api/practice/individual-tax/review-packs/*` → Supabase DB.

---

## Audit Logging

Every material action logs to `practice_individual_tax_review_pack_events`:

| Event | Trigger |
|---|---|
| `individual_tax_review_pack_generated` | Pack created |
| `individual_tax_review_pack_report_viewed` | HTML, PDF, or data endpoint hit |
| `individual_tax_review_pack_submitted_review` | Submit for review |
| `individual_tax_review_pack_approved` | Approve |
| `individual_tax_review_pack_rejected` | Reject |

---

## Known Limitations / Follow-up Notes

```
FOLLOW-UP NOTE
- Area: Review Pack report rendering
- What was done: HTML report uses dark-theme inline CSS for web viewing; PDF uses PDFKit
- Not yet confirmed: Whether print-to-PDF from browser (Ctrl+P) is needed as alternative
- Risk if not checked: Print output may need a @media print stylesheet pass for paper output
- Recommended next review: Codebox 31 or when first review pack is tested end-to-end

FOLLOW-UP NOTE
- Area: PDF `viewRpReport` — blob URL approach
- What was done: fetch → blob → createObjectURL → anchor click
- Not yet confirmed: Behaviour on Safari iOS (blob download may not work as expected)
- Risk if not checked: PDF download may silently fail on mobile Safari
- Recommended next check: Test on Safari before client-facing rollout

FOLLOW-UP NOTE
- Area: Pack snapshot regeneration
- What was done: No regenerate endpoint exists — a new pack must be generated
- Decision: This is intentional — each generation is a new point-in-time record
- If practice wants to "refresh" a pack: generate a new one, archive the old one
```
