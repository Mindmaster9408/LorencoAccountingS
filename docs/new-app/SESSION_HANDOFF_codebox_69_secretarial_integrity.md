# Session Handoff — Codebox 69: Secretarial Register Integrity Audit + Statutory Data Quality Review

> Date: 2026-07-03
> Status: COMPLETE — migration 126 NOT yet applied to Supabase — nothing committed or pushed

---

## What Was Built

### A company-wide, bulk-fetch audit engine — not 25 clients × 25 checks worth of round trips

`runIntegrityAudit()` fetches every table it needs exactly once per run (company-scoped, ~19 queries total, all in parallel), groups the results by `client_id` in memory, and then runs 10 pure validation functions over that in-memory data. No validation function performs its own database I/O. This keeps a full-practice audit fast regardless of client count, and keeps every validation trivially unit-testable in isolation (pure function in, findings array out).

### Fault isolation at both the fetch layer and the validation layer

Every one of the ~19 bulk queries is wrapped in `_fetchSafe()` (returns `[]` on any error, logs it, never throws) and every one of the 10 validation groups is wrapped in `_safeCheck()` (returns `[]` on any error, logs it, never throws). This means a single misbehaving query or a single buggy validation can never take down the whole audit run — directly satisfying the spec's "One validation failing must NEVER stop the entire audit," extended to cover the data-fetching layer too, since that's the more likely real-world failure point (a transient Supabase error, not a logic bug).

### 31 deterministic finding codes across all 10 required categories

Register/director/shareholder integrity (no active directors, no shareholders, percentage math exceeding or falling short of 100%, duplicate active records, missing registered office/registration number/financial year-end), annual returns (missing, overdue), Beneficial Ownership (incomplete, blocked, orphaned readiness items, broken ownership-chain references), Lifecycle (unknown status, terminal-with-active-workflow, dormant-with-trading-workflow, Secretarial/Lifecycle status disagreement, implementation-without-approval, completed-without-implementation, wrong lifecycle-profile reference), Governance (missing resolution/meeting for an implemented change, orphaned resolution/meeting/decision records), Evidence (missing checklist, incomplete/partial/blocked readiness, orphaned template link), Calendar (blocked and waiting statutory obligations, broken schedule/dependency references). Every finding carries a `recommended_action` — always a suggestion for the manager to act on, never an automatic fix.

### Reuse over duplication, extended one step further this codebox

Rather than re-implement BO readiness scoring, `beneficial-ownership.js` gained one more small additive export — `computeReadinessFromItems` (aliasing its existing private `_computeReadiness`) — so the integrity audit can bulk-fetch all of a company's BO readiness items once and score every client's readiness using the exact same thresholds the BO module itself uses, without calling `getBeneficialOwnershipProfile()` once per client (which would re-run several of its own queries per call). Similarly, `entity-lifecycle.js` gained a small additive `TERMINAL_STATUSES` export so the integrity audit never redeclares that 3-value list as a second, potentially-drifting source of truth. Both exports are zero-risk — pure data or pure functions, no behavior change to either module's existing routes.

### Backend — `secretarial-integrity.js` (12 endpoints)

