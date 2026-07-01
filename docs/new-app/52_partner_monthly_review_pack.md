# Codebox 52 — Practice Partner Monthly Review Pack

> Module: Practice Management — Partner Review Packs
> Status: Complete (migration 109 not yet applied to Supabase)
> Migration: 109
> Routes: `/api/practice/partner-review-packs/*`

---

## Purpose

Produces a partner-ready monthly (or ad-hoc) review pack — a frozen, deterministic
management report built from the Management Dashboard (Codebox 50) and KPI
History (Codebox 51), carried through a formal partner sign-off workflow
(submit for review → approve/reject) and exportable as HTML or PDF.

**This is NOT AI. NOT forecasting. NOT automated email reporting.** Every
figure in a pack is either a direct reuse of an existing compute function's
output or a plain subtraction between two frozen numbers.

---

## Architect Freedom — Deviations & Improvements (documented per spec's instruction)

1. **Extended the Codebox 51 reuse pattern to `computeExecutiveFeed`.** The report snapshot content list requires an "executive feed summary." Codebox 50's `/executive-feed` route wasn't previously extracted into a reusable function (only `/summary`, `/alerts`, `/partner-review`, `/practice-score` were, for Codebox 51). It was extracted the same way — zero behavior change to the existing route, exported for direct reuse — so this codebox never re-implements the 9-source feed-merging query set.

2. **Extended `kpi-history.js` to export its metric-extraction and delta-math internals.** `METRIC_EXTRACTORS`, `METRIC_KEYS`, `direction()`, and `deltaPct()` were exported from `kpi-history.js` so `partner-review-packs.js` computes "KPI Movement" and "Practice Score Movement" using the **exact same** metric definitions and delta formula as the KPI History trend viewer — never a second, potentially-diverging copy of the same 13-key mapping.

3. **Added a generic `_diffSection()` helper for all 8 "movement" sections** (risk, QMS, tax, capacity, client health, document requests, reminders, compliance). Rather than hand-writing ~40 individual field-delta calculations (one per numeric field across 8 sections), a single reusable function diffs any two same-shaped objects field-by-field. This is more than the 13 KPI History metric keys cover — it uses the **full** `kpi_data` payload stored in each snapshot (which already contains every field `computeSummary()` produces), so "movement" sections are genuinely rich, not limited to the narrow trend-viewer metric list.

4. **`draft` and `archived`/`cancelled` given concrete, documented meanings within the 7-status enum**, since the spec listed the allowed values but the endpoint list doesn't include a dedicated "create draft" or "archive" action:
   - `draft` is reserved for a future "create without generating" flow — not currently produced by any endpoint (the only creation path, `POST /generate`, always produces a `generated` pack with frozen data). Documented as unused-but-valid, not silently dropped from the CHECK constraint.
   - `DELETE /:id` produces **either** `cancelled` (pack withdrawn before completion — from `draft`/`generated`/`under_review`/`rejected`) **or** `archived` (a completed, `approved` pack being retired) depending on the pack's current status at delete time. This gives both terminal enum values a real, distinct meaning instead of collapsing them into one generic "soft delete."
   - `rejected` is treated as **non-terminal** — a rejected pack can be edited via `PUT` (to fix the issue the reviewer flagged) and resubmitted via `submit-review`, rather than requiring a brand-new pack to be generated. This matches how rejection normally works in a sign-off process (fix and resubmit the same document).

5. **Force-regenerate cancels the superseded pack rather than overwriting it** — identical reasoning to Codebox 51's force-recapture: a review pack is itself a historical record, and silently rewriting one that a partner may have already opened would defeat the purpose of "stable snapshot-based reporting" (implementation priority #2). The unique guard's partial index is scoped to exclude `cancelled`/`archived` so a superseded pack never blocks a fresh generation for the same period.

None of these deviations expand scope beyond "create a reliable monthly partner review pack" — they exist to make the existing spec requirements (reuse KPI logic, stable snapshots, clear sign-off workflow, meaningful status values) actually work together correctly, and are all called out explicitly here per the spec's instruction to document any improvement or deviation.

---

## Migration 109

### `practice_partner_review_packs`

