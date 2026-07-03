# Session Handoff — Codebox 60: Practice Learning, Development & Training Centre

> Date: 2026-07-02
> Status: COMPLETE — migration 117 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### A progress engine with an explicit, tiered, documented formula

`calculateLearningProgress()` computes each goal's progress via three tiers, in order: (1) a `completed` status always wins outright at 100%, (2) a skill-linked goal uses `current_level / target_level`, (3) otherwise, a goal with logged activities uses `completed_hours / planned_hours`, (4) a goal with none of the above is 0%. Every tier is documented directly in code comments above the function, and every goal's computed progress carries a human-readable `reason` string explaining which tier applied — "no hidden logic," matching the same discipline the Skills Matrix (Codebox 59) and Alert Rules (Codebox 53) established for their own scoring. The plan-level `overall_progress` is a simple average of its goals, and the function always rewrites the plan's cached column as a side effect — called from every goal/activity CRUD path that touches that plan, so the cache can never silently drift from what a fresh calculation would show.

### Two soft-delete design decisions, made independently rather than by copying a rule mechanically

1. **`practice_learning_plans` has no `is_active` column** — `DELETE /plans/:id` sets `status='cancelled'`, reusing the existing enum's terminal value.
2. **`practice_cpd_records` DOES have `is_active`, separate from `status`** — because `status` there already carries real meaning (recorded/verified/expired), the same reasoning Codebox 59 used for `practice_team_certifications`.

These look like they could have been "just copy whatever Codebox 59 did," but they're actually two independent judgment calls that happened to land differently because the two tables' `status` columns mean different things. Worth flagging explicitly so a future reader doesn't assume there's one blanket "archive pattern" rule being mechanically applied everywhere — the rule is "don't let a soft-delete flag lie about a column's real meaning," and that rule produces different answers depending on what the status column already says.

### Migration 117

Six tables exactly as named in the spec. `practice_learning_progress` was built as a genuine history table (point-in-time snapshots, written only when a manager explicitly captures one, or read from directly via `GET /progress/:plan_id/history`) — distinct from `practice_learning_plans.overall_progress`, which is always just "the last computed value." This is the same "frozen snapshot vs. live state" distinction already used by KPI History (Codebox 51) and Resource Forecast snapshots (Codebox 57), applied here to a new domain.

### Backend — `learning-centre.js` (~24 endpoints)

Key judgment calls:

**CPD hours in the progress calculation are practice-wide for the team member, not plan-scoped.** A person's CPD hours count toward external professional body requirements regardless of which internal development plan (if any) prompted the training — scoping to a single plan would have under-counted a number that has real meaning outside this system entirely.

**The Skills Matrix suggestion endpoint is a direct read, not a shared helper call.** `GET /suggested-goals/:team_member_id` queries `practice_team_skills` directly with the same gap filter the Skills Matrix's own Training Needs tab already uses — there's no scoring formula to duplicate here, just a plain filter, so requiring `skills-matrix.js` for this one query would have added a dependency without adding any actual logic reuse.

