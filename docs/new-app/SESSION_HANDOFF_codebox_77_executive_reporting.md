# Session Handoff — Codebox 77: Practice Executive Reporting + Board Pack Foundation

> Date: 2026-07-05
> Status: COMPLETE — migration 134 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### The hardest design constraint: assembling 14 sections without a second KPI engine

The spec's own boundary was explicit and repeated: NOT Business Intelligence, NOT Power BI, NOT AI reporting, no duplicated KPI engines. `buildExecutiveReport()` therefore never re-derives a number — it calls the same exported functions Partner Review Packs (Codebox 52) already proved out (`computeSummary()`, `computePracticeScore()`, `computeAlerts()`, `computePartnerReview()`, `computeExecutiveFeed()`), adds `buildScorecard({scorecardType:'practice'})` and `calculateProfitability()` as genuine period-scoped reuse, and — critically — never independently re-queries Risk or QMS, since `risk-register.js`/`quality-management.js` export no compute function at all; both are reused exclusively via `computeSummary().risk`/`.qms`.

### Two modules with no company-wide export got count-only queries, not new scoring

`notifications.js` and `learning-centre.js` have no company-wide summary function (`notify()` and `calculateLearningProgress()` are both per-item/per-plan). Their sections (`_notificationCounts()`, `_learningCounts()`) are plain counts against `practice_notifications`/`practice_learning_plans` — deliberately never re-deriving either module's own internal scoring formula (e.g. Partner Scorecards' `100 − overdue×10 − critical_unread×5` notification score was left untouched).

### Generation freezes; regeneration upserts, never duplicates

`report_snapshot` is written once per generate/regenerate call and never touched afterwards. Sections are the more interesting case: a unique `(report_id, section_key)` index means every regenerate **upserts** the 14 engine-sourced sections in place — refreshing their `section_snapshot` — while a manual section a partner already added (flipped to `section_status: 'manual'`) is explicitly skipped in `_upsertSections()` and never overwritten.

### Backend — `executive-reporting.js`

