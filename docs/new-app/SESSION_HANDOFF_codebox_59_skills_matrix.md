# Session Handoff — Codebox 59: Practice Skills Matrix + Competency Framework

> Date: 2026-07-02
> Status: COMPLETE — migration 116 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### A catalog matching the spec's own examples, extended only where invited

All 12 example categories and 24 skills come straight from the spec's own examples (Prepare/Review VAT Return, Income Tax, Company Tax, Provisional Tax, EMP501, Prepare/Review AFS, Payroll Processing/Review, QMS Review, Risk Review, Workflow Design, Client Meeting, Xero, Pastel, Excel, Sean AI...). A handful of additional skills (CIPC Annual Return, Beneficial Ownership Filing, Compliance Deadline Management, Client Advisory, Team Supervision, Staff Mentoring) were added only under categories the spec explicitly named, using the spec's own "developer may expand/extend" language as the only license to do so — not invented freely. Certification *types*, by contrast, were deliberately left unseeded: SAICA/SAIPA/SAIT-style bodies are practice-specific and the spec gave no examples to build from, so guessing specific certification names would have been fabrication rather than following the spec.

### A real bug caught and fixed: Express route ordering

Adding `GET /competency-preview` to `delegation.js` initially placed it *after* the existing `GET /:id` route. Since Express matches routes in registration order and `/:id` is a wildcard path parameter, any request to `/competency-preview` would have been silently swallowed by `/:id` (which would treat "competency-preview" as an id value, fail to find a matching delegation, and return a 404) — never reaching the actual new route at all. This is exactly the kind of bug that's easy to miss because *something* still responds; it doesn't crash, it just silently does the wrong thing. Caught during this session and fixed by moving the new route above `/:id` in registration order, with a comment explaining why the ordering matters so it doesn't regress if more routes are added later.

### Two structural field additions beyond the spec's literal table listings

1. **`practice_team_certifications.is_active`** — the table already has a `status` column tracking a certification's real-world lifecycle (active/expired/pending/revoked). Reusing that column as a generic "hide this record" flag would have meant a mistakenly-entered duplicate could only be archived by lying about its real-world state (e.g. marking a still-valid certification "revoked" just to hide it). `is_active` is a separate, honest soft-delete flag; `status` keeps its real meaning.
2. **No archive column on `practice_team_skills` at all** — deliberately. A competency record isn't a discrete "thing" to delete; "no exposure to this skill" (level 0) is itself a meaningful, valid state. `DELETE /team-skills/:id` resets the record to level 0 rather than hiding a row — same information-preserving spirit as an archive flag, expressed through the data model that already exists rather than a new column.

### Migration 116

Six tables exactly as named in the spec: `practice_skill_categories`, `practice_skills`, `practice_team_skills`, `practice_certifications`, `practice_team_certifications`, `practice_skill_events`. Full details in the technical doc.

### Backend — `skills-matrix.js` (~24 endpoints)

Key judgment calls:

**`POST /team-skills` is an upsert, not a strict create.** Assigning or updating someone's competency level is something a manager naturally repeats over time — requiring a lookup-then-PUT round trip for every update after the first would have added friction for no safety benefit. `onConflict: 'company_id,team_member_id,skill_id'` handles this cleanly.

**`getCompetency()` deliberately does not guess.** Its `MODULE_SKILL_MAP` only covers the 5 delegation source types (risk-register, qms-review, qms-finding, tax-individual, tax-company) that map onto exactly one obvious skill. Tasks, deadlines, compliance-packs, document-requests, and reminders are left unmapped on purpose — inventing a "best guess" specific-skill match for a generic task title would have been precisely the "hidden logic" this module's Architecture Boundaries forbid. Unmapped modules still get a useful answer (the person's overall average level), just honestly labelled as such rather than pretending to know something the data doesn't support.

**Access is manager-or-self throughout, matching Codebox 58's established privacy boundary.** Anyone can view the skills/categories catalog (not sensitive), but a specific person's competency ratings, certifications, and full competency profile are only visible to that person themselves or a manager — not broadcast to every colleague.

### Integrations

