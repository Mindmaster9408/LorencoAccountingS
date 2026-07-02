# Session Handoff — Codebox 53: Practice Alert Rules Engine + Manual Alert Configuration

> Date: 2026-07-02
> Status: COMPLETE — migration 110 NOT yet applied to Supabase — not committed or pushed

---

## What Was Built

### Pre-build audit

Before writing any code, a full audit (via a background research pass) was run across `management-dashboard.js`, `risk-register.js`, `quality-management.js`, `capacity.js`, `client-health.js`, `compliance-packs.js`, `reminders.js`, `document-requests.js`, and `communications.js` to catalogue every hardcoded numeric/status threshold currently used to decide alert severity. This produced the exact `SEED_DEFAULTS` values used below — every seeded default is copied verbatim from a real line of existing code, not invented.

### Scope decision — comprehensive seeding, scoped wiring

28 rules were seeded across all 12 required groups (Risk, Tax, Capacity, QMS, Client Health, Compliance, Documents, Reminders, Communications, Knowledge, SOP, Billing) for full administrative visibility. Only 8 of those 28 are actually consumed by code today — all inside `management-dashboard.js`, the module this codebox's own spec describes as the place "each module currently decides independently when something is red." The spec's Architecture Boundaries section explicitly states the individual source-of-truth modules (Risk, QMS, Tax, Capacity, Compliance, Documents, Reminders) "remain owners of their data" and that the Rules Engine "only supplies thresholds" — this was read as licence to leave those modules' own internal logic untouched for this codebox, while still seeding their thresholds (marked `settings.wired: false` with a `settings.maps_to` pointer) for future adoption by whichever codebox eventually refactors each module. This kept regression risk bounded to one already-well-understood, twice-previously-refactored file instead of nine.

**The 8 wired rules** (all inside `management-dashboard.js`): `risk_high_min` (15), `risk_critical_min` (20), `risk_partner_acceptance_min` (15), `capacity_overloaded_ratio` (1.0), `compliance_deadline_overdue_grace_days` (0), `document_overdue_grace_days` (0), `reminder_overdue_grace_days` (0), `reminder_upcoming_window_days` (7). Every default value reproduces the previously hardcoded number exactly.

### Migration 110

- **`practice_alert_rule_groups`** — 12 categories, per-company.
- **`practice_alert_rules`** — full spec field set plus `default_warning_value`/`default_threshold_text`/`default_severity`/`default_enabled` (needed for a complete reset, since a single `default_value` column can't hold the state of every operator type), `threshold_text` (for `contains`/`=`/`!=`), and `version` (spec's "Rules versioned" requirement). Unique index on `(company_id, rule_key)`.
- **`practice_alert_rule_events`** — append-only, `rule_key` denormalized so history survives deletion of non-system rules.

### Backend — `alert-rules.js` (15 endpoints)

Key judgment calls:

**`getRule()`/`getRules()` never throw, never return `undefined`.** A `SAFE_DEFAULTS` map is generated at module load time directly from the same `SEED_DEFAULTS` array used to seed the database — so the code-level fallback and the DB-level seed can never drift apart. If a company hasn't run "Seed Defaults" yet, or a specific row is missing, or the query errors, `getRules()` still returns a usable value matching the original hardcoded behaviour. This is what makes "existing alerts continue working" true even before a company seeds the engine.

**In-process cache, 30s TTL, keyed by `company_id`.** `management-dashboard.js`'s compute functions can be called up to 5 times in a single request (`partner-review-packs.js`'s report builder calls all 5 in parallel via `Promise.all`) — without a cache this would mean up to 5× redundant rule queries per report generation. Cache is invalidated immediately (not just expired) on every create/update/reset/seed/import for that company, so an admin never sees stale thresholds after saving a change.

**`enabled` semantics differ by rule shape — a deliberate asymmetry, not an inconsistency.** For the 4 min-threshold "band" rules (risk high/critical/partner-acceptance, capacity-overloaded), disabling the rule substitutes `Infinity` as the effective threshold, so the condition can never be met — the alert is fully suppressed. For the 4 day-count rules (3× overdue grace, 1× upcoming window), `enabled` is not treated as a suppression toggle at all — the rule's `threshold_value` is always applied regardless. A day-count doesn't have an unambiguous "disabled" meaning (disabled = 0 days? disabled = never overdue? disabled = ignore the whole category?), so rather than guess, disabling a day-count rule only affects its visibility/editability in the admin UI. See Follow-Up Notes.

**Grace-day model chosen for overdue rules.** The spec's own headline example was "Overdue Reminder = 14 days," but the existing code only ever compared `due_date < today` — an implicit 0-day grace with no configurable knob at all. Rather than leave the example unfulfillable, `reminder_overdue_grace_days` / `document_overdue_grace_days` / `compliance_deadline_overdue_grace_days` were introduced as genuinely new, additive configuration (default `0`, mathematically identical to the old behaviour) so a partner actually can set "Overdue Reminder = 14 days" through the UI today.

