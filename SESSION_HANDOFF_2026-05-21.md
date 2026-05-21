# SESSION HANDOFF — 2026-05-21
## Sean AI Coaching Tab + Infinite Legacy Global Authority

---

## WORKSTREAM A — Infinite Legacy Global Payroll Authority

### What Was Changed

#### 1. `backend/config/migrations/022_global_payroll_authority.sql` — NEW
Added `is_global_payroll_authority BOOLEAN NOT NULL DEFAULT false` to the `companies` table.
Added a unique partial index `idx_companies_single_global_authority` enforcing that at most one company can hold this flag.
Includes a DO block that marks The Infinite Legacy via `WHERE company_name ILIKE '%Infinite Legacy%'` and raises EXCEPTION if 0 or more than 1 row would be marked (prevents ambiguous matches).
Ends with a verification SELECT to confirm the flag is set.

**Run this migration in Supabase SQL Editor before testing the authority endpoint.**

#### 2. `backend/shared/utils/globalAuthority.js` — NEW
Two exported functions:
- `isGlobalPayrollAuthority(companyId)` — returns `true` if the company holds the flag; fails closed (returns `false`) on DB error. Used as a gate in the global KV write route.
- `getGlobalAuthorityCompany()` — returns `{ id, company_name, is_global_payroll_authority }` for the flag-holding company. Used by the read-only endpoint. Returns `null` on error or if no row exists.

**Design intent:** The flag is DB-authoritative. No hardcoded company name, no role assumption.

#### 3. `backend/modules/payroll/routes/kv.js` — MODIFIED
`PUT /global/:key` gate hardened:
- Gate 1: `role === 'super_admin'` only (removed prior `business_owner` global write access)
- Gate 2: `isGlobalPayrollAuthority(req.companyId)` — DB check. Returns 403 if company is not the authority.

**Before:** Any `business_owner` or `super_admin` from any company could write global payroll KV.
**After:** Only a `super_admin` whose company holds `is_global_payroll_authority = true` can write global KV.

Read operations (`GET /global/:key`) are unchanged — any authenticated user can read global standards.

#### 4. `backend/modules/payroll/routes/global-authority.js` — NEW
Read-only endpoint:
```
GET /api/payroll/global-authority
```
Requires `authenticateToken` + `PAYROLL.VIEW` permission.
Returns: `{ ok: true, company_id, company_name, is_global_payroll_authority: true }`
If migration has not been run: 404 with hint to run migration 022.

### What Is Still Pending (PAUSED — Resume Next Session)

#### PENDING 1: Register route in `backend/modules/payroll/index.js`
Add:
```javascript
const globalAuthorityRoutes = require('./routes/global-authority');
router.use('/global-authority', globalAuthorityRoutes);
```
Without this the endpoint returns 404.

#### PENDING 2: Update `frontend-payroll/payroll-items.html` banners
Lines 1785 and 1833 contain hardcoded `"Infinite Legacy"` strings in the global tax config read-only banner and description.
These must be replaced with a dynamic fetch:
```javascript
// In initTaxConfigReadOnly():
const auth = await fetch('/api/payroll/global-authority', { headers: authHeaders() });
const { company_name } = await auth.json();
// Pass company_name to displayGlobalTaxConfig(cfg, updatedAt, company_name)
```
The `displayGlobalTaxConfig` function signature needs a 3rd parameter and must interpolate the name into both banner strings.

### What Was NOT Changed
- No payroll calculation logic touched
- No `payroll-engine.js`, `PayrollCalculationService.js`, or snapshot read path touched
- No finalized period logic touched
- No client payroll data touched
- Migration 022 must still be run manually

### Regression Risk for Authority Changes
**LOW.** The only changed behaviour is:
1. `PUT /global/:key` now also requires `is_global_payroll_authority`. Any `business_owner` role that previously had global write access will now receive 403. This is intentional — global KV writes should only come from The Infinite Legacy.
2. `GET /global/:key` unchanged.
3. No calculation paths touched.

---

## WORKSTREAM B — Sean AI Coaching Tab

