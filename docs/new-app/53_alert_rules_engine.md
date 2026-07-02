# Codebox 53 — Practice Alert Rules Engine + Manual Alert Configuration

> App: Lorenco Practice Management
> Status: Complete — migration 110 not yet applied to Supabase — nothing committed or pushed

## Purpose

Every module in the practice (Risk, Tax, Capacity, QMS, Client Health, Compliance, Documents, Reminders, Communications, Knowledge, SOP, Billing) independently decided when something was "red" — hardcoded numbers scattered across the codebase. This codebox creates ONE central Alert Rules Engine so partners/practice managers can configure those thresholds without touching code.

**NOT AI. NOT automatic threshold tuning. NOT machine learning.** Deterministic, database-driven configuration only.

## Architect Freedom — Scope Decisions & Deviations

1. **Comprehensive seeding, scoped wiring.** All 28 thresholds identified in the pre-build audit are seeded as rows across all 12 required groups (Risk, Tax, Capacity, QMS, Client Health, Compliance, Documents, Reminders, Communications, Knowledge, SOP, Billing) — giving partners full administrative visibility today. Actual code integration (`getRule()`/`getRules()` calls replacing hardcoded numbers) is scoped to **`management-dashboard.js` only** — the one true central "alerts" aggregator this codebox's own WHY section describes. The spec's Architecture Boundaries section states explicitly that Risk, QMS, Tax, Capacity, Compliance, Documents, and Reminders "remain owners of their data" and that "the Rules Engine only supplies thresholds" — this is read as permission to leave those modules' own internal logic (risk-register.js's own risk banding, capacity.js's own utilization function, client-health.js's own score bands, etc.) untouched, while still seeding their thresholds for future adoption. Each seeded rule's `settings.wired` flag (`true`/`false`) and `settings.maps_to` string tell the admin UI — and any future engineer — exactly which rules are live in code today versus informational-only. This kept regression risk bounded to one already-well-understood file (refactored twice before, in Codebox 51 and 52) instead of eight.
2. **8 rules wired into `management-dashboard.js`:** `risk_high_min`, `risk_critical_min`, `risk_partner_acceptance_min`, `capacity_overloaded_ratio`, `compliance_deadline_overdue_grace_days`, `document_overdue_grace_days`, `reminder_overdue_grace_days`, `reminder_upcoming_window_days` — these are consumed in `computeSummary`, `computeAlerts`, `computePartnerReview`, and `computePracticeScore`. Every default value is copied verbatim from the previously hardcoded number found during the audit, so seeding these rows changes nothing until a partner edits them.
3. **Grace-day model for overdue rules.** The spec's own example ("Overdue Reminder = 14 days") implied a configurable day-count, but the existing code only ever compared `due_date < today` (an implicit 0-day grace). Rather than leaving that ungeneralized, `reminder_overdue_grace_days`, `document_overdue_grace_days`, and `compliance_deadline_overdue_grace_days` were introduced as day-count rules with a default of `0` — mathematically identical to the old `< today` comparison, but now genuinely tunable (e.g. to 14 days) without any code change. Same treatment for `reminder_upcoming_window_days` (default `7`, matching the old hardcoded 7-day window).
4. **`enabled=false` semantics differ by rule shape.** For the four min-threshold "band" rules (risk high/critical, partner-acceptance, capacity-overloaded), disabling suppresses the alert entirely (effective threshold becomes `Infinity`, so nothing can ever match). For the four day-count rules, `enabled` is not treated as a suppression toggle — disabling a day-count has no unambiguous meaning — the rule's `threshold_value` is always applied. This is a deliberate, documented asymmetry rather than an oversight (see Follow-Up Notes).
5. **`getRule()`/`getRules()` never throw and never return `undefined`.** Every seeded rule_key has a hardcoded `SAFE_DEFAULTS` fallback (generated from the same `SEED_DEFAULTS` array used to seed the DB, so the two can never drift). If a company hasn't run "Seed Defaults" yet, or a row is temporarily missing, or the query fails, callers still get a usable value matching the original hardcoded behaviour. This directly satisfies the "existing alerts continue working" success criterion even in a not-yet-seeded or degraded state.
6. **Operator/severity diversity demonstrated, not just declared.** All 8 required operators (`>`, `>=`, `<`, `<=`, `=`, `!=`, `between`, `contains`) and all 5 severities appear in the seeded rule set (e.g. `capacity_normal_band_pct` uses `between`; `qms_failed_review_alert` uses `=`; `qms_critical_finding_alert` uses `contains`) — not just supported by the schema/validator in the abstract.
7. **`version` incremented only on real edits.** The DB trigger bumps `updated_at` on every `UPDATE`, but `version` is only incremented in application code when a create/update/reset/import actually changes a rule's evaluable fields — avoiding version churn from no-op saves.

## Database — Migration 110

Three tables (all `IF NOT EXISTS`, safe to re-run):