**Delegation** (the spec's primary integration point): a new `GET /competency-preview` endpoint lets the create-delegation modal show live advisory info (previous owner vs. prospective new owner competency, plus a warning if the new owner is restricted or has little/no recorded experience) as the form is filled in — before the manager commits. The same advisory is attached to `GET /:id` for already-created delegations, scoped to single-delegation views only (not the list view) to avoid paying for extra query overhead on every list load.

**Planning Board** (marked "optional" in the spec, built anyway since it was cheap): Team Board cards show an Expert/Advanced/Training Needed badge per member, computed from a single lightweight query across the whole team rather than N calls into the heavier `getCompetency()` helper.

**Resource Forecast** (also marked "optional," and the only one of the three integration points the spec explicitly calls optional): **not built.** It would require cross-referencing every forecast week's unassigned/under-owned work against team-wide skill coverage — meaningfully more engineering than the other two integrations, for the one integration point the spec itself flagged as lowest priority. Documented as a deliberate scope decision, not an oversight — see Follow-Up Notes.

### Frontend — `skills-matrix.html` + `js/skills-matrix.js` (prefix `sk`)

Five tabs: Team Competency (per-member skill list, editable in place, shows every catalog skill even ones the person has no record for yet), Skills Catalog (categories + skills management), Certifications (type catalog + team-held certifications with expiry highlighting), Training Needs (practice-wide gap list, sorted by gap size), History. No chart library, no AI, matching every other codebox this session.

---

## Nothing Regressed

- `delegation.js`'s existing 10 endpoints and `changeOwnership()` pipeline are completely unchanged — the only additions are the new `GET /competency-preview` route and an opt-in `includeAdvisory` parameter on the existing `_enrichDelegations()` helper, defaulted to `false` everywhere except the one call site that was deliberately changed.
- `planning-board.js`'s `GET /team` response gained exactly one new field (`competency_badge`) per team member — every existing field is untouched, and the new field is additive (frontend code that doesn't know about it simply ignores it).
- `work-queue.js`, `capacity.js`, `notifications.js` — completely untouched.
- `node --check` passes on `skills-matrix.js`, `delegation.js`, `planning-board.js`, `index.js`, `layout.js`, and all three new/modified frontend JS files.
- A standalone Node smoke test loaded `skills-matrix.js` in isolation and confirmed `getCompetency`, `MODULE_SKILL_MAP`, and `LEVELS` are exported correctly; a second smoke test loaded `delegation.js` (which now requires `skills-matrix.js` in addition to `notifications.js`/`work-queue.js`/`planning-board.js`) and confirmed the full module chain resolves with no circular dependency.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep across every new/modified file.
- All files verified present on disk via `ls` immediately after writing.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `116_practice_skills_matrix.sql`

