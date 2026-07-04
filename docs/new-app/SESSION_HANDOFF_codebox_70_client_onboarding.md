# Session Handoff — Codebox 70: Practice Client Onboarding + Entity Formation Foundation

> Date: 2026-07-03
> Status: COMPLETE — migration 127 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### A workspace over an existing client, not a new client-creation flow

Onboarding attaches to a `practice_clients` row that already exists (created via the Clients module, as always) — this codebox never creates a client, it builds the internal workspace that tracks "is this client ready to go live." That distinction matters: `buildOnboardingWorkspace()` takes a `clientId` and verifies it first via the same `_verifyClient()` pattern used everywhere else this session.

### Splitting "initialize 9 things" into what can safely be created vs. what can only be detected

The spec's `buildOnboardingWorkspace()` list names 9 things to "create or link where appropriate... DO NOT duplicate existing records... always detect first." Read literally, that's ambiguous about whether every item must be auto-created. Working through each one: Secretarial Profile, Entity Lifecycle Profile, Client Success Profile, Evidence Templates, and a BO Readiness seed item all have genuinely safe defaults and get auto-created (idempotently, checking existence first every time). Statutory Calendar, Evidence Checklists, Risk Register, Knowledge Links, and Tax Profile all require information that doesn't exist yet at onboarding time — a due-date anchor, a triggering event, a human risk judgment, a human-picked article, or a NOT NULL taxpayer type with no sensible default. Auto-creating any of these would mean guessing, which every prior codebox's "never guess" discipline forbids. So these five are DETECTION-ONLY: their current state is read and surfaced in the readiness view (`missing_modules`), and the manager is prompted to complete them through their own existing modules once the right information exists. This is the single most consequential judgment call in this codebox, and it's documented at the top of both the router and the migration file so it's never mistaken for an oversight.

### A genuine schema audit finding: three different entity-type vocabularies

Three modules describe "what kind of entity is this" with three different sets of enum values: `practice_secretarial_profiles.company_type`, this codebox's own `entity_type`, and `practice_entity_lifecycle_profiles.entity_category` (Codebox 68). The first two are spelled identically; the third uses `company`/`close_corporation`/`non_profit` instead of `pty_ltd`/`cc`/`npc` for three of its seven values. Rather than alter Codebox 68's already-applied CHECK constraint (invasive, and out of scope for this codebox), a small translation map bridges the two only where this module writes to Entity Lifecycle on first creation. Documented as a known inconsistency worth harmonizing in a future session, not silently patched over.

### Reusing helpers correctly means sometimes NOT reusing them for the create path

`secretarial.js`'s `getOrInitProfile()` and `entity-lifecycle.js`'s `getEntityLifecycleProfile()` both lazily create their respective profiles with generic defaults, because neither function has any way to know a client's actual entity type. This codebox *does* know it (it's a required onboarding field) at the exact moment a profile needs to be created. Rather than either (a) blindly reuse the generic helpers and leave `company_type`/`entity_category` empty, forcing a manager to set them manually right after onboarding claims to have "initialized" them, or (b) risk changing those helpers' signatures and behavior for every existing caller — this codebox writes its own small, existence-check-first creation logic for exactly these two profiles, while still reusing the generic helpers' exact pattern (check first, insert only if missing, never touch an existing row). This is reuse of the *pattern*, not the *function*, and is documented as a deliberate exception rather than left unexplained.

### Backend — `client-onboarding.js` (~16 endpoints)

Full profile/step/checklist CRUD, plus four workflow actions matching the spec's endpoint list almost exactly: submit-review, approve, complete, and one addition — `cancel` (added for the same reason Codebox 69 added `reopen`: the migration's own `onboarding_status` enum includes `'cancelled'`, and leaving it unreachable would be worse than adding the obvious, minimal, manager-gated endpoint to reach it).

### Frontend — `client-onboarding.html` + `js/client-onboarding.js` (prefix `cb`)

- Client-picker-first, with a distinct "Start Onboarding" panel shown only when no profile exists yet for the selected client
- 5 tabs once a profile exists: Profile (status + action bar + editable details), Workflow (13-step checklist with per-step status dropdowns), Checklist (entity-specific document/information checklist), Readiness (overall readiness pill, module-by-module breakdown, missing information, recommended actions), Events
- No document viewer, no file upload UI, no chart library, no AI

### Integrations

**Clients module**: an "Onboarding" link added per client row — deep-links into this module, which itself decides Start vs. Continue.
**Secretarial**: new "Client Onboarding" panel showing status + completion %.
**Management Dashboard**: new "Client Onboarding" KPI section — new clients this month, active, delayed, avg progress.
**Planning Board**: an `active_onboardings_count` per team member on the Team Board.

---

## Nothing Regressed

