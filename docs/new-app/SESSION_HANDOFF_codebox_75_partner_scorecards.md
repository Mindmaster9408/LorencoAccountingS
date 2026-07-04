# Session Handoff — Codebox 75: Practice Partner Performance + Practice Scorecards

> Date: 2026-07-04
> Status: COMPLETE — migration 132 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### An audit interrupted mid-flight, then completed directly

A background research agent was dispatched to map every existing KPI source (Management Dashboard, KPI History, Capacity, Quality, Risk, Client Success, Learning, Skills Matrix, Planning Board, Notifications) before any scoring formula was written — per the spec's explicit "no duplicate KPI calculations" requirement. That agent hit a session limit partway through and returned only partial findings. Rather than proceed on an incomplete picture, the remaining audit (quality/risk/learning/notification table columns, `capacity.js`/`skills-matrix.js`/`planning-board.js` export shapes) was completed directly via targeted reads and greps before writing the migration or the engine. One real correction came out of this: `practice_notifications`'s terminal-status list is `completed`/`archived`/`cancelled`, not the `read`/`resolved`/`dismissed` initially assumed — caught by re-checking `notifications.js`'s own `TERMINAL_STATUSES` constant before finalizing the notification component's formula.

### The single biggest design decision: `computePracticeScore()` already exists

Codebox 50 (Management Dashboard) already implements a practice-wide deterministic weighted-penalty score across quality/compliance/risk/capacity/tax. This codebox's entire design center is: reuse those exact penalty formulas, but make them **scopable to one team member's owned work** (via the ownership columns confirmed during the audit) instead of only ever being practice-wide. Nine components in total — the five `computePracticeScore()` already covers (recombined as quality/risk/capacity) plus four new ones (profitability, client success, engagement, learning, planning, notifications) built the same way: read the source table directly, apply the same style of penalty arithmetic, never recompute a number some other module already owns.

### Never fabricate a score for data that doesn't exist

This was the hardest constraint to get right. A partner who owns zero clients cannot have a meaningful "profitability score" — not 0 (implies terrible), not 100 (implies perfect), just genuinely undefined. Every component therefore returns `score: null` with `confidence: 'none'` and a warning when its underlying scope is empty (zero owned clients/engagements). The overall score is then a weighted average of only the components that DID return a number, with weights re-normalized to sum to 1 among those — documented explicitly since the spec's own weighting example implicitly assumes all nine are always present.

A second, subtler distinction: components scoped to a person's own conduct (quality, risk, learning, planning, notifications) behave differently from portfolio-scoped ones. Zero quality findings attributed to someone could genuinely mean "no problems" — so those default to 100, but with `confidence: 'low'` and a warning, so a reviewer never mistakes "we have no data" for "this person is flawless."

### Backend — `partner-scorecards.js`

`buildScorecard()` resolves scope (one team_member_id for partner/manager, a department-matched list for team, null for practice) then runs all nine component functions in parallel. Snapshots are immutable once created (`DELETE` → 405), matching the Profitability precedent from Codebox 73. The review workflow reuses Profitability's exact `review_status` enum and `TRANSITIONS`-map pattern rather than inventing a new one.

### Frontend — `partner-scorecards.html` + `js/partner-scorecards.js` (prefix `psc`)

Six tabs (Practice/Partners/Managers/Teams/History/Reviews). The first four share one compute-panel skeleton (scope picker + period + Calculate + component breakdown showing source/formula/weight/confidence for every component + Save Snapshot) — a deliberate implementation consolidation, same precedent as Profitability's Analysis tab.

### Integrations — three, all read-only

**Management Dashboard**: a new KPI section (latest practice score, total snapshots, lowest score needing review). **Planning Board**: an optional "📉 Needs Support" badge on the existing per-member team board when a saved scorecard scores below 60. **Client Success**: a read-only section showing the responsible team member's most recent saved scorecard — Client Success performs zero new calculation, exactly as the spec required ("Read-only reuse. No new calculations.").

---

## Nothing Regressed

