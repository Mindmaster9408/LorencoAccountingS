# Codebox 72 — Practice Engagement Scope Control + Work Authorization Gate

> App: Lorenco Practice Management
> Status: Complete — migration 129 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Are we allowed to do this work under the current engagement?" and "If not, who approved the exception?" — within seconds. A deterministic, non-blocking gate that checks whether work appears within an active engagement's scope, and when it doesn't, records exactly what was attempted, why it looks out of scope, and who approved or overrode it.

**DO NOT BUILD: legal advice, automatic engagement drafting, billing automation, hard blocking of normal work.** This module warns and records — it never prevents an operation elsewhere in the system from completing.

## Architect Freedom — Scope Decisions & Deviations

1. **Scope resolution order is deterministic and checked in a fixed sequence, never guessed**: (1) an explicit exclusion in any active engagement's `scope_exclusions` always wins, producing `out_of_scope` immediately regardless of any other match; (2) a direct `engagement_type` match; (3) an `advisory`/`management` engagement whose `scope_inclusions` explicitly mentions the work type (the spec's own "tax planning" example); (4) `no_active_engagement` if the client has zero active engagements of any kind; (5) `unknown` for the three genuinely unmappable work types (`billing`, `onboarding`, `custom`); (6) otherwise `possible_gap`. This exact ordering is documented so a future reviewer never has to reverse-engineer why a given check resolved the way it did.
2. **The high/critical-risk override "partner required" rule is enforced as encourage-but-never-block, exactly as the spec's own two clauses require together** ("Partner required where role data is available" AND "no silent blocking"). A manager (not a partner) CAN approve a high/critical override or accept-risk action — the approval is never rejected outright — but the resulting event is tagged `metadata.partner_required_unverified: true` and the API response surfaces `partner_required_unverified: true` so the frontend can display it plainly. Nothing is hidden; the record simply shows a manager approved something that ideally wanted a partner.
3. **The duplicate guard is a partial unique index, not a plain unique constraint** — `(company_id, source_module, source_type, source_id, work_type)` is only enforced unique while `authorization_status NOT IN ('cancelled', 'override_rejected')`. This lets a rejected override or a cancelled check be re-attempted fresh (a brand-new row) without ever violating a constraint, while still preventing two simultaneously "live" authorization records for the same underlying check.
4. **`checkWorkAuthorization()` reuses `engagement-management.js`'s `getClientEngagementProfile()` export live** — it never duplicates engagement scope/risk data. If that call fails for any reason, the check degrades to `scope_result: 'unknown'` rather than throwing, so a transient engagement-data issue never breaks whatever operation triggered the check.
5. **Workflow-generation auto-check was intentionally NOT wired into `engagements.js`'s `generate-workflow` endpoint**, despite the spec listing this as an integration point ("If low-risk: Run check before workflow generation. Warn only."). Codebox 71 achieved and documented a "zero lines changed in `engagements.js`" result; adding even a small, non-blocking, try-caught scope check there would break that streak for a benefit that's available another way: the identical check is one click away as an explicit, manual action from both the Tasks page ("🔍 Check Scope") and the Work Authorization page itself. A manager can run it immediately before generating a workflow with the same practical safety net, at zero risk to the existing, stable workflow-generation code path. This is the one spec-listed integration point deliberately scoped down — see the spec's own qualifier: "Do not rewrite existing modules heavily."
6. **The "Check Scope" action on Tasks was added as a small, genuinely minimal change** — one new button (only rendered when the task has a `client_id`) and one new global function (`checkTaskScope()`), following the exact existing per-card action-button convention already in `tasks.js`. `task.type` maps deterministically to `work_type` (e.g. `vat_return`/`tax_return`/`annual_financial` → `tax`; `audit` → `compliance`; `general`/`other` → `custom`) — no guessing, no new enum invented.
7. **Client Onboarding's "show whether onboarding work is covered" integration is a manager-triggered button, not an automatic page-load check** — every check writes an audit event (`authorization_checked`, and often `authorization_warning_created`), so auto-running it on every page view would create event-log noise proportional to page views rather than actual decisions. This mirrors the exact "no silent initialization" discipline Codebox 70 already established for its own auto-initializers.
8. **Engagement Management's "linked work authorizations" panel filters client-side** rather than adding a new `matched_engagement_id` query parameter to `GET /work-authorization` — a client already fetched by `client_id` is filtered down to the current engagement in the frontend, avoiding a backend change for a single detail-view convenience.