### Scope
This workstream adds a complete coaching module to the Sean AI frontend and backend:
- New DB tables (`sean_coaching_cases`, `sean_coaching_audit_log`)
- Rule-based coaching engine (`coaching-engine.js`) — no LLM, no external APIs
- Five backend routes under `/api/sean/coaching/`
- Full frontend tab in `frontend-sean/index.html` (chat panel, pattern dashboard, manual case entry)

**STRICT SCOPE PRESERVED:** No changes made to the Coaching App, Accounting app, Paytime, POS, Inventory, Practice Manager, or the Ecosystem dashboard.

---

### Section 1 — DB Migration: `backend/config/migrations/023_sean_coaching_cases.sql`

#### Table: `sean_coaching_cases`
| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | — |
| `company_id` | INTEGER NOT NULL | FK → companies(id) ON DELETE CASCADE — tenant isolation |
| `trigger_phrase` | TEXT | The coaching input that triggered this case |
| `context` | TEXT | Optional background/situation context |
| `personality_signals` | JSONB | Stored output of `identifyPersonalitySignals()` |
| `emotional_state` | TEXT | Dominant signal label |
| `response_used` | TEXT | The coaching response that was used/suggested |
| `outcome` | TEXT | positive / negative / neutral / unknown |
| `pattern_group` | TEXT | Cluster label for similar cases |
| `confidence` | NUMERIC(5,4) | Normalised [0..1], CHECK constraint enforced |
| `learned_from_user` | BOOLEAN NOT NULL DEFAULT false | True when sourced from feedback |
| `created_by` | TEXT | User email or identifier |
| `created_at` | TIMESTAMPTZ | — |
| `updated_at` | TIMESTAMPTZ | — |

Indexes: `company_id`, `(company_id, pattern_group)`, `(company_id, created_at DESC)`, `(company_id, learned_from_user) WHERE learned_from_user = true`, `(company_id, emotional_state) WHERE emotional_state IS NOT NULL`.

#### Table: `sean_coaching_audit_log`
Logs: `coaching_case_created`, `coaching_chat_submitted`, `coaching_response_suggested`, `coaching_feedback_saved`, `coaching_pattern_built`.
No raw sensitive text in the `metadata` column — summary data only (input_length, signal_count, pattern_group, etc.).

**Run this migration in Supabase SQL Editor before using the coaching tab.**

---

### Section 2 — Coaching Engine: `backend/sean/coaching-engine.js`

Pure server-side, rule-based. No LLM. No external API calls. No browser-side state.

#### Signal Rules (7 total)
Each rule defines a `label`, `keywords` array (bilingual: Afrikaans + English), and a `weight` multiplier.

| Label | Description | Weight |
|-------|-------------|--------|
| `control_perfectionism` | Need for control, perfectionism, rigid rule-following | 1.5 |
| `isolated_disconnected` | Feeling alone, misunderstood, cut off | 1.5 |
| `passive_stuck` | Feeling trapped, unable to act, helpless | 1.5 |
| `anxious_overwhelmed` | Fear, anxiety, stress, overwhelm | 1.3 |
| `motivated_action` | Readiness to act, motivation, forward movement | 1.0 |
| `grief_loss` | Grief, loss, mourning | 1.4 |
| `relationship_conflict` | Conflict, tension in relationships | 1.2 |

**IMPORTANT DISCLAIMER (embedded in engine source):** These are COACHING SIGNALS only. They are NOT medical, psychiatric, or psychological diagnoses. Labels describe input text patterns, not clinical assessments of any person.

#### `identifyPersonalitySignals(inputText)`
Returns: `{ signals: [{label, score, matchedKeywords, weight}], dominant: string|null, signalCount: number }`
Score = sum of `weight` per matched keyword across all rules. Sorted descending. `dominant` = label with highest score.

#### Scoring Methodology: `scoreCaseMatch(inputText, emotionalState, dominantSignal, caseRecord)`
Mirrors `knowledge-base.js` scoring:
- `trigger_phrase` keyword match: **+10 per keyword** (high weight — like title match)
- `context` keyword match: **+1 per keyword** (lower weight — like content match)
- `emotional_state` exact match bonus: **+5**
- Dominant signal alignment bonus: **+3**

