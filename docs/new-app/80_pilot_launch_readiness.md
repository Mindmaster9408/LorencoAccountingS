# Codebox 80 — Practice Pilot Launch Readiness + Navigation/UX Consolidation

> App: Lorenco Practice Management
> Status: Complete — migration 137 not yet applied to Supabase — nothing committed or pushed

## Purpose

"Can we start pilot testing?" — a GO / NO-GO / CONDITIONAL GO decision with a reason. This is the final codebox (±80 total): a consolidation and launch-readiness layer, not a new business module. It reduces every prior codebox's own health signal (Operational Health, Automation) plus a new manager-editable launch checklist and known-issues register into one readiness score, and — the concrete, required deliverable — fixes the navigation, which had grown into an unreadable flat list of 69 links.

**This is NOT a new business module. NOT a core-logic rewrite.** No existing module's backend logic was changed.

## Mandatory Pre-Build Audit — Key Findings

No pre-existing readiness/checklist/known-issue table exists anywhere. `computePilotReadiness()` reads existing signals directly, never re-derives their scoring:

- `operational-health.js` exports `computeOperationalHealth()` (Codebox 79) — **not called fresh here.** Per the spec's own instruction ("Use: Operational Health latest run... Do not invent health data"), this module reads the latest **stored** `practice_health_check_runs` row only. If none exists, `readiness_status` is forced to at least `needs_attention` and a warning code `OPERATIONAL_HEALTH_NOT_RUN` is raised — exactly as specified, never a fabricated score.
- `practice_automation_runs` (Codebox 78) is read directly (the same count-only pattern `management-dashboard.js` and `operational-health.js` both already use) for recent failed-run counts.
- Role-link health is read from the **stored** Operational Health run's own `category_results.role_links` (Codebox 79 already computed this exact signal) — never re-derived.
- `lib/team-access.js` is reused, not reimplemented, for the one new frontend-facing endpoint this codebox adds: `GET /api/practice/team/me`, which exists solely so the frontend can safely infer whether to show manager-level navigation groups. It calls `teamAccess.getMyTeamMember()`/`isManager()` directly. The backend authorization boundary is completely unchanged — every existing manager-gated route is untouched.
- **Navigation audit finding:** the flat 69-link nav in `layout.js` had no grouping and no overflow handling — items simply wrapped across multiple lines as more codeboxes added pages. Fixed by grouping into 9 dropdown menus (see below), implemented as CSS injected by `layout.js` itself (not `practice.css`), for the same reason `_renderBell()` already uses inline styling: layout.js is shared by every page and must render correctly regardless of which stylesheet (if any) that page links.
- **Separate, pre-existing CSS-linking finding (documented, not fixed — out of scope for this codebox):** 35 of the newer pages (Codeboxes 74–79, including several built this session) link `/practice/css/layout.css`, which does not exist on disk (only `practice.css` does). This is harmless in practice — every one of those 35 pages carries its own complete embedded `<style>` block and renders fully styled regardless — but it is a dead link. Not fixed here per the architecture boundary ("Do not rewrite core modules," "minimal risk," and "Full design-system rewrite" is an explicit Future Enhancement) — fixing it would mean either creating real content for a file 35 pages currently don't actually need, or changing 35 `<link>` tags with no browser-testing capability to verify no visual regression. Documented as a follow-up note.

## Architect Freedom — Scope Decisions & Deviations