All spec fields present exactly as specified. `pack_status` 7-value CHECK. Indexes on `company_id`, `pack_status`, `period_key` (partial, non-null), `review_period_start`, `review_period_end`, `snapshot_start_id` (partial), `snapshot_end_id` (partial) — all as requested. A duplicate-guard partial unique index on `(company_id, period_key)` **scoped to non-terminal statuses** (`NOT IN ('cancelled', 'archived')`) implements the spec's own stated rule ("duplicate active pack for same period_key should return 409 unless force=true") — this wasn't a named index in the spec's field list but is required to implement a rule the spec explicitly states.

### `practice_partner_review_pack_events`

Append-only, exactly as specified.

---

## Backend — `partner-review-packs.js`

### Endpoints (11 total, all from spec)

| Method | Route | Purpose |
|---|---|---|
| GET | `/` | Paginated list — filters: pack_status, period_from, period_to, page, limit |
| POST | `/generate` | Generate a new pack (see snapshot/report logic below) |
| GET | `/:id` | Single pack (full row, including frozen `report_snapshot`) |
| PUT | `/:id` | Edit narrative fields only (pack_name, executive_summary, partner_notes) |
| PUT | `/:id/submit-review` | generated/rejected → under_review |
| PUT | `/:id/approve` | under_review → approved |
| PUT | `/:id/reject` | under_review → rejected (requires `rejection_reason`) |
| DELETE | `/:id` | Soft cancel (non-approved) or archive (approved) |
| GET | `/:id/report-data` | Frozen report_snapshot as JSON |
| GET | `/:id/report-html` | Server-rendered HTML report |
| GET | `/:id/report-pdf` | PDFKit-generated PDF, streamed |
| GET | `/:id/events` | Append-only audit log |

### Snapshot/Report Logic

`POST /generate`:
1. **Duplicate guard**: if `period_key` given and an active (non-terminal) pack already exists for it, returns 409 with `existing_pack_id` unless `force=true`. With `force=true`, the existing pack is cancelled (event `partner_review_pack_cancelled`, `reason: 'force_regenerate'`) before the new one is created.
2. **Snapshot resolution**: if `snapshot_start_id`/`snapshot_end_id` are supplied, both are verified to belong to the company (404 if not). If not supplied, the nearest **active** KPI snapshot at-or-before each period boundary is used (`generated_at <= boundary date`, most recent first) — a warning is added to the pack if no snapshot exists for a boundary, and the report falls back to live current-state data for that boundary (never blocking generation — "if no snapshots exist, still allow current-state pack but add warning," per spec).
3. **Report freezing**: `_buildReportSnapshot()` calls `managementDashboard.computeSummary/computePracticeScore/computeAlerts/computePartnerReview/computeExecutiveFeed` (all live, all reused, never re-implemented) plus the resolved start/end snapshot rows, and assembles the full `report_snapshot` JSON — **no KPI value in the payload is ever accepted from the request body.**
4. The frozen JSON is stored in `report_snapshot` and **never recalculated** — `report-data`/`report-html`/`report-pdf` always read the stored value, confirmed stable even if underlying source data changes afterward.

`report_snapshot` contains every section the spec requires: `period`, `snapshots` (start/end refs), `latest_summary`, `latest_alerts`, `latest_partner_queue`, `latest_executive_feed`, `kpi_trends` (13 metric keys, reused from KPI History), `practice_score_movement`, `movement` (8 sections: risk/qms/tax/capacity/client_health/document_requests/reminders/compliance), `warnings`, `assumptions`.

### HTML/PDF Logic

Both `_buildHtmlReport()` and `_buildPdfReport()` render the same 15 sections in the same order the spec lists them (1. Header through 15. Disclaimer), reading only from the frozen `report_snapshot` (never recomputing). HTML is a self-contained string template (no external dependencies). PDF uses PDFKit — already installed (`pdfkit@^0.13.0`), following the exact defensive-load pattern used elsewhere in this codebase (`tax-reports.js`): `let PDFDocument; try { PDFDocument = require('pdfkit'); } catch (e) { PDFDocument = null; }`, with a 503 response if unavailable rather than crashing the server. The PDFKit API calls used (fillColor/font chaining, `bufferedPageRange()`, `switchToPage()`) were smoke-tested standalone and confirmed to produce a valid PDF stream before being wired into the router.

