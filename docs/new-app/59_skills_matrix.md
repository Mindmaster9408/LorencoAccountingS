# Codebox 59 — Practice Skills Matrix + Competency Framework

> App: Lorenco Practice Management
> Status: Complete — migration 116 not yet applied to Supabase — nothing committed or pushed

## Purpose

Answers "who is actually qualified to do this work?" — giving managers visibility into skills, competency levels, certifications, preferences, and restrictions across the team, and giving employees visibility into "what should I learn next?"

**This module ADVISES. It never assigns work, never blocks delegation, never overrides a manager's decision, and makes no AI recommendations.** Every consuming integration (Delegation, Planning Board) treats its output strictly as a warning label.

## Architect Freedom — Scope Decisions & Deviations

1. **Seeded catalog matches the spec's own examples exactly, extended only where explicitly invited.** All 12 example categories and 24 skills (built from the spec's literal examples: VAT/AFS/Payroll/EMP501/Income Tax/Company Tax/Provisional Tax/Risk Review/QMS Review/Workflow Design/Client Meeting/Xero/Pastel/Excel/Sean AI) are seeded via an idempotent `POST /seed-defaults`, the same pattern as Codebox 53's Alert Rules. A handful of skills not explicitly named in the spec (CIPC Annual Return, Beneficial Ownership Filing, Compliance Deadline Management, Client Advisory, Team Supervision, Staff Mentoring) were added only under categories the spec explicitly listed and only where "developer may expand/extend" was the spec's own stated invitation — not invented freely.
2. **Certification *types* are deliberately NOT seeded**, unlike categories/skills. SAICA, SAIPA, SAIT and similar bodies are practice-specific and the spec gave no certification examples to seed from — fabricating specific certification names for a real accounting practice would have been guessing, not following the spec's examples. The catalog starts empty; a manager adds the certifications relevant to their own practice.
3. **`ownership_role`-style structural additions repeated: `ownership_role` isn't needed here, but `is_active` was added to `practice_team_certifications` beyond the spec's literal field list**, because the table already has a `status` column tracking the certification's real-world state (active/expired/pending/revoked) — reusing `status` as a generic soft-delete flag would have meant a mistakenly-entered record could only be "archived" by lying about its real-world state (e.g. marking a still-valid certification "revoked" just to hide a duplicate entry). `is_active` is a separate, honest soft-delete flag; `status` keeps its real meaning.
4. **`practice_team_skills` has no `is_active`/archive column at all — "removing" a skill assignment resets it to level 0 (No Exposure) instead.** A competency record isn't really a discrete "thing" that gets deleted the way a category or certification does — it's someone's current standing on a skill, and "they have no exposure to this" is a perfectly valid, meaningful state rather than a soft-deleted placeholder. `DELETE /team-skills/:id` resets `current_level`/`target_level`/flags rather than hiding a row, preserving full history in `practice_skill_events` either way.
5. **`getCompetency()` is one function serving two shapes of question** — "what's this person's overall profile" (used by the Skills Matrix page itself) and "how qualified are they for *this specific kind* of work" (used by Delegation's advisory). The second shape depends on `MODULE_SKILL_MAP`, a deliberately small and honest mapping from delegation `source_module` → relevant `skill_key`(s), covering only the 5 source types (risk-register, qms-review, qms-finding, tax-individual, tax-company) that map cleanly onto exactly one skill. Tasks, deadlines, compliance-packs, document-requests, and reminders are left unmapped — guessing a specific skill for a generic task title would have been exactly the kind of "hidden logic" this module must avoid. Unmapped modules still return a useful `overall_level` (the person's average across all rated skills), just without pretending false precision.
6. **Delegation's `GET /:id` route-ordering required a deliberate fix.** Adding `GET /competency-preview` to `delegation.js` initially placed it *after* `GET /:id` in the file — since Express matches routes in registration order and `/:id` is a wildcard, a request to `/competency-preview` would have been swallowed by `/:id` (treating "competency-preview" as an id value) before ever reaching the new route. This was caught and fixed during this session by moving the new route above `/:id`, and is called out explicitly here because it's exactly the kind of bug that silently "works" in casual testing (both routes return *something*) while actually being broken.
7. **The Delegation competency advisory is scoped to single-delegation views only, not list views**, to avoid paying for N extra lightweight query-sets on every `GET /` list load. `_enrichDelegations()` takes an opt-in `includeAdvisory` flag, passed `true` only from `GET /:id` (and implicitly exercised by the new `GET /competency-preview` endpoint the create-modal calls live).
8. **Resource Forecast's advisory integration ("upcoming work where no sufficiently skilled staff exist") was deliberately not built.** The spec explicitly marks this one "Optional advisory" — the only integration point marked optional in the entire spec — and it requires meaningfully more engineering than the other two integrations (cross-referencing every forecast week's unassigned/under-owned work against team-wide skill coverage, not just a single delegation or a per-member badge). Given the two higher-value, explicitly-non-optional integrations (Delegation, Planning Board) were already substantial, this was consciously scoped out rather than built shallow. See Follow-Up Notes.
9. **Planning Board's badge computation uses one lightweight direct query, not `getCompetency()` per team member.** A badge only needs "does this person have any Expert/Advanced-rated skill, and do they have any target-above-current gap" — a single `MAX(current_level)` / gap-flag pass over one query for the whole team, computed inline in `planning-board.js`. Calling `getCompetency()` once per member would have meant 3× N queries for information this simple; the richer helper is reserved for contexts (Delegation, the Skills Matrix page itself) that actually need its full advisory shape.