1. **The 6 pre-existing pages the spec's own 9 group lists didn't explicitly name** (`workflows`, `compliance`, `tasks`, `billing`, `period-queue`, `client-health`) were folded into the closest-fit existing group (Operations, Compliance & Tax, Clients respectively) rather than inventing a 10th "Other" bucket — verified programmatically that all 69 `PAGES` entries appear in exactly one `NAV_GROUPS` list (one intentional exception below), with zero missing and zero typo'd keys.
2. **`work-queue` intentionally appears in two groups** (Dashboard, as "My Work," and Operations, as "Work Queue") — this is the spec's own explicit instruction, not a bug; verified as the only duplicate across all groups.
3. **Role-aware nav renders the full navigation first, then trims** — it never withholds the full nav while waiting on the `/api/practice/team/me` response, and if that request fails or is slow, the full nav simply stays visible. This "fails open" design was a deliberate choice given the spec's own hard rule: "Do not hide routes as a security boundary... Frontend hiding is UX only."
4. **Navigation CSS is injected once by `layout.js` via a `<style>` tag with a stable id** (`lorenco-practice-nav-css`), not added to `practice.css` — guarantees the new nav renders correctly on every page regardless of which stylesheet (if any) that page links, closing the exact class of risk the broken-`layout.css`-link finding above surfaced.
5. **`NAVIGATION_CONSOLIDATED` is a hardcoded `true` constant in `pilot-readiness.js`**, not a runtime probe — navigation structure is code, not queryable data, so there is nothing to "invent" here: it ships in the same commit as the grouped nav it describes. Documented explicitly in the migration header as the honest reasoning, not an invented health signal.
6. **The known-issues register enforces a hard `blocked` status** for any unresolved critical issue in the `security` or `access` category, per the spec's scoring rule verbatim — this cannot be overridden by a high overall score, and a "go" decision is rejected server-side (422) if the latest run's `readiness_status` is `blocked`.
7. **`accept-risk` requires non-empty `resolution_notes`** (mirrors the "reason required for consequential actions" convention used throughout this session) — an issue cannot be silently waved through without a documented justification.
8. **All 8 mutating routes were manager-gated from the first draft** (matching the lesson carried forward from Codebox 78/79, after Codebox 77's initial gap) — confirmed 8-for-8 by direct grep before this doc was written.

## Database — Migration 137

Four new tables: `practice_pilot_readiness_runs`, `practice_pilot_checklist_items`, `practice_pilot_known_issues`, `practice_pilot_events` (append-only, same convention as Codeboxes 76–79). No changes to any existing table.

## Backend — `pilot-readiness.js`

### Readiness Engine — `computePilotReadiness()`

Reads (never recomputes): the latest stored Operational Health run, recent automation failures (direct count query), open known issues, and checklist items. Combines them via the spec's exact scoring formula into `{ overallScore, readinessStatus, criticalBlockers, moduleMatrix, smokeTestSummary, navigationSummary, knownIssueSummary, blockers, warnings, recommendedNextActions, readinessSnapshot }`.

### Scoring (exact spec formula)

Start at 100. Subtract: critical issue −20, high issue −10, medium issue −4, low issue −1, failed critical checklist item −15, failed high checklist item −8, Operational Health critical finding −20, navigation not consolidated −10 (never triggers post-launch of this codebox). Floor at 0.

**Status:** `launch_ready` (≥95, zero critical blockers) → `pilot_ready` (≥85, zero critical blockers) → `needs_attention` (≥70) → `not_ready` (<70). `blocked` overrides all of the above if any unresolved critical security/access issue exists. If Operational Health has never run, `launch_ready`/`pilot_ready` are downgraded to `needs_attention` regardless of score.

### Seed Checklist

15 default smoke-test items exactly per spec (`POST /checklist/seed-defaults`, idempotent by `check_title`, never re-duplicated): login, role access, team user links, client create/view, Planning Board, My Work, Notifications, Secretarial profile, Engagement management, Executive Reporting generate, Automation dry-run, Operational Health run, no-localStorage-violations, Management Dashboard, navigation-no-overflow.

## Navigation Consolidation

`layout.js`'s flat 69-link list is now 9 dropdown groups (Dashboard, Operations, Clients, Secretarial & Governance, People & Practice, Compliance & Tax, Quality & Risk, Strategy & Executive), each a button that toggles a positioned dropdown menu; only one dropdown open at a time; closes on outside click. CSS is self-injected (works with or without `practice.css`/the page's own embedded styles). Verified: zero routes removed, zero pages orphaned, zero typo'd keys (script-checked, not eyeballed).

## Role-Aware Navigation

`GET /api/practice/team/me` (new, read-only, reuses `lib/team-access.js` directly) tells the frontend whether the current user is manager-level. Non-managers see a reduced 2-group nav (Dashboard, Clients); managers see all 9 groups. This is UX-only — the backend's existing manager gate on every actual mutating route is completely unchanged.

## Smoke-Test Checklist

Covered by the 15 seeded `practice_pilot_checklist_items` rows (see above) — this table doubles as both the general launch checklist and the smoke-test list, since the spec did not request a separate table for smoke tests specifically.

## Known Issues Register

Full CRUD + resolve + accept-risk workflow. A critical issue in `security`/`access` category is the one hard gate that can override an otherwise-high readiness score.

## Integrations

- **Management Dashboard**: a new `pilot_readiness` block in `computeSummary()` — latest stored run's score/status/decision, open critical issue count — direct queries only, no fresh computation from a dashboard load.

## Frontend

`pilot-readiness.html` + `js/pilot-readiness.js` (prefix `pr`): a Go/No-Go decision hero, 5 tabs (Module Matrix / Smoke-Test Checklist / Known Issues / Readiness Runs / Events), a run-readiness modal, a run-detail modal with inline Go/No-Go/Conditional-Go decision recording, and known-issue create/detail/resolve/accept-risk modals.

## localStorage Findings

Zero actual violations in any new file — the one grep match in `pilot-readiness.js` is a literal string inside a seeded checklist item's title ("No localStorage violations in new files"), not code. `layout.js`'s pre-existing `localStorage.getItem('company')` (display-only company name caching) predates this codebox and is out of its scope.

## Multi-Tenant Safety

Every query in `pilot-readiness.js` verified individually — all correctly scoped by `company_id`, either as an insert payload field or a chained `.eq()`. All 8 mutating routes confirmed manager-gated (8-for-8 by grep).

## Files Created

| File | Purpose |
| --- | --- |
| `accounting-ecosystem/backend/config/migrations/137_practice_pilot_launch_readiness.sql` | 4 tables: readiness runs, checklist items, known issues, append-only events |
| `accounting-ecosystem/backend/modules/practice/pilot-readiness.js` | Router + `computePilotReadiness()` engine |
| `accounting-ecosystem/backend/frontend-practice/pilot-readiness.html` | Pilot Readiness UI |
| `accounting-ecosystem/backend/frontend-practice/js/pilot-readiness.js` | Pilot Readiness UI logic |
| `docs/new-app/80_pilot_launch_readiness.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_80_pilot_readiness.md` | Handoff |

## Files Modified

| File | Change |
| --- | --- |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `pilot-readiness.js` router; added `GET /team/me` (new, read-only, reuses `lib/team-access.js`) |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | Added `pilot_readiness` block to `computeSummary()` |
| `accounting-ecosystem/backend/frontend-practice/js/management-dashboard.js` | Rendered the new KPI card |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added the "Pilot Readiness" KPI grid container |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | **Navigation consolidation** — grouped dropdown nav, role-aware trimming, self-injected CSS; added the "Pilot Readiness" page entry |