Auth-safe PDF download: the frontend calls `PracticeAPI.fetch()` (which attaches the Bearer token), reads the response as a `Blob`, creates an object URL, and triggers the download via a synthetic `<a download>` click — a plain `<a href="...">` would never carry the Authorization header, so this is the only way to download an authenticated PDF, exactly as the spec's "Auth-safe download through frontend fetch/blob" instruction requires.

### Partner Sign-Off Logic

State machine: `generated ⇄ under_review → approved` (terminal via archive) or `→ rejected` (non-terminal — editable and resubmittable back to `under_review`). `approve` sets `reviewed_by`/`reviewed_at` AND `approved_by`/`approved_at` together (the reviewing action IS the approval). `reject` sets `reviewed_by`/`reviewed_at` AND requires a non-empty `rejection_reason`. Approved packs are immutable via `PUT` (matches the approved-is-frozen convention used throughout this codebase — Knowledge Base, SOP Library, etc).

### Multi-Tenant Safety

Every query across all 11 endpoints scoped to `req.companyId`. `_verifyPack` re-checks ownership before every read/mutation. Snapshot ownership (`snapshot_start_id`/`snapshot_end_id`) explicitly verified against the company before use.

---

## Frontend — `partner-review-packs.html` + `js/partner-review-packs.js`

- Summary cards: total/generated/under_review/approved/rejected counts
- Filter bar: status, period from/to
- Pack list, click-through to detail
- Generate Pack modal — with inline "Force Regenerate" button appearing only after a 409 duplicate-period response (same UX pattern as Codebox 51's capture flow)
- Detail modal — 3 tabs: **Overview** (status, period, summary/notes, warnings), **Report** (score movement, KPI trend table, key alerts, "Open HTML Report ↗" and "Download PDF ⬇" buttons), **Events** (append-only log)
- Submit for Review / Approve / Reject (reason-required modal) / Cancel-or-Archive actions in the detail footer, context-sensitive to pack status
- No chart library — report viewer uses plain tables, per spec

### No localStorage / KV

Zero browser storage usage in any new file. `node --check` passed on all new/modified JS files.

---

## Management Dashboard / KPI History Integration

- **Management Dashboard**: a purple "📄 Generate Monthly Review Pack" link added next to the existing "📸 Capture KPI Snapshot" and "↻ Refresh" buttons, navigating to `partner-review-packs.html?generate=1` (auto-opens the Generate modal, same "navigate with intent" pattern as Codebox 51).
- **KPI History**: a "Create Partner Pack from Selected Snapshots" button added next to "Compare Selected (2)", reusing the same 2-snapshot selection checkboxes. Since snapshot IDs are sequential (`GENERATED BY DEFAULT AS IDENTITY`), the lower ID is treated as the start snapshot and the higher as the end (documented heuristic, avoids an extra lookup call) — navigates to `partner-review-packs.html?generate=1&snapshot_start_id=X&snapshot_end_id=Y`, pre-filling both fields in the Generate modal.

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/109_practice_partner_review_packs.sql` | 2 tables + trigger + indexes + partial unique index |
| `backend/modules/practice/partner-review-packs.js` | Backend router — 11 endpoints + HTML/PDF builders |
| `backend/frontend-practice/partner-review-packs.html` | Frontend page |
| `backend/frontend-practice/js/partner-review-packs.js` | Frontend IIFE (`prp` prefix) |
| `docs/new-app/52_partner_monthly_review_pack.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_52_partner_review_pack.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/management-dashboard.js` | Extracted `computeExecutiveFeed` as a reusable exported function (same pattern as Codebox 51's 4 functions) — zero behavior change to `/executive-feed` |
| `backend/modules/practice/kpi-history.js` | Exported `METRIC_EXTRACTORS`, `METRIC_KEYS`, `direction`, `deltaPct` for reuse; added "Create Partner Pack from Selected Snapshots" function |
| `backend/modules/practice/index.js` | Mount Partner Review Packs router at `/partner-review-packs` after `/kpi-history` |
| `backend/frontend-practice/js/layout.js` | Add "Partner Review Packs" nav entry after KPI History |
| `backend/frontend-practice/management-dashboard.html` | Add "📄 Generate Monthly Review Pack" link |
| `backend/frontend-practice/kpi-history.html` | Add "Create Partner Pack from Selected Snapshots" button |
