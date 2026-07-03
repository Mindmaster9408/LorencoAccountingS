# Codebox 67 — Secretarial Statutory Calendar + Compliance Scheduler

> App: Lorenco Practice Management
> Status: Complete — migration 123 not yet applied to Supabase — nothing committed or pushed

## Purpose

One statutory calendar showing every upcoming corporate compliance obligation for every client. Managers immediately know what's due today, overdue, approaching, blocked, or not yet started.

**NOT another Deadlines module.** `practice_deadlines` remains the master task/deadline system — this module defines recurring statutory obligations and synchronises them with `practice_deadlines` by linking to an existing/created row, never duplicating deadline management. **NOT CIPC API. NOT automatic submissions. NOT cron jobs. NOT calendar sync. NOT email/SMS/push reminders.**

## Architect Freedom — Scope Decisions & Deviations

1. **An audit of `practice_deadlines`' actual schema (migrations 007/011/058) determined exactly how deadline synchronisation would work before any code was written.** `practice_deadlines` already has `deadline_type`, `compliance_area`, `due_date`, `status`, and other fields extended well beyond its original 3-column shape. `_resolveOrCreateDeadline()` matches on `(client_id, deadline_type, due_date)` and only inserts a new row when no match exists — the "link, never duplicate" instruction implemented literally, using the exact reuse target the spec named.
2. **Only `annual_return` and `beneficial_ownership_review` obligation types map onto an established `deadline_type` value** (`cipc_annual_return` and `beneficial_ownership`, both already present in `practice_deadlines`' extended vocabulary before this codebox). The other 8 obligation types fall back to `deadline_type = 'custom'` when synced — rather than inventing new `deadline_type` values that might collide with a future, unrelated codebox's own additions to that shared vocabulary, or silently guessing at a mapping the spec never confirmed.
3. **Categories (`upcoming`/`due_today`/`overdue`/`blocked`/`waiting`/`completed`/`future`) are never stored — always computed live by `buildStatutoryCalendar()`** from `due_date`, `warning_date`, `grace_end_date`, stored `status`, and live dependency resolution. This is the same "frozen state vs. computed category" discipline applied throughout this session (BO readiness, Client Success cadence, Learning Centre progress) — a schedule row only ever stores its true lifecycle state (`pending`/`completed`/`cancelled`); everything temporal is derived fresh on every read, so it can never silently go stale.
4. **`blocked` vs. `waiting` is a genuine interpretive call the spec's wording left open** — both are listed as distinct buckets with an unsatisfied dependency being the trigger for both. The distinction implemented: an item with an unsatisfied dependency is `blocked` once it's actually due or overdue (the dependency is now actively stopping real work), and `waiting` while it's still comfortably in the future (a prerequisite hasn't happened yet, but there's no urgency). This gives the two buckets genuinely different meanings instead of being redundant synonyms.
5. **Dependency satisfaction reuses `beneficial-ownership.js`'s exported engine for `bo_review`-type dependencies** (`getBeneficialOwnershipProfile()`, checking `readiness.status === 'ready'`) rather than re-implementing BO readiness scoring a second time. `evidence_complete` and `governance_complete` dependency types have no automatic check available in this codebase (Codebox 66, which would have built a document/evidence checklist system, was not built in this session) — these always report unsatisfied unless a manager explicitly overrides, which is the safe, honest, "never guess" behavior rather than inventing a fake automatic check.
6. **Manager override always short-circuits dependency satisfaction to `true`, regardless of dependency type** — matching the spec's literal "Manager may override" instruction, with the override reason, actor, and timestamp all recorded and auditable.
7. **`generateSchedule()` is idempotent** (checks existing `period_label`s before inserting, backed by a DB-level unique constraint on `(obligation_id, period_label)` as a safety net) — the same incremental-generation philosophy established for BO readiness items in Codebox 65, appropriate here because a manager will realistically call "Generate Schedule" more than once as time passes and new occurrences become due.
8. **Recurrence anchor resolution reuses existing cross-referenced data rather than asking for a duplicate date.** `anchor: 'registration_date'` reads `practice_secretarial_profiles.registration_date` (Codebox 62); `anchor: 'financial_year_end'` reads `practice_taxpayer_profiles.financial_year_end` (Codebox 62's own established cross-reference, from Codebox 25) — neither value is copied onto the obligation record itself, avoiding yet another duplicate of client identity data.
9. **Planning Board and Management Dashboard integrations take deliberately different approaches to the same cost tradeoff, for a defensible reason.** Planning Board (badges on every work item, every board load) uses cheap, approximate direct queries — exactly like Codebox 65's BO badge — rather than calling `buildStatutoryCalendar()` per client. Management Dashboard (one aggregator call per dashboard load, not per-client-per-item) DOES call `buildStatutoryCalendar()` directly, because it only runs once for the whole company per page load, and the spec's own Implementation Priorities list ranks "Dashboard visibility" (5) above general performance concerns — the authoritative, correct computation was worth the one-time cost there, while the N-times-per-board-load cost on Planning Board was not.

## Database — Migration 123

Four tables: `practice_statutory_obligations` (the recurring rule), `practice_statutory_schedule` (individual due occurrences), `practice_statutory_dependencies` (gating rules), `practice_statutory_calendar_events` (append-only). Full field-by-field rationale in the migration's own header and per-table comments.

## Backend — `secretarial-calendar.js`

### Endpoints (~20)

Summary, company-wide calendar (optionally filtered by client), full CRUD for Obligations (+ `generate-schedule`), Schedule (read/create/update — including manual, non-recurring entries), Dependencies (create + override), and events.

## Scheduler Logic

`buildStatutoryCalendar(cid, clientId)` — reads schedule rows, resolves each row's category live (see Architect Freedom #3-#4), and returns both a flat `items` list and a `buckets` object keyed by category, plus a `counts` summary. Pure computation, no side effects, safe to call as often as needed.

## Recurrence Engine

`_computeDueDates()` steps forward from a resolved anchor date in fixed month increments (1/3/6/12/N for monthly/quarterly/half-yearly/annual/every-X-months), applying `due_rule.offset_days`, always advancing past today before generating any occurrence (never backfills history). `one_off` produces exactly one date from the anchor; `manual` produces none — those obligations are scheduled entirely by hand via `POST /schedule`. See Architect Freedom #7-#8 for the idempotency and anchor-reuse decisions.

## Deadline Integration

See Architect Freedom #1-#2. `_resolveOrCreateDeadline()` is the single choke point every schedule-generating code path (both automatic recurrence and manual schedule entry) passes through — there is no path in this router that can create a statutory schedule entry without first checking for and preferring an existing `practice_deadlines` row.

## Dashboard Integration

Management Dashboard's `computeSummary()` now includes a `statutory_compliance` block (overdue/due-today/upcoming/blocked counts), rendered as a new "Statutory Compliance" KPI section — reusing `buildStatutoryCalendar()` directly (see Architect Freedom #9) rather than re-approximating the categorization a second time in that file.

## Secretarial Integration

- **Secretarial page**: a "Statutory Compliance" panel per selected client (overdue/due-today/upcoming/blocked counts, the next few upcoming/overdue items, a blocked-count callout) plus an "Open Calendar →" deep link.
- **Client Detail**: not extended in this pass — see Follow-Up Notes.
- **Planning Board**: `statutory_workload_upcoming`/`statutory_workload_blocked` flags (see Architect Freedom #9 for the cost-driven, approximate implementation), rendered as "📅 Statutory Due Soon" / "📅 Statutory Blocked" badges.

## Frontend

`secretarial-calendar.html` + `js/secretarial-calendar.js` (prefix `sc`): a company-wide (not client-picker-first) page, matching the spec's framing of "one statutory calendar... for every client." Summary cards, 6 tabs (Calendar / Upcoming / Overdue / Blocked / Completed / Templates). The Templates tab manages obligation rules and triggers schedule generation; every other tab reads the live-computed calendar. No chart library, no AI, no graph visualization.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `secretarial-calendar.js`, both new frontend files, and every edited file (`index.js`, `layout.js`, `management-dashboard.js`, `js/management-dashboard.js`, `management-dashboard.html`, `planning-board.js`, `js/planning-board.js`, `secretarial.html`, `js/secretarial.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. Dependency links (`depends_on_schedule_id`) independently re-verified against the dependency's own `client_id` server-side. Reads unrestricted per-user; all writes and workflow actions manager-gated.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/123_practice_secretarial_calendar.sql` | 4 tables |
| `accounting-ecosystem/backend/modules/practice/secretarial-calendar.js` | Router + recurrence engine + `buildStatutoryCalendar()` + deadline sync |
| `accounting-ecosystem/backend/frontend-practice/secretarial-calendar.html` | Statutory Calendar UI |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial-calendar.js` | Statutory Calendar UI logic |
| `docs/new-app/67_secretarial_calendar.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_67_secretarial_calendar.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `secretarial-calendar` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Statutory Calendar" nav entry, placed after Beneficial Ownership |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | Requires `secretarial-calendar.js`; added `statutory_compliance` block to `computeSummary()` |
| `accounting-ecosystem/backend/frontend-practice/js/management-dashboard.js` | Renders the new Statutory Compliance KPI section |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added `kpiStatutoryCompliance` section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | `_buildTeamItemPool()` attaches `statutory_workload_upcoming`/`statutory_workload_blocked` flags per item |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Renders the statutory workload badges on work items |
| `accounting-ecosystem/backend/frontend-practice/secretarial.html` | Added a "Statutory Compliance" panel |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial.js` | Loads upcoming obligations/compliance readiness per selected client |
