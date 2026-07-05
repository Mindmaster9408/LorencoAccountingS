# Session Handoff — Codebox 79: Practice Operational Health Centre + System Readiness Monitor

> Date: 2026-07-05
> Status: COMPLETE — migration 136 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### The hardest design constraint: auditing everything without duplicating anything

Every prior codebox this session reused another module's exported *compute function*. This codebox is structurally different — its entire job is to read tables that belong to OTHER modules directly (module health, stale data, integration integrity). The discipline applied throughout: read raw table state to detect a *structural* problem (missing table, orphaned reference, aging row) — never re-derive a business *score* or *status* that a module already computes itself. Where a module already exposes a reusable compute function (`alert-rules.js`'s `getRules()`), that function is called instead of re-implementing rule resolution.

### This module directly formalizes a bug found earlier in this session

The role-link-integrity check is not a generic "nice to have" — it exists because `practice_team_members.user_id` being left `NULL` caused a real production incident earlier today (super admins locked out of the Planning Board). `lib/team-access.js` was fixed to self-heal that specific case invisibly. This codebox makes the *class* of problem permanently visible on a dashboard instead of relying on someone noticing a 403 again: it counts unlinked team members, tells you which ones will self-heal automatically (single clean email match) vs. which need a human to go fix them on the Team page, and separately catches the reverse case — a team member still linked to a user whose company access was later revoked.

### A genuine migration-directory discovery, not a hypothetical

While building the migration-readiness check, auditing the actual file system (not assumptions) revealed this app's migrations live in **two separate directories** with independently-numbered, overlapping filenames — `accounting-ecosystem/database/migrations/` (ecosystem-wide + foundational practice tables 054–056) and `accounting-ecosystem/backend/config/migrations/` (every Codebox from 46 [057] onward). A naive migration-readiness check that counted `.sql` files in one directory would have produced a false "migration 054/055/056 missing" alarm on every single run, since those numbers exist only in the other directory. The check was designed around live table existence specifically because of this finding — documented in both the migration header and this handoff so a future developer doesn't have to rediscover it.

### An N+1 query caught before the file was ever run

The first draft of the role-link check re-queried `user_company_access` inside a loop, once per unlinked team member. Caught on review (the same discipline applied to catching Codebox 78's unawaited-insert bug) and fixed to fetch the active-access list once and reuse it across every member — before the file was syntax-checked for the first time.

### Backend — `operational-health.js`

7 parallel category checks (`Promise.all`) feeding one weighted score. Every check is deliberately conservative about false positives: the stale-automation-rule check only flags rules that have run before but gone quiet (a never-run manual rule isn't "stale," it's simply unused); the module-health check only flags a table as broken on an actual query error, never on a business-logic judgment.

### Frontend — `operational-health.html` + `js/operational-health.js` (prefix `oh`)

A score hero, 7-category breakdown grid, and 3 tabs (Checklist/Findings/History) rather than the spec's more granular section list — the checklist and findings panels together cover "module health / config / migrations / automation / role-links / stale-data / integrations / production readiness / pilot readiness" without needing 8+ separate tabs, since every one of those concepts already surfaces as either a checklist item or a categorized finding. "Run Health Check Now" requires a native `confirm()` before executing, since it's a real (if lightweight) write.

---

## Nothing Regressed

- `alert-rules.js`'s `getRules()` — called exactly as-is, read-only, no wrapper.
- `lib/team-access.js` — not modified; this module mirrors its email-matching *logic* for reporting purposes only, never calls into it or touches its self-heal write path.
- `management-dashboard.js`'s `computeSummary()` gained one new additive `operational_health` key; every existing key (including Codebox 77's and 78's) is untouched.
- `node --check` passes on every new/modified JS file, verified individually as each was written and again in a final sweep.
- Full router chain (`require('./modules/practice/index.js')` with dummy env vars) loads cleanly with `operational-health.js` mounted.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`136_practice_operational_health.sql`

Expected: "Success. No rows returned." No seeding step needed — the first "Run Health Check Now" click populates everything. Migration 135 from Codebox 78 should already be live.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, a full require-graph smoke test, and grep for browser-storage violations.*

1. Apply migration 136 to Supabase.
2. Navigate to `/practice/operational-health.html` — should show "No health check has been run yet" and an empty checklist.
3. Click "Run Health Check Now" → confirm the score hero populates with a score/status, the 7 category cards populate, the Pilot Readiness Checklist tab shows 8 items, and the Findings tab shows any actual issues (or "everything checked out clean").
4. Confirm the "Role Links" category and checklist item correctly reflect the current state of `practice_team_members` (should be clean/healthy now, since the earlier root-cause fix already backfilled the 4 super-admin rows this session).
5. Manually null out a test team member's `user_id` in Supabase (or use a throwaway row) → re-run the health check → confirm it now appears in the role-link findings as auto-healable or needs-review, matching the actual email-match state.
6. Go to Run History → click into the run just created → confirm the run detail modal shows `health_check_started` and `health_check_completed` events in order.
7. Go to `/practice/management-dashboard.html` → confirm the new "Operational Health" KPI section shows the same score/status/timestamp as the latest run.
8. As a non-manager, attempt `POST /run` → confirm 403; confirm all GET reads still succeed.
9. Log in as a different company → confirm zero cross-company health check runs/events visible, and confirm the health check itself only ever reports on the current company's own data.
10. DevTools → Application → Storage → confirm no operational-health data in localStorage/sessionStorage/IndexedDB.
11. Run the health check twice in a row → confirm both runs are recorded (this module has no dry-run/idempotency concept — every run is a real, persisted snapshot by design).

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: two separate migration directories with overlapping file numbers
- Confirmed now: accounting-ecosystem/database/migrations/ (ecosystem-wide + practice foundation, 054-056) and accounting-ecosystem/backend/config/migrations/ (Codebox 46 onward, 057+) both exist and both contain live, applied migrations. This module's migration-readiness check probes live table existence specifically to be immune to this split.
- Not yet confirmed: whether a future consolidation of these two directories is planned, and if so, how in-flight migration numbering would be reconciled.
- Risk: Low for this module (the check design already accounts for it) — but genuinely confusing for any future developer who tries to find "migration 055" and gets the wrong file, or assumes file count equals applied-migration count.
- Recommended next review point: if a future codebox needs to reason about "which migration number is next," check BOTH directories, not just accounting-ecosystem/backend/config/migrations/ alone (that folder's own next number is 137; the other folder's is unrelated and separately numbered).
```

```
FOLLOW-UP NOTE
- Area: role-link auto-healable vs needs-review counts are a live read, not a stored remediation queue
- Confirmed now: the health check reports counts and categorizes them correctly at the moment it runs, but does not persist a list of WHICH specific team members need review beyond what's visible in the run's own findings/category_results JSON.
- Not yet confirmed: whether partners will want a direct "go fix this" link from a role-link finding straight to the specific team member's row on the Team page.
- Risk: Low — the Team page itself already surfaces the "No login" badge per member; this is a UX convenience gap, not a correctness gap.
- Recommended next review point: if manual role-link review becomes a frequent workflow, add team_member_id references into the role_links finding detail so the frontend can deep-link directly.
```
