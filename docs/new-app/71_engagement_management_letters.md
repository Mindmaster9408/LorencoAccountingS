# Codebox 71 — Practice Engagement Management + Engagement Letter Foundation

> App: Lorenco Practice Management
> Status: Complete — migration 128 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Are we formally engaged to perform this work?" and "What engagements need review or renewal?" — within seconds. An enhancement layer over the practice's existing engagement system, adding risk acceptance, engagement-letter tracking, a richer review/renewal lifecycle, scope clarity, and governance events.

**DO NOT BUILD: document generation, e-signature, automatic proposal acceptance, legal drafting.** This module is structured engagement management and engagement-letter **tracking** only — future PDF/e-signature must plug into this foundation.

## Mandatory Pre-Build Audit — What Already Existed

A complete engagement system already exists and is **live**, built across Codeboxes 15/16 (migrations 065-067):

- `practice_service_catalog` (065) — master service list
- `practice_client_engagements` (065) — one row per client engagement, with generation-tracking columns added in 066 and recurrence-definition columns added in 067
- `practice_client_engagement_events` (065) — append-only audit trail, **no DB CHECK constraint** on `event_type`
- `practice_engagement_periods` (067) — manual recurrence period queue
- Router `modules/practice/engagements.js` (638 lines) + companion `engagement-periods.js` (694 lines), both mounted at the practice router's **root** (`router.use('/', ...)`), exporting only their router objects (no reusable helper functions)

**Critical finding**: `engagements.js`'s `generate-workflow`/`generation-preview` endpoints gate on the legacy `status` column being exactly `'active'` (lines 481, 502) — a live functional dependency, not just a naming convention. This fact shaped nearly every design decision below.

**Decision**: This codebox is built as an **enhancement layer**, exactly as instructed. `engagements.js` is never modified — not one line, not one behavior change. See migration 128's own header for the complete, field-by-field audit of what already existed vs. what was genuinely added.

## Architect Freedom — Scope Decisions & Deviations