Full run/finding CRUD plus four explicit review actions — acknowledge, resolve, accept-risk (requires a reason, since risk acceptance is a real business decision), and reopen (added beyond the spec's literal endpoint list so the migration's own `finding_reopened` event type isn't dead code — see docs Architect Freedom #8). No endpoint ever mutates a finding's `finding_category`, `finding_code`, `severity`, `description`, or `source_*` fields after creation — those are the audit's permanent record of what was found; only `status`, `notes`, and the `reviewed_*` fields are ever updated.

### Frontend — `secretarial-integrity.html` + `js/secretarial-integrity.js` (prefix `si`)

- Company-wide page (no client picker — a data-quality audit naturally spans every client)
- Prominent score badge (color-coded good/fair/poor) + summary cards + a "Run Audit" button
- 4 tabs: Audit Runs, Open Findings (with category/severity filters + inline actions), Resolved Findings (with Reopen), Events
- No document viewer, no file upload UI, no chart library, no AI

### Integrations

- **Management Dashboard**: new "Secretarial Integrity" KPI section, reading only the latest stored run's counts plus a live open-findings count — never triggers a new audit from a page load.
- **Secretarial**: new "Secretarial Integrity" panel per client, reused via a filtered findings query.
- **Entity Lifecycle**: new "Secretarial Integrity Warnings" panel per client, same reuse pattern.
- **Planning Board**: a `critical_integrity_finding` flag (open critical/high findings only), rendered as an "⚠ Integrity Issue" badge — the same lightweight direct-query pattern as every other Planning Board badge this session.

---

## Nothing Regressed

- `beneficial-ownership.js`'s existing ~26 endpoints and `getBeneficialOwnershipProfile()`/`_generateReadinessItems()` behavior are completely unchanged — the only addition is one new export aliasing an existing private function.
- `entity-lifecycle.js`'s existing ~18 endpoints and `getEntityLifecycleProfile()` behavior are completely unchanged — the only addition is one new export of an existing constant.
- `secretarial-calendar.js`'s `buildStatutoryCalendar()` and `secretarial-evidence.js`'s `getChecklistReadiness()` are called read-only, exactly as their existing signatures already support — neither file was modified.
- `management-dashboard.js`'s `computeSummary()` — every existing key (`entity_lifecycle`, `evidence_readiness`, `statutory_compliance`, etc.) is unchanged; `secretarial_integrity` is a new, additive key.
- `planning-board.js`'s `_buildTeamItemPool()` — every existing flag (at-risk, annual-return-due, pending-statutory-change, evidence-blocked, statutory-workload, BO-readiness-concern, lifecycle-transition-pending) is unchanged; `critical_integrity_finding` is a new, additive field.
- `secretarial.js`'s `secLoadClientData()`/`secOnClientChange()` — every existing panel load (recent changes, governance, BO summary, statutory panel, lifecycle panel) is unchanged; the integrity panel load is additive.
- `node --check` passes on every new/modified JS file (see Final Verification below).
- Zero `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` matches introduced by this codebox — confirmed via grep.
- All files verified present on disk immediately after writing.
- A stray no-op ternary (`(critHigh ? '' : '')` — dead code left over from an editing false-start) was caught and removed from `secretarial.js`'s new integrity panel renderer during self-review, before this handoff was written.

---

## IMPORTANT: Migration Must Be Applied

Apply in Supabase SQL Editor → New Query → paste → Run:

`126_practice_secretarial_integrity.sql`

Expected: "Success. No rows returned." No seeding step is required — the three tables start empty; the first "Run Audit" click populates a run and its findings.

---

## Testing Required

*None of the following has been browser-tested. All verification so far was code-review, `node --check`, and grep for browser-storage violations.*

1. Apply migration 126 to Supabase (migrations 117-122, 124-125 should already be live per prior handoffs; 123 was applied earlier in the session)
2. Navigate to `/practice/secretarial-integrity.html` — should show a "—" score and zero summary cards, with "No audits run yet" on the Audit Runs tab
3. Click "Run Audit" — confirm a new run appears with a score, and that severity counts on the run row match the findings actually created
4. Pick a client with no active directors on its Director Register (company_type `pty_ltd` or `cc`) — confirm a `no_active_directors` finding (high) appears for that client
5. Pick a client with a Beneficial Ownership readiness status of `blocked` — confirm a `bo_readiness_blocked` finding (high) appears
6. Pick a client whose Entity Lifecycle status is `deregistered` but who still has an active (non-terminal) lifecycle transition — confirm a `lifecycle_terminal_with_active_workflow` finding (high) appears
7. On an open finding, click "Resolve" — confirm its status becomes Resolved, it disappears from Open Findings, and appears on Resolved Findings with a reviewer/timestamp
8. On an open finding, click "Accept Risk" without typing a reason — confirm it's rejected (400); type a reason and confirm it succeeds and the finding moves to Resolved Findings tagged Accepted Risk
9. On a resolved/accepted-risk finding, click "Reopen" — confirm it returns to Open Findings
10. Run a second audit — confirm it creates a **new** run row (not an update to the first) and that findings from the first run are untouched
11. Go to `/practice/management-dashboard.html` — confirm the new "Secretarial Integrity" KPI section shows the latest run's score/critical count and the live open-findings count
12. Go to `/practice/secretarial.html` for a client with open findings — confirm the new "Secretarial Integrity" panel shows the correct count
13. Go to `/practice/entity-lifecycle.html` for the same client — confirm the "Secretarial Integrity Warnings" panel shows the same open findings
14. Go to `/practice/planning-board.html` for a client with an open critical/high finding — confirm the "⚠ Integrity Issue" badge appears
15. As a non-manager, attempt `POST /run` and any finding review action — confirm 403 on each; confirm all `GET` reads still succeed
16. Log in as a different company — confirm zero cross-company runs/findings/events visible
17. DevTools → Application → Storage → confirm no integrity data in localStorage/sessionStorage/IndexedDB

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: The 'ignored' finding status has no endpoint or event type wired to it
- Confirmed now: The migration's CHECK constraint includes 'ignored' per the spec's literal enum, but no endpoint or event type was specified for reaching it. Inventing an unrequested bulk-dismiss action was judged out of scope for this pass.
- Not yet confirmed: Whether practices want a distinct "ignore this finding permanently, don't show it again, don't count it toward score" action separate from "accepted_risk" (which already requires a reason and is visible on the Resolved Findings tab).
- Risk: None currently — 'ignored' is simply unreachable, not a data-integrity risk.
- Recommended next review point: If requested, add a PUT /findings/:id/ignore endpoint and an 'finding_ignored' event type (small, additive migration + router change) mirroring the accept-risk pattern.
```

```
FOLLOW-UP NOTE
- Area: Director/shareholder-specific register checks are scoped to company_type IN ('pty_ltd', 'cc') only
- Confirmed now: NPCs/trusts/partnerships/sole proprietors have fundamentally different ownership/control structures (members, trustees/beneficiaries, partners, none) that a director/shareholder-shaped check would misclassify as "empty" and falsely flag.
- Not yet confirmed: Whether the practice wants equivalent integrity checks for NPC members, trust trustees/beneficiaries, or partnership partners in a future pass.
- Risk: Low — no false positives are being generated for those entity types today; they simply receive fewer checks (registered office, registration number, financial year-end, annual returns, BO, lifecycle, governance, evidence, and calendar checks all still apply universally).
- Recommended: If requested, add a small NPC/trust/partnership-specific check set additively, following the same _finding()/severity pattern established here.
```

```
FOLLOW-UP NOTE
- Area: Codebox 70 (Practice Client Onboarding + Entity Formation Foundation) is the recommended next codebox
- Confirmed now: This integrity audit intentionally skips clients not yet onboarded into a given module (no secretarial profile, no lifecycle profile, no BO records) — it audits data QUALITY within tracked entities, not onboarding COMPLETENESS across all clients.
- Not yet confirmed: Whether Codebox 70's onboarding foundation should itself trigger or link into an integrity check once a new entity's initial records are created.
- Risk: None — purely a sequencing/design question for the next codebox, not a defect in this one.
- Recommended next review point: Revisit when Codebox 70 is scoped.
```