**Validation covers every case in the spec's Rule Validation section**: duplicate `rule_key` (app-level check + DB unique index as defense-in-depth), invalid `comparison_operator` (must be one of the 8 supported), invalid thresholds (`between` requires low < high, `contains` requires `threshold_text`, numeric operators require a numeric `threshold_value`, and optional `settings.min_value`/`max_value` bounds are enforced), and system-rule deletion (blocked with a 422, not silently ignored).

**Import/Export is a safe upsert, never a destructive replace.** Export produces a flat JSON array of the portable rule fields (no internal IDs/timestamps). Import validates every row before writing anything (all-or-nothing — if any row fails validation, zero changes are applied), updates existing `rule_key`s in place, creates unknown ones as custom rules, and never deletes anything not present in the imported set.

### Frontend — `alert-rules.html` + `js/alert-rules.js` (prefix `ar`)

- Summary cards (total/enabled/disabled/system/custom/critical-severity counts)
- Group chip bar — click to filter by category; the active chip shows an inline "↺ reset group" control
- Searchable, filterable rule table (search box + enabled/disabled filter) showing condition text (e.g. `>= 15`, `between 50 and 85`, `= "blocked"`), severity pill, enabled/disabled pill, and version
- "wired" badge on rules actually consumed by `management-dashboard.js` (tooltip shows the exact function names), so partners can see at a glance which edits take effect immediately versus which are recorded for future use
- Create/Edit modal with operator-aware field visibility (warning value only appears for `between`; threshold text only for `contains`/`=`/`!=`) and inline pre-submit validation via `POST /validate`
- Rule Detail modal — 2 tabs (Overview / History) with Edit, Reset to Default, Enable/Disable, and Delete (disabled with a tooltip for system rules) actions
- Import modal (paste JSON, server-validated before any write) and one-click Export (blob download, same auth-safe pattern used for PDF downloads in Codebox 52)
- Global History modal
- No chart library, per spec — table/pill based throughout

### Management Dashboard Integration

`management-dashboard.html` got a "⚙️ Configure Alert Rules" link next to the existing KPI Snapshot / Generate Review Pack buttons.

---

## Nothing Regressed

