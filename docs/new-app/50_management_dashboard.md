# Codebox 50 — Management Dashboard (Executive Command Centre)

> Module: Practice Management — Management Dashboard
> Status: Complete
> Migration: **None** (see decision below)
> Routes: `/api/practice/management-dashboard/*`

---

## Purpose

The executive command centre for partners — **not an operational page**. It
aggregates read-only KPIs, alerts, a partner approval queue, an activity
feed, and a deterministic weighted "Practice Score" from every existing
practice module in one place.

---

## Migration Decision — No Migration Created

The spec required "NO NEW TABLES unless absolutely necessary" and offered an
**optional** snapshot table only "if justified." After auditing all source
tables (via a research pass across migrations 007, 055, 058, 061–064,
068–074, 077, 081, 088, and Codeboxes 44–49's own tables), the decision is:
**no migration.**

Every dashboard endpoint runs 15–25 small, indexed, company-scoped
`COUNT`-only queries (`head: true` — no row bodies fetched) in parallel via
`Promise.all`. At the data volume expected for a single accounting practice
(tens to low-hundreds of rows per table), this is expected to resolve in
well under a second with no caching. A snapshot table would add write
complexity (a refresh job, staleness windows, cache-invalidation logic) for
a problem that doesn't exist yet.

**Revisit if:** practice data volume grows into the thousands of rows per
table, or the dashboard is loaded so frequently that the aggregate query
load becomes measurable on the database. At that point, `108_practice_management_dashboard_snapshots.sql` (a periodic snapshot of the `/summary` and `/practice-score` payloads) would be the natural next step — documented here as a follow-up, not built.

---

## Backend — `management-dashboard.js`

### Endpoints (5, exactly as specified)

| Method | Route | Purpose |
|---|---|---|
| GET | `/summary` | Executive KPIs across 12 module groups |
| GET | `/executive-feed` | Merged recent activity, newest first |
| GET | `/alerts` | Critical / high / overdue / blocked / needs-partner / requires-approval only |
| GET | `/partner-review` | Everything currently waiting on a partner decision |
| GET | `/practice-score` | Deterministic weighted score (no AI) |

### KPI Logic — Source Tables & Definitions

All confirmed via direct migration/router audit (not guessed):

| Group | Metric | Query |
|---|---|---|
| Practice | Active Clients / Staff | `practice_clients` / `practice_team_members` WHERE `is_active = true` |
| Practice | Open / Overdue Tasks | `practice_tasks` status IN (open, in_progress); overdue adds `due_date < today` |
| Capacity | Over-Capacity Staff, Avg Utilization | `practice_team_members.weekly_capacity_hours` vs SUM(`practice_tasks.estimated_hours`) for open tasks per `assigned_to` — computed in Node, not SQL, since it's a per-member ratio |
| Tax | Open Returns | `practice_individual_tax_returns` + `practice_company_tax_returns` NOT IN (completed, cancelled) |
| Tax | Ready Review / Ready Submit | `status = 'ready_for_review'` / `filing_stage = 'ready_to_submit'` (exact enum values from both tables) |
| Tax | Pipeline | Both return tables, `filing_stage` NOT IN (completed, cancelled) |
| Tax | Payments Outstanding | `practice_tax_payments` direction=payable, status IN (outstanding, partially_paid) |
| Tax | SARS Recon | `practice_sars_statement_lines` reconciliation_status IN (unmatched, disputed) |
| Tax | Open Disputes | `practice_tax_dispute_cases` case_status NOT IN (completed, cancelled) — matches the router's own `TERMINAL_STATUSES`, so `accepted`/`rejected` still count as open until formally completed |
| Tax | Completion Packs | `practice_tax_completion_packs` pack_status NOT IN (completed, cancelled) |
| QMS | Reviews / Failed / Needs Correction | `practice_quality_reviews` status counts |
| QMS | Open / Critical / High Findings | `practice_quality_findings` status IN (open, in_progress), by severity |
| Risk | Open / High / Critical | `practice_risks` — High = inherent_risk 15–19, Critical = inherent_risk ≥ 20 (matches the Risk Register frontend's own rating bands exactly) |
| Client Health | Healthy/Watch/Critical/Unknown | `practice_clients.health_status`: `good`→Healthy, `watch`→Watch, `at_risk`+`critical`→Critical (spec only asked for 3 buckets; the real enum has 5 — `unknown`/null exposed as a 4th transparency field, documented as a judgment call) |
| Knowledge / SOP | Draft/Under Review/Approved | Direct status counts, exact match to those modules' enums |
| Billing | Draft/Locked Packs, Realisation | `practice_billing_packs.status`; realisation = SUM(billable_value)/SUM(recoverable_value) over non-cancelled packs |
| Reminders | Overdue/Upcoming | `practice_reminders` status IN (open, snoozed); overdue = `due_date < today`, upcoming = next 7 days |
| Document Requests | Outstanding/Overdue | `practice_document_requests.request_status` IN (requested, reminder_sent, partially_received); overdue adds `required_by_date < today` |
| Communications | Unread Follow-ups | `practice_client_communications` response_required=true AND response_status IN (waiting, overdue) AND not cancelled |
| Compliance | Open/Blocked | Open = `practice_deadlines` non-terminal statuses; Blocked = `practice_compliance_packs.readiness_status = 'blocked'` — spec's "Compliance: Open, Blocked" is ambiguous between deadlines and packs, so both are covered under the one label pair (documented judgment call) |

### Practice Score Logic — Documented Weighting

```
Overall = Quality×0.30 + Compliance×0.25 + Risk×0.20 + Capacity×0.10 + Tax×0.15
```

Each sub-score starts at 100 and is reduced by fixed, documented penalties
(all in the `SCORE_WEIGHTS` const and the scoring block in `management-dashboard.js` — the single source of truth if weights are retuned):

| Sub-score | Penalty per unit |
|---|---|
| Quality | −15/failed review, −10/critical finding, −5/high finding, −2/medium finding, −1/low finding |
| Compliance | −8/overdue deadline, −10/blocked compliance pack, −15/missed deadline |
| Risk | −15/critical risk, −8/high risk, −2/other open risk |
| Capacity | −20/over-capacity staff member, −0.5 per point of average utilization over 100% |
| Tax | −3/outstanding payable payment, −2/unmatched SARS line, −5/open dispute |

All sub-scores clamped to 0–100. **No AI — pure arithmetic**, matching the spec's explicit "Do NOT use AI" instruction.

### Partner Queue Logic

Pulls exactly the 6 categories named in the spec: Knowledge articles `status='under_review'`, SOPs `status='under_review'`, Tax completion packs `pack_status='review_pending'`, QMS reviews `status='in_review'`, Risks `status='open' AND inherent_risk >= 15` (a "significant risk still awaiting a partner accept/mitigate/monitor decision" — judgment call since the spec named "Risk acceptance" without a precise status rule), and Billing packs `status='reviewed'` (submitted for approval, not yet approved/locked).

### Executive Feed Logic

Merges from every module that has a dedicated append-only event log (`practice_quality_events`, `practice_risk_events`, `practice_tax_dispute_events`, `practice_tax_completion_events`, `practice_knowledge_events`, `practice_sop_events`) plus recency-sorted rows from modules without one (`practice_client_communications`, `practice_reminders`, `practice_billing_packs.updated_at`, `practice_client_health_snapshots.calculated_at`), then sorts the merged list newest-first in Node and truncates to the requested limit.

**"Workflow" activity is intentionally omitted** — `practice_tax_pipeline_events`'s exact column shape wasn't confirmed during the audit, and guessing column names risked a runtime 500. Documented as a follow-up rather than guessed.

### Multi-Tenant Safety

Every query — all ~30 across the 5 endpoints — is scoped to `req.companyId`. No query in this router ever omits the `company_id` filter.

---

## Frontend — `management-dashboard.html` + `js/management-dashboard.js`

- **Practice Score hero**: a conic-gradient ring (colour-graded green/amber/red by score) plus 5 sub-score cards showing value, documented weight %, and a mini progress bar
- **KPI grid**, grouped into 7 sections (Practice & Capacity, Tax, Quality, Risk, Client Health, Knowledge & SOP, Billing/Reminders/Compliance) — each card colour-coded (good/warn/bad) by threshold and clickable through to the relevant operational page
- **Alerts panel** — severity-pilled list (critical/high/overdue/blocked/needs_partner/requires_approval)
- **Partner Queue panel** — grouped by category with a source tag
- **Executive Feed panel** — chronological merged activity with a source tag
- **Quick Actions** — direct links to QMS, Risk, Tax Dashboard, Capacity, Client Health, Compliance, Billing, Knowledge, SOP
- Manual "↻ Refresh" button re-fetches all 5 endpoints

### No localStorage / KV

Zero browser storage usage. `node --check` passed on both new JS files. This dashboard is entirely read-only — no audit table needed (per spec).

---

## Files Created

| File | Purpose |
|---|---|
| `backend/modules/practice/management-dashboard.js` | Backend router — 5 endpoints |
| `backend/frontend-practice/management-dashboard.html` | Frontend page |
| `backend/frontend-practice/js/management-dashboard.js` | Frontend IIFE (`md` prefix) |
| `docs/new-app/50_management_dashboard.md` | This doc |
| `docs/new-app/SESSION_HANDOFF_codebox_50_management_dashboard.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Mount dashboard router at `/management-dashboard` after `/risk-register` |
| `backend/frontend-practice/js/layout.js` | Add "Management Dashboard" nav entry, placed right after "Dashboard" |