#### `findSimilarCases(inputText, companyId, supabase, signalResult, minConfidence)`
Fetches latest 200 cases for the company. Scores each. Normalises:
```
confidence = min(rawScore / (keywords.length × 10), 1.0)
```
Returns scored cases sorted descending, filtered by `minConfidence` (default 0.0).

#### `buildPattern(scoredCases)`
Takes top N scored cases (capped at 10 in the route). Uses confidence-weighted aggregation to find:
- Dominant `pattern_group`
- Dominant `emotional_state`
- Most frequently used `response_used`
- `avgConfidence` across cases, `caseCount`

#### `suggestResponse(pattern, emotionalState, confidence)`
- `confidence < 0.65`: returns uncertainty prompt: `"Ek leer nog hieroor. Kan jy my help om hierdie situasie beter te verstaan?"` — source: `'uncertain'`
- Pattern has `bestResponse`: returns it — source: `'stored'`
- Pattern matched but no stored response: returns signal-aware Afrikaans framing per signal label — source: `'signal_aware'`

#### `CONFIDENCE_THRESHOLD = 0.65` (exported constant, used by route)

---

### Section 3 — Backend Routes: `backend/sean/coaching-routes.js`

Mounted at `/api/sean/coaching/` (registered in `backend/sean/routes.js`).

#### Auth
`router.use(authenticateToken)` — belt-and-suspenders. `/api/sean` is already gated in `server.js`.

#### Tenant Safety
`getCompanyId(req)` extracts `req.companyId || req.user?.companyId`. All routes return 400 if no company context. Every DB query filters by `company_id`. Company A cannot read or modify Company B cases.

#### Audit Logging
`auditLog()` is fire-and-forget — failures are logged to console but never return errors to the client. No raw sensitive text (trigger content) is written to the audit log — only metadata (input_length, signal_count, pattern_group, dominant_signal, confidence).

#### `GET /api/sean/coaching/cases`
Lists coaching cases for the authenticated company.
Optional filters: `pattern_group`, `emotional_state`, `learned_from_user`, `limit` (default 50, max 200).
Returns: `{ ok, count, cases: [{id, triggerPhrase, context, personalitySignals, emotionalState, responseUsed, outcome, patternGroup, confidence, learnedFromUser, createdBy, createdAt}] }`

#### `POST /api/sean/coaching/cases`
Manually creates a coaching case. `learned_from_user` defaults to `false` for manual entries.
Audits: `coaching_case_created`.

#### `POST /api/sean/coaching/chat`
Full coaching chat flow:
1. `identifyPersonalitySignals(inputText)` — detect signals
2. `findSimilarCases(inputText, companyId, supabase, signalResult)` — score DB cases
3. If `topConfidence >= 0.65`: `buildPattern(top10)` → `suggestResponse(pattern, dominant, confidence)` — audit `coaching_pattern_built`
4. Else: `suggestResponse(null, dominant, 0)` — uncertainty prompt
5. Audit `coaching_chat_submitted` and `coaching_response_suggested`

Returns: `{ ok, response, confidence, source, signals, dominantSignal, patternGroup, matchedCases, isUncertain }`

#### `POST /api/sean/coaching/feedback`
Records user feedback on a coaching response. Saves as a new learned case (`learned_from_user: true`).
- `outcome === 'positive'`: stores `response_given`
- `outcome === 'negative'`: stores `better_response`
Audits: `coaching_feedback_saved`.

#### `GET /api/sean/coaching/patterns`
Returns pattern dashboard stats:
- `total`, `learnedFromUser`, `manualEntries`
- `patternGroups`: array of `{ group, caseCount, avgConfidence }` sorted by count desc
- `recentCases`: last 5 cases — summary only (no trigger text)

---

### Section 4 — Frontend: `frontend-sean/index.html`

#### Nav Tab Added
```html
<button class="nav-tab" data-tab="coaching" onclick="switchTab('coaching')">🧘 Coaching</button>
```

#### `switchTab()` Updated
```javascript
if (tabId === 'coaching') loadCoachingTab();
```