1. **`engagement_status` (10 values) is a NEW, additive column — the legacy `status` column (4 values) is preserved and continues to drive `engagements.js` unchanged.** This mirrors the precedent from migration 125 (Entity Lifecycle's `current_lifecycle_status` vs. Secretarial's `company_status`) — **with one deliberate difference**: because `status === 'active'` has a real, live functional dependency (the generate-workflow gate), this module's own actions DO write to the legacy `status` column for the specific transitions with a clean, unambiguous equivalent (`STATUS_SYNC_MAP`: active→active, paused→paused, ended→ended, cancelled/rejected→cancelled). `draft`/`proposed`/`under_review`/`renewal_due`/`renewed` never touch it. This is a stronger sync discipline than Codebox 68's, justified by a provable cross-module dependency that Codebox 68's pair of statuses never had.
2. **Several spec-requested fields were mapped to existing columns instead of duplicated**: `responsible_partner_id` → existing `partner_team_member_id`; `responsible_manager_id` → existing `responsible_team_member_id`. `fee_amount` NUMERIC(14,2) was **not** applied — the existing NUMERIC(12,2) column is reused as-is (changing an already-live column's precision was judged unnecessary risk for zero benefit at current fee scales). `engagement_type`, `fee_basis`, and `billing_frequency` are new, genuinely distinct-granularity columns that co-exist with the older `service_category`/`billing_type`/`fee_frequency` — different concepts, not duplicates. Full mapping table in migration 128's header.
3. **A pre-existing-engagement edge case was found and handled explicitly.** Any engagement created before this migration (or via the legacy `engagements.js` router) gets `engagement_status = 'draft'` from the ALTER's own DEFAULT — even if its legacy `status` is already `'active'`. Every "is this engagement active" check in this module (`_isEffectivelyActive()`) therefore checks **either** condition (`engagement_status` in the active-like set **or** legacy `status === 'active'`), never just the new column alone. Without this, every pre-existing engagement would be misclassified as inactive by the new work-coverage-gap detector and the client engagement profile.
4. **The engagement-letter activation gate uses a deliberately broader reading than the spec's literal trigger.** The spec says "if `engagement_letter_status = required`... block unless signed or waived." Read literally, a letter that's been drafted or sent (but never signed) would have moved *off* `'required'` and could slip through the gate — an obvious loophole. This module blocks activation whenever the letter status is anything **other than** `not_required`/`signed`/`waived` (i.e. `required`, `drafted`, `sent`, and `expired` all block) — closing that gap while still honoring the two named exceptions exactly.
5. **The developer chose BLOCK, not WARN, for both the risk-acceptance gate and the letter gate** (the spec explicitly left this choice open). Both gates support an audited override: `activate`/`resume` accept an optional `override_risk_reason` that accepts risk inline as part of the same request (audited as `engagement_risk_accepted` with `metadata.override: true`); the letter gate has no override parameter by design — the only way past it is to actually get the letter signed or explicitly waived (itself an audited action requiring a reason), never a silent bypass flag.
6. **A `PUT /:id/reject` action was added beyond the spec's literal endpoint list** — the same reasoning as Codebox 69/70's `reopen`/`cancel` additions: the `rejected` engagement_status exists in the CHECK constraint but had no path to reach it. Added as the natural, minimal counterpart to `propose`, manager-gated, requires a reason.
7. **A second, brand-new, DB-CHECK-constrained events table (`practice_engagement_management_events`) was created instead of writing into the existing `practice_client_engagement_events`.** The existing table has no CHECK constraint and is owned entirely by `engagements.js`'s own vocabulary; writing this module's richer 18-value vocabulary into it would either require loosening its usage conventions or silently mixing two unrelated event taxonomies in one table. A dedicated table keeps both audit trails clean and independently correct — the same "each module owns its own events table" pattern used throughout this session.
8. **Work-coverage gap detection (`_detectPossibleGaps()`) flags only `possible_gap`, never definitively** — checking tax profile existence, PAYE-registered flag, secretarial profile/change-case existence, and time-entry existence against active engagement types. Each check is independently wrapped so one failing check never blocks the others.
9. **Client Onboarding's "create a starter engagement" option was declined.** The spec explicitly says "do not guess service scope," and a starter engagement requires `engagement_name` + `service_category` — neither of which can be safely inferred from onboarding's `entity_type` alone. Client Onboarding gets a read-only engagement-status/readiness display instead, matching the same "detect, never guess" discipline Codebox 70 already established for its own detection-only modules.

## Database — Migration 128

`practice_client_engagements` gains ~23 additive columns (risk acceptance, scope, letter-status mirror fields, richer lifecycle, review/renewal dates) — see migration header for the complete list and reasoning. Two new tables: `practice_engagement_letters`, `practice_engagement_management_events` (append-only). No existing table's prior behavior changes.

## Backend — `engagement-management.js`

Mounted at its **own dedicated prefix** `/engagement-management` (not the practice router's root, where `engagements.js`/`engagement-periods.js` already live) — zero path collision risk, zero shared route-ordering concerns.

### Endpoints (~25)

Summary, engagement CRUD (list/create/get/update/soft-cancel), a client-profile endpoint, 10 lifecycle actions (propose/reject/activate/pause/resume/start-review/complete-review/mark-renewal-due/renew/end) + accept-risk, full letter CRUD + 3 letter actions (send/sign/waive), events.

## Engagement Engine

`getClientEngagementProfile(cid, clientId)` — active engagements, due-for-review, renewal-due, missing-letters, high-risk, services-covered, and possible-gaps, all computed from `_isEffectivelyActive()`-filtered data (see Architect Freedom #3).

## Risk Acceptance Logic

High/critical-risk engagements cannot `activate`/`resume` without `risk_accepted_by` — either via a prior `PUT /:id/accept-risk` call, or an inline `override_risk_reason` on the activate/resume request itself (always audited, always requires a reason).

## Letter Tracking Logic

No document content is ever stored beyond a structured `content_snapshot` audit copy. See Architect Freedom #4-#5 for the activation-gate reading and the block-vs-warn decision.

## Integrations

- **Client Onboarding**: read-only engagement status/readiness panel (no starter engagement auto-created — see Architect Freedom #9).
- **Client Success**: engagement summary panel (active services, renewal due, missing letters, high risk) in the client detail modal.
- **Management Dashboard**: new "Engagement Management" KPI section (due for review, missing letters, high-risk-without-acceptance, clients-with-work-no-engagement — the last computed as a cheaper company-wide approximation, not the fully-typed per-client gap detection).
- **Planning Board**: an `engagement_risk_unaccepted` flag → "🛑 Risk Not Accepted" badge, same lightweight direct-query pattern as every other badge this session.

## Frontend

`engagement-management.html` + `js/engagement-management.js` (prefix `em`): two top-level tabs (All Engagements company-wide list with filters; Client Profile, client-picker-first) plus an Engagement Detail modal with its own Scope/Risk/Letters/Events sub-tabs and a status-driven action bar. No document viewer, no e-signature UI, no chart library, no AI.

## localStorage Findings

Zero matches across the migration, `engagement-management.js`, both new frontend files, and every edited file (`index.js`, `layout.js`, `client-onboarding.html`+`js`, `client-success.js`, `management-dashboard.js`+`js`+`html`, `planning-board.js`+`js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. `client_id` re-verified against `practice_clients` before engagement creation. Reads unrestricted per-user; all writes manager-gated (`_requireManager`).

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/128_practice_engagement_management_letters.sql` | ALTERs `practice_client_engagements` (additive) + 2 new tables |
| `accounting-ecosystem/backend/modules/practice/engagement-management.js` | Router + engine + risk/letter logic |
| `accounting-ecosystem/backend/frontend-practice/engagement-management.html` | Engagement Management UI |
| `accounting-ecosystem/backend/frontend-practice/js/engagement-management.js` | Engagement Management UI logic |
| `docs/new-app/71_engagement_management_letters.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_71_engagement_management.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `engagement-management` router at its own prefix |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Engagement Management" nav entry |
| `accounting-ecosystem/backend/frontend-practice/client-onboarding.html` + `js/client-onboarding.js` | Added read-only engagement status/readiness panel |
| `accounting-ecosystem/backend/frontend-practice/js/client-success.js` | Added engagement summary panel to client detail modal |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` + `js/management-dashboard.js` + `management-dashboard.html` | Added `engagement_management` block + KPI section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` + `js/planning-board.js` | Attaches `engagement_risk_unaccepted` flag; renders the badge |

**`engagements.js` and `engagement-periods.js` were NOT modified — zero lines changed in either file.**

## Recommended Codebox 72

Practice Engagement Scope Control + Work Authorization Gate, as specified — the next control layer once engagements formally exist, preventing work from happening outside an engagement's agreed scope.
