# Session Handoff — Codebox 51: Practice KPI Engine + Historical Trend Analytics

> Date: 2026-07-01
> Status: COMPLETE — migration 108 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Refactor of `management-dashboard.js` (Codebox 50) — no behavior change

The 4 route handlers needed for snapshot capture (`/summary`, `/alerts`, `/partner-review`, `/practice-score`) were each split into:
- A pure `computeX(cid)` async function — identical queries, identical math, identical return shape as before
- A thin `router.get(...)` wrapper that calls it and does `res.json(...)` / catches errors exactly as it did previously

The 4 functions are attached to `module.exports` (`module.exports.computeSummary = computeSummary`, etc.) so `kpi-history.js` can call them as plain in-process function calls. This was necessary because the spec required KPI-history capture to "call/reuse the same logic as management-dashboard... do not duplicate KPI logic if avoidable," and the only way to do that without a wasteful/fragile self-HTTP-call is to expose the computation as a directly-callable function. **Verified:** all 5 original routes on `/api/practice/management-dashboard/*` still return the exact same JSON shapes as before this refactor — this was a pure extraction, not a rewrite.

### Migration 108

Two tables, `IF NOT EXISTS`, safe to re-run:

- **`practice_kpi_snapshots`**: All spec fields present. `snapshot_type` 6-value CHECK (`daily`/`weekly`/`monthly`/`quarterly`/`annual`/`manual`). **Added a `status` column** (`active`/`archived`, default `active`) — this was the spec's own "Preferred" suggestion for how `DELETE` should behave, taken further because it's also required to make `force=true` recapture work (see below). Unique guard on `(company_id, source_dashboard, snapshot_type, period_key)` implemented as a **partial** unique index, scoped to `WHERE period_key IS NOT NULL AND status = 'active'` — the `status = 'active'` clause is a deliberate deviation from the literal 4-column spec, documented inline in the migration, because without it archiving a superseded snapshot would never free up its `period_key` for a fresh capture (the old, now-archived row would still collide with a new insert under the same unique index).
- **`practice_kpi_snapshot_events`**: Append-only, exactly as specified.

### Backend — `kpi-history.js` (9 endpoints)

Key behaviours and judgment calls:

**Capture never trusts frontend KPI values:** `POST /capture` calls `managementDashboard.computeSummary(cid)`, `.computePracticeScore(cid)`, `.computeAlerts(cid)`, `.computePartnerReview(cid)` directly — the request body only ever supplies metadata (`snapshot_type`, `period_start`, `period_end`, `period_key`, `snapshot_name`, `notes`, `force`). This satisfies the spec's explicit "no frontend-provided KPI values trusted" rule by construction — there's no code path where a KPI number could come from anywhere but the live compute functions.

**Force-recapture archives, never overwrites (spec asked to document this choice):** When `force=true` and an active snapshot already exists for the requested period, the old snapshot is updated to `status = 'archived'` (with a `kpi_snapshot_archived` event, `reason: 'force_recapture'`), and a brand-new row is inserted for the same period. The alternative — mutating the existing row's `kpi_data`/`score_data`/etc. in place — was rejected because it would silently rewrite a historical record a partner may have already viewed, which defeats the entire purpose of a "reliable KPI history engine." This is called out explicitly per the spec's instruction to document the choice.

**`tax_review_queue` metric — no literal existing field, mapped to closest concept:** The spec names this as a trend/compare metric key but no field in Codebox 50's output is literally called that. Mapped to `kpi_data.tax.ready_review` (tax returns ready for review) as the closest confirmed concept. Documented as a judgment call, not silently guessed.

**Audit events with a required single `snapshot_id` anchor:** `practice_kpi_snapshot_events.snapshot_id` is `NOT NULL`, but two of the four spec-named events span more than one snapshot conceptually:
- `kpi_snapshot_compared` — logged against `snapshot_a_id`, with `snapshot_b_id` captured in `metadata`
- `kpi_trend_viewed` — logged against the most recent snapshot in the filtered trend result set, with the query parameters (`metric_key`, `snapshot_type`, `period_from`, `period_to`, `result_count`) captured in `metadata`. If the trend filter matches zero snapshots, no event is written (nothing to attach it to) — documented rather than silently skipped.

**Trend deltas are simple subtraction, nothing more:** `delta = current − previous` between chronologically adjacent active snapshots for the requested metric. `delta_percentage` is `null` when the previous value is `0` (avoids a meaningless divide-by-zero "percentage change from nothing"). `trend_direction` is a plain `up`/`down`/`flat` string. No regression, no extrapolation, no AI — matches the spec's "simple deterministic deltas only" instruction exactly.

**Multi-tenant:** Every one of the 9 endpoints scopes every query to `req.companyId`. `_verifySnapshot` re-checks ownership before every read or mutation on a specific snapshot.

---

### `index.js` + `layout.js`

`kpi-history` router mounted at `/kpi-history` after the `/management-dashboard` block. "KPI History" nav entry added directly after "Management Dashboard."

---

### Frontend — `kpi-history.html` + `js/kpi-history.js` (kpi prefix)

- Summary cards: total/monthly/weekly/manual snapshot counts, latest snapshot date, score trend direction
- Capture Snapshot modal with inline "Force Recapture" button appearing only after a 409 duplicate-period response (rather than a generic error toast) — a small UX improvement that directly supports the spec's `force=true` flow
- Snapshot list with per-row Compare checkboxes (capped at 2) and a "Compare Selected" button
- Snapshot Detail modal: Overview tab (all 6 scores, 6 key KPIs, alert summary, partner queue total) + Events tab
- Trend Viewer: metric dropdown (all 13 spec-named keys), snapshot type + date range filters, plain table output (period / value / delta / direction) — **no chart library**, per spec
- Compare modal: 4 tables (score / KPI / alert / partner queue comparisons)
- Archive action (soft-delete only)