- **`practice_alert_rule_groups`** — 12 organizational categories, per-company (not global — consistent with the rest of the schema's multi-tenant convention).
- **`practice_alert_rules`** — one row per configurable threshold. Full field set per spec (`rule_key`, `category`, `display_name`, `description`, `comparison_operator`, `threshold_value`, `warning_value`, `severity`, `enabled`, `editable`, `system_rule`, `default_value`, `sort_order`, `settings` jsonb) plus additions needed for full reset fidelity (`default_warning_value`, `default_threshold_text`, `default_severity`, `default_enabled`) and a `threshold_text` column for the `contains`/`=` operators. `version INTEGER` satisfies "Rules versioned." Unique index on `(company_id, rule_key)` — the DB-level half of duplicate-key prevention.
- **`practice_alert_rule_events`** — append-only audit log. `rule_key` is denormalized so history survives rule deletion (non-system rules can be deleted).

## Backend — `alert-rules.js`

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/summary` | Counts by category/severity/enabled/system vs custom |
| GET | `/groups` | 12 groups with per-group rule/enabled counts |
| POST | `/groups/:groupId/reset` | Reset every rule in a group to its seeded defaults |
| POST | `/seed-defaults` | Idempotent bootstrap — creates missing groups/rules only, never overwrites |
| GET | `/export` | Export all rules as JSON |
| POST | `/import` | Safe upsert — updates existing rule_keys, creates unknown ones, never deletes |
| POST | `/validate` | Dry-run validation (no write) — used by the frontend before submit |
| GET | `/events` | Global rule-change history (optional `?rule_id=`) |
| GET | `/` | List rules (filters: `category`, `enabled`, `group_id`, `search`) |
| GET | `/:id` | One rule + its 20 most recent events |
| POST | `/` | Create a custom rule |
| PUT | `/:id` | Update a rule (blocked if `editable=false`) |
| POST | `/:id/reset` | Reset one rule to its seeded default |
| DELETE | `/:id` | Delete a rule (blocked if `system_rule=true`) |
| GET | `/:id/events` | Full history for one rule |

### Rule Engine Logic

- **`getRules(cid, keys[])`** / **`getRule(cid, key)`** — the reusable helper other modules call in-process (`require('./alert-rules').getRules(...)`). Resolves each key to its DB row, falling back to a hardcoded `SAFE_DEFAULTS` entry (derived from the same `SEED_DEFAULTS` array used for seeding, so the two never drift) if the row is missing. Never throws.
- **In-process cache.** A `Map` keyed by `company_id`, 30-second TTL, invalidated immediately on any write for that company. `management-dashboard.js`'s compute functions can run up to 5 times per request (see `partner-review-packs.js`'s `_buildReportSnapshot`, which calls all 5 in parallel) — the cache keeps that from becoming 5× the rule queries.
- **Validation (`_validatePayload`)** enforces: duplicate `rule_key` prevention (app-level 409/422 check backed by the DB unique index as defense-in-depth), valid `comparison_operator` against the 8-value enum, valid `severity` against the 5-value enum, operator-specific requirements (`between` needs both bounds with low < high; `contains` needs `threshold_text`; numeric operators need a numeric `threshold_value`), and optional `settings.min_value`/`max_value` range enforcement.
- **System rule protection.** All 28 seeded rules are `system_rule: true` — they can be edited and reset but never deleted (`DELETE` returns 422). Custom rules created via `POST /` are `system_rule: false` and fully deletable.

## Integration Logic

`management-dashboard.js` requires `alert-rules.js` and calls `getRules(cid, [...keys])` once at the top of each of the four affected compute functions, then uses the resolved values in place of what were previously inline literals:

- `computeSummary`: risk band (`highRiskCount`/`criticalRiskCount`), capacity overload ratio, reminder overdue/upcoming cutoffs, document overdue cutoff.
- `computeAlerts`: risk band + partner-acceptance threshold, reminder/document/deadline overdue cutoffs.
- `computePartnerReview`: risk partner-acceptance threshold.
- `computePracticeScore`: risk band, capacity overload ratio, compliance deadline overdue cutoff.

Every default value reproduces the prior hardcoded behaviour exactly — verified by comparing each `SEED_DEFAULTS` entry against the corresponding line found in the pre-build audit. `computeExecutiveFeed` (Codebox 52's extraction) has no thresholds and was not touched.

## Frontend

`alert-rules.html` + `js/alert-rules.js` (prefix `ar`): summary cards, a group filter bar (chip per category, with an inline "reset group" control when a group is selected), a searchable/filterable rule table, a create/edit modal with operator-aware field visibility (warning value only for `between`, threshold text only for `contains`/`=`/`!=`), a 2-tab rule detail modal (Overview + History) with Edit/Reset/Enable-Disable/Delete actions, an Import modal (paste JSON, validated server-side before anything is written), a global History modal, and inline pre-submit validation via `POST /validate`. Export triggers a JSON file download via blob (no chart library; no AI; all CSS/table-based, per spec).

## Multi-Tenant Safety

Every query across all 15 endpoints is scoped to `req.companyId`. `_verifyRule` re-checks company ownership before every mutation. The in-process cache is keyed by `company_id`, so no cross-tenant cache bleed is possible.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `alert-rules.js`, both frontend files, and the `management-dashboard.js`/`index.js`/`layout.js` edits. Confirmed via grep.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/110_practice_alert_rules.sql` | 3 tables |
| `accounting-ecosystem/backend/modules/practice/alert-rules.js` | Router + `getRule()`/`getRules()` helper |
| `accounting-ecosystem/backend/frontend-practice/alert-rules.html` | Admin UI |
| `accounting-ecosystem/backend/frontend-practice/js/alert-rules.js` | Admin UI logic |
| `docs/new-app/53_alert_rules_engine.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_53_alert_rules.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | 8 hardcoded thresholds replaced with `getRules()` calls across 4 compute functions |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `alert-rules` router at `/alert-rules` |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Alert Rules" nav entry |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added "⚙️ Configure Alert Rules" link |