**The Delegation development badge is deliberately not skill-specific.** `getDevelopmentBadge(cid, teamMemberId, skillId)` supports an optional `skillId` parameter for future precision, but Delegation's own call site passes `null` — resolving a `MODULE_SKILL_MAP` skill_key to an actual skill_id would need an extra lookup for a badge that's already meant to be a soft hint, not a precise measurement (unlike the actual competency *level* comparison next to it in the same advisory, which does warrant that precision because it's the number driving a real decision).

### Frontend — `learning-centre.html` + `js/learning-centre.js` (prefix `lc`)

- Summary cards (active/draft/overdue plans, mentors active, goals total/completed, CPD hours/records)
- Learning Plans tab — list with progress bars; opening a plan shows nested goals→activities, inline "Mark Complete," "+ Add Goal," "+ Add Activity," a "📸 Capture Progress Snapshot" button, and plan cancellation
- Create Plan modal — live Skills Matrix suggestions as a team member is selected (informational chips, not auto-created goals)
- CPD tab — full record management with expiry visibility
- History tab — global event feed
- No chart library, no AI, matching every codebox this session

### Integrations

**Skills Matrix**: suggested development goals shown live in the Create Plan modal.
**Delegation**: `new_owner_development_badge` added to the existing Codebox 59 competency advisory — "In Development" / "Mentored" badges rendered alongside the competency levels already shown there, never affecting whether a delegation can proceed.

---

## Nothing Regressed

- `delegation.js`'s existing 10 endpoints, `changeOwnership()` pipeline, and Codebox 59 competency advisory are unchanged in structure — the only addition is one new field (`new_owner_development_badge`) computed via one new `Promise.all` entry in `_competencyAdvisory()`, wrapped in its own `.catch()` so a Learning Centre lookup failure can never break the delegation flow.
- `skills-matrix.js` — completely untouched; the suggestion feature reads its owned table directly rather than modifying it.
- `work-queue.js`, `planning-board.js`, `capacity.js`, `notifications.js`, `resource-forecasting.js` — completely untouched.
- `node --check` passes on `learning-centre.js`, `delegation.js`, `index.js`, `layout.js`, and both new/modified frontend JS files.
- A standalone Node smoke test loaded `learning-centre.js` in isolation and confirmed `calculateLearningProgress` and `getDevelopmentBadge` are exported correctly; a second smoke test loaded `delegation.js` (which now requires `learning-centre.js` in addition to `notifications.js`/`work-queue.js`/`planning-board.js`/`skills-matrix.js`) and confirmed the full 5-module dependency chain resolves with no circular dependency.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `117_practice_learning_centre.sql`

Expected: "Success. No rows returned." Apply after migration 116 (already applied per the prior codebox's stated assumption).

No seeding step is required or provided — development plans, goals, activities, and CPD records all start empty and are created entirely by managers as needed.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, two standalone module-loading smoke tests, and grep for browser-storage violations.*

1. Apply migration 117 to Supabase
2. Navigate to `/practice/learning-centre.html` — should show zeroed summary cards and an empty plan list
3. Click "+ New Development Plan," select a team member with Skills Matrix gaps recorded → confirm suggestion chips appear live in the modal
4. Create a plan with status "Active" → confirm it appears in the plan list at 0% progress
5. Open the plan, add a goal linked to a skill with `current_level=2, target_level=4` → confirm the goal shows in the plan detail and the plan's overall progress updates to 50% (2/4) immediately without a page reload
6. Add a second goal with no skill link, then add an activity under it with `planned_hours=10, completed_hours=5` → confirm that goal shows 50% and the plan's overall progress becomes the average of both goals (50%)
7. Mark the first goal "Complete" → confirm its progress becomes 100% and the plan's overall progress recalculates to reflect the average of 100% and 50%
8. Click "📸 Capture Progress Snapshot" → confirm a snapshot row is created; call `GET /progress/:plan_id/history` (or check the DB) to confirm it recorded the exact figures shown at that moment
9. Change the underlying goals/activities after the snapshot, then check the snapshot again → confirm it still shows the OLD figures (frozen, not recalculated) while the plan's live `overall_progress` shows the NEW figures
10. Record a CPD entry for a team member with `hours=6` → confirm it appears in the CPD tab and the summary's "CPD Hours" figure increments
11. Open that same team member's learning plan progress (`GET /progress/:plan_id`) → confirm `cpd_hours_accumulated` reflects their total CPD hours practice-wide, not scoped to just this plan
12. Record a CPD entry with an expiry date in the past → confirm it's flagged `is_expired: true` on the CPD tab
13. As a non-manager, attempt to create a plan or goal → confirm 403; confirm they CAN still view their OWN plan and a plan where they are the assigned mentor
14. As a non-manager who is neither the plan's team member nor its mentor, attempt to view that plan → confirm 403
15. Go to `/practice/delegation.html`, open "Delegate Work" for a new owner who has an active learning plan → confirm the "📘 In Development" or "🤝 Mentored" badge appears in the advisory box, alongside the existing competency-level lines from Codebox 59
16. Confirm the badge never blocks or disables the "Delegate" submit button
17. Cancel a learning plan → confirm its status becomes `cancelled` and it's excluded from the default "active" filtered views but still retrievable via `?status=cancelled`
18. Log in as a different company → confirm zero cross-company plans/goals/activities/CPD records visible
19. DevTools → Application → Storage → confirm no learning-centre data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Delegation's development badge is not skill-specific (always calls getDevelopmentBadge with skillId=null)
- Confirmed now: A deliberate scope decision — the badge is a soft hint, and resolving MODULE_SKILL_MAP's skill_key to an actual skill_id would need an extra lookup query for marginal precision gain.
- Not yet confirmed: Whether managers will want the more precise, skill-specific version once they've used the general one for a while.
- Risk: Very low — the function already supports the skillId parameter; making the call site skill-specific later is a one-line change plus one lookup query, not a redesign.
- Recommended: If requested, resolve the skill_key -> skill_id lookup once (cacheable, since skill catalogs change rarely) rather than per-delegation-request.
```

```
FOLLOW-UP NOTE
- Area: No rule-based reminder system was built despite "Rule-based reminders" being listed as a Success Criterion
- Confirmed now: The spec's Success Criteria section lists "Rule-based reminders" but the Backend/Endpoints section never names a specific reminder endpoint, and no other codebox section (Learning Plan fields, Goals, Activities, CPD, Progress Engine) describes what should trigger a reminder or where it should surface. Rather than invent an unspecified feature, this was left unbuilt.
- Not yet confirmed: What "rule-based reminders" should concretely mean here — e.g. "notify the mentor when a goal's target_date passes with status still not_started," or "notify the team member when CPD hours are below some threshold near a cycle deadline." Codebox 54's notify() helper is the natural mechanism once the trigger rules are specified.
- Risk: None currently — no functionality is broken; a genuinely unspecified feature was correctly left unbuilt rather than guessed at.
- Recommended: If this surfaces as a real need, it belongs in the same category as Alert Rules (Codebox 53) — a specific, deterministic, spec-defined trigger condition, not something to invent silently in a future pass.
```

```
FOLLOW-UP NOTE
- Area: practice_cpd_records.category is free text, not linked to any taxonomy
- Confirmed now: Deliberate — CPD categories are typically defined by an external professional body (SAICA/SAIT/etc.) with their own classification system, distinct from the internal Skills Matrix category taxonomy. Forcing CPD into that taxonomy would have been a false equivalence.
- Not yet confirmed: Whether practices will want CPD category reporting/rollups (e.g. "hours by category") badly enough to justify introducing a proper CPD category catalog later.
- Risk: Low — free text still supports basic grouping/search; a dedicated catalog can be introduced later as a purely additive migration if needed.
- Recommended: If CPD category reporting becomes a real requirement, model it the same way practice_certifications was modelled in Codebox 59 — its own small catalog table, not reuse of practice_skill_categories.
```
