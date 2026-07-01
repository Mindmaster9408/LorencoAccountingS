# Codebox 51 — Practice KPI Engine + Historical Trend Analytics

> Module: Practice Management — KPI History
> Status: Complete (migration 108 not yet applied to Supabase)
> Migration: 108
> Routes: `/api/practice/kpi-history/*`

---

## Purpose

Begins recording the Management Dashboard's (Codebox 50) KPIs over time so
partners can see trends — weekly/monthly/quarterly/annual/manual snapshots,
each a frozen copy of the dashboard's summary, alerts, partner queue, and
practice score at that point in time.

**This is NOT AI. NOT forecasting. NOT predictive analytics.** Every number
in this module is either a direct copy of a Codebox 50 computation, or a
simple deterministic delta (`current − previous`) between two snapshots.

---

## Architect Freedom — Deviations & Improvements (documented per spec's instruction)

1. **Refactored `management-dashboard.js` to expose reusable compute functions.** The spec required "call/reuse the same logic as management-dashboard... do not duplicate KPI logic if avoidable." The four route handlers (`/summary`, `/alerts`, `/partner-review`, `/practice-score`) were each split into a pure `computeX(cid)` function (no behavior change — same queries, same math, same output shape) plus a thin route wrapper that calls it and handles the HTTP response. The four functions are attached to `module.exports` so `kpi-history.js` calls them **in-process** (a plain function call, not an HTTP request back into the same server) — this is both correct per the spec's "no frontend-provided KPI values trusted" rule and avoids the overhead/fragility of a self-HTTP-call. Verified zero behavior change: `/summary`, `/alerts`, `/partner-review`, `/practice-score` still return byte-identical JSON shapes.

2. **Added a `status` column (`active`/`archived`) to `practice_kpi_snapshots`.** The spec itself suggested this as the "Preferred" option for `DELETE`: *"Add status field if needed: active / archived and archive instead of hard delete."* This was taken further than a simple soft-delete flag — it's also **load-bearing for the force-recapture flow** (see below), which is why it's called out as a deviation rather than left as an implicit assumption.

3. **The literal spec's unique guard (`company_id + source_dashboard + snapshot_type + period_key` where `period_key is not null`) was scoped to `status = 'active'` rows only.** Without this, `force=true` recapture would be impossible: archiving the old snapshot wouldn't free its `period_key` for a new one, because the unique index would still see the (now-archived) old row as occupying that slot. Scoping the index to `status = 'active'` makes "no duplicate snapshot for the same period" mean "no duplicate **active** snapshot" — an archived, superseded snapshot no longer counts, which is the only way "no duplicate" and "force recapture" can coexist without ever deleting historical data.

4. **`force=true` archives-then-inserts, never overwrites.** The spec explicitly left this as an open design choice ("create a new manual snapshot or update existing only if safer — document choice"). Overwriting an existing snapshot's `kpi_data`/`score_data`/etc. in place would silently rewrite history a partner may have already viewed or referenced — a correctness/audit violation for a module whose entire purpose is being a reliable historical record. Archiving the old row (preserving it, just marked non-canonical) and inserting a fresh row for the same period is the safer choice and was documented inline in both the migration and the router.

None of these deviations changed the objective (a reliable KPI history engine) or broke any existing module — they exist purely to make the spec's own stated preferences (reuse logic, archive don't delete, safe force-recapture) actually work together correctly.

---

## Migration 108

### `practice_kpi_snapshots`