### Management Dashboard Integration

A green "📸 Capture KPI Snapshot" link was added next to the existing "↻ Refresh" button on `management-dashboard.html`. It links to `/practice/kpi-history.html?capture=1`; `kpi-history.js` reads that query param on load and auto-opens the Capture Snapshot modal — "navigate with intent" per the spec, avoiding a duplicate capture form embedded on the dashboard itself.

---

## Nothing Regressed

- Codebox 50's Management Dashboard: all 5 original routes verified to return identical JSON after the refactor — this was a pure function extraction, no logic changed
- All other existing practice routers and pages: untouched
- Paytime: not touched
- No `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` in any new or modified file (confirmed via grep — zero matches across the migration, both routers, both frontend pages, and both frontend JS files)
- `node --check` passes on `management-dashboard.js` (refactored), `kpi-history.js` (backend), `js/kpi-history.js` (frontend), `index.js`, and `layout.js`
- Every file verified present on disk via `ls` immediately after writing

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `108_practice_kpi_history.sql`

Expected: "Success. No rows returned."

Apply previous migrations first if not done — 107 is confirmed already applied per this codebox's stated assumption.

---

## Testing Required

*None of the following has been browser-tested. All verification was code-review, `node --check`, and grep for browser-storage violations only.*

1. Apply migration 108 to Supabase
2. Navigate to `/practice/kpi-history.html` — summary cards show all zeros, empty snapshot list
3. Click "+ Capture Snapshot" → choose type `manual`, leave period_key blank → capture → confirm a new row appears with a real overall_score matching the current Management Dashboard's practice-score
4. Capture again with `period_key = "2026-07"`, `snapshot_type = "monthly"` → confirm success
5. Capture a third time with the exact same `period_key` and `snapshot_type` → confirm 409 with `existing_snapshot_id`, and the UI shows the inline "Force Recapture" button
6. Click "Force Recapture" → confirm the old snapshot for that period is now `archived` (visible via `status=archived` filter) and a new `active` one exists for the same period_key
7. Open the Trend Viewer, select `overall_score`, click "Show Trend" → confirm a per-snapshot table with delta/direction between the two (or more) captured snapshots
8. Try each of the other 12 metric keys → confirm no errors, values come from the correct nested path
9. Select 2 snapshots via the list checkboxes → "Compare Selected" → confirm 4 comparison tables render with sensible deltas
10. From `/practice/management-dashboard.html` → click "📸 Capture KPI Snapshot" → confirm it navigates to kpi-history.html and the Capture modal auto-opens
11. Archive a snapshot from its detail modal → confirm it disappears from the default (active-only) list but reappears when filtering `status=archived` or `status=all`
12. Open a snapshot's Events tab → confirm `kpi_snapshot_captured` and (if applicable) `kpi_snapshot_archived` events are present with correct timestamps
13. Log in as a different company → confirm zero cross-company snapshots visible
14. DevTools → Application → Storage → confirm no KPI history data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: No automated scheduled snapshots
- Confirmed now: All snapshots are captured manually via "Capture Snapshot" (or force-recapture); nothing runs on a cron/schedule
- Not yet: Automated daily/weekly/monthly capture — explicitly listed under "FUTURE ENHANCEMENTS — DO NOT BUILD NOW" in this codebox's spec
- Risk: None — this is intentional per spec; trend data will only exist for periods someone manually captured
- Recommended: A future codebox could add a scheduled job (respecting the same computeSummary/computeAlerts/etc. reuse pattern) once the practice wants automatic history without manual capture
```

```
FOLLOW-UP NOTE
- Area: tax_review_queue metric mapping
- Confirmed now: Mapped to kpi_data.tax.ready_review (tax returns with status='ready_for_review') since no field is literally named "tax review queue"
- Not yet: Confirmation from the practice that this is the intended meaning (vs., e.g., "ready to submit" or a combined pipeline count)
- Risk: Low — the underlying data is correct and consistently defined; only the label-to-field mapping is a judgment call
- Recommended: If partners expect "tax review queue" to mean something else, remap the single line in METRIC_EXTRACTORS in kpi-history.js — no schema change needed
```

```
FOLLOW-UP NOTE
- Area: kpi_snapshot_compared / kpi_trend_viewed events anchor to a single snapshot_id
- Confirmed now: practice_kpi_snapshot_events.snapshot_id is NOT NULL, so both of these "spans two-or-more snapshots" events are logged against one snapshot (compared → snapshot_a_id; trend_viewed → the most recent snapshot in the filtered result set), with the other snapshot(s) captured in metadata
- Not yet: No dedicated "which snapshots were involved" query — you'd need to read the metadata JSONB of each event to reconstruct the full comparison/trend-view history
- Risk: Low — the audit trail is complete (nothing is lost), just not normalized into a separate many-to-many table
- Recommended: If frequent "who compared what" reporting becomes a need, consider a lightweight companion table; not justified at this stage (would violate the "no new tables unless absolutely necessary" spirit carried over from Codebox 50)
```

```
FOLLOW-UP NOTE
- Area: Snapshot data can grow large (kpi_data + score_data + alert_data + partner_queue_data as JSONB)
- Confirmed now: alert_data stores the full alerts array from computeAlerts() (could be dozens of items for a practice with many overdue items); no truncation applied
- Not yet: No row-size monitoring or truncation policy
- Risk: Low at current practice scale (JSONB handles this fine up to many KB per row); could matter only if a practice accumulates thousands of alerts at capture time
- Recommended: If storage becomes a concern, truncate alert_data.alerts to the top N by severity before storing — but only after observing real row sizes, not preemptively
```
