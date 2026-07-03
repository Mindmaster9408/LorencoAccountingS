# Codebox 61 — Practice Client Success & Relationship Management

> App: Lorenco Practice Management
> Status: Complete — migration 118 not yet applied to Supabase — nothing committed or pushed

## Purpose

Answers "which client needs me today?" — relationship health, planned success activities, strategic opportunities, key contacts, communication cadence, and meeting history, all in one place.

**NOT a CRM. NOT a sales pipeline. NOT marketing/email marketing. NOT lead management. NOT client master data** (name/type/onboarding stays authoritative in `practice_clients`). Fully manager-controlled, deterministic, explainable. No AI, no forecasting, no automatic scoring propagation.

## Architect Freedom — Scope Decisions & Deviations

1. **`practice_client_contacts` already existed as a live, working feature with no prior migration file.** Audit (RULE A1) found full CRUD for this table already implemented in `modules/practice/index.js` (lines ~988-1092) — routes, sanitization, soft-delete via `is_active` — but zero `CREATE TABLE` anywhere in the repo's migration history. Rather than either (a) blindly writing a fresh `CREATE TABLE` that might drift from or conflict with the live schema, or (b) silently skipping the spec's explicit request for new contact fields, migration 118 does both: a `CREATE TABLE IF NOT EXISTS` reproducing the exact existing column set (so a fresh/reset database still gets a complete table), followed by explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements for the four new fields (`is_decision_maker`, `is_financial_contact`, `is_operational_contact`, `birthday`). This is safe and correct whether the table already exists live (the expected case) or not. See RULE A4 ("merge the behaviours instead of replacing the old with the new").
2. **Existing Contacts CRUD routes in `index.js` were left untouched — client-success.js does not duplicate them.** Since the working, tested `/api/practice/clients/:id/contacts` endpoints already exist, the Client Success frontend calls them directly for reads/writes rather than the spec's literal "Contacts CRUD under client-success.js" being built as a second, parallel set of routes. Building a duplicate would have violated "Shared > duplicated" for zero benefit and introduced real risk (two code paths writing the same table). `is_primary` is reused as "preferred contact" per the spec's Key Contacts fields — no redundant new column added.
3. **"Client Health" here is RELATIONSHIP health, a distinct concept from the pre-existing OPERATIONAL health in `client-health.js`.** `practice_clients.health_score`/`health_status` (an earlier codebox, before this session) already scores overdue deadlines/tasks/periods/engagements/WIP — a genuinely different question from "is the relationship in good shape." Rather than re-implement overdue-item counting (which would have violated "no duplicated business logic," a hard constraint repeated in this spec's own Health Engine section), `client-success.js`'s `calculateClientHealth()` **composes** the existing operational score (reused via new exports added to `client-health.js`: `scoreClientFromData`, `fetchHealthData`, `statusFromScore` — a purely additive change, zero risk to the 900+ lines of existing, working Client Health routes) with a native communication-cadence calculation. The combined `relationship_status` is the *worse* of the two components (deterministic rank: critical < at_risk < watch < healthy), and `relationship_score` is a simple average of whichever components have a value. Both are stored on the new `practice_client_success` table — never written back onto `practice_clients`, so the two concepts can never collide or be confused in the schema. The existing `client-health.html` page and its 900+ lines of Actions/risk-factor machinery are completely unchanged.
4. **Manager override freezes the relationship state outright, and is a hard stop for the engine — never partially applied.** Setting `is_manager_override = true` on `practice_client_success` means `calculateClientHealth()` returns the stored values as-is and never recomputes or overwrites them until a manager explicitly clears the override. This mirrors the spec's "manager can always override" requirement literally, and reuses the same override/audit-trail pattern already established by Alert Rules (Codebox 53) and Skills Matrix certifications.
5. **Communication cadence is pure date arithmetic — no external email/calendar integration**, per the spec's explicit boundary. `next_planned_contact_date` (if set) is authoritative: overdue if in the past, due-soon within 7 days, else on-track. If no next date is set, the calculation falls back to elapsed time since `last_meaningful_contact_date` (overdue past 90 days, due-soon past 60). Logging a meeting automatically advances `last_meaningful_contact_date` (if the meeting is more recent than what's stored) and sets `next_planned_contact_date` from the meeting's `next_meeting_date` field, so cadence tracking doesn't require a manager to separately edit the relationship record after every meeting — one data entry, not two.
6. **"Review Reminders" (a Success Criterion) is a computed field, not a push notification or scheduled job.** No codebox this session has introduced a background/cron job pattern, and inventing one here — silently, for a criterion with no further specification in the Backend/Endpoints section — would have been exactly the kind of hidden, unrequested automation the project's rules prohibit. Instead, `review_status` (`overdue`/`due_soon`/`on_track`/`none`) is computed live from `next_review_date` and surfaced on every relevant read (list, detail, summary). A manager-facing notification IS fired (via the existing `notify()` helper from Codebox 54) when a manager override sets `relationship_status = 'critical'` — a genuinely deliberate, explicit action, not a passive time-based trigger.
7. **Meeting history supports correction via `PUT`, but has no `DELETE` route.** Meetings are a factual record of what happened; the spec frames this as history ("Meeting History" section), and this codebase's established convention for anything framed as history/audit is append-and-correct, never delete (see `practice_learning_progress`, KPI History, Partner Review Packs snapshots). A logged meeting can be edited if entered incorrectly, but not removed.
8. **Opportunities have no `DELETE` route either — only status transitions (`identified → discussed → proposal → won/lost/deferred`).** The spec explicitly forbids building a sales pipeline with stages/forecasting/quotas; the status enum here is a manually-set label, not a workflow engine. Removing an opportunity that turned out to be a data-entry mistake is handled the same way other manually-logged records in this session are — a manager can set its status to `deferred` and it drops out of the default "open" filtering, but nothing is silently destroyed.
9. **A company-wide `GET /opportunities/all` endpoint was added beyond the spec's literal client-scoped endpoint list**, because the spec's own Frontend section lists "Opportunities" as a first-class page section (implying a board view across all clients, not just within one client's detail), and the summary/KPI figures (open estimated value, counts by status) need a company-wide read regardless of which client they came from. This is additive, not a scope expansion of what data exists — no new table, just a second read path over `practice_client_opportunities`.
10. **Reads are company-scoped only; writes are manager-gated** — no per-user privacy restriction on which clients can be *viewed*, unlike the personal-data privacy model used for Learning Centre/Skills Matrix/CPD (Codebox 59-60). This follows the closest existing precedent for client-level (not personal) data: `client-health.js` has no per-user read restriction, only company scoping. `?assigned_to_me=true` is provided as a convenience filter for the "which client needs me today" UX, not an access-control boundary.

## Database — Migration 118

Six tables: `practice_client_success` (new), `practice_client_contacts` (pre-existing, extended — see #1 above), `practice_client_success_activities` (new), `practice_client_opportunities` (new), `practice_client_meetings` (new), `practice_client_success_events` (new, append-only). Full field-by-field rationale in the migration's own comments.

## Backend — `client-success.js`

### Endpoints (~20)

`GET /summary`, `GET /`, `GET /:clientId`, `GET /:clientId/health`, `POST /:clientId/recalculate`, `PUT /:clientId`, `PUT /:clientId/override`, full CRUD for `/:clientId/activities` (+ `PUT /activities/:id`), `/:clientId/meetings` (+ `PUT /meetings/:id`, no delete — see #7), `/:clientId/opportunities` (+ `PUT /opportunities/:id`, no delete — see #8), `GET /opportunities/all`, `GET /events/log`. Contacts are NOT re-implemented here — see #2.

### Health Engine — `calculateClientHealth()`

Composes the pre-existing operational health score (reused from `client-health.js` via new exports, never recomputed) with a native communication-cadence calculation. See Architect Freedom #3 for the full reasoning and #4 for the override behavior.

## Integrations

- **Management Dashboard** — a new "Client Relationship (Client Success)" KPI section, computed alongside (and clearly separate from) the existing operational "Client Health" section in `computeSummary()`.
- **Planning Board** — `_buildTeamItemPool()` now attaches an `at_risk_client` boolean to every work item via one lightweight direct query against `practice_client_success` (not a per-item call into `calculateClientHealth()`) — rendered as a soft "⚠ At-Risk Client" badge, purely informational, never affecting priority ordering. Same reasoning as the Skills Matrix competency badge precedent from Codebox 59.
- **Client Detail / Risk Register / Knowledge Base / Communications links** (spec's Integration section) — deliberately deferred. These are cross-links into other modules' detail pages, not functional dependencies of Client Success itself; adding them now without a concrete UI slot in each target page would have meant guessing at those pages' layouts. Tracked as a follow-up below.

## Frontend

`client-success.html` + `js/client-success.js` (prefix `cs`): summary cards, a 3-tab layout (Clients / Opportunities / History). The Clients tab lists every client with relationship status, score, trend, owner, cadence, and next review, filterable by status and "assigned to me"; clicking a row opens a detail modal with relationship info (editable by managers), success activities, meeting history, opportunities, and key contacts (the contacts section reads/writes the pre-existing `/api/practice/clients/:id/contacts` endpoints — see #2). No chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `client-success.js`, both new frontend files, and every edited file (`client-health.js`, `index.js`, `layout.js`, `management-dashboard.js`, `js/management-dashboard.js`, `management-dashboard.html`, `planning-board.js`, `js/planning-board.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. Client-level data has no additional per-user read restriction (see Architect Freedom #10); all writes are manager-gated via the same `_myTeamMember`/`_isManager`/`_requireManager` triage used throughout this session.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/118_practice_client_success.sql` | 6 tables (5 new + 1 pre-existing extended) |
| `accounting-ecosystem/backend/modules/practice/client-success.js` | Router + `calculateClientHealth()` |
| `accounting-ecosystem/backend/frontend-practice/client-success.html` | Client Success UI |
| `accounting-ecosystem/backend/frontend-practice/js/client-success.js` | Client Success UI logic |
| `docs/new-app/61_client_success.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_61_client_success.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/client-health.js` | Added `module.exports.scoreClientFromData`/`fetchHealthData`/`statusFromScore` — purely additive, zero behavior change to existing routes |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `client-success` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Client Success" nav entry, placed after Learning Centre |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | Added `client_relationship` block to `computeSummary()` |
| `accounting-ecosystem/backend/frontend-practice/js/management-dashboard.js` | Renders the new Client Relationship KPI section |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added `kpiClientRelationship` section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | `_buildTeamItemPool()` attaches `at_risk_client` flag per item |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Renders the "At-Risk Client" badge on work items |