Full CRUD on reports/sections/decisions/actions, two report-creation paths (`POST /` for a draft-then-generate flow, `POST /generate` for Partner Review Packs' exact one-shot create+generate shape), 5 workflow transitions (generate/submit-review/approve/publish/archive) plus soft-cancel DELETE, decision/action complete + soft-cancel DELETE, and PDF/HTML export via PDFKit + a template-string HTML builder — the same pattern already used by Partner Review Packs, Tax Reports, and Billing. No second reporting engine was introduced; the HTML/PDF builder pair here is new code, not a shared module, matching the existing per-file convention (there is no central report-rendering module anywhere in this codebase to reuse).

### A gap caught and fixed mid-build: this module was originally ungated

The two closest precedents (`partner-review-packs.js`, `kpi-history.js` — Codeboxes 51/52) have **zero** manager-role gating anywhere; that "pure reporting family" treats read/generate/approve as equally open to any authenticated company user. Codebox 77's first draft followed that precedent by omission. On review, given (a) approving/publishing a board pack is a materially more governance-significant action than viewing a KPI trend line, and (b) this exact session just finished centralizing and hardening manager-role gating into `lib/team-access.js` with an explicit instruction that "no further role-gate implementations should duplicate authorization logic — always use the shared helper," leaving this module ungated would have been the same class of inconsistency just fixed elsewhere. All 20 mutating routes now call `_requireManager()` → `teamAccess.requireManager()` (confirmed by direct grep: 20 `router.post/put/delete` declarations, 20 `_requireManager()` calls). GET/list endpoints remain open, matching the operational-module family's read/write split (e.g. `client-success.js`).

### Frontend — `executive-reporting.html` + `js/executive-reporting.js` (prefix `er`)

4 top-level tabs (Reports/Decisions/Action Register/Events) plus a Report Detail modal (Overview/Sections/Decisions/Actions/Events) — Decisions and Actions each get both a company-wide top-level view (for "what's outstanding across every report") and a report-scoped view inside the detail modal (for "what came out of this specific board pack"), satisfying the spec's own "Sections: Summary, Reports, Decisions, Action Register, Events" navigation structure without duplicating the list-rendering logic (both call the same `GET /decisions` / `GET /actions` endpoints, just with/without a `report_id` filter).

### Integrations — one deliberately avoids a circular require

**Management Dashboard**: gained a new `executive_reporting` block in `computeSummary()` — but implemented as **direct count queries**, not by requiring `executive-reporting.js`. That module already requires `management-dashboard.js` for its own report engine; a reverse require would be circular. Node can usually tolerate a circular require here (neither module invokes the other's functions until request time, long after both finish loading), but direct queries — the same pattern already used for the Strategic Planning block — avoid the risk entirely rather than relying on that being safe. **Strategic Planning**: a "Create Executive Report" button on each plan review deep-links to the new page with title/type/period pre-filled via query string; Strategic Planning does not call into `executive-reporting.js` or touch its tables. **Partner Scorecards**: pure read-only reuse via `buildScorecard()`.

---

## Nothing Regressed

- `management-dashboard.js`'s `computeSummary()`, `computePracticeScore()`, `computeAlerts()`, `computePartnerReview()`, `computeExecutiveFeed()` — none modified beyond `computeSummary()` gaining one new additive `executive_reporting` key (3 more direct, cheap queries; no change to any existing key).
- `partner-scorecards.js`, `profitability.js`, `capacity.js`, `planning-board.js`, `kpi-history.js` — only their existing exported functions are called; none of their own routes or exports were touched.
- `strategic-planning.js` — the only change is one new button (`spCreateExecutiveReport()`) on the plan-review mini-card and a small `_reviewsById` cache to support it; no existing function signature changed.
- `node --check` passes on every new/modified JS file, verified individually as each was written, and again in a final sweep.
- Full router chain (`require('./modules/practice/index.js')` with dummy env vars) loads cleanly with `executive-reporting.js` mounted.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`134_practice_executive_reporting.sql`

Expected: "Success. No rows returned." No seeding step required — all five tables start empty. Migration 133 from Codebox 76 should already be live.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, a full require-graph smoke test, and grep for browser-storage violations.*

1. Apply migration 134 to Supabase.
2. Navigate to `/practice/executive-reporting.html` — should show zeroed summary cards and both governance banners.
3. Create a report (title, type=monthly, period) via "Save as Draft" → confirm it appears in the Reports list at status "Draft".
4. Open the report → click Generate → confirm status becomes "Generated", all 14 sections appear under the Sections tab, and a confidence rating shows on Overview.
5. Confirm the KPI Trends section shows `—` for every metric with a note that no snapshot exists yet (expected on a fresh database with no `practice_kpi_snapshots` rows) — then create a KPI snapshot via the existing KPI History page and regenerate the report to confirm trends populate.
6. Submit for Review → Approve → confirm `approved_by`/`approved_at` populate and the report becomes read-only (no Generate/Save Narrative buttons remain).
7. Publish → confirm `published_by`/`published_at` populate; Archive → confirm status becomes "Archived".
8. Add a decision (title, category) on a non-terminal report → confirm it appears under both the report's Decisions tab and the company-wide Decisions tab. Mark it "Implemented" → confirm `completed_at` is set.
9. Add an action linked to that decision → confirm it appears under both views; Complete it → confirm `completed_at` is set.
10. Cancel a draft report with a reason → confirm status becomes "Cancelled" and the reason is stored; confirm a cancelled report cannot be generate/edited further.
11. Click "View HTML" and "Download PDF" on a generated report → confirm both render all 14 sections, decisions, and actions without errors.
12. Go to `/practice/management-dashboard.html` → confirm the new "Executive Reporting" KPI section shows the latest report title and correct awaiting-approval/outstanding-action counts.
13. Go to `/practice/strategic-planning.html`, open a plan with a review, click "Create Executive Report" → confirm it opens Executive Reporting with title/type/period pre-filled from that review.
14. As a non-manager (a `staff`/`senior`/`viewer` team member), attempt every POST/PUT/DELETE on this module → confirm 403 on each; confirm all GET reads still succeed. As a super admin with no roster row, confirm every write still succeeds (via the `lib/team-access.js` bypass).
15. Log in as a different company → confirm zero cross-company reports/sections/decisions/actions/events visible.
16. DevTools → Application → Storage → confirm no executive-reporting data in localStorage/sessionStorage/IndexedDB.

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: manager-gating scope for the Action Register specifically
- Confirmed now: every Action Register write (create/update/complete/cancel) requires manager role, same as Decisions and Reports — chosen for consistency and simplicity across the whole module.
- Not yet confirmed: whether partners want a non-manager team member to be able to mark their OWN assigned action complete (owner_team_member_id match) without full manager rights, similar to how work-queue.js lets a non-manager act on their own queue items.
- Risk: Low — current behavior is more restrictive than it might need to be, never less. No security risk, only a possible UX friction point if action owners are frequently non-managers.
- Recommended next review point: if staff regularly need to self-report action completion, add an owner-match bypass to PUT /actions/:id/complete specifically (not to the other 19 routes).
```

```
FOLLOW-UP NOTE
- Area: KPI Trends section depends entirely on practice_kpi_snapshots existing
- Confirmed now: buildExecutiveReport() degrades gracefully (all trend values null, a warning pushed, confidence downgraded) when no snapshot exists at or before a period boundary — never an error, never a fabricated number.
- Not yet confirmed: whether partners will remember to run a KPI History snapshot capture before generating a period's executive report, or whether report generation should prompt/offer to trigger one.
- Risk: Low — purely a UX completeness question, not a correctness risk.
- Recommended next review point: if "KPI Trends always empty" becomes a common complaint, consider a one-click "capture snapshot now, then generate" convenience action on the create-report modal.
```