#### Tab Content: `<div id="tab-coaching">`
Three sections:

**Section A — Coaching Chat Panel**
- `#coachingMessages` — scrollable chat area with `msg-user` / `msg-sean` classes
- `#coachingMeta` — confidence %, pattern group, signal, source badge (hidden until response)
- `#coachingFeedbackRow` — "Dit het gewerk ✓" / "Verbeter dit ✗" buttons (hidden until response)
- `#coachingNegativePanel` — `#coachingBetterResponse` textarea + "Stoor verbetering" button (hidden until ✗ clicked)
- `#coachingInput` textarea + "Stuur" button — Enter key sends (Shift+Enter inserts newline)
- Disclaimer banner: coaching signals are niet diagnoses nie

**Section B — Pattern Dashboard**
- Stats grid: `#coachingStatTotal`, `#coachingStatLearned`, `#coachingStatManual`
- Pattern groups table: `#coachingPatternGroupsBody`
- Recent cases table: `#coachingRecentCasesBody` (5 cases, no trigger text)
- "🔄 Verfris" button, "➕ Leer Nuwe Geval" button

**Section C — Manual Case Entry: `#coachingManualForm`**
Form fields: trigger_phrase (required), context, emotional_state (dropdown with all 7 signal labels), pattern_group, response_used, outcome (dropdown), confidence [0..1].
Hidden by default. Shown via "Leer Nuwe Geval" button. Hidden + reset via "Kanselleer".

#### Coaching JavaScript Functions

| Function | Purpose |
|----------|---------|
| `loadCoachingTab()` | Called by `switchTab('coaching')` — triggers `loadCoachingPatterns()` |
| `sendCoachingChat()` | POST /sean/coaching/chat, renders response, shows meta + feedback UI |
| `showCoachingNegativeFeedback()` | Shows `#coachingNegativePanel` |
| `submitCoachingFeedback(outcome)` | POST /sean/coaching/feedback with `_coachingLast` context |
| `loadCoachingPatterns()` | GET /sean/coaching/patterns, renders stats grid + tables |
| `showManualCaseForm()` | Shows `#coachingManualForm`, scrolls to it |
| `hideManualCaseForm()` | Hides + resets all form fields |
| `saveManualCase()` | POST /sean/coaching/cases with validation |

**State variable:** `_coachingLast` stores `{ original_message, response_given, pattern_group, dominant_signal, confidence }` from the last response. Cleared after feedback is submitted or on new chat send.

**No localStorage / sessionStorage used for any coaching data.** Compliant with CLAUDE.md RULE D1.

---

### Section 5 — Privacy, Disclaimers, and Safety

1. **Not diagnoses:** Engine source, route comments, and frontend banner all state clearly that coaching signals are NOT medical/psychiatric/psychological diagnoses or assessments.
2. **Signal language only:** `suggestResponse` uses `"Dit klink asof..."` framing, never asserting what a person IS.
3. **Multi-tenant isolation:** Every DB query filtered by `company_id`. 400 returned if no company context.
4. **Audit log privacy:** No raw trigger text in `sean_coaching_audit_log`. Only metadata.
5. **Recent cases API:** Returns summary fields only — no `trigger_phrase` in the patterns endpoint response.

---

### Section 6 — Verification Checklist (15 Items)

Before marking coaching as production-ready, verify:

| # | Test | Expected |
|---|------|----------|
| 1 | Run migration 023 in Supabase | Both tables created, all 5 indexes exist |
| 2 | POST /api/sean/coaching/chat with a message | Returns `{ ok, response, confidence, source, signals }` |
| 3 | `confidence < 0.65` response | Returns "Ek leer nog hieroor..." and `isUncertain: true` |
| 4 | `confidence >= 0.65` with stored response | Returns `source: 'stored'` and the stored response text |
| 5 | `confidence >= 0.65` without stored response | Returns `source: 'signal_aware'` with signal-aware framing |
| 6 | POST /api/sean/coaching/feedback with `outcome: 'positive'` | `learned: true` in response, new case in DB with `learned_from_user: true` |
| 7 | POST /api/sean/coaching/feedback with `outcome: 'negative'` | `better_response` stored in `response_used`, `learned_from_user: true` |
| 8 | GET /api/sean/coaching/patterns | Returns stats with `total`, `learnedFromUser`, `patternGroups`, `recentCases` |
| 9 | Company A cannot read Company B cases | GET /cases returns empty for a different `companyId` |
| 10 | Missing company context | All routes return `400: Company context required` |
| 11 | Click "🧘 Coaching" nav tab | Tab content appears, `loadCoachingPatterns()` fires |
| 12 | Send a chat message in UI | Message appears, "Thinking" placeholder, then response |
| 13 | "Dit het gewerk ✓" button | Feedback submitted, confirmation message shown, buttons hidden |
| 14 | "Verbeter dit ✗" button | Textarea appears, "Stoor verbetering" submits and learns |
| 15 | "Leer Nuwe Geval" → fill form → "Stoor Geval" | Case saved via POST /cases, patterns dashboard refreshes |

---

### Section 7 — Files Changed This Session

| File | Status | Notes |
|------|--------|-------|
| `backend/config/migrations/022_global_payroll_authority.sql` | NEW | Global authority flag migration |
| `backend/config/migrations/023_sean_coaching_cases.sql` | NEW | Coaching tables migration |
| `backend/shared/utils/globalAuthority.js` | NEW | DB-authoritative authority helpers |
| `backend/modules/payroll/routes/kv.js` | MODIFIED | PUT /global/:key now requires authority check |
| `backend/modules/payroll/routes/global-authority.js` | NEW | Read-only authority info endpoint |
| `backend/sean/coaching-engine.js` | NEW | Rule-based signal detection + pattern matching |
| `backend/sean/coaching-routes.js` | NEW | 5 coaching routes with auth + audit |
| `backend/sean/routes.js` | MODIFIED | Registered coaching sub-router |
| `frontend-sean/index.html` | MODIFIED | Nav tab, tab content (A/B/C), switchTab, coaching JS |

---

### Section 8 — What Was NOT Changed

- No Coaching App files touched
- No Paytime payroll engine or calculation service touched
- No Accounting app files touched
- No POS, Inventory, or Practice Manager files touched
- No Ecosystem dashboard files touched
- No finalized snapshot read path touched
- No browser storage used for coaching data
- No hardcoded company name in authority logic (DB-authoritative)
- No LLM or external API calls in coaching engine

---

### Section 9 — Pending Follow-Ups

```
FOLLOW-UP NOTE
- Area: Paytime Global Authority UI
- Dependency: global-authority route not yet registered in payroll index.js
- Confirmed now: Route file created, helper utilities built, migration written
- Not yet confirmed: Route is registered and endpoint returns 200
- Risk if wrong: GET /api/payroll/global-authority returns 404; payroll-items.html banners still show hardcoded "Infinite Legacy"
- Recommended next check: Next session — register route, update banner JS, test end-to-end

FOLLOW-UP NOTE
- Area: Sean Coaching — production readiness
- Dependency: Both migrations (022 and 023) must be run in Supabase
- Confirmed now: All backend and frontend code is complete
- Not yet confirmed: Migrations executed, DB tables exist, all 15 verification tests pass
- Risk if wrong: Coaching tab will show API errors until migrations are run
- Recommended next check: Run migrations, then verify the 15-item checklist above
```

---

## WORKSTREAM C — Safe Pay Run Reversal / Unlock Workflow

### What Was Changed

#### 1. `backend/config/migrations/024_payroll_run_reversal.sql` — NEW
Adds reversal support to the DB schema:
- Extends `payroll_runs.status` CHECK to include `'reversed'`
- Adds `reversed_at TIMESTAMPTZ`, `reversed_by INTEGER`, `reversal_reason TEXT` to `payroll_runs`
- Extends `payroll_snapshots.status` CHECK to include `'reversed'`
- Adds `reversed_at TIMESTAMPTZ`, `reversed_by INTEGER` to `payroll_snapshots`
- **Drops** `idx_payroll_snapshots_unique` (was unconditional — blocked re-run after reversal)
- **Creates** `idx_payroll_snapshots_active_unique ON payroll_snapshots (company_id, employee_id, period_key) WHERE status != 'reversed'`