Expected: "Success. No rows returned." Apply after migration 115 (already applied per the prior codebox's stated assumption).

**After applying the migration, click "Seed Default Categories & Skills" on the Skills Matrix page (or `POST /api/practice/skills-matrix/seed-defaults`) at least once** to populate the 12 categories and 24 skills. This is required before the Team Competency tab shows anything meaningful, and before Delegation's advisory or Planning Board's badges can find any skill data to report on. Certification types are NOT seeded — a manager needs to add the certifications relevant to their own practice manually.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, two standalone module-loading smoke tests, and grep for browser-storage violations.*

1. Apply migration 116 to Supabase
2. Navigate to `/practice/skills-matrix.html` — should show the "no categories yet" banner and zeroed summary cards
3. Click "Seed Default Categories & Skills" — confirm 12 categories and 24 skills are created; click again — confirm `already_seeded: true` and no duplicate rows (idempotency)
4. On the Team Competency tab, select a team member → confirm all 24 catalog skills appear (even ones with no record yet, showing level 0)
5. Click "Update" on a skill, set current_level=4, target_level=5, check "Preferred," save → confirm the row updates immediately and the summary's "Advanced Ratings" count increments
6. Set another skill's current_level=5 → confirm "Expert Ratings" increments
7. Set a skill's target_level above current_level and save → confirm it appears on the Training Needs tab, sorted correctly by gap size
8. Add a custom category and a custom skill under it → confirm they appear correctly and can be assigned to a team member like the seeded ones
9. Archive a skill → confirm it disappears from the default Skills Catalog view but reappears with `?include_archived=true`
10. Add a certification type (e.g. "SAICA CA(SA)") → add a team certification for a specific member with an expiry date within 60 days → confirm it shows in "Expiring Soon" on the summary cards
11. Add a team certification with an expiry date in the past → confirm it's flagged `is_expired: true` and counted in "Expired"
12. As a non-manager, attempt to update a team skill or add a certification → confirm a 403, and confirm GET requests for your OWN skills/certifications still work
13. As a non-manager, attempt to view a colleague's team-skills via `?team_member_id=` → confirm a 403
14. Go to `/practice/delegation.html`, open "Delegate Work," pick a source type/ID and a new owner whose relevant skill is rated 0 or 1 → confirm a warning appears in the create modal BEFORE submitting ("little or no recorded experience...")
15. Mark that same new owner as `is_restricted` for the relevant skill, then repeat step 14 → confirm the warning changes to the restriction message, and confirm the delegation can STILL be submitted successfully (never blocked)
16. Open an existing delegation's detail view → confirm the "Skills Matrix Advisory" section appears at the bottom with previous/new owner competency levels
17. Go to `/practice/planning-board.html`'s Team Board → confirm members with a level-5 skill show an "🏆 Expert" badge, level-4-max show "⭐ Advanced," and members with any target>current gap (and nothing higher) show "📘 Training Needed"
18. Log in as a different company → confirm zero cross-company categories/skills/team-skills/certifications visible, and that seeding one company's defaults does not create rows for another company
19. DevTools → Application → Storage → confirm no skills-matrix data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Resource Forecast's Skills Matrix advisory ("upcoming work where no sufficiently skilled staff exist") was not built
- Confirmed now: This is the one integration point the spec itself explicitly marks "Optional advisory" (Delegation and Planning Board's integrations are not marked optional). Given the two required integrations were already substantial, this was consciously scoped out rather than built shallow/rushed.
- Not yet confirmed: Whether managers will actually want this once they've used the other two integrations for a while — it may become a natural next request.
- Risk: None currently — no functionality is missing that the spec required.
- Recommended: If requested, the natural shape is: for each forecast week's unassigned or thinly-owned work items (especially unowned deadlines, which Codebox 57 already surfaces separately), check whether any active team member has current_level >= 3 ("Independent") for the mapped skill (if one exists in MODULE_SKILL_MAP) — reuse getCompetency() per candidate rather than a new formula.
```

```
FOLLOW-UP NOTE
- Area: MODULE_SKILL_MAP only covers 5 of the 10 delegation source types
- Confirmed now: Deliberate — tasks, deadlines, compliance-packs, document-requests, and reminders don't map onto one obvious skill without guessing, so they were left out rather than force-mapped.
- Not yet confirmed: Whether task-level skill tagging (e.g. a task's own `metadata` carrying a relevant skill_key, set at task-creation time) would be a better long-term answer for the "tasks" case specifically, since tasks are the single largest and most varied source type.
- Risk: Low — the advisory simply falls back to overall_level for unmapped modules, which is honest and non-broken, just less specific.
- Recommended: If tasks need specific-skill advisory in the future, the cleanest extension point is adding an optional skill_id/skill_key field to practice_tasks itself (a source-module change, owned by tasks.js) rather than trying to infer it from a task's free-text title in skills-matrix.js.
```

```
FOLLOW-UP NOTE
- Area: practice_team_skills has no archive column — "removal" is a reset to level 0
- Confirmed now: A deliberate data-modeling choice (see technical doc) rather than an oversight — "no exposure" is itself a valid, meaningful competency state.
- Not yet confirmed: Whether managers will find "Update" (which can reset via the same form) sufficiently discoverable as the removal mechanism, versus expecting a dedicated "Delete" action.
- Risk: Very low — purely a UX-discoverability question, no data-integrity risk.
- Recommended: If this causes confusion in practice, the fix is a UI label change (e.g. a dedicated "Reset to No Exposure" button) rather than a schema change.
```