## Database — Migration 116

Six tables:

- **`practice_skill_categories`** / **`practice_skills`** — the catalog, manager-editable, soft-archived via `is_active`.
- **`practice_team_skills`** — one row per (team member, skill): `current_level`/`target_level` (0–5, exactly the spec's 6-level scale), `is_preferred`/`is_restricted`, `last_reviewed_date`, `review_notes`. No self-service editing anywhere — every write endpoint requires a manager.
- **`practice_certifications`** — certification type catalog (not seeded — see Architect Freedom #2).
- **`practice_team_certifications`** — certifications actually held, with `status` (active/expired/pending/revoked) and `is_active` as two independently meaningful flags (see Architect Freedom #3). `expiry_date` is indexed specifically so a future codebox can build expiry reminders without a migration change — matching the spec's own "Allow expiry reminders later."
- **`practice_skill_events`** — append-only, 15 event types covering every entity's lifecycle.

## Backend — `skills-matrix.js`

### Endpoints (~24)

`GET /summary`, `POST /seed-defaults`, full CRUD for `/categories`, `/skills`, `/team-skills` (POST is an upsert — see below), `/certifications`, `/team-certifications`, `GET /competency/:team_member_id`, `GET /events`.

### Skills Engine

Standard catalog CRUD, all writes manager-gated. `POST /team-skills` is implemented as an **upsert** (`onConflict: 'company_id,team_member_id,skill_id'`) rather than pure create — assigning or updating someone's competency level is naturally idempotent from a manager's perspective (they repeat the same action over time as someone develops), so requiring a separate lookup-then-PUT round trip would have added friction without adding safety. Viewing is scoped like Codebox 58's Delegation: managers see everyone, everyone else sees only their own record.

### Competency Helper — `getCompetency()`

Returns overall level (average across all skills with `current_level > 0`), the relevant skill(s) for a given `source_module` (or the full profile if unmapped), certification status, restrictions, and missing competencies (`target_level > current_level`) — exactly the 5 things the spec's Competency Engine section asks for. Exported for Delegation and Planning Board to reuse in-process; never called from anywhere that could turn its output into a gate.

## Integrations

- **Delegation** — `GET /competency-preview` (checked live as the create-delegation form fills in) and `competency_advisory` on `GET /:id` (single-delegation detail) both compare previous/new owner competency for the relevant skill and surface a warning (restricted, or low/no experience) — never blocking submission or any lifecycle action.
- **Planning Board** — Team Board cards show an optional Expert/Advanced/Training Needed badge next to each member's name, computed from one lightweight query (see Architect Freedom #9).
- **Resource Forecast** — deliberately not built (see Architect Freedom #8).

## Frontend

`skills-matrix.html` + `js/skills-matrix.js` (prefix `sk`): summary cards, a 5-tab layout (Team Competency / Skills Catalog / Certifications / Training Needs / History). Team Competency shows every catalog skill for a selected member (including ones they have no record for yet, editable in place) with level/target pills and preferred/restricted flags. Skills Catalog manages categories and skills. Certifications manages both the type catalog and team-held certifications (expiry-highlighted). Training Needs lists every gap (`target_level > current_level`) practice-wide, sorted by gap size. No chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `skills-matrix.js`, both new frontend files, and every edited file (`delegation.js`, `planning-board.js`, `index.js`, `layout.js`, `delegation.html`, `js/delegation.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. Read access for personal data (`team-skills`, `team-certifications`, `competency/:id`) is further scoped to manager-or-self, matching the privacy boundary established in Codebox 58.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/116_practice_skills_matrix.sql` | 6 tables |
| `accounting-ecosystem/backend/modules/practice/skills-matrix.js` | Router + `getCompetency()` |
| `accounting-ecosystem/backend/frontend-practice/skills-matrix.html` | Skills Matrix UI |
| `accounting-ecosystem/backend/frontend-practice/js/skills-matrix.js` | Skills Matrix UI logic |
| `docs/new-app/59_skills_matrix.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_59_skills_matrix.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/delegation.js` | Requires `skills-matrix.js`; added `_competencyAdvisory()`, `GET /competency-preview`, `competency_advisory` on `GET /:id` |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | Added `competency_badge` per member on `GET /team` via one lightweight query |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `skills-matrix` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Skills Matrix" nav entry |
| `accounting-ecosystem/backend/frontend-practice/delegation.html` | Added `.inline-msg.warn` style; advisory box in create modal |
| `accounting-ecosystem/backend/frontend-practice/js/delegation.js` | `_renderAdvisory()`, `dlCheckAdvisory()`, advisory shown in detail view |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Renders the optional competency badge on Team Board cards |