**Run this migration in Supabase SQL Editor before testing the reversal flow.**

#### 2. `backend/modules/payroll/services/PayrollHistoryService.js` — MODIFIED
- `getSnapshot()`: added `.neq('status', 'reversed')` filter — prevents `maybeSingle()` ambiguity after reversal creates two rows for same period
- `listSnapshots()`: added `includeReversed` option (default: false, excludes reversed from normal views)
- Added `reverseSnapshotsForRun(supabase, runId, companyId, userId)` — sets all run snapshots to `status='reversed', is_locked=false, reversed_at, reversed_by`
- Added `reversePayrollRun(supabase, runId, companyId, userId, reason)` — sets run to `status='reversed'`
- Updated `module.exports` to export new methods

#### 3. `backend/modules/payroll/routes/payruns.js` — MODIFIED
- Added `POST /api/payroll/reverse` route — requires `PAYROLL.APPROVE` permission
  - Validates `run_id`, `period_key`, `reason` (reason is mandatory for audit trail)
  - Verifies run belongs to company and is currently `'finalized'`
  - Calls `reverseSnapshotsForRun` then `reversePayrollRun` atomically
  - Records audit log entry `PAYROLL_REVERSE`
  - Returns `{ success, run_id, period_key, reversed_count, timestamp }`
- Updated `GET /api/payroll/history` to accept `status='reversed'` and `include_reversed=true` query params

#### 4. `backend/modules/payroll/routes/unlock.js` — MODIFIED
Added pre-check before credential verification:
- Fetches snapshot for `empId/period/companyId` where `is_locked=true`
- If snapshot has a `payroll_run_id`, fetches that run
- If run `status === 'finalized'` → returns HTTP 422 with `{ code: 'REQUIRES_RUN_REVERSAL', run_id }`
- Pre-check failure is non-fatal (fails open to allow individual unlock as fallback)

#### 5. `frontend-payroll/js/payroll-api.js` — MODIFIED
- Added `reverse(runId, periodKey, reason)` method — `POST /api/payroll/reverse`
- Added `getHistoryAll(periodKey)` method — `GET /api/payroll/history?include_reversed=true`

#### 6. `frontend-payroll/payroll-execution.html` — MODIFIED
- Added `.status-reversed` CSS badge (red) and `.btn-reverse` / reversal modal CSS
- Added "🔄 Reverse Pay Run" button to `#finalized-badge` div (shown when run is finalized)
- Added `#reversalModal` HTML — reason textarea (required), confirmation button
- Added `openReversalModal()` / `closeReversalModal()` / `confirmReversal()` functions
- Added `openHistoryReversalModal(runId, periodKey)` — allows reversing from the history view
- Updated `loadHistory()` to call `PayrollAPI.getHistoryAll()` (includes reversed — full audit)
- Updated `renderHistorySnapshots()` to detect reversed runs, show red badge + "[Reversed — audit record]" label
- Updated `renderRunDetailPanel()` to handle `isReversed` parameter — suppresses statutory returns for reversed runs, shows "↩ Reversed" label, shows "Reverse This Run" button for finalized runs
- Updated snapshot status badges to show `status-reversed` for reversed snapshots
- Updated `loadRunDetail()` status badge to handle `'reversed'` status

#### 7. `frontend-payroll/employee-detail.html` — MODIFIED
- Added `var _lockedRunId = null` state variable
- When `_isDbLocked = true`: captures `_lockedRunId = calcResult.data.snapshot.payroll_run_id`
- Updated locked status bar message: shows "Execute Payroll → Reverse Pay Run" guidance when `_lockedRunId` is set
- Updated `requestManagerAuth()` → now `async`: pre-checks run status via `PayrollAPI.getRunDetail(_lockedRunId)`. If `status === 'finalized'`, shows alert directing to Execute Payroll and returns without showing modal
- Updated `verifyManagerAuth()`: handles `code === 'REQUIRES_RUN_REVERSAL'` server response — closes modal and shows correct guidance message

