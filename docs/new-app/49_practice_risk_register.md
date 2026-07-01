# Codebox 49 — Practice Risk Register + Internal Control Matrix

> Module: Practice Management — Risk Register
> Status: Complete (migration 107 not yet applied to Supabase)
> Migration: 107
> Routes: `/api/practice/risk-register/*`

---

## Purpose

Internal practice governance layer tracking risks across seven categories
(operational, compliance, tax, payroll, finance/cyber/privacy/fraud,
business continuity, client service, strategic) with owners, likelihood ×
impact scoring, controls, residual risk, mitigation/contingency plans, and
periodic review history.

**This is NOT enterprise risk software.** It is a lightweight internal
governance register sized for an accounting practice, not a full GRC platform.

---

## Migration 107

### `practice_risks` — one row per risk

| Field | Notes |
|---|---|
| `category` | 12-value CHECK: `operational`, `compliance`, `tax`, `payroll`, `finance`, `cyber`, `privacy`, `fraud`, `business_continuity`, `client_service`, `strategic`, `other` |
| `status` | 6-value CHECK: `open`, `monitoring`, `mitigated`, `accepted`, `closed`, `cancelled` |
| `likelihood` / `impact` | INTEGER, CHECK 1–5 each |
| `inherent_risk` | **Always server-calculated** as `likelihood * impact` (1–25) — never accepted from the client, recomputed on every likelihood/impact change. This is the "Overall Rating" from the spec's requirements list. |
| `residual_risk` | Nullable INTEGER 1–25 — manually assessed after considering controls (no automatic control-effectiveness discount formula) |
| `review_frequency` | 5-value CHECK: `monthly`, `quarterly`, `biannual`, `annual`, `ad_hoc` |
| `source_type` / `source_id` | Nullable — set only when the risk was created from a Quality Finding, Knowledge Article, Tax Dispute, or Completion Pack. A risk originates from at most ONE source, so this is a direct column pair rather than a link table (contrast with Codebox 46/47's many-to-many link tables) |

Auto-updates `updated_at` via `tg_prisk_updated_at` trigger. Two safety indexes:
- `idx_prisk_heatmap` on `(company_id, likelihood, impact)` for the heat map query
- `uq_prisk_active_title_client` — **partial unique index** enforcing the spec's duplicate rule ("no duplicate active risk with same title + linked client"), case-insensitive via `lower(title)`, with a `-1` sentinel via `COALESCE` so risks with no linked client are also deduplicated correctly

### `practice_risk_controls` — Internal Control Matrix

`control_type` is free TEXT (no "Allowed" list was given in the spec, matching the established convention from Codebox 47 where unlisted enum-like fields are left as free text). `effectiveness` is the one CHECK-constrained field (3 values: `ineffective`, `partially_effective`, `effective`). `is_active` boolean supports soft-remove (added — not in the spec's literal field list, but required to implement "CRUD Controls" with a `DELETE` endpoint per this codebase's consistent soft-delete convention).

### `practice_risk_reviews` — Review History

Two-step lifecycle: `POST .../reviews` creates a `draft` row (scheduling a review), `PUT .../reviews/:id/complete` snapshots the assessment (`likelihood_at_review`, `impact_at_review`, `residual_risk_at_review`) and freezes it — later changes to the parent risk never retroactively alter a completed review's snapshot.

### `practice_risk_events` — append-only audit log

Covers risk-level, control-level (`control_id`), and review-level (`review_id`) events in one table.

---

## Backend — `risk-register.js`

### Endpoints (24 total)

| Method | Route | Purpose |
|---|---|---|
| GET | `/summary` | Status counts + high-inherent-risk count + overdue-review count + category breakdown |
| GET | `/heatmap` | 5×5 grid of active-risk counts per (likelihood, impact) cell |
| GET | `/risks` | Paginated list — filters: search, category, status, linked_client_id, owner_team_member_id, source_type, source_id |
| POST | `/risks` | Manual create (duplicate-guarded) |
| GET | `/risks/:id` | Single risk, enriched with client name |
| PUT | `/risks/:id` | Update — recomputes `inherent_risk` if likelihood/impact change |
| DELETE | `/risks/:id` | Soft cancel |
| PUT | `/risks/:id/close` | Any non-terminal → closed |
| PUT | `/risks/:id/reopen` | closed/cancelled → open |
| GET/POST | `/risks/:id/controls` | List / add controls |
| PUT/DELETE | `/controls/:controlId` | Update / soft-remove a control |
| GET/POST | `/risks/:id/reviews` | List / schedule a review |
| PUT | `/reviews/:reviewId/complete` | Complete a review — snapshots assessment, propagates to parent risk |
| GET | `/risks/:id/events` | Append-only event log |
| POST | `/create-from-finding` | Create risk from a `practice_quality_findings` row |
| POST | `/create-from-knowledge-article` | Create risk from a `practice_knowledge_articles` row |
| POST | `/create-from-tax-dispute` | Create risk from a `practice_tax_dispute_cases` row |
| POST | `/create-from-completion-pack` | Create risk from a `practice_tax_completion_packs` row |

### Risk Logic

`inherent_risk` is never client-supplied — always `likelihood * impact`, recalculated server-side on create and on any update that changes either factor. `residual_risk` remains manual (same judgment call documented for QMS's `quality_score` in Codebox 48 — automatic control-effectiveness scoring can be added later without breaking manually-entered values).

### Control Logic

Controls are scoped to a risk (`risk_id`). `effectiveness` is optional (a control can exist before it's been assessed). Soft-removed via `is_active = false` rather than hard delete, preserving history for audit.

### Heat Map Logic

`GET /heatmap` returns a 5×5 array of `{ likelihood, impact, count }` cells counting **active** risks only (`status NOT IN ('closed','cancelled')`). The frontend renders it as a colour-graded grid (likelihood as rows 5→1 top-to-bottom, impact as columns 1→5 left-to-right — conventional heat-map orientation) and each cell is clickable to filter the risk table to that exact likelihood/impact combination.

### Duplicate Guard

Enforced both at the application layer (`_findActiveDuplicate` — case-insensitive title match + linked client, excluding closed/cancelled — returns 409 with `existing_risk_id`) and at the database layer (`uq_prisk_active_title_client` partial unique index), matching the pattern established in Codebox 48.

### Create-From-Source Integrations

Each helper verifies the source record belongs to the company, applies the duplicate guard, and defaults `category`/title from the source (all overridable in the request body). `client_id` resolution:
- `create-from-tax-dispute` / `create-from-completion-pack`: source tables carry `client_id` directly — inherited automatically
- `create-from-finding`: `practice_quality_findings` has no `client_id` column — resolved via the finding's parent `practice_quality_reviews.client_id`
- `create-from-knowledge-article`: `practice_knowledge_articles` has no client concept (practice-wide) — `client_id` stays null unless explicitly passed

### Multi-Tenant Safety

Every query scoped to `req.companyId`. `_verifyRisk`, `_verifyControl`, `_verifyReview` re-check ownership before every mutating action. Source-record ownership verified before creating a risk via any create-from-* helper.

---

## Frontend — `risk-register.html` + `js/risk-register.js`

### Page

- Summary cards (Open, Monitoring, Mitigated, Accepted, Closed, High Inherent Risk, Review Overdue) — status cards clickable to filter
- **Heat map**: 5×5 colour-graded grid, clickable cells filter the table to that likelihood/impact combination
- Filter bar: category, status, client ID, free-text search
- Paginated risks table (category, status, title, client, inherent rating, residual rating, next review date) — colour-coded rating badges (low/medium/high/critical)
- Create Risk modal (title, category, review frequency, likelihood, impact, client ID, owner, next review date, mitigation/contingency plans, monitoring notes)
- Risk Detail modal — 4 tabs:
  - **Overview**: metadata grid (category, status, client, owner, likelihood, impact, inherent/residual ratings, review frequency, next review) + mitigation/contingency/monitoring text + source provenance
  - **Controls**: list with effectiveness badges, add/remove
  - **Reviews**: history list, "Schedule Review" and "Complete Review" (opens a modal for likelihood/impact/residual/next-date/notes)
  - **Events**: append-only audit log
- Context-sensitive footer: non-terminal → Close Risk + Cancel; terminal → Reopen
- `?source_type=X&source_id=Y` URL params render an info banner listing risks created from that source, with a "Create one ↗" quick action

### No localStorage / KV

Zero browser storage usage in any new file. `node --check` passed on all new/modified JS files.

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/107_practice_risk_register.sql` | 4 tables + 3 triggers + indexes + partial unique index |
| `backend/modules/practice/risk-register.js` | Backend router — 24 endpoints |
| `backend/frontend-practice/risk-register.html` | Frontend page (incl. heat map) |
| `backend/frontend-practice/js/risk-register.js` | Frontend IIFE (`risk` prefix) |
| `docs/new-app/49_practice_risk_register.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_49_risk_register.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Mount Risk Register router at `/risk-register` after `/qms` |
| `backend/frontend-practice/js/layout.js` | Add "Risk Register" nav between Quality and Tax Config |
| `backend/frontend-practice/js/quality-management.js` | Add "Risk ↗" link per finding, alongside resolve/verify/cancel actions |
| `backend/frontend-practice/js/knowledge-base.js` | Add "Risk ↗" link to article detail footer |
| `backend/frontend-practice/js/tax-disputes.js` | Add "Risk ↗" link to dispute footer, alongside "Knowledge ↗" |
| `backend/frontend-practice/js/tax-completion.js` | Add "Risk ↗" link to completion pack footer, alongside "Knowledge ↗", "Procedure ↗", "QMS Review ↗" |
