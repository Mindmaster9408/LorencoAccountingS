# Codebox 77 — Practice Executive Reporting + Board Pack Foundation

> App: Lorenco Practice Management
> Status: Complete — migration 134 not yet applied to Supabase — nothing committed or pushed

## Purpose

"What decisions do we need to make today?" instead of "where is the information?" — a frozen, approvable executive board pack assembled entirely from existing Practice engines, for partner meetings, management meetings, monthly/quarterly reviews, annual planning, and practice governance.

**This is NOT Business Intelligence, NOT Power BI, NOT AI reporting, NOT financial statement reporting.** It is a management reporting layer built from data every other codebox already computes.

## Mandatory Pre-Build Audit — Key Findings

No pre-existing executive-report/board-pack table exists anywhere. Confirmed reuse targets — every one read directly by `buildExecutiveReport()`, never a duplicate KPI/scoring engine:

- `management-dashboard.js` exports `computeSummary()`/`computePracticeScore()`/`computeAlerts()`/`computePartnerReview()`/`computeExecutiveFeed()` (Codebox 50) — the backbone of the report snapshot, exactly the same reuse pattern Partner Review Packs (Codebox 52) already established. `risk-register.js` and `quality-management.js` (Codeboxes 48/49) export **no** compute function at all, so Risk/QMS figures are reused via `computeSummary().risk`/`.qms` only.
- `partner-scorecards.js` exports `buildScorecard()` (Codebox 75) — called once with `scorecardType: 'practice'` for a live practice-level score. Read-only reuse, per the spec's own instruction.
- `profitability.js` exports `calculateProfitability()` (Codebox 73) — called practice-wide (no `clientId`) for the period. `pricing-review.js` exports `buildPricingReview()` (Codebox 74) but has **no** company-wide aggregate signature (it's per-client/engagement) — reused via `computeSummary().pricing_review` instead of looping per client.
- `capacity.js` exports `buildTeamCapacity()` (Codebox 18/57) and `planning-board.js` exports `buildTeamItemPool()` (Codebox 56) — neither appears in `computeSummary()`, so this is their first reuse in a report context, not a duplication.
- `kpi-history.js` exports `METRIC_EXTRACTORS`/`METRIC_KEYS`/`direction`/`deltaPct` (Codebox 51) — reused for the KPI Trends section against the nearest active `practice_kpi_snapshots` row at/before each period boundary, identical to Partner Review Packs' own diffing pattern. No second KPI-diff engine was written.
- `secretarial-calendar.js`/`secretarial-evidence.js` (Codeboxes 66/67) are **not** re-invoked directly — their output is already folded into `computeSummary()`'s `statutory_compliance`/`evidence_readiness`/`secretarial_integrity` blocks, reused from there.
- `notifications.js` and `learning-centre.js` export no company-wide summary function — their sections are plain count-only queries against `practice_notifications`/`practice_learning_plans`, never re-deriving either module's internal scoring formula.

## Architect Freedom — Scope Decisions & Deviations

1. **A `confidence` rating (`high`/`medium`/`low`) is computed deterministically from the warnings count** (0 → high, 1–2 → medium, 3+ → low) — the spec asks the engine to return "Confidence" without dictating a formula; documented explicitly as a judgment call, no AI involved.
2. **`cancellation_reason` columns were added** to reports/decisions/actions for the same "reason required for consequential actions" convention used throughout this session.
3. **Four event types were added beyond the spec's literal 12** (`report_cancelled`, `decision_cancelled`, `action_cancelled`, `decision_updated`/`action_updated`/`report_updated`) so every status change and edit has a matching event — same convention as Codebox 76.
4. **A `published_by`/`published_at` pair was added to `practice_executive_reports`** beyond the spec's literal field list, mirroring `approved_by`/`approved_at`, since `published` is a distinct workflow status with its own actor/timestamp.
5. **Report creation supports two paths**: `POST /` (create as `draft`, no snapshot) then `POST /:id/generate`, or a one-shot `POST /generate` (create+generate together, matching Partner Review Packs' exact shape) — used by Strategic Planning's deep link. Both converge on the same `buildExecutiveReport()` engine and the same frozen-snapshot discipline.
6. **Sections are upserted, not recreated, on regenerate** — a unique `(report_id, section_key)` index means regenerating a report refreshes every engine-sourced section's `section_snapshot` in place while never touching a section a partner already flipped to `manual`.
7. **A manual section can only be added for a `section_key` not already present on the report** (enforced by the same unique index) — a partner adds freeform content under an unused key (typically `recommendations`), rather than a second row under an existing key.
8. **Capacity and Planning sections call their engines directly** (`buildTeamCapacity()`, `buildTeamItemPool()`) rather than relying solely on `computeSummary()`'s rollup counts, since neither appears in `computeSummary()` at all — this is additive first-use, not a duplicate of anything.
9. **All 20 mutating routes are manager-gated via the canonical `lib/team-access.js` helper**, deliberately deviating from the zero-gating precedent of the pure-reporting family this codebox builds on (Management Dashboard, KPI History, Partner Review Packs have no role check anywhere). Approving/publishing a board pack is a governance-significant action; every write goes through `_requireManager()` → `teamAccess.requireManager()`, per CLAUDE.md's just-established rule that no module may re-implement authorization logic. GET/list endpoints remain open to any authenticated company user, matching the operational-module family's read/write split.

## Database — Migration 134

Five new tables: `practice_executive_reports`, `practice_executive_report_sections`, `practice_executive_decisions`, `practice_executive_action_register`, `practice_executive_events` (append-only, one shared log with nullable reference columns, same convention as Codebox 76's `practice_strategic_events`). No changes to any existing table.

## Backend — `executive-reporting.js`

Full CRUD on reports/sections/decisions/actions, 5 report workflow actions (generate/submit-review/approve/publish/archive) plus soft-cancel DELETE, decision/action complete + soft-cancel DELETE, report HTML/PDF export (PDFKit — the same library and template-string-HTML pattern already used by Partner Review Packs, Tax Reports, and Billing; no second reporting engine was introduced), and company-wide list endpoints for Decisions/Actions/Events so those can be their own top-level page tabs, not just nested under a report.

### Report Engine — `buildExecutiveReport()`

Collects Practice Health, Strategic Progress, KPI Trends, Partner Scorecards, Profitability, Pricing, Client Success, Capacity, Planning, Risk, Quality, Secretarial, Notifications, and Learning — 14 sections total — entirely from the reuse targets listed above. Returns `{ reportSnapshot, sectionDefs, warnings, missingInformation, confidence }`. Called from `POST /:id/generate` (regenerate an existing draft/generated/under_review report) and `POST /generate` (create+generate in one call).

## Generation & Immutability

Generation freezes `report_snapshot` and upserts section rows. Reports never change automatically afterwards — regenerating (allowed while `draft`/`generated`/`under_review`) is the only way to refresh, and it always fully overwrites the snapshot and every non-manual section. `approved`/`published`/`archived` reports are completely frozen — no edit, no regenerate, no narrative changes.

## Decision & Action Registers

`practice_executive_decisions` is an executive decision register only — it never creates `practice_tasks` or workflow items. `practice_executive_action_register` is a lightweight management follow-up list, explicitly not a replacement for Task Management; a future integration may reference an action, but this module never creates a task from one.

## Integrations

- **Management Dashboard**: a new KPI block (latest report, reports awaiting approval, outstanding actions) — count-only direct queries against the new tables, same pattern as every other KPI block. Deliberately does **not** `require('./executive-reporting')` — that module already requires `management-dashboard.js` for its own report engine, so a reverse require would be circular; direct queries avoid that entirely.
- **Strategic Planning**: a "Create Executive Report" button on each plan review deep-links to `/practice/executive-reporting.html` with `report_title`/`report_type`/`period_start`/`period_end` pre-filled from the review — Strategic Planning does not call into `executive-reporting.js` or write to its tables; the partner still confirms and generates the report there.
- **Partner Scorecards**: read-only reuse via `buildScorecard()` — no write path, no scoring change.

## Frontend

`executive-reporting.html` + `js/executive-reporting.js` (prefix `er`): 4 top-level tabs (Reports/Decisions/Action Register/Events) plus a Report Detail modal (Overview/Sections/Decisions/Actions/Events) — the spec's own "Sections: Summary, Reports, Decisions, Action Register, Events" structure, with Decisions/Actions/Events available both company-wide (top-level tabs) and scoped to one report (inside its detail modal).

## localStorage Findings

Zero matches across the migration, `executive-reporting.js`, both new frontend files, and every edited file (`management-dashboard.js`, `strategic-planning.js`, `layout.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. All report/section/decision/action writes require the caller to be authenticated and company-scoped via `authenticateToken`/`requireCompany` — matching the rest of the practice module (this codebox does not add a manager-only gate of its own; see Remaining Risks).

## Files Created

| File | Purpose |
| --- | --- |
| `accounting-ecosystem/backend/config/migrations/134_practice_executive_reporting.sql` | 5 tables: reports, sections, decisions, action register, append-only events |
| `accounting-ecosystem/backend/modules/practice/executive-reporting.js` | Router + `buildExecutiveReport()` engine + PDF/HTML builders |
| `accounting-ecosystem/backend/frontend-practice/executive-reporting.html` | Executive Reporting UI |
| `accounting-ecosystem/backend/frontend-practice/js/executive-reporting.js` | Executive Reporting UI logic |
| `docs/new-app/77_executive_reporting.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_77_executive_reporting.md` | Handoff |

## Files Modified

| File | Change |
| --- | --- |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `executive-reporting.js` router at `/executive-reporting`, right after Partner Review Packs |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | Added `executive_reporting` block to `computeSummary()` (direct count queries, no circular require) |
| `accounting-ecosystem/backend/frontend-practice/js/management-dashboard.js` | Rendered the new KPI card |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added the "Executive Reporting" KPI grid container |
| `accounting-ecosystem/backend/frontend-practice/js/strategic-planning.js` | Added `spCreateExecutiveReport()` deep-link button on each plan review |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added the "Executive Reporting" nav entry |
