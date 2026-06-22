# Codebox 33 — Company Tax Review Pack + Draft PDF

**App:** Lorenco Practice Management
**Date:** 2026-06-21
**Status:** Implemented

---

## Purpose

Generates an immutable review pack from captured company tax return data:
AFS inputs, adjustments, latest draft calculation, warning flags, assumptions,
and reviewer sign-off — rendered as HTML (dark-themed) and PDF (PDFKit).

**NOT SARS-final. NOT ITR14 submission. NOT eFiling. NOT tax advice.**
Every pack and report shows: "DRAFT COMPANY TAX ESTIMATE ONLY — accountant review required."

---

## What Was Built

### Database (Migration 083)

| Table | Purpose |
|---|---|
| `practice_company_tax_review_packs` | One row per generated pack per return. Contains immutable `report_snapshot` JSONB. |
| `practice_company_tax_review_pack_events` | Audit event log — every generate, submit-review, approve, reject recorded. |

### Backend (`company-tax-review-packs.js`)

Standalone router mounted as third fallthrough at `/api/practice/company-tax`
(after `company-tax.js` CB31 and `company-tax-calculations.js` CB32).

| Endpoint | Purpose |
|---|---|
| `POST /:returnId/review-packs/generate` | Snapshot all return data; create pack |
| `GET /review-packs/:id/report-data` | Return pack + snapshot JSON |
| `GET /review-packs/:id/report-html` | Render full HTML report (dark theme) |
| `GET /review-packs/:id/report-pdf` | Stream PDF via PDFKit (501 if not installed) |
| `PUT /review-packs/:id/submit-review` | Transition: generated/draft/rejected → ready_for_review |
| `PUT /review-packs/:id/approve` | Transition: ready_for_review/reviewed → approved |
| `PUT /review-packs/:id/reject` | Transition: ready_for_review/reviewed → rejected (reason required) |
| `GET /review-packs/:id/events` | Audit event list for a pack |
| `GET /review-packs/:id` | Fetch single pack |
| `GET /:returnId/review-packs` | List all non-cancelled packs for a return |

Route ordering: All 3-segment specific routes registered BEFORE 2-segment generic routes.

### Snapshot Builder (`buildSnapshot`)

Pulls at generation time (immutable after):

| Source | Data fetched |
|---|---|
| `practice_company_tax_returns` | All return fields (AFS, assessed loss, status, FY dates) |
| `practice_clients` | display_name, company_name, client_type |
| `practice_taxpayer_profiles` | taxpayer_type, income_tax_reference, registration_number |
| `practice_company_tax_adjustments` | All adjustments — type, description, amount, tax_effect |
| `practice_company_tax_readiness_items` | All readiness items — status used for scoring |
| `practice_company_tax_calculations` | Latest non-cancelled calculation (or supplied calcId) |

Computed at snapshot time:
- `readiness`: score (0–100), status (ready/partial/incomplete/blocked/unknown), counts
- `afs`: all AFS numeric fields extracted from return row
- `adjustment_totals`: add_back_total, disallowance_total, deduction_total, allowance_total
- `warning_flags`, `assumptions`, `calculation_lines`: from calculation or fallback defaults

**Source data changes after generation do NOT affect an existing pack.**

### HTML Report Sections

| Section | Content |
|---|---|
| 1. Header | Lorenco Practice Management banner, draft warning, pack meta |
| 2. Client / Company Details | Name, type, registration number, income tax ref, tax year, FY period |
| 3. Return Readiness | Score, status, required/done/blocked counts, blocked item list |
| 4. AFS Input Summary | Turnover, COS, gross profit, other income, opex, finance costs, accounting profit/loss, assessed loss schedule |
| 5. Tax Adjustments | Adjustment table by type; add-back/disallowance/deduction/allowance totals |
| 6. Draft Calculation Summary | Calculation lines table; taxable income / payable / refund summary cards |
| 7. Warning Flags | All flags as chips |
| 8. Assumptions & Tax Config | Rate source, calculation name/version, assumption list, unsupported area list |
| 9. Reviewer Sign-off | Prepared by / reviewed by / approval notes fields |
| 10. Disclaimer | "DRAFT COMPANY TAX ESTIMATE ONLY — NOT SARS-final" |

### PDF (PDFKit)

