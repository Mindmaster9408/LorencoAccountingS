# Session Handoff — Codebox 78: Practice Automation Foundation + Workflow Orchestration

> Date: 2026-07-05
> Status: COMPLETE — migration 135 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### The hardest design constraint: deterministic execution with zero eval, zero dynamic code

The spec's boundary was blunt: "No dynamic code execution. No eval. No arbitrary JavaScript." The condition engine (`_getPath()`, `_applyOperator()`) and the action-text interpolator (`_interpolate()`) are both pure string/path resolution — a dot-path walker and a regex-based `{{token}}` replacer, nothing that ever constructs or executes a code string. Every operator is an explicit `switch` case; every action type is an explicit `switch` case in `_executeAction()`. There is no generic "call this function by name" capability anywhere — adding a new action type requires a code change, by design, not a data change.

### A real bug caught and fixed during the build: condition steps weren't actually awaited

The first draft of the condition-step-writing loop used `Array#forEach` with an async insert call inside it, discarding the returned promise — a classic "looks synchronous, isn't" bug that would have caused racy step ordering and unhandled rejections in production. Caught on review before the file was even syntax-checked the first time; replaced with a plain `for...of` loop with `await` on every iteration, matching the pattern already used correctly in the action-execution loop. No other part of the file had this issue (the action loop was written correctly from the start).

### Every "stop early" path now has an informative summary, not a generic one

The engine uses a `_StopRun` sentinel exception to unwind out of the try block on a deliberate stop (inactive rule / invalid actions / idempotent duplicate / conditions not met) without treating it as a genuine error. A `stopSummary` variable is set immediately before each `throw new _StopRun()` so the run's `result_summary` column reads e.g. "Conditions not met — no actions were run." instead of a generic "Run stopped." — this was tightened during the build once the gap was noticed (the idempotent-duplicate path already had its own good message; the other three stop points didn't).

### Manager-gating was applied correctly from the first pass this time

Codebox 77's first draft had zero manager-role gating on its mutating routes (matching the pure-reporting-family precedent it was built on) and had to be corrected mid-build once the gap was noticed. This module was written immediately afterward with that lesson applied: all 20 mutating routes (`POST /rules`, `PUT /rules/:id`, `DELETE /rules/:id`, `PUT /rules/:id/approve|activate|pause|disable|archive`, `POST /rules/:id/test|run`, `POST /seed-defaults`) call `_requireManager()` → `teamAccess.requireManager()` from the start — confirmed by direct grep (20 mutating handlers, 20 gate calls) rather than discovered as a gap afterward.

### Idempotency is the one place where dry vs. live genuinely diverges in behavior

Every other part of the engine treats dry and live runs identically (same steps written, same validation, same event trail) — idempotency is the deliberate exception. A dry run's idempotency-check step is always `skipped` with a note explaining why (dry runs don't consume idempotency, per spec, verbatim); only a live run computes and checks a real key, and only a live run's completed/completed-with-warnings result gets a key persisted for future duplicate detection.

### Backend — `automation.js`

Full CRUD on rules, 5 workflow transitions plus soft-cancel DELETE, manual test/run execution (`POST .../test` always forces a dry run server-side regardless of any client-supplied flag — there is no way to accidentally live-run through the test endpoint), run/step/event listing both company-wide and rule-scoped, a static catalogue endpoint (no DB query — just the constant lists), and idempotent seed-defaults insertion of 4 draft-only example rules.

### Frontend — `automation.html` + `js/automation.js` (prefix `auto`)

4 top-level tabs matching the spec's page-section list almost 1:1 (Rules combines spec sections 1+2, Run History is section 6, Events is folded in as its own tab, Catalogue/Help is section 8). Conditions/actions are edited as raw JSON textareas rather than a visual builder — explicitly named as a future enhancement in the spec ("Visual workflow builder" under DO NOT BUILD NOW), so this was the correct scope call, not a shortcut. The Test/Run modal makes the dry-run/live-run distinction impossible to miss: a native `confirm()` gate before any live execution, a red "Run Live Now" button only shown when explicitly requested, and the run result panel always shows the run's actual persisted status rather than an optimistic client-side guess.

---

## Nothing Regressed

