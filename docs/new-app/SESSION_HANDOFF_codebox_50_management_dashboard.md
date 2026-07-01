# Session Handoff — Codebox 50: Management Dashboard (Executive Command Centre)

> Date: 2026-07-01
> Status: COMPLETE — no migration needed — not committed or pushed

---

## What Was Built

### No Migration (documented decision)

Audited every source table (via a dedicated Explore research pass covering
migrations 007, 055, 058, 061–064, 068–074, 077, 081, 088, plus Codeboxes
44–49's own tables from this session) before deciding. All KPIs are
computable from existing tables with count-only queries; no caching
justification exists at current data volume. `108_practice_management_dashboard_snapshots.sql` is documented as a future option, not built.

### Backend — `management-dashboard.js` (5 endpoints)

Key behaviours and judgment calls:

**Read-only, no audit trail:** Per spec ("Dashboard is read-only. No audit table required"), this router never writes anything — no `auditFromReq`, no event tables, no mutations of any kind. Pure `GET` aggregation.

**Capacity utilization computed in Node, not SQL:** `weekly_capacity_hours` (per team member) vs. `SUM(estimated_hours)` of their open tasks is a per-member ratio that doesn't reduce cleanly to a single SQL aggregate across the whole company, so both raw row sets are fetched in one query each and the ratio math (over-capacity count, average utilization %) happens in a small JS reduction. This is reused identically in both `/summary` and `/practice-score`.

**Risk band thresholds match the Risk Register frontend exactly:** High = `inherent_risk` 15–19, Critical = ≥20 — copied verbatim from `risk-register.js`'s own `_ratingClass` function so the dashboard and the Risk Register page never disagree about what counts as "high" vs "critical."

**Client Health — 5 enum values mapped to the spec's 3 buckets:** The spec only asked for Healthy/Watch/Critical, but the real `health_status` enum (confirmed via audit) has 5 values: `good`, `watch`, `at_risk`, `critical`, `unknown`. Mapped as `good`→Healthy, `watch`→Watch, `at_risk`+`critical`→Critical (combined), with `unknown`/null exposed as a 4th "unassessed" field for transparency rather than silently dropped.

**Compliance "Open, Blocked" — ambiguous, resolved by covering both readings:** The spec doesn't say whether this refers to compliance deadlines or compliance packs. Resolved by using deadlines for "Open" (non-terminal `practice_deadlines` rows) and compliance packs for "Blocked" (`readiness_status = 'blocked'`), since those are the two places "open" and "blocked" are meaningful concepts in the existing schema.

**Tax dispute "open" matches the dispute router's actual terminal-state logic, not a naive reading:** `practice_tax_dispute_cases` has an `accepted`/`rejected` outcome status that is NOT in that router's own `TERMINAL_STATUSES` array (only `completed`/`cancelled` are). So an accepted-but-not-yet-completed dispute still counts as "open" here — matching the actual behaviour of the dispute workflow, not just the label.

**Workflow activity omitted from the Executive Feed (documented, not guessed):** `practice_tax_pipeline_events`'s exact column names beyond `source_type` and stage values weren't confirmed during the schema audit. Rather than guess a column name and risk a runtime 500 on every dashboard load, this source was left out and flagged as a follow-up. All 9 other requested feed sources (QMS, Risk, Tax [via dispute+completion events], Client, Billing, Reminders, Communications, Knowledge, SOP) are implemented with confirmed columns.

**Partner Queue "Risk acceptance" — no explicit spec rule, so a defensible threshold was chosen:** Risks with `status='open' AND inherent_risk >= 15` (i.e., still open AND rated high-or-critical) are treated as "awaiting a partner accept/mitigate/monitor decision." Lower-rated open risks aren't surfaced in the partner queue — they don't need executive attention yet.

**Practice Score is pure deterministic arithmetic — no AI, as explicitly instructed:** Each of the 5 sub-scores starts at 100 and is reduced by fixed penalties per adverse condition (documented in full in `50_management_dashboard.md` and mirrored in the `SCORE_WEIGHTS` const + scoring block in the router itself, which is the single source of truth if weights are ever retuned). Overall score is the weighted sum matching the spec's example weighting exactly: Quality 30%, Compliance 25%, Risk 20%, Capacity 10%, Tax 15%.

**Multi-tenant:** Every one of the ~30 queries across all 5 endpoints is scoped to `req.companyId`. No exceptions.

---

### `index.js` + `layout.js`

`management-dashboard` router mounted at `/management-dashboard` after the `/risk-register` block. "Management Dashboard" nav entry added directly after the existing operational "Dashboard" link (first position after it), since it's the primary landing page partners are expected to use most.

---

### Frontend — `management-dashboard.html` + `js/management-dashboard.js` (md prefix)

- Practice Score hero: conic-gradient ring colour-graded green (≥80) / amber (≥60) / red (<60), plus 5 sub-score cards each showing value, its documented weight %, and a progress bar
- 7 KPI sections covering all 12 spec-named categories (Practice, Capacity, Tax, QMS, Risk, Client Health, Knowledge, SOP, Billing, Reminders, Document Requests, Communications, Compliance) — every card is colour-coded by a good/warn/bad threshold and clickable through to the relevant operational page
- Alerts panel, Partner Queue panel, Executive Feed panel — each with a live count badge
- Quick Actions: 9 direct links (QMS, Risk, Tax Dashboard, Capacity, Client Health, Compliance, Billing, Knowledge, SOP)
- Manual "↻ Refresh" button re-fetches all 5 endpoints in parallel
- No chart library — per spec, "Charts optional. No chart library required." The score ring is pure CSS `conic-gradient`; progress bars are plain divs

---

## Nothing Regressed

- All existing practice routers and pages: untouched — this is a purely additive read-only aggregator
- Paytime: not touched
- No `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` in any new file (confirmed via grep — zero matches)
- `node --check` passes on `management-dashboard.js` (backend), `js/management-dashboard.js` (frontend), and the two modified files (`index.js`, `layout.js`)
- Every file verified present on disk via `ls` immediately after writing

---

## Nothing to Apply

No migration was created, so there's nothing to run in Supabase for this codebox. The dashboard works immediately against the existing schema (assuming migrations 054–107 are already applied, which the task's stated assumption confirms for 107).

