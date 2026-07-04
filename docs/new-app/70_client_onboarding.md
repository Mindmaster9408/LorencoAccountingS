# Codebox 70 — Practice Client Onboarding + Entity Formation Foundation

> App: Lorenco Practice Management
> Status: Complete — migration 127 not yet applied to Supabase — nothing committed or pushed

## Purpose

"What is still required before this client is fully operational?" A professional onboarding workspace built over an **existing** `practice_clients` row — tracks progress, initializes (or safely detects and links to) the Secretarial suite's per-client records, and gives managers a single readiness view before a new client goes live.

**DO NOT BUILD: CIPC incorporation, SARS registration, banking integration, a client portal, email automation, digital signatures.** This module prepares the Practice to perform those activities later — it never calls an external API and never creates a new `practice_clients` row itself (onboarding attaches to a client that already exists).

## Architect Freedom — Scope Decisions & Deviations

1. **`buildOnboardingWorkspace()` splits the spec's 9-item initialization list into TRUE initializers (idempotent create-if-missing) and DETECTION-ONLY reads, rather than treating all 9 as auto-create actions.** Five modules get genuinely safe, non-guessing default values on first creation (Secretarial Profile, Entity Lifecycle Profile, Client Success Profile, Evidence Templates, BO Readiness seed item) — these are auto-initialized. Four modules require information that doesn't exist yet at onboarding time and cannot be safely guessed (Statutory Calendar needs a registration_date/financial_year_end due-date anchor; Evidence Checklists need a triggering source event like a change case; Risk Register needs a human likelihood/impact judgment; Knowledge Links need a human-picked relevant article) — these are DETECTION-ONLY: their current count is read and surfaced in the readiness view, never fabricated. Tax Profile is also detection-only, since `practice_taxpayer_profiles.taxpayer_type` is NOT NULL with no safe default. This split is the single most important design decision in this codebox — see the router's own header comment for the definitive list.
2. **Secretarial and Entity Lifecycle profiles are created with a direct INSERT (setting `company_type`/`entity_category` from the onboarding `entity_type`), not by reusing the existing `getOrInitProfile()`/`getEntityLifecycleProfile()` exports for the create path.** Those helpers create with generic defaults (`company_type = null`, `entity_category = 'company'`) because they don't know the client's actual entity type. Onboarding *does* know it (it's a required field), so this module writes its own creation logic to set it correctly on first creation — while still checking for an existing profile first and never touching one that already exists. This is a deliberate exception to "always reuse the existing helper," justified because reusing it here would silently discard known-good information the generic helper has no way to receive without changing its exported signature (which risks every existing caller).
3. **A 3-value entity-type naming mismatch between modules was found and mapped, not "fixed."** `practice_secretarial_profiles.company_type` and this module's `entity_type` use identical spellings (`pty_ltd`/`cc`/`npc`/`trust`/`partnership`/`sole_proprietor`/`other`) — no translation needed. `practice_entity_lifecycle_profiles.entity_category` (migration 125) uses different spellings for 3 of the 7 (`company` instead of `pty_ltd`, `close_corporation` instead of `cc`, `non_profit` instead of `npc`). A small `ENTITY_TYPE_TO_LIFECYCLE_CATEGORY` map bridges this. Harmonizing the three enums into one shared vocabulary was judged out of scope and risky (would require altering two already-applied CHECK constraints across live data) — documented here as a known inconsistency for a future session to consider, not something this codebox silently papers over.
4. **"Approve onboarding" and "Complete onboarding" are two distinct, sequential actions**, matching the spec's own endpoint list exactly: `PUT /approve` (only from `review` status) records `reviewed_by`/`reviewed_at` and completes the "Review completed" step; `PUT /complete` (only after approval) sets `onboarding_status = 'completed'` and completes the "Go-live approved" step. A manager cannot skip straight to complete without first approving — enforced by checking `profile.reviewed_at` is set.
5. **`PUT /profiles/:clientId/cancel` is an addition beyond the spec's literal endpoint list.** `onboarding_status` includes `'cancelled'` in its CHECK constraint per the spec's own field list, but no endpoint was named to reach it. Added as the minimal, obviously-necessary counterpart (requires a reason, manager-only) — the same reasoning applied to Codebox 69's `reopen` endpoint addition.
6. **`completion_percentage` is always server-calculated** from (completed-or-skipped steps + completed required checklist items) ÷ (total steps + total required checklist items) — never accepted from the client, matching the migration's own comment and the discipline already established for Entity Lifecycle's `current_lifecycle_status` and BO's `effective_percentage`.
7. **Checklist regeneration only ADDS missing items, never removes or resets existing ones** — the same idempotent-regeneration discipline established in Codebox 63/66/68's checklist generators.
8. **Onboarding checklist templates (`ONBOARDING_CHECKLIST_DEFAULTS`) are developer-authored, deterministic sets per entity type** — the spec names PTY/Trust/NPC/Sole Proprietor as examples, not exact item lists. `cc` reuses the `pty_ltd` set (both have a director + shareholder register); `other` gets a minimal generic set.
9. **Three additional small additive exports were needed this codebox**: `client-success.js` → `getOrInitSuccessRow`, `secretarial-evidence.js` → `ensureDefaultTemplates`, both aliasing existing private functions with zero behavior change — extending the same reuse-over-duplication precedent established in every prior codebox this session.

## Database — Migration 127

Four new tables: `practice_onboarding_profiles`, `practice_onboarding_steps`, `practice_onboarding_checklists`, `practice_onboarding_events` (append-only). No changes to any existing table.

## Backend — `client-onboarding.js`

### Endpoints (~16)

Summary, profile CRUD (list/get-with-readiness/create/update), step list/update, checklist generate/update, four workflow actions (submit-review/approve/complete/cancel), events.

## Onboarding Engine

`buildOnboardingWorkspace(cid, clientId, entityType, actorUserId)` — creates the profile (if missing), the 13 default steps (if none exist), and the entity-specific checklist (if empty), then runs the 5 TRUE initializers, each independently wrapped so one failing initializer never blocks the rest. Any step in `AUTO_COMPLETABLE_STEPS` (Secretarial/Entity Lifecycle/BO/Evidence initialized) is auto-marked complete once its module reports success (created or already existed). Idempotent and safe to re-run — calling it again on an existing profile detects everything and creates nothing new except genuinely missing pieces.

## Initialization Logic

See Architect Freedom #1-#3. Every initializer checks for an existing row *before* creating one, and never updates a field on a pre-existing row — "Never overwrite existing data" applied literally, including for the entity_type-derived `company_type`/`entity_category` fields, which are only ever set at the moment of the original INSERT.

## Readiness Logic

`_computeReadiness()` — pure, deterministic function combining step/checklist completion, the 6 detected module states, and 4 basic-information checks (contact name/email, assigned team member, expected go-live date) into an `overall_readiness` (`not_ready`/`in_progress`/`ready_for_review`/`ready`), a `module_readiness` breakdown, `missing_modules`/`missing_information` lists, and plain-language `recommended_next_actions`. No AI, no scoring model beyond simple completion ratios.

## Dashboard Integration

- **Clients module**: an "Onboarding →" link per client row, deep-linking into this module — the destination page itself determines Start vs. Continue based on whether a profile already exists (avoids an extra per-row status query on the Clients list).
- **Secretarial**: new "Client Onboarding" panel showing status + completion %.
- **Management Dashboard**: new "Client Onboarding" KPI section (new clients this month, active, delayed, avg progress) via cheap count-only queries.
- **Planning Board**: an `active_onboardings_count` per team member on the Team Board, plus an "Onboarding" quick link when non-zero.

## Frontend

`client-onboarding.html` + `js/client-onboarding.js` (prefix `cb`): client-picker-first (onboarding is per-client), a "Start Onboarding" panel when no profile exists yet, and 5 tabs once one does (Profile / Workflow / Checklist / Readiness / Events). The Profile tab's action bar is status-driven (Submit for Review → Approve → Complete, plus Cancel at any point). No document viewer, no chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `client-onboarding.js`, both new frontend files, and every edited file (`client-success.js`, `secretarial-evidence.js`, `index.js`, `layout.js`, `clients.html`, `secretarial.js` + its frontend JS, `management-dashboard.js` + its frontend JS + HTML, `planning-board.js` + its frontend JS). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. `client_id` is independently re-verified against `practice_clients` before profile creation. Reads unrestricted per-user; all writes (profile creation/update, step/checklist updates, workflow actions) are manager-gated (`_requireManager`).

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/127_practice_client_onboarding.sql` | 4 tables: profiles, steps, checklists, append-only events |
| `accounting-ecosystem/backend/modules/practice/client-onboarding.js` | Router + onboarding engine + initializers + readiness logic |
| `accounting-ecosystem/backend/frontend-practice/client-onboarding.html` | Client Onboarding UI |
| `accounting-ecosystem/backend/frontend-practice/js/client-onboarding.js` | Client Onboarding UI logic |
| `docs/new-app/70_client_onboarding.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_70_client_onboarding.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/client-success.js` | Added `getOrInitSuccessRow` export (purely additive) |
| `accounting-ecosystem/backend/modules/practice/secretarial-evidence.js` | Added `ensureDefaultTemplates` export (purely additive) |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `client-onboarding` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Client Onboarding" nav entry |
| `accounting-ecosystem/backend/frontend-practice/clients.html` | Added "Onboarding" link per client row |
| `accounting-ecosystem/backend/frontend-practice/secretarial.html` + `js/secretarial.js` | Added "Client Onboarding" panel |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` + `js/management-dashboard.js` + `management-dashboard.html` | Added `client_onboarding` block + KPI section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` + `js/planning-board.js` | Team board attaches `active_onboardings_count`; renders it + an onboarding quick link |

## Recommended Codebox 71

Practice Engagement Management + Engagement Letter Foundation, as specified — the contractual foundation beneath every workflow, once a client is onboarded.