- Requires `pdfkit ^0.13.0` (already in package.json)
- Same 10 sections as HTML, rendered to A4 at 50pt margin
- Graceful fallback: if PDFKit unavailable → 501 with HTML redirect message
- Filename: `draft-co-tax-review-{tax_year}-{client-name}.pdf`

### Frontend (`company-tax.html` + `js/company-tax.js`)

**Added tab:** Review Packs (7th tab in the detail modal).

**Features:**
- Permanent draft warning banner on tab
- "Generate Review Pack" button — calls `POST /:returnId/review-packs/generate`
- Pack list (newest first) — click to open inline detail
- Pack detail: status badge, metadata, warning flag chips, action buttons
- "View Report" — fetches HTML via API with auth headers → blob URL → new tab
- "Download PDF" — fetches PDF via API with auth headers → blob → download trigger
- Submit for Review / Approve / Reject buttons per status
- Reject reason modal (`#ctRpRejectModal`) — requires non-empty reason
- Auth-safe: report/PDF use `PracticeAPI.fetch()` (Authorization header) then blob URL

**State vars added:**
- `_RP_BASE` = `/api/practice/company-tax`
- `_rpSubmitting` — double-submit guard for generate
- `_rpRejectId` — tracks which packId is being rejected
- `_rpDetailId` — tracks which packId detail is open

**Functions added (11):**
- `loadCtReviewPacks()` — fetch and render pack list
- `ctGenerateReviewPack()` — POST generate, auto-open result
- `ctOpenRpDetail(packId)` — fetch + render pack detail inline
- `ctCloseRpDetail()` — hide detail, clear card highlight
- `ctViewRpReport(packId)` — fetch HTML → blob URL → new tab
- `ctDownloadRpPdf(packId)` — fetch PDF → blob → download link
- `ctSubmitRpReview(packId)` — PUT submit-review
- `ctApproveRp(packId)` — PUT approve
- `ctOpenRpRejectModal(packId)` — show reject modal
- `ctCloseRpRejectModal()` — hide reject modal
- `ctConfirmRpReject()` — PUT reject with reason

---

## Snapshot Immutability

The `report_snapshot` JSONB column is written once at generate time and never
updated by any endpoint. If the accountant changes AFS inputs or runs a new
calculation after generating a pack, the existing pack's snapshot is unaffected.
To reflect latest data, generate a new pack.

## Multi-Tenant Safety

- All routes filter on `company_id = req.companyId`
- `verifyReturnOwnership()` validates return before generate and list
- `verifyPackOwnership()` validates pack before all `:id` operations
- `calculation_id` validated against both `company_id` and `company_tax_return_id`
- All snapshot sub-queries scoped to `company_id = cid`

## No Browser Storage

Zero `localStorage`, `sessionStorage`, or KV writes for any pack or report data.
All data via `/api/practice/company-tax/*` → Supabase.

## No Silent Finalization

- Generating a review pack does NOT change company tax return status
- Approving a review pack does NOT mark the return as submitted or completed
- No ITR14, no SARS file, no eFiling call in this codebox

## Audit Events

| Event | Trigger |
|---|---|
| `company_tax_review_pack_generated` | POST generate |
| `company_tax_review_pack_report_viewed` | GET report-data / report-html / report-pdf |
| `company_tax_review_pack_submitted_review` | PUT submit-review |
| `company_tax_review_pack_approved` | PUT approve |
| `company_tax_review_pack_rejected` | PUT reject |

---

## Known Limitations / Follow-up Notes

```
FOLLOW-UP NOTE
- Area: Report-PDF auth for direct browser opens
- What was done: PDF fetched via PracticeAPI.fetch() with auth headers → blob URL
- Not yet implemented: Signed URL or session-cookie auth for direct link opens
- Risk: Blob URL approach works but requires JS; cannot link to PDF directly
- Recommended next review: If PDF sharing outside the app is required, implement signed URL

FOLLOW-UP NOTE
- Area: Calculation snapshot alignment
- What was done: Latest non-cancelled calculation fetched at generate time
- Not yet: If a calc is deleted/cancelled after pack generation, pack snapshot is safe
- Risk: Low — snapshot is immutable. Historical calc rows remain.

FOLLOW-UP NOTE
- Area: Review pack regeneration vs versioning
- What was done: Each generate creates a new pack row; old packs remain
- Not yet: No auto-cancellation of previous packs on new generate
- Risk: Multiple packs with different snapshots may confuse reviewer
- Recommended: Add UI hint showing latest pack vs older packs
```
