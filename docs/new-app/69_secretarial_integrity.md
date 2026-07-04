# Codebox 69 — Secretarial Register Integrity Audit + Statutory Data Quality Review

> App: Lorenco Practice Management
> Status: Complete — migration 126 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Is this entity actually ready?" before "Can we submit?" A quality-assurance layer over the entire Secretarial suite built so far (Registers, Workflows, Governance, Beneficial Ownership, Evidence, Statutory Calendar, Entity Lifecycle) — detects missing data, cross-module inconsistencies, and broken references, classifies them by severity, and gives managers a single score and review workflow.

**DO NOT BUILD: data correction, automatic repair, CIPC validation, legal advice.** This module only detects, classifies, and reports — it never writes to any table outside its own three (runs/findings/events). Managers decide how to resolve every finding.

## Architect Freedom — Scope Decisions & Deviations

1. **Audit scope is "clients already onboarded into the relevant module," not "every client."** A client with no `practice_secretarial_profiles` row is skipped by the register/director/shareholder/annual-return checks entirely; a client with no Entity Lifecycle profile is skipped by the lifecycle checks; a client with zero BO records is skipped by the BO checks. This module audits data quality **within** modules that already track an entity — it does not flag "this client hasn't been onboarded yet" (that is Codebox 70's job, per the roadmap).
2. **Director/shareholder-register checks (no active directors, no shareholders, percentage math, duplicates) are scoped to `company_type IN ('pty_ltd', 'cc')` only.** NPCs have members, not shareholders; trusts have trustees and beneficiaries; sole proprietors and partnerships have neither directors nor a share register in the CIPC sense. Applying these checks universally would produce false positives for every non-company entity type. This is a deliberate, documented narrowing — not an oversight — and is easy to extend additively if a future codebox adds NPC-specific/trust-specific register checks.
3. **`GOVERNANCE_REQUIRED_CHANGE_TYPES` and `EVIDENCE_EXPECTED_CHANGE_TYPES` are developer-chosen subsets of the 16 `change_type` values**, not literally specified by the spec. Both lists are used only to flag a *missing* governance/evidence record for an already-implemented change — never to block, auto-generate, or require one. Documented here so a future reviewer knows these are judgment calls, not spec text.
4. **"Broken foreign references" is implemented as several targeted checks, not one generic reflection-based scanner.** Given the "Codebox 41 convention" (no real FK constraints anywhere in this schema), a fully generic orphan-detector would need to enumerate every plain-integer reference column across ~25 tables — high risk, low clarity. Instead, each check targets a specific, known reference relationship (ownership chain → beneficial owner, evidence checklist → template, statutory schedule → obligation, statutory dependency → schedule/checklist, lifecycle transition → lifecycle profile, governance decision/resolution/meeting → change case) with a clear, explainable finding message naming exactly which link is broken. "Developer may add additional deterministic checks" is exercised here to keep the audit explainable rather than exhaustively generic.
5. **Two of the 31 finding codes (`implementation_without_approval`, `transition_without_implementation`) are internal data-consistency checks on Entity Lifecycle transitions rather than literal spec text.** They correspond to the spec's "Transition without implementation" / "Implementation without approval" line items, interpreted as: a transition should never reach `implemented`/`completed` status without having passed through `approved`/`implemented` first. Since the Entity Lifecycle API itself enforces this ordering (Codebox 68), these checks exist purely as a safety net for data that could only arise from a direct database edit outside the API — rated `critical` accordingly.
6. **Performance: this audit is a bulk, company-wide scan, not a per-client composition of every other module's engine.** For BO readiness, the audit bulk-fetches `practice_bo_readiness_items` once for the whole company and reuses `beneficial-ownership.js`'s exact scoring function (`computeReadinessFromItems`, newly exported additively) rather than calling `getBeneficialOwnershipProfile()` once per client. For Evidence and the Statutory Calendar, the audit does reuse the per-checklist (`getChecklistReadiness()`) and whole-company (`buildStatutoryCalendar()`) engines directly, since those are already correctly-shaped for bulk/parallel use. This mirrors the session's established "keep expensive operations cheap at scale" precedent (Planning Board, Management Dashboard) while still reusing scoring logic rather than duplicating it.
7. **Every one of the ~19 bulk queries and the ~10 validation groups is independently wrapped** (`_fetchSafe()` for queries, `_safeCheck()` for validation groups) so a single failing query or a single failing validation group never prevents the rest of the audit from completing — the spec's "One validation failing must NEVER stop the entire audit" applied to the data-fetching layer as well as the validation layer, since a query failure is the most likely real-world failure mode.
8. **The `PUT /findings/:id/reopen` endpoint is an addition beyond the spec's literal endpoint list.** The migration's own `finding_reopened` event type would otherwise be unreachable dead code — no other listed endpoint produces it. Added as the natural, minimal counterpart to acknowledge/resolve/accept-risk, gated by the same manager-only rule.
9. **The `ignored` finding status is defined in the database CHECK constraint (per the spec's literal enum) but has no endpoint or event type wired to it in this pass.** No endpoint or event type was specified for it, and inventing an unrequested bulk-dismiss action was judged out of scope. Documented as a follow-up.
10. **Scoring is per-run, company-wide** — `overall_score` lives on the run row, not per-client. A single run can span many clients; the score reflects the practice's overall Secretarial data quality at that point in time, matching the spec's field list (`overall_score` on `practice_secretarial_integrity_runs`, not on a per-client table).

## Database — Migration 126

Three new tables: `practice_secretarial_integrity_runs`, `practice_secretarial_integrity_findings`, `practice_secretarial_integrity_events` (append-only). No changes to any existing table — this module reads from ~15 existing tables but writes to none of them.

## Backend — `secretarial-integrity.js`

### Endpoints (12)

Summary, `POST /run` (manager-only, triggers a full audit), run list/detail, finding list/detail/notes-update, four review actions (acknowledge/resolve/accept-risk/reopen — see Architect Freedom #8), events.

## Audit Engine

`runIntegrityAudit(cid, actorUserId, runType)` — inserts a run row, bulk-fetches ~19 tables (each independently fault-tolerant), runs 10 validation groups (each independently fault-tolerant) covering 31 distinct finding codes across all 10 finding categories, bulk-inserts the resulting findings and their `finding_created` events, computes the severity-weighted score, and closes out the run row. Returns the full result (run, findings, module summary, score) directly to the caller — the same "operation returns its own result" shape used by every workflow-action endpoint this session.

## Validation Logic

Each of the 10 validation groups is a pure function over already-fetched, already-grouped data (grouped by `client_id` via a shared `_groupBy()` helper) — no validation function performs its own database I/O, which is what makes the whole engine's parallel-fetch-then-pure-compute shape possible. See Architect Freedom #1-#5 for scoping decisions.

## Scoring Model

`100 - (critical×15 + high×7 + medium×3 + low×1)`, floored at 0, `info` findings score 0. `passed = true` only when a run has zero critical and zero high findings. A re-run always creates a **new** run row — history is never overwritten, matching every other audit-trail table this session.

## Dashboard Integration

- **Management Dashboard**: new "Secretarial Integrity" KPI section — latest score, critical findings, open findings, latest audit date — reads only the **latest stored run** plus a live open-findings count; never triggers a new audit from a dashboard page load (see Architect Freedom #6).
- **Secretarial**: new "Secretarial Integrity" panel showing this client's open-finding count, reused via `GET /findings?client_id=&status=open`.
- **Entity Lifecycle**: a new "Secretarial Integrity Warnings" panel on the Profile tab, same reuse pattern.
- **Planning Board**: a `critical_integrity_finding` flag (open critical/high findings only) rendered as a "⚠ Integrity Issue" badge, same lightweight direct-query pattern as every other badge this session.

## Frontend

`secretarial-integrity.html` + `js/secretarial-integrity.js` (prefix `si`): a company-wide page (no client picker — findings span all clients), a prominent score badge, a "Run Audit" button, and 4 tabs (Audit Runs / Open Findings / Resolved Findings / Events). Open Findings supports category/severity filtering and inline Acknowledge/Resolve/Accept Risk actions; Resolved Findings supports Reopen. No document viewer, no chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `secretarial-integrity.js`, both new frontend files, and every edited file (`beneficial-ownership.js`, `entity-lifecycle.js`, `index.js`, `layout.js`, `secretarial.js` + its frontend JS, `entity-lifecycle.html` + its frontend JS, `management-dashboard.js` + its frontend JS + HTML, `planning-board.js` + its frontend JS). Confirmed via grep.

## Multi-Tenant Safety

Every one of the ~19 bulk queries in `runIntegrityAudit()` is scoped to `company_id`. All finding/run reads and writes are scoped to `company_id`. Reads unrestricted per-user; running an audit and reviewing findings are manager-gated (`_requireManager`).

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/126_practice_secretarial_integrity.sql` | 3 tables: runs, findings, append-only events |
| `accounting-ecosystem/backend/modules/practice/secretarial-integrity.js` | Router + audit engine + 10 validation groups + scoring |
| `accounting-ecosystem/backend/frontend-practice/secretarial-integrity.html` | Secretarial Integrity UI |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial-integrity.js` | Secretarial Integrity UI logic |
| `docs/new-app/69_secretarial_integrity.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_69_secretarial_integrity.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/beneficial-ownership.js` | Added `computeReadinessFromItems` export (purely additive, aliases existing private `_computeReadiness`) |
| `accounting-ecosystem/backend/modules/practice/entity-lifecycle.js` | Added `TERMINAL_STATUSES` export (purely additive) |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `secretarial-integrity` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Secretarial Integrity" nav entry |
| `accounting-ecosystem/backend/frontend-practice/secretarial.html` + `js/secretarial.js` | Added "Secretarial Integrity" panel |
| `accounting-ecosystem/backend/frontend-practice/entity-lifecycle.html` + `js/entity-lifecycle.js` | Added "Secretarial Integrity Warnings" panel |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` + `js/management-dashboard.js` + `management-dashboard.html` | Added `secretarial_integrity` block + KPI section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` + `js/planning-board.js` | `_buildTeamItemPool()` attaches `critical_integrity_finding` flag; renders the "Integrity Issue" badge |

## Recommended Codebox 70

Practice Client Onboarding + Entity Formation Foundation, as specified by the user — the natural next step now that existing-entity data quality can be audited.
