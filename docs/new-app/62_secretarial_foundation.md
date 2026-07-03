# Codebox 62 — Practice Secretarial Foundation

> App: Lorenco Practice Management
> Status: Complete — migration 119 not yet applied to Supabase — nothing committed or pushed

## Purpose

Gives managers a single place to know "I know everything about this company's statutory position" — corporate profile, director register, shareholder register, annual return tracking, and a timeline of statutory events, per client.

**NOT accounting. NOT tax. NOT payroll. NOT a client CRM. NOT document management. NOT a CIPC API integration. NOT automatic submissions. NOT e-signatures. NOT document generation. NOT trust accounting. NOT estate planning.** This is a FOUNDATION — it stores statutory information. It does not manage statutory CHANGE as a workflow (approvals/checklists/deadlines around a director appointment, for instance) — that is Codebox 63.

## Architect Freedom — Scope Decisions & Deviations

1. **Several spec-listed profile fields already exist elsewhere and are reused, not duplicated.** Audit (RULE A1) found `practice_clients.registration_number`, `.vat_number`, and `.coida_registration_number` already store the CIPC registration number, VAT number, and COIDA number respectively; `practice_taxpayer_profiles.income_tax_reference` and `.financial_year_end` already store the income tax number and a proper per-client `DATE` financial year-end (from an earlier, out-of-session codebox — Codebox 25's Taxpayer Profile Foundation). None of these are repeated on `practice_secretarial_profiles`. `getCorporateProfile()` cross-references them live. PAYE/SDL/UIF registration *numbers* were confirmed genuinely absent everywhere (only a `paye_registered` boolean flag exists on `practice_taxpayer_profiles`, not the actual number) — those three, plus company type, registration date, registered/postal address, company status, CIPC status, auditor, company secretary, and financial officer, are all genuinely new fields with no prior home in the schema.
2. **`financial_year_end` is read from `practice_taxpayer_profiles`, not stored a second time, even though not every client necessarily has a taxpayer profile yet.** The alternative — adding a redundant `financial_year_end` column to the secretarial profile "just in case" — would have created exactly the two-sources-of-truth problem RULE A2 exists to prevent. If a client has no taxpayer profile yet, the Secretarial page shows "—" for that field with a note that it's sourced from the Taxpayer Profile, rather than silently drifting from it.
3. **`practice_clients.fiscal_year_end` (a pre-existing, informally-typed TEXT field like "February" or "08-31", used for tax-cadence generation) is deliberately NOT what's shown as the statutory financial year-end.** `practice_taxpayer_profiles.financial_year_end` is a proper `DATE` maintained for the same conceptual purpose but with the precision a CIPC/statutory record needs — using the informal text field instead would have been a worse, lossier reuse than the one actually available.
4. **Director `shareholding_pct` is kept as its own field on `practice_company_directors`, separate from the shareholder register, exactly as the spec lists it** — even though this creates a field that can drift from a matching row in `practice_company_shareholders`. This was not invented; it's a literal spec requirement (Directors section lists "Shareholding %" as its own field, distinct from the entire Shareholders section). A director need not be a formally registered shareholder entity but can still have a beneficial-interest percentage worth recording. Flagged here so a future reader understands this is spec-driven, not an oversight.
5. **CIPC status is free text; company status is a `CHECK`-constrained enum.** `cipc_status` holds CIPC's own externally-defined vocabulary ("In Business," "Business Rescue," "Final Deregistration," etc.) — the same reasoning already used for CPD category in Codebox 60: an external taxonomy shouldn't be hard-coded into this schema. `company_status` is the app's own internal, constrained lifecycle state that the UI and future Planning Board/Client Success integrations reason about directly.
6. **The Timeline has no separate table — `GET /:clientId/timeline` reads directly from `practice_secretarial_events`.** The spec's Database section only lists five tables (no separate timeline table), and the Timeline section's own field list ("Director appointed, Director resigned, Share transfer, Annual return, Company detail change, Manager notes") is exactly the append-only events log's `event_type` enum. Building a second table would have duplicated the events table for no benefit.
7. **`getGovernanceSummary()` is a separate, deliberately lighter export from `getCorporateProfile()`**, built specifically for Client Success's reuse (spec: "No duplicate logic"). Client Success only needs two counts (outstanding annual returns, active director count) to decide whether to show a governance concern — calling the full `getCorporateProfile()` aggregation (profile + directors + shareholders + returns + timeline) for that would have been wasteful and would have coupled Client Success to secretarial.js's full response shape unnecessarily.
8. **Planning Board's "Director change pending" warning (listed in the spec) was NOT built.** No pending-change concept exists yet — Codebox 63 (Statutory Change Management, per the user's own "Recommended Codebox 63") is what introduces workflow state for a director change in progress. Only "Annual return due" (a real, available data point in this foundation codebox) was integrated, using the same lightweight-direct-query pattern already established for the at-risk-client badge in Codebox 61. "Statutory reminder" (the spec's third listed Planning Board item) is likewise not a distinct concept yet beyond annual returns — tracked as a follow-up.
9. **Directors/shareholders/annual returns support status transitions via `PUT`, not `DELETE`.** A resigned director, a transferred shareholder, and a filed annual return are all historically meaningful states, not deletions — consistent with the append-and-correct convention already established for Client Success meetings/opportunities in Codebox 61.
10. **The Secretarial page is a client-picker-first page, not a company-wide list-first page like most other Codeboxes this session.** Nearly everything in this module (Corporate Profile, Directors, Shareholders, Annual Returns) is inherently single-client data — there is no meaningful company-wide "browse" view analogous to Client Success's client list. A client picker (backed by the pre-existing `GET /api/practice/clients`) is the entry point, and the page also accepts a `?client_id=` deep-link parameter from Client Detail's new Secretarial section.

## Database — Migration 119

Five tables: `practice_secretarial_profiles` (new), `practice_company_directors` (new), `practice_company_shareholders` (new), `practice_annual_returns` (new), `practice_secretarial_events` (new, append-only, doubles as the Timeline source). Full field-by-field rationale, including which fields were deliberately left out because they're reused from elsewhere, is in the migration's own header comment and per-table comments.

## Backend — `secretarial.js`

### Endpoints (~17)

`GET /summary`, `GET /:clientId` (full corporate profile via `getCorporateProfile()`), `PUT /:clientId/profile`, full CRUD for `/:clientId/directors` (+ `PUT /directors/:id`), `/:clientId/shareholders` (+ `PUT /shareholders/:id`), `/:clientId/annual-returns` (+ `PUT /annual-returns/:id`), `GET /:clientId/timeline`, `POST /:clientId/timeline/note`, `GET /events/log`. No `DELETE` routes anywhere — see Architect Freedom #9.

### Secretarial Engine — `getCorporateProfile()`

Pure aggregation, exactly as the spec requires: reads the secretarial profile, directors, shareholders, annual returns, and the last 30 timeline events for one client, and cross-references `income_tax_reference`/`financial_year_end` from `practice_taxpayer_profiles` and identity fields from `practice_clients` rather than re-storing them (see Architect Freedom #1-#3). Also computes `upcoming_statutory_actions` — currently just annual returns due or overdue within 60 days, sorted soonest-first — a plain date filter, not a scoring engine.

### `getGovernanceSummary()`

A separate, lighter export for Client Success's reuse. See Architect Freedom #7.

## Integrations

- **Client Detail** — a new Section 22 ("Secretarial") added after Company Tax Returns, following the exact same pattern as every other client-detail section this session (hidden by default, shown once the client loads, a lightweight read-only summary fetched via `loadClientSecretarial()`, and an "Open in Secretarial →" link carrying `?client_id=`). No inline CRUD — full editing only happens on `secretarial.html` itself, per the spec's "Do NOT duplicate" instruction.
- **Planning Board** — `_buildTeamItemPool()` now also attaches an `annual_return_due` boolean per item (client has a pending/overdue annual return due within 60 days), rendered as a soft, non-blocking "📋 Annual Return Due" badge alongside the existing at-risk-client badge from Codebox 61.
- **Client Success** — `GET /:clientId` now also returns a `governance` block (via `getGovernanceSummary()`, wrapped in `.catch()` so a Secretarial lookup failure never breaks the rest of the Client Success detail view), rendered as a governance-concern line in the relationship health breakdown when applicable.

## Frontend

`secretarial.html` + `js/secretarial.js` (prefix `sec`): summary cards, a client picker (supports `?client_id=` deep links), and once a client is selected — 5 tabs (Corporate Profile / Directors / Shareholders / Annual Returns / Timeline). The Corporate Profile tab shows the reused/cross-referenced fields as clearly-labeled read-only cards above the editable secretarial-only fields, so a manager can never mistake which fields live where. No chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `secretarial.js`, both new frontend files, and every edited file (`index.js`, `layout.js`, `client-success.js`, `js/client-success.js`, `planning-board.js`, `js/planning-board.js`, `client-detail.html`, `js/client-detail.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. No per-client read restriction (matching the established precedent for client-level, non-personal data — `client-health.js`, `client-success.js`); all writes (profile, directors, shareholders, annual returns, manager notes) are manager-gated via the standard `_myTeamMember`/`_isManager`/`_requireManager` triage.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/119_practice_secretarial_foundation.sql` | 5 tables |
| `accounting-ecosystem/backend/modules/practice/secretarial.js` | Router + `getCorporateProfile()` + `getGovernanceSummary()` |
| `accounting-ecosystem/backend/frontend-practice/secretarial.html` | Secretarial UI |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial.js` | Secretarial UI logic |
| `docs/new-app/62_secretarial_foundation.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_62_secretarial_foundation.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `secretarial` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Secretarial" nav entry, placed after Client Success |
| `accounting-ecosystem/backend/modules/practice/client-success.js` | Requires `secretarial.js`; added `governance` block to `GET /:clientId` |
| `accounting-ecosystem/backend/frontend-practice/js/client-success.js` | Renders the governance-concern line in the relationship detail view |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | `_buildTeamItemPool()` attaches `annual_return_due` flag per item |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Renders the "Annual Return Due" badge on work items |
| `accounting-ecosystem/backend/frontend-practice/client-detail.html` | Added Section 22 (Secretarial) |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Added `loadClientSecretarial()`, wired into the client-load sequence |