All fields exactly as specified, plus the `status` column described above. `snapshot_type` CHECK: `daily`, `weekly`, `monthly`, `quarterly`, `annual`, `manual`. Indexes on `company_id`, `snapshot_type`, `period_key` (partial, non-null), `generated_at DESC`, `source_dashboard`, and `status`. The unique guard is a partial unique index (see deviation #3 above).

### `practice_kpi_snapshot_events`

Append-only, exactly as specified — no `status`, no updates, no deletes.

---

## Backend — `kpi-history.js`

### Endpoints (9 total, all from spec)

| Method | Route | Purpose |
|---|---|---|
| GET | `/summary` | Total/monthly/weekly/manual snapshot counts + latest date + trend direction (if ≥2 snapshots exist) |
| GET | `/` | Paginated list — filters: snapshot_type, period_from, period_to, source_dashboard, status (defaults to `active`), page, limit |
| GET | `/:id` | Single snapshot (full stored payload) |
| POST | `/capture` | Capture a new snapshot from live Management Dashboard data |
| GET | `/trends` | Chronological metric values + deltas + direction for one metric key |
| GET | `/compare` | Score/KPI/alert/partner-queue comparison between two snapshots |
| DELETE | `/:id` | Soft archive (`status = 'archived'`) |
| GET | `/:id/events` | Append-only event log |

### KPI Snapshot Logic

`POST /capture` calls `managementDashboard.computeSummary(cid)`, `.computePracticeScore(cid)`, `.computeAlerts(cid)`, `.computePartnerReview(cid)` — the exact same functions Codebox 50's live dashboard uses — and stores their return values verbatim into `kpi_data`, `score_data`, `alert_data`, `partner_queue_data`. **No KPI value is ever read from the request body.** The request body only supplies metadata: `snapshot_type`, `period_start`, `period_end`, `period_key`, `snapshot_name`, `notes`, `force`.

Duplicate guard: if `period_key` is supplied and an active snapshot already exists for `(company_id, source_dashboard, snapshot_type, period_key)`, returns 409 with `existing_snapshot_id` unless `force=true`. With `force=true`, the existing snapshot is archived (event: `kpi_snapshot_archived`, metadata `{reason: 'force_recapture'}`) and a new snapshot is captured fresh for the same period — full history preserved, nothing overwritten.

### Trend Logic — Simple Deterministic Deltas Only

`METRIC_EXTRACTORS` is the single source of truth mapping each of the 13 spec-named metric keys to a path inside a stored snapshot's `kpi_data`/`score_data`:

| Metric key | Extracted from |
|---|---|
| `overall_score` | `score_data.overall_score` |
| `quality_score`, `compliance_score`, `risk_score`, `capacity_score`, `tax_score` | `score_data.scores.*` |
| `open_risks`, `critical_risks` | `kpi_data.risk.*` |
| `open_findings` | `kpi_data.qms.open_findings` |
| `overdue_documents` | `kpi_data.document_requests.overdue` |
| `tax_review_queue` | `kpi_data.tax.ready_review` — **judgment call**: the spec named this metric but no existing field is literally called "tax review queue"; mapped to the closest confirmed concept (tax returns ready for review) |
| `overdue_reminders` | `kpi_data.reminders.overdue` |
| `capacity_overloaded_count` | `kpi_data.capacity.over_capacity_staff` |

`GET /trends` fetches all matching active snapshots ordered oldest-first, extracts the requested metric from each, and computes `delta = current − previous` and `delta_percentage` (rounded to 1 decimal, `null` when the previous value is 0 to avoid a meaningless divide-by-zero percentage) between consecutive snapshots. `trend_direction` is `up`/`down`/`flat`. **No prediction, no regression, no extrapolation — every value is a real, already-captured snapshot.**

### Compare Logic

`GET /compare?snapshot_a_id=&snapshot_b_id=` fetches both snapshots (company-scoped) and produces four comparison arrays using the same `METRIC_EXTRACTORS`:
- **Score comparison**: overall + 5 sub-scores, A vs B, delta, delta %, direction
- **KPI comparison**: the 7 non-score metric keys, same shape
- **Alert comparison**: counts per severity bucket (critical/high/overdue/blocked/needs_partner/requires_approval) plus total, A vs B, delta
- **Partner queue comparison**: totals per the 6 queue categories, A vs B, delta

### Audit Events

`practice_kpi_snapshot_events` logs all 4 spec-named event types: `kpi_snapshot_captured` (on every capture), `kpi_snapshot_archived` (on `DELETE` and on force-recapture supersession), `kpi_snapshot_compared` (logged against `snapshot_a_id`, metadata records `snapshot_b_id` — a compare action spans two snapshots but the table's `snapshot_id` is `NOT NULL` singular, so one anchor was chosen and documented), `kpi_trend_viewed` (logged against the most recent snapshot in the filtered trend result set, metadata captures the query parameters — same single-anchor reasoning; if the filter matches zero snapshots, no event is written since there's nothing to attach it to).

### Multi-Tenant Safety

Every query across all 9 endpoints is scoped to `req.companyId`. `_verifySnapshot` re-checks company ownership before every read/mutate. `computeSummary`/`computeAlerts`/`computePartnerReview`/`computePracticeScore` (reused from Codebox 50) are already fully company-scoped internally.

---

## Frontend — `kpi-history.html` + `js/kpi-history.js`

- Summary cards: total/monthly/weekly/manual snapshot counts, latest snapshot date, score trend direction (▲/▼/■)
- Capture Snapshot modal — snapshot type, period key, period start/end, name, notes; on a 409 duplicate response, shows an inline "Force Recapture" button (re-submits with `force: true`) rather than a generic error
- Snapshot list — filterable table with a per-row "Compare" checkbox (max 2 selectable) and a "Compare Selected (2)" action button
- Snapshot Detail modal — 2 tabs: **Overview** (all scores, key KPIs, alert count + first 10 labels, partner queue total, notes) and **Events** (append-only log)
- Trend Viewer — metric dropdown (all 13 spec-named keys), snapshot type filter, date range, renders a plain table: period / value / delta / direction (no chart library, per spec)
- Compare modal — 4 tables (score, KPI, alert, partner queue comparisons)
- Archive action in the detail footer (soft-delete only, per spec's preference)

### No localStorage / KV, no chart library

Zero browser storage usage. No chart library — trend and compare views are plain HTML tables with simple ▲/▼/■ direction indicators, per the spec's explicit "Do not add chart libraries" and "cards, tables, simple trend indicators... only" instruction.

---

## Management Dashboard Integration

A green "📸 Capture KPI Snapshot" link was added to the Management Dashboard's header, next to the existing "↻ Refresh" button. It navigates to `/practice/kpi-history.html?capture=1`, which `kpi-history.js` reads on load to auto-open the Capture Snapshot modal — "navigate with intent," per the spec, rather than embedding a full capture form as a second copy on the dashboard page itself (avoids duplicating capture UI across two pages).

---

## Files Created

| File | Purpose |
|---|---|
| `backend/config/migrations/108_practice_kpi_history.sql` | 2 tables + indexes + partial unique index |
| `backend/modules/practice/kpi-history.js` | Backend router — 9 endpoints |
| `backend/frontend-practice/kpi-history.html` | Frontend page |
| `backend/frontend-practice/js/kpi-history.js` | Frontend IIFE (`kpi` prefix) |
| `docs/new-app/51_kpi_history_trend_analytics.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_51_kpi_history.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/management-dashboard.js` | Refactored 4 route handlers into reusable `computeSummary`/`computeAlerts`/`computePartnerReview`/`computePracticeScore` functions, exported for Codebox 51 to reuse — zero behavior change to the existing 5 routes |
| `backend/modules/practice/index.js` | Mount KPI History router at `/kpi-history` after `/management-dashboard` |
| `backend/frontend-practice/js/layout.js` | Add "KPI History" nav entry between Management Dashboard and Profile |
| `backend/frontend-practice/management-dashboard.html` | Add "📸 Capture KPI Snapshot" link next to the Refresh button |