---

## Testing Required

*None of the following has been browser-tested. All verification was code-review, `node --check`, and grep for browser-storage violations only.*

1. Navigate to `/practice/management-dashboard.html` — confirm the Practice Score ring renders with a value and colour
2. Confirm all 7 KPI sections populate with numbers (zeros are fine on an empty practice — confirm no errors/blank sections)
3. Confirm the Alerts panel shows a count and lists items when critical/high/overdue/blocked/needs-partner/requires-approval conditions exist (create a critical risk or failed QMS review to test)
4. Confirm the Partner Queue shows items when a Knowledge article or SOP is `under_review`, or a tax completion pack is `review_pending`
5. Confirm the Executive Feed shows recent activity from at least Knowledge, SOP, QMS, and Risk (the modules with confirmed event tables)
6. Click each Quick Action link — confirm it navigates to the correct existing page
7. Click a KPI card — confirm it navigates to the relevant operational page
8. Log in as a different company — confirm all KPIs, alerts, queue, and feed are company-isolated (zero cross-company data)
9. DevTools → Application → Storage — confirm no dashboard data in localStorage/sessionStorage/IndexedDB
10. Manually verify the Practice Score math against the documented formula for a known test scenario (e.g., 1 failed QMS review + 1 critical risk + 0 everything else should produce Quality=85, Risk=85, others=100, Overall = 85×0.30 + 100×0.25 + 85×0.20 + 100×0.10 + 100×0.15 = 94)

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Executive Feed — "Workflow" source omitted
- Confirmed now: practice_tax_pipeline_events exists (migration 088) with source_type and stage enum values confirmed, but its exact non-enum column names (timestamps, notes, actor) were not confirmed during the schema audit
- Not yet: Workflow activity does not appear in the executive feed
- Risk: Low — 9 of the 10 requested feed sources are implemented; Workflow is the only gap, and it's clearly documented rather than silently missing
- Recommended next check: Read 088_practice_tax_filing_pipeline.sql directly (or the tax-pipeline.js router) to confirm practice_tax_pipeline_events' exact column names, then add it as a 10th feed source
```

```
FOLLOW-UP NOTE
- Area: No caching / snapshot table
- Confirmed now: All 5 endpoints run live count-only queries every request; no snapshot table exists
- Not yet: Performance has not been measured against production data volumes
- Risk: Low today — but if a practice's practice_tasks, practice_quality_findings, etc. grow into the thousands of rows, the ~30 parallel count queries per /summary or /practice-score call could become noticeable
- Recommended: If dashboard load times become a concern, build 108_practice_management_dashboard_snapshots.sql as a periodic (e.g. hourly) cache of the /summary and /practice-score payloads, with the live endpoints as a manual "force refresh" fallback
```

```
FOLLOW-UP NOTE
- Area: Practice Score weighting is a starting point, not validated against real practice data
- Confirmed now: Weights (Quality 30%, Compliance 25%, Risk 20%, Capacity 10%, Tax 15%) and per-condition penalties match the spec's example exactly and are documented in one place (SCORE_WEIGHTS const + scoring block in management-dashboard.js)
- Not yet: No partner has reviewed whether these penalty magnitudes produce sensible real-world scores (e.g., does 1 critical risk really justify a 15-point Risk deduction, or should it be steeper?)
- Risk: Low — purely cosmetic/interpretive risk, not a data integrity issue; scores are informational only, nothing depends on them being "correct"
- Recommended: After a few weeks of real use, ask the partners whether the Practice Score "feels right" against their own intuition, and retune the constants in one place if not
```

```
FOLLOW-UP NOTE
- Area: Client Health — 5-value enum compressed to spec's 3-bucket request
- Confirmed now: good→Healthy, watch→Watch, at_risk+critical→Critical, unknown/null→separate "unassessed" field
- Not yet: No practice confirmation that combining at_risk and critical into one "Critical" bucket is the right call (they may want them separated)
- Risk: Low — the underlying data isn't lost, just combined for the dashboard's simplified 3-bucket view (the Client Health page itself still shows the full 5-value breakdown)
- Recommended: If partners want at_risk and critical shown separately on the dashboard, split the "Critical" KPI card into two
```
