# Codebox 65 — Secretarial Beneficial Ownership + Ownership Chain Foundation

> App: Lorenco Practice Management
> Status: Complete — migration 122 not yet applied to Supabase — nothing committed or pushed

## Purpose

Answers "who ultimately owns or controls this client?" and "are we ready to file/confirm BO information?" within seconds. A beneficial owner register, ownership chains tracing a path from a direct shareholder down to an ultimate natural person, and a deterministic BO readiness checklist per client.

**NOT CIPC API. NOT automatic filing. NOT legal advice. NOT document generation.** Structured BO recordkeeping and readiness tracking only — future CIPC filing must plug into this foundation, not replace it.

## Architect Freedom — Scope Decisions & Deviations

1. **Beneficial owners are an ADDITIONAL layer on `practice_company_shareholders` (Codebox 62), never a duplicate of it.** `getBeneficialOwnershipProfile()` reads the shareholder register live and returns it alongside beneficial owners/chains — a beneficial owner may or may not be a direct shareholder (a natural person behind a corporate or trust shareholder typically isn't one), so the two registers answer genuinely different questions and are never merged.
2. **Percentage calculation is a single shared function used by both beneficial owners (no `chain_path`) and ownership chains (which have one)** — `_calcEffectivePercentage()` tries, in order: manual override → chain-path multiplication (only if every step has a numeric percentage) → direct percentage → `null` with `confidence: 'unknown'` and an explicit `missing_information` message. Beneficial owners simply never populate `chain_path`, so that branch is skipped naturally for them and they fall through to direct/unknown — one function, no duplicated logic, exactly matching the spec's literal ordering ("do not guess").
3. **`is_reportable` is computed, never asked for directly** — it's a deterministic function of `is_natural_person` + `reporting_threshold_met` (itself derived from `effective_percentage` vs. a threshold, default 5%, stored per-owner in `settings.reporting_threshold_pct` for future configurability per the spec's own instruction) OR a manager-supplied `force_reportable` flag for control-type reportability regardless of percentage. `reporting_threshold_met` is `null` (not `false`) whenever `effective_percentage` is unknown — an explicit design choice so "we don't know yet" is never silently rendered as "not reportable."
4. **Readiness item generation is idempotent by design, not a one-shot wall like Codebox 63's checklist generation.** `_generateReadinessItems()` only inserts items that don't already exist for the same `(beneficial_owner_id | ownership_chain_id, item_type)` pair, so it's safe to call again after adding a new owner or chain — new items get generated for the new records, existing items and their statuses are untouched. This is a deliberate improvement under "Architect Freedom: readiness scoring... helper functions," since BO registers are added to incrementally over time far more often than Codebox 63's one-shot statutory change checklists are.
5. **The readiness score/status is always computed live from current item statuses — never stored.** `POST /client/:clientId/recalculate-readiness` computes and returns the result and writes an audit event (satisfying "no readiness recalculation without event"), but there is no persisted `readiness_score` column anywhere — this guarantees the number can never drift from what a fresh read of the items would show, the same "frozen snapshot vs. live state" discipline applied consistently across this session (e.g. Learning Centre's `overall_progress`).
6. **`bo_readiness_recalculated` is a client-level event forced into a source_type enum with no 'client' option.** The migration's `source_type` CHECK only allows `beneficial_owner`/`ownership_chain`/`readiness_item` — recalculation isn't tied to one specific row. `source_type = 'readiness_item'` is reused with `source_id` set to the `clientId` itself (documented in code as a placeholder, not a real readiness_item id) — the event's own `client_id` column is the reliable field for filtering, and the full computed result is preserved in `metadata`. Flagged explicitly so a future reader querying by `source_id` for this one event type knows what they're actually looking at.
7. **Chain path linking validates `root_holder_reference_id` (a shareholder) and `ultimate_owner_id` (a beneficial owner) independently, each against the chain's own `client_id`** — no frontend `company_id` or cross-client ID is ever trusted, matching the exact linking-validation pattern established in Codebox 64.
8. **Planning Board and Management Dashboard integrations are deliberately scoped to "blocked" readiness items only, not the full ready/partial/incomplete score.** Both are explicitly marked "Optional" in the spec. Computing the full readiness score for every client on every Planning Board load or dashboard load would mean replicating `_computeReadiness()`'s per-client item aggregation N times per page render — instead, both integrations run one plain, cheap query for `practice_bo_readiness_items` rows with `status = 'blocked' AND required = true`, grouped by `client_id`. This catches the most urgent case (something is actively blocking BO readiness) without the cost or duplication of a full score recomputation on every unrelated page load.

## Database — Migration 122

Four tables: `practice_beneficial_owners`, `practice_ownership_chains`, `practice_bo_readiness_items`, `practice_beneficial_ownership_events` (append-only). Full field-by-field rationale in the migration's own header and per-table comments.

## Backend — `beneficial-ownership.js`

### Endpoints (~26)

Summary; client BO profile; full CRUD + `verify`/`archive` for Beneficial Owners; full CRUD + `verify`/`archive` for Ownership Chains; readiness read/generate/update-item/recalculate; global and per-source events feeds.

## BO Engine

`getBeneficialOwnershipProfile(cid, clientId)` — pure aggregation returning the client, direct shareholders (read live from Codebox 62, never duplicated), beneficial owners, ownership chains, readiness (items + computed score/status), reportable owners, and a missing-information count. See Architect Freedom #1.

## Percentage Logic

See Architect Freedom #2 for the shared `_calcEffectivePercentage()` function and its exact precedence order (manual → chain multiplication → direct → unknown). Every non-manual, non-direct result that can't be computed returns `null` with a documented `missing_information` string — the function never guesses.

## Reportable Logic

See Architect Freedom #3. `is_reportable` = (`is_natural_person` AND `reporting_threshold_met === true`) OR manager-supplied `force_reportable`. `reporting_threshold_met` is `null` when the underlying percentage is unknown, never coerced to `false`.

## Readiness Logic

Default item generation is keyed off `owner_type` (identity always; address for natural persons; company register for companies; trust deed for trusts; nominee declaration for nominees; percentage confirmation when reportable) and chain presence (one "chain support" item per active chain), plus one client-level "manager review" item — see Architect Freedom #4 for the idempotent, incremental generation design. Score = percentage of required items in a done state (`received`/`verified`/`waived`); `blocked` overrides ready/partial/incomplete regardless of score; `unknown` when there are no required items at all — exactly the thresholds and precedence the spec specifies (≥85 ready, ≥50 partial, else incomplete).

## Secretarial Integration

- **Secretarial page**: a "Beneficial Ownership" panel showing the selected client's readiness status/score, reportable owner count, and missing information count, plus a "Manage BO →" deep link.
- **Client Detail**: Section 22 (Secretarial, extended across Codeboxes 62-64) now also shows BO readiness, reportable owners count, and missing information count.
- **Secretarial Governance**: not integrated in this pass — the spec marks "link resolutions to BO readiness" as fully optional, and no obvious low-risk hook presented itself without either resolutions or readiness items needing a new cross-reference field neither table currently has. Tracked as a follow-up.
- **Planning Board**: a `bo_readiness_concern` flag (blocked required items only — see Architect Freedom #8) rendered as a "🛑 BO Readiness Blocked" badge.
- **Management Dashboard**: a new "Beneficial Ownership" KPI section (verified/incomplete owner counts, reportable owner count, clients-with-blocked-items count) — low-risk, count-only queries, matching the exact precedent set by Codebox 61's Client Relationship section.

## Frontend

`beneficial-ownership.html` + `js/beneficial-ownership.js` (prefix `bo`): summary cards, a client picker (supports `?client_id=` deep links), a readiness banner, and 4 tabs (Beneficial Owners / Ownership Chains / Readiness / Events) once a client is selected. The Beneficial Owners tab also shows the client's direct shareholders read-only for context. Readiness items are updated inline via a status dropdown per row. No graph visualization (explicitly out of scope), no chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `beneficial-ownership.js`, both new frontend files, and every edited file (`index.js`, `layout.js`, `secretarial.html`, `js/secretarial.js`, `js/client-detail.js`, `planning-board.js`, `js/planning-board.js`, `management-dashboard.js`, `js/management-dashboard.js`, `management-dashboard.html`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. Chain links (`root_holder_reference_id`, `ultimate_owner_id`) independently re-verified against the chain's own `client_id` server-side — no frontend-supplied ID trusted. Reads unrestricted per-user; all writes and workflow actions manager-gated.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/122_practice_secretarial_beneficial_ownership.sql` | 4 tables |
| `accounting-ecosystem/backend/modules/practice/beneficial-ownership.js` | Router + `getBeneficialOwnershipProfile()` + percentage/reportable/readiness logic |
| `accounting-ecosystem/backend/frontend-practice/beneficial-ownership.html` | Beneficial Ownership UI |
| `accounting-ecosystem/backend/frontend-practice/js/beneficial-ownership.js` | Beneficial Ownership UI logic |
| `docs/new-app/65_beneficial_ownership.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_65_beneficial_ownership.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `beneficial-ownership` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Beneficial Ownership" nav entry, placed after Secretarial Governance |
| `accounting-ecosystem/backend/frontend-practice/secretarial.html` | Added a "Beneficial Ownership" panel |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial.js` | Loads BO readiness/reportable/missing-info summary per selected client |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Section 22 now also shows BO readiness/reportable/missing-info |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | `_buildTeamItemPool()` attaches `bo_readiness_concern` flag per item |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Renders the "BO Readiness Blocked" badge on work items |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | Added `beneficial_ownership` block to `computeSummary()` |
| `accounting-ecosystem/backend/frontend-practice/js/management-dashboard.js` | Renders the new Beneficial Ownership KPI section |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added `kpiBeneficialOwnership` section |