### Architecture

```
POST /api/payroll/reverse
  → verify run is 'finalized' + belongs to company
  → reverseSnapshotsForRun (status='reversed', is_locked=false)
  → reversePayrollRun (status='reversed', reason recorded)
  → audit log

After reversal:
  → POST /api/payroll/run (creates new draft snapshots — allowed by conditional index)
  → POST /api/payroll/finalize (locks new snapshots)
  → Old reversed snapshots preserved for audit forever
```

### DB Migration Required
**Run `024_payroll_run_reversal.sql` in Supabase SQL Editor before testing.**
Includes verification query — expected result: all 4 checks return count ≥ 1.

### What Was NOT Changed
- PayrollEngine and calculation logic — untouched
- Tax logic — untouched
- YTD logic — untouched
- PAYE/UIF/SDL rules — untouched
- No hard deletes of any payroll data
- No browser storage used

### Regression Tests Required (RULE E3)
Before push: TEST-PAY-02, TEST-PAY-09, TEST-PAY-10, TEST-PAY-11, TEST-PAY-12, TEST-PAY-13

```
FOLLOW-UP NOTE
- Area: Payroll Run Reversal
- Dependency: Migration 024 must be run in Supabase SQL Editor
- Confirmed now: All backend routes, service methods, and frontend UI implemented
- Not yet confirmed: Migration executed, reversal end-to-end tested, regression tests run
- Risk if wrong: getSnapshot() may return ambiguous rows if conditional index not applied; reverse route will fail on status CHECK violation
- Recommended next check: Run migration 024, test full reversal flow (finalize → reverse → re-run → re-finalize), run TEST-PAY-09 through TEST-PAY-13
```

---

*Session date: 2026-05-21*
*Changed by: Ruan van Loggerenberg*
*Co-authored with: Claude Sonnet 4.6*

---

## WORKSTREAM D — Sean AI Coaching Tab Rebuild: Client Context Chat + Quick Actions

### What Was Changed

#### 1. `accounting-ecosystem/backend/sean/coaching-routes.js` — MODIFIED (new routes appended)

**All existing 5 routes unchanged.** New additions before `module.exports`:

**New helpers:**
- `COACHING_APP_URL` / `COACHING_APP_TOKEN` — env vars for Coaching App proxy
- `requireCoachingAccess(req, res, next)` — checks `users.has_coaching_access = true` in ecosystem DB; blocks with 403 if not set
- `coachingAppFetch(path, opts)` — proxies to Coaching App backend using service token; throws `err.code = 'NOT_CONFIGURED'` if env vars missing

**New routes (all require `requireCoachingAccess`):**
- `GET /api/sean/coaching/clients/search?q=` — search Coaching App clients by name (min 2 chars, max 10 results)
- `GET /api/sean/coaching/clients/:clientId/context` — lightweight context for chat: name, step, dream, gauges, latest session
- `GET /api/sean/coaching/clients/:clientId/latest-session` — most recent session notes (date, summary, insights, actions, mood)
- `GET /api/sean/coaching/clients/:clientId/full-profile` — full profile: all steps, all 9 gauges as bar chart data, last 5 sessions
- `POST /api/sean/coaching/client-chat` — coaching chat with optional `coaching_client_id`; injects client context prefix into CoachingEngine input
- `POST /api/sean/coaching/session-prep/:clientId` — structured session prep: step name, gauge highlights (concerns/strengths), last session summary + actions

**Audit logging:** All new routes write to `sean_coaching_audit_log` via the existing `auditLog()` helper.

**Multi-tenant safety:** `getCompanyId(req)` used throughout; `has_coaching_access` check enforced on every request.

#### 2. `accounting-ecosystem/frontend-sean/index.html` — MODIFIED (coaching tab only)

**HTML replaced** (old: disclaimer + pattern chat + pattern dashboard + manual case entry → new: 4 sections):
- Mode toggle bar: Algemeen / Klient buttons
- Section A: Client search panel (only visible in Klient mode) with live search input + results dropdown
- Section B: Selected client badge (name + step + last session date) with clear button
- Section C: Chat interface with mode indicator + messages area + input
- Section D: Quick Actions panel (only visible when client selected) with Berei Sessie Voor / Vorige Sessie Notas / Volle Profiel buttons + `#coachingActionPanel` output area