- `notifications.js`'s `notify()` — called exactly as-is, no wrapper, no changed signature; `notifications.js` itself was not modified at all.
- `reminders.js`, `executive-reporting.js`, `partner-scorecards.js`, `secretarial-workflows.js`, `secretarial-integrity.js`, `client-onboarding.js`, `risk-register.js`, `quality-management.js`, `pricing-review.js` — none were modified; all are read-only trigger-context sources or, in `reminders`'/`executive-reporting`'s case, direct-insert targets using their own already-established table shapes.
- `management-dashboard.js`'s `computeSummary()` gained one new additive `automation` key; every existing key is untouched.
- `node --check` passes on every new/modified JS file, verified individually as each was written and again in a final sweep.
- Full router chain (`require('./modules/practice/index.js')` with dummy env vars) loads cleanly with `automation.js` mounted.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`135_practice_automation_foundation.sql`

Expected: "Success. No rows returned." No seeding step required at the DB level — use the in-app "Seed Example Rules" button (calls `POST /seed-defaults`) to insert the 4 draft example rules once migration 135 is live. Migration 134 from Codebox 77 should already be live.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, a full require-graph smoke test, and grep for browser-storage violations.*

1. Apply migration 135 to Supabase.
2. Navigate to `/practice/automation.html` — should show zeroed summary cards and both governance banners.
3. Click "Seed Example Rules" → confirm 4 draft rules appear in the Rules tab, all `draft` status, 2 of them (pricing/secretarial) showing "Needs Approval".
4. Create a new rule: name, key, trigger `manual`, category `custom`, conditions `[]`, actions `[{"type":"create_notification","category":"system","severity":"info","title":"Test {{source.name}}"}]` → confirm it saves as draft.
5. Attempt to save a rule with an unsupported action (`{"type":"send_email", ...}`) → confirm a clear rejection message naming the action.
6. Open the new rule → Test (Dry Run) with `source: {"name":"Hello"}` → confirm the run result shows `dry_run` status, a "would create notification" step output with the interpolated title "Test Hello", and that `practice_notifications` gained NO new row.
7. Activate the rule → confirm it moves to `active`.
8. Run Live Now with the same context → confirm a real notification appears (check `/practice/notifications.html`), the run status is `completed`, and an idempotency key was stored.
9. Run Live Now again with the identical trigger_source_type/trigger_source_id → confirm the second run is `skipped` (idempotent duplicate) and no second notification was created.
10. Create a high-safety-level rule → confirm `requires_approval` auto-sets to true and Activate is blocked until Approve is clicked.
11. Open Run History → click into a run → confirm every step (safety_check, idempotency_check, condition(s), action(s), output) is visible with correct status.
12. Test `create_executive_action` against a rule with no resolvable `report_id` → confirm it fails safely with a clear error, no executive action created, and no `practice_task` created anywhere.
13. Go to `/practice/management-dashboard.html` → confirm the new "Automation" KPI section shows correct active-rule/failed-run/warning-run counts.
14. As a non-manager, attempt every POST/PUT/DELETE on this module → confirm 403 on each; confirm GET reads still succeed.
15. Log in as a different company → confirm zero cross-company rules/runs/steps/events visible.
16. DevTools → Application → Storage → confirm no automation data in localStorage/sessionStorage/IndexedDB.

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: REMINDER_TYPES/REMINDER_SEVERITIES mirrored constants in automation.js
- Confirmed now: automation.js hardcodes a copy of reminders.js's own (unexported) REMINDER_TYPES/SEVERITIES lists, since that module exports neither as a reusable constant. Documented explicitly as a deliberate small allow-list duplication, not a logic duplication.
- Not yet confirmed: whether reminders.js's list will change independently in a future codebox without this copy being updated.
- Risk: Low — a drifted list would only cause create_reminder's validation to reject an otherwise-valid reminder_type (a false negative, not a false positive/security issue).
- Recommended next review point: if reminders.js ever exports REMINDER_TYPES/SEVERITIES as constants (matching the pattern notifications.js already uses for CATEGORIES/SEVERITIES), switch automation.js to require and reuse them directly instead of the local copy.
```

```
FOLLOW-UP NOTE
- Area: no existing module fires a trigger automatically yet
- Confirmed now: this is the explicit, spec-mandated scope of Codebox 78 — "Do not wire every module yet. This codebox builds the foundation and safe manual execution." Every rule's trigger_type is descriptive metadata; execution only ever happens via manager-initiated Test/Run Now.
- Not yet confirmed: which specific module integration point(s) a future codebox should wire first (e.g. executive-reporting.js's publish endpoint calling into evaluateAutomationRule() for any active rule with trigger_type='executive_report_published').
- Risk: None — this is a deliberate phased rollout, not an oversight.
- Recommended next review point: a future codebox (post-78) should design the actual event-firing wiring, likely starting with the highest-value trigger (executive_report_published or secretarial_integrity_critical) as a single, carefully-reviewed integration before generalizing to all 14 trigger types.
```