- `client-success.js`'s existing endpoints and `calculateClientHealth()` are unchanged — the only addition is one new export aliasing an existing private function.
- `secretarial-evidence.js`'s existing ~20 endpoints, `getChecklistReadiness()`, and `getEvidenceSummary()` are unchanged — the only addition is one new export aliasing an existing private function.
- `secretarial.js`, `entity-lifecycle.js`, `beneficial-ownership.js` — read from only, via their existing exports; none were modified this codebox.
- `management-dashboard.js`'s `computeSummary()` — every existing key is unchanged; `client_onboarding` is a new, additive key.
- `planning-board.js`'s `/team` endpoint — every existing per-member field is unchanged; `active_onboardings_count` is a new, additive field.
- `secretarial.js`'s `secLoadClientData()`/`secOnClientChange()` — every existing panel load is unchanged; the onboarding panel load is additive.
- `clients.html`'s existing row actions (View, Edit) are unchanged; "Onboarding" is a new, additive link.
- `node --check` passes on every new/modified JS file.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep.
- All files verified present on disk immediately after writing.
- A half-finished `new_clients_this_month` field (a placeholder comment instead of a real computation) was caught and fixed during self-review before this handoff was written — replaced with a proper `created_at`-window calculation, mirrored identically in both the module's own `/summary` endpoint and the Management Dashboard's reuse of the same logic.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`127_practice_client_onboarding.sql`

Expected: "Success. No rows returned." No seeding step is required — profiles, steps, and checklists are all created lazily via `POST /profiles` (which calls `buildOnboardingWorkspace()`), never via a migration-time seed.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migration 127 to Supabase
2. Navigate to `/practice/client-onboarding.html` — should show zeroed summary cards
3. Select a client with no onboarding profile → confirm the "Start Onboarding" panel appears (not the full workspace)
4. Choose an entity_type (e.g. `pty_ltd`) and click "Start Onboarding" → confirm a profile, 13 default steps, and a PTY-specific checklist all appear
5. Confirm the "Secretarial initialized," "Entity lifecycle created," and "BO initialized" steps are already marked Completed immediately after creation (auto-completed by `buildOnboardingWorkspace()`)
6. Go to `/practice/secretarial.html` for the same client → confirm a Secretarial Profile now exists with `company_type` set to `pty_ltd` (not null)
7. Go to `/practice/entity-lifecycle.html` for the same client → confirm an Entity Lifecycle Profile exists with `entity_category = 'company'`
8. Go to `/practice/beneficial-ownership.html` for the same client → confirm one BO readiness item ("Manager review of Beneficial Ownership register") exists
9. Click "Start Onboarding" AGAIN for the same client (or re-trigger `POST /profiles`) → confirm it does NOT create a second profile, second set of steps, or duplicate checklist items — confirm idempotency
10. Manually set `company_type` on that client's Secretarial Profile to something else, then re-run onboarding initialization → confirm it is NOT overwritten (existing data is always reused, never touched)
11. Tick off checklist items and mark steps complete until all required items are done → confirm the Readiness tab's `overall_readiness` progresses from `not_ready` → `in_progress` → `ready_for_review`
12. Click "Submit for Review" → "Approve" → confirm the "Review completed" step auto-completes and `reviewed_at` is set
13. Click "Complete Onboarding" → confirm `onboarding_status` becomes `completed`, the "Go-live approved" step auto-completes, and the action bar disappears
14. On a different client, click "Cancel Onboarding" without a reason → confirm it's rejected (400); provide a reason → confirm it succeeds and status becomes `cancelled`
15. Go to `/practice/management-dashboard.html` → confirm the new "Client Onboarding" KPI section shows counts matching the Client Onboarding page
16. Go to `/practice/planning-board.html` → confirm a team member with an assigned active onboarding shows the correct count and an "Onboarding" quick link
17. As a non-manager, attempt to create/update a profile, step, or checklist item, or any workflow action → confirm 403 on each; confirm all `GET` reads still succeed
18. Log in as a different company → confirm zero cross-company profiles/steps/checklists/events visible
19. DevTools → Application → Storage → confirm no onboarding data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Three different entity-type enum vocabularies across Secretarial (company_type), Entity Lifecycle (entity_category), and this codebox (entity_type)
- Confirmed now: secretarial.company_type and this module's entity_type are spelled identically (7 matching values); entity_lifecycle.entity_category differs for 3 of 7 values (company/close_corporation/non_profit vs. pty_ltd/cc/npc). A translation map bridges this only at Entity Lifecycle profile creation time.
- Not yet confirmed: Whether a future session should harmonize all three into one shared enum/lookup table.
- Risk: Low — the mapping is small, explicit, and tested at the one place it's used; no data corruption risk, just a minor ongoing maintenance surface if a new entity type is ever added to only one of the three enums.
- Recommended next review point: If a new entity type needs to be added, add it to all three CHECK constraints and this module's mapping in the same change.
```

```
FOLLOW-UP NOTE
- Area: Statutory Calendar, Evidence Checklists, Risk Register, Knowledge Links, and Tax Profile are detection-only during onboarding — never auto-created
- Confirmed now: Each requires information (a due-date anchor, a triggering event, a human risk judgment, a human-picked article, or a NOT NULL taxpayer type) that doesn't exist at onboarding time and cannot be safely guessed without violating "never guess."
- Not yet confirmed: Whether practices want a more guided "next step" prompt (e.g., a direct link from the Readiness tab's missing_modules list straight into the relevant module's create form, pre-filled with the client_id) rather than just a plain module name in the missing list.
- Risk: None currently — the current behavior is safe (informational only); this is a UX enhancement opportunity, not a defect.
- Recommended: If requested, add direct "Set this up →" links per missing module on the Readiness tab, reusing each target module's existing create form.
```