- `management-dashboard.js`'s `computePracticeScore()`, `computeSummary()`, `computeAlerts()`, `computePartnerReview()`, `computeExecutiveFeed()` — none modified beyond `computeSummary()` gaining one new additive `partner_scorecards` key.
- `capacity.js`, `skills-matrix.js`, `planning-board.js` — only their existing exported functions (`buildTeamCapacity`, `getCompetency`, `buildTeamItemPool`) are called; nothing in those files was changed except `planning-board.js`'s own additive `GET /team` fields.
- `client-success.js` — the existing `Promise.all` fetch chain, its five original entries, and `_renderClientDetail()`'s existing sections are all unchanged; the new section and its loader are purely additive.
- `node --check` passes on every new/modified JS file, verified individually as each was written.
- One bug caught and fixed during self-review before finalizing: the notification component's terminal-status filter initially used an assumed (`read`/`resolved`/`dismissed`) list that doesn't match `notifications.js`'s actual `TERMINAL_STATUSES` (`completed`/`archived`/`cancelled`) — corrected immediately upon re-checking the source file, before this handoff was written.
- A second bug caught and fixed during the Client Success integration: the new "Responsible Team Member Performance" placeholder div would have been stuck on "Loading…" forever for any client with no `responsible_team_member_id` set — fixed by explicitly handling that case rather than silently leaving the fetch un-triggered.
- Full router chain (`require('./modules/practice/index.js')` with dummy env vars) loads cleanly with `partner-scorecards.js` mounted.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`132_practice_partner_scorecards.sql`

Expected: "Success. No rows returned." No seeding step required — all three tables start empty.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migration 132 to Supabase (migration 131 from Codebox 74 should already be live).
2. Navigate to `/practice/partner-scorecards.html` — should show zeroed summary cards and both governance banners.
3. On the Practice tab, set a period and click Calculate → confirm an overall score and all 9 component cards render with source/formula/weight/confidence; confirm any component with zero underlying data shows `null`/`none` rather than a fabricated number.
4. Click Save Snapshot → confirm it appears on the History tab.
5. On the Partners tab, pick a partner with owned clients that have saved Profitability snapshots → Calculate → confirm the profitability component shows a real score and reasonable confidence.
6. On the Teams tab, confirm the team picker is populated from actual `department` values in use; Calculate for one → confirm scores aggregate across that department's members.
7. Open a saved snapshot from History → confirm the full component breakdown renders identically to the live calculation.
8. Attempt `DELETE /snapshots/:id` directly → confirm 405, never actually deletes.
9. Create an Executive Review from a snapshot detail → walk it through Submit → Complete → Mark Action Required → Accept → Archive, confirming each transition writes an event.
10. Go to `/practice/management-dashboard.html` → confirm the new "Partner Scorecards" KPI section shows the latest practice score and lowest-scoring snapshot matching the Partner Scorecards page.
11. Go to `/practice/planning-board.html`'s team view for a member with a saved scorecard below 60 → confirm the "📉 Needs Support" badge appears.
12. Go to `/practice/client-success.html`, open a client with a responsible team member who has a saved scorecard → confirm the "Responsible Team Member Performance" section shows it; open a client with no responsible team member → confirm it shows the "no responsible team member" empty state instead of hanging on "Loading…".
13. As a non-manager, attempt to save a snapshot or create/action a review → confirm 403 on each; confirm all `GET`/ad-hoc-compute reads still succeed.
14. Log in as a different company → confirm zero cross-company scorecards/reviews/events visible.
15. DevTools → Application → Storage → confirm no scorecard data in localStorage/sessionStorage/IndexedDB.

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: "team" scorecards group by practice_team_members.department, a plain string column with no validation or canonical list
- Confirmed now: GET /team-keys returns the distinct department values actually in use, so the frontend picker never guesses a string. team_key is stored as-is on the scorecard row.
- Not yet confirmed: Whether the practice wants a proper teams/departments table with a stable ID (rather than a free-text string) if department naming ever needs to be renamed without orphaning historical scorecards.
- Risk: Low today — department values are already used elsewhere in this codebase as a plain string (Codebox 15's original team member profile). Would only become a real risk if departments are renamed frequently.
- Recommended next review point: If a dedicated teams/departments table is ever introduced, migrate team_key to reference it and backfill existing scorecard rows.
```

```
FOLLOW-UP NOTE
- Area: personal-conduct-scoped components (quality/risk/learning/planning/notifications) default to a score of 100 with confidence:'low' when zero rows are attributed to that team member
- Confirmed now: This mirrors computePracticeScore()'s own existing behavior (Codebox 50) — absence of negative signals contributes to a good score, practice-wide. This codebox carries that same convention forward per-member, with the difference that a "low confidence" flag and warning always accompany a zero-attribution 100, so it's never silently mistaken for "definitely fine."
- Not yet confirmed: Whether partners would prefer these components to return null (like the portfolio-scoped ones) when zero rows are attributed, rather than defaulting to 100-with-a-caveat.
- Risk: Low — the confidence/warning fields make the caveat visible in every rendered view (compute panel, saved snapshot detail); no silent misrepresentation.
- Recommended: No action needed unless partners specifically request these components behave like the portfolio-scoped ones (null instead of 100-with-caveat) when data is absent.
```