**JS replaced** (all old coaching functions removed, new ones added):
- State: `_coachingMode` (string, default 'algemeen') and `_coachingClient` (object or null) — **JS variables only, no localStorage**
- `loadCoachingTab()` — calls `switchCoachingMode(_coachingMode)` (name preserved, required by `switchTab()`)
- `switchCoachingMode(mode)` — toggles mode buttons, shows/hides client section and quick actions
- `searchCoachingClients()` — debounced 300ms, calls `/api/sean/coaching/clients/search`
- `selectCoachingClient(id, name, step, lastSession)` — sets `_coachingClient`, updates badge, shows quick actions
- `clearCoachingClient()` — clears `_coachingClient`, hides badge and quick actions
- `sendCoachingClientChat()` — sends message to `/api/sean/coaching/client-chat` with optional `coaching_client_id`
- `clearCoachingActionPanel()` — hides and clears the action output div
- `runSessionPrep()` — calls `/api/sean/coaching/session-prep/:id`, renders gauge highlights + step + last session
- `loadLatestSession()` — calls `/api/sean/coaching/clients/:id/latest-session`, renders session notes
- `loadFullProfile()` — calls `/api/sean/coaching/clients/:id/full-profile`, renders gauge bar charts + steps + sessions
- `_renderGaugeHighlights(highlights)` — renders concerns/strengths summary from session prep data

**No localStorage used anywhere in new coaching code.** Chat messages live in DOM only (cleared on page refresh or client change).

---

### Architecture Notes

**Authentication chain:**
1. Ecosystem user logs in → JWT stored in `localStorage.sean_token` (auth token only — permitted)
2. User opens coaching tab → every API call uses ecosystem JWT (`Bearer ${token}`)
3. `requireCoachingAccess` checks `users.has_coaching_access` in ecosystem DB → only `ruanvlog@lorenco.co.za` has this set
4. Backend proxy uses `COACHING_APP_TOKEN` env var → calls Coaching App as service account

**Coaching App data contract used:**
- `GET /api/clients/:id` returns `{ client: { ...all columns, steps[], gauges{}, sessions[] } }`
- `sessions` = last 10 sessions ordered by `session_date DESC`
- `gauges` = 9 keys: fuel, horizon, thrust, engine, compass, positive, weight, nav, negative (0–100)
- Table: `coaching_clients` (canonical — confirmed from `clients.routes.js`)

---

### Deployment Setup Required

Two env vars must be added to the ecosystem backend (Zeabur service environment):

```
COACHING_APP_URL=https://<coaching-app-hostname>
COACHING_APP_TOKEN=<valid Coaching App JWT for the service/coach account>
```

The `COACHING_APP_TOKEN` must be a valid JWT issued by the Coaching App's own `/api/auth` route for the coach account. Until these are set, the new routes return 503 with a clear error message ("Coaching App integration not configured..."). The frontend shows this as a user-readable Afrikaans message.

---

### What Was NOT Changed

- All other tabs in `frontend-sean/index.html` (Dashboard, Chat, Transactions, Calculator, Codex, Categories) — untouched
- All existing 5 routes in `coaching-routes.js` (GET /cases, POST /cases, POST /chat, POST /feedback, GET /patterns) — untouched
- Coaching App backend — not modified (task spec: "Do NOT modify Coaching App code")
- No payroll files modified — no regression tests required

---

```
FOLLOW-UP NOTE
- Area: Sean Coaching Tab — Deployment
- Dependency: COACHING_APP_URL + COACHING_APP_TOKEN env vars
- Confirmed now: All backend routes + frontend UI implemented and verified
- Not yet confirmed: Env vars set in Zeabur; end-to-end test against live Coaching App
- Risk if wrong: Routes return 503; frontend shows error message (graceful degradation)
- Recommended next check: Set env vars in Zeabur, open coaching tab, switch to Klient mode, search a client name, select client, test all 3 quick actions
```