## Database — Migration 129

Two new tables: `practice_work_authorizations`, `practice_work_authorization_events` (append-only). No changes to any existing table.

## Backend — `work-authorization.js`

### Endpoints (~10)

Summary, `POST /check` (the main entry point), list/get, four override/risk actions (request-override, approve-override, reject-override, accept-risk), soft-cancel, events.

## Authorization Engine

`checkWorkAuthorization({ companyId, clientId, workType, sourceModule, sourceType, sourceId, riskLevel, metadata, actorUserId })` — verifies the client, pulls active engagements live, resolves scope deterministically, upserts the authorization record (reusing an existing live row for the same source+work_type per the duplicate guard), writes its audit events, and returns both the record and a plain-language `recommended_action`.

## Scope Mapping Logic

See Architect Freedom #1 for the full deterministic ordering. `WORK_TYPE_ENGAGEMENT_TYPES` is the single source of truth for which engagement type(s) directly cover which work type — e.g. tax→tax, secretarial→secretarial/company_secretarial, payroll→payroll.

## Override Logic

Low/medium risk: any manager can approve. High/critical risk: a partner (`owner`/`partner` role) is expected, but a manager can still approve — flagged `partner_required_unverified`, never blocked. `override_reason` and accept-risk `reason` are both hard-required — never optional, never silently skipped.

## Integrations

- **Tasks**: an optional "🔍 Check Scope" button per task card (only when the task has a client).
- **Client Onboarding**: a manager-triggered "Check Coverage" button (not automatic).
- **Engagement Management**: a new "Authorizations" tab on the engagement detail modal, showing linked authorizations.
- **Planning Board**: an `out_of_scope_work` flag → "🚧 Out of Scope" badge.
- **Management Dashboard**: new "Work Authorization" KPI section (out-of-scope work, pending overrides, high-risk overrides).
- **Workflow generation**: deliberately NOT auto-wired — see Architect Freedom #5.

## Frontend

`work-authorization.html` + `js/work-authorization.js` (prefix `wa`): company-wide list with status/scope/work-type filters, a "Check Work" modal for manual checks, and a detail modal with a status-driven action bar and an Events section. No AI, no chart library.

## localStorage Findings

Zero matches across the migration, `work-authorization.js`, both new frontend files, and every edited file (`index.js`, `layout.js`, `tasks.js`, `client-onboarding.html`+`js`, `engagement-management.js`, `management-dashboard.js`+`js`+`html`, `planning-board.js`+`js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. `client_id` re-verified against `practice_clients` before every check. Reads unrestricted per-user; all writes manager-gated (`_requireManager`).

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/129_practice_engagement_scope_control.sql` | 2 tables: authorizations, append-only events |
| `accounting-ecosystem/backend/modules/practice/work-authorization.js` | Router + engine + scope mapping + override logic |
| `accounting-ecosystem/backend/frontend-practice/work-authorization.html` | Work Authorization UI |
| `accounting-ecosystem/backend/frontend-practice/js/work-authorization.js` | Work Authorization UI logic |
| `docs/new-app/72_work_authorization_scope_control.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_72_work_authorization.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `work-authorization` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Work Authorization" nav entry |
| `accounting-ecosystem/backend/frontend-practice/js/tasks.js` | Added "Check Scope" button + `checkTaskScope()` |
| `accounting-ecosystem/backend/frontend-practice/client-onboarding.html` + `js/client-onboarding.js` | Added manager-triggered coverage check panel |
| `accounting-ecosystem/backend/frontend-practice/js/engagement-management.js` | Added "Authorizations" detail tab |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` + `js/management-dashboard.js` + `management-dashboard.html` | Added `work_authorization` block + KPI section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` + `js/planning-board.js` | Attaches `out_of_scope_work` flag; renders the badge |

**`engagements.js` and `engagement-periods.js` were NOT modified — see Architect Freedom #5.**

## Recommended Codebox 73

Practice Client Profitability + Service Margin Foundation, as specified — now that work is tied to engagements and scope, the Practice needs to know whether each client/service is actually profitable.