- All 8 wired rules default to the exact value previously hardcoded — confirmed by direct comparison against the pre-build audit's line-by-line findings for each of `computeSummary`, `computeAlerts`, `computePartnerReview`, `computePracticeScore`.
- `computeExecutiveFeed` (Codebox 52's extraction) has no thresholds and was not touched.
- `kpi-history.js` and `partner-review-packs.js` — untouched; they call `management-dashboard.js`'s compute functions in-process exactly as before, and those functions' return shapes are unchanged.
- No circular `require()` — `alert-rules.js` has zero dependency on `management-dashboard.js` (verified by loading both modules standalone in a smoke test).
- `node --check` passes on `alert-rules.js`, `management-dashboard.js`, `index.js`, `layout.js`, and both frontend JS files.
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches across every new/modified file (migration, both routers, both frontend files, `layout.js`, `management-dashboard.html`) — confirmed via grep.
- All files verified present on disk via `ls` immediately after writing.
- A standalone Node smoke test loaded both `alert-rules.js` and `management-dashboard.js`, confirmed all expected exports are present, confirmed all 28 `SEED_DEFAULTS` rule_keys are unique, confirmed every seeded category maps to one of the 12 `GROUPS`, and confirmed the 8 wired rule_keys match the integration plan exactly.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:
- `110_practice_alert_rules.sql`

Expected: "Success. No rows returned." Apply after migration 109 (already applied per prior codebox's stated assumption).

**After applying the migration, each company must click "Seed Defaults" on the Alert Rules page (or `POST /api/practice/alert-rules/seed-defaults`) at least once** to populate its groups/rules. Until then, `getRule()`/`getRules()` still return correct values via the `SAFE_DEFAULTS` code-level fallback, so no alert behaviour changes — but the admin page will show "No rules seeded yet" and the summary/group counts will be zero.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, a standalone module-loading smoke test, and grep for browser-storage violations.*

1. Apply migration 110 to Supabase
2. Navigate to `/practice/alert-rules.html` — should show the "No rules seeded yet" banner and zeroed summary cards
3. Click "🌱 Seed Defaults" — confirm 12 groups and 28 rules are created; banner disappears; summary cards populate
4. Click "🌱 Re-seed (safe)" again — confirm `already_seeded: true` / no duplicate rows are created (idempotency)
5. Click a group chip (e.g. "Risk") — confirm the table filters to that group's 3 rules; confirm the inline "↺" reset-group control appears
6. Open the "High Risk Threshold" rule → Edit → change threshold_value from 15 to 18 → Save → confirm the table shows `>= 18` and version increments to v2
7. Go to `/practice/management-dashboard.html` and refresh — confirm the "High Risk" alert count now reflects the 18 threshold (fewer risks should count as "high") — this is the core proof that the engine is genuinely wired, not just cosmetic
8. Reset that same rule via "↺ Reset to Default" — confirm it returns to 15 and the dashboard's alert count reverts
9. Disable the "Critical Risk Threshold" rule — confirm on the dashboard that no risk is ever counted as critical (suppressed, not defaulted)
10. Re-enable it — confirm critical counting resumes
11. Change "Reminder Overdue Grace (days)" from 0 to 14 — confirm reminders due within the last 14 days no longer appear in "Overdue" on the dashboard (this proves the day-count integration works, matching the spec's own headline example)
12. Try creating a custom rule with a `rule_key` that already exists — confirm a 409/422 with a clear duplicate-key error, and that the "Validate" button in the modal surfaces the same error before you even submit
13. Try the `between` operator with threshold_value >= warning_value — confirm validation blocks it
14. Try deleting a system rule — confirm it's blocked (button disabled with a tooltip; API returns 422 if attempted directly)
15. Create a custom rule, then delete it — confirm it's removed and the summary counts update
16. Export rules → confirm a JSON file downloads with all seeded + custom rules
17. Edit the exported JSON (e.g. change one threshold_value), then Import it → confirm the matching rule_key is updated in place and no other rules are affected or deleted
18. Reset a whole group ("↺" on an active group chip) → confirm every rule in that group reverts to its default
19. Open the global History modal and a single rule's History tab → confirm every action from steps 6–18 appears with correct event types and timestamps
20. Log in as a different company → confirm zero rules/groups/events visible, and that seeding one company's defaults does not create rows for another company
21. DevTools → Application → Storage → confirm no alert-rule data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: `enabled` flag has no suppression meaning for the 4 day-count rules (grace/window days)
- Confirmed now: For risk/capacity band rules, disabling suppresses the alert (effective threshold = Infinity). For grace/window day rules, `enabled` only affects admin-UI visibility — the threshold_value is always applied.
- Not yet confirmed: Whether partners will expect toggling "enabled" off on e.g. "Reminder Overdue Grace (days)" to mean "never flag reminders as overdue" (a suppression) rather than "no effect."
- Risk: Low-medium — could cause confusion if a partner disables a day-count rule expecting suppression and doesn't get it.
- Recommended: If this surfaces as a real support question, either (a) document the distinction directly in the rule's `description` field, or (b) special-case grace/window rules so `enabled=false` sets an effectively infinite grace period (never overdue) for full consistency with the band-rule suppression behaviour.
```

```
FOLLOW-UP NOTE
- Area: 20 of 28 seeded rules are not yet wired into their owning module's own code (risk-register.js, capacity.js, client-health.js, compliance-packs.js, reminders.js, document-requests.js, communications.js, quality-management.js, knowledge-base.js, practice-sop.js, billing.js, tax modules)
- Confirmed now: Editing these rules via the Alert Rules page has zero effect on the practice today — they are seeded for administrative visibility and future adoption only. Each carries `settings.wired: false` and a `settings.maps_to` pointer identifying its intended consumer, and the admin UI surfaces a "wired" badge so this is visible to users, not hidden.
- Not yet confirmed: Which future codebox(es) will refactor each of those modules to call getRule()/getRules(). This was a deliberate scope boundary for Codebox 53 (see Architect Freedom point 1 in the technical doc), not an oversight.
- Risk: Low — clearly labelled in the UI, and editing an unwired rule cannot cause incorrect behaviour (it simply has no effect yet), so there's no silent-failure risk.
- Recommended: When a future codebox touches one of those modules, check its rules' `settings.maps_to` field first — the wiring pattern established in management-dashboard.js (fetch via getRules() once per compute function, before building queries) should be reused directly.
```

```
FOLLOW-UP NOTE
- Area: Practice Score weights/penalties (SCORE_WEIGHTS and the per-severity/per-condition point deductions in computePracticeScore) were deliberately left out of the Alert Rules Engine
- Confirmed now: These are Codebox 50's own documented, deterministic scoring formula constants (e.g. -15/failed review, -8/high risk) — a distinct concern from "when is X raised as an alert." Only the *banding* thresholds that feed into that formula (risk_high_min, risk_critical_min, capacity_overloaded_ratio, compliance_deadline_overdue_grace_days) were wired, not the point-value constants themselves.
- Not yet confirmed: Whether a future codebox should extend the Rules Engine to also cover scoring weights (this would blur the "alert threshold" vs "score formula" boundary and wasn't requested by this spec).
- Risk: None currently — Codebox 50's formula remains exactly as documented and untouched.
- Recommended: If partners ask to tune score weights/penalties without code changes, treat that as a new, explicitly-scoped codebox rather than silently expanding this one's boundary.
```
