# Pilot Smoke Testing — Future Build Roadmap

> **Status:** Roadmap only. No items below are implemented yet.  
> **Current baseline:** Pilot Smoke Test Pack v01 (manual guided testing with DB-backed evidence storage)  
> **Created:** 2026-05

---

## Phase 1 (current — v01): Manual Guided Testing ✅

Delivered:
- Static test pack (23 tests across 6 categories)
- Browser-based checklist UI with Pass / Fail / Blocked / Not Tested recording
- Notes, screenshot reference, error text capture per test item
- DB-backed run storage (company-scoped)
- Markdown export
- Load/save previous runs
- Navigation integration under Administration → QA

---

## Phase 2: Evidence Enhancement

**Screenshot Upload (not just reference text)**  
- Add `screenshot_data` BYTEA or `screenshot_url TEXT` to `pilot_smoke_test_results`  
- Upload endpoint: `POST /api/accounting/pilot-smoke-tests/runs/:id/results/:resultId/screenshot`  
- Store screenshots in Supabase Storage bucket `qa-evidence/`  
- Show thumbnail previews in the checklist UI  
- Retention policy: 90 days  

**Screen Recording Reference**  
- Free-text field for screen recording filename / link (Loom, local file path, etc.)  

**Attachments**  
- Multi-file upload per test item (PDF error dumps, log excerpts)  
- Stored in `qa-evidence/` bucket, linked via `pilot_smoke_test_result_attachments` table  

---

## Phase 3: Regression Tracking & Trending

**Per-test History View**  
- For any given test key, show the last N run results as a timeline  
- Surface: "bank_import_statement has been failing for 3 consecutive runs"  

**Test Pack Versioning**  
- Version the test template in the DB rather than hardcoding  
- `pilot_smoke_test_templates` table (already in initial design, deferred to v01+)  
- Allow adding new tests or deprecating old ones with `deprecated_at` timestamp  
- Runs pin to the template version at time of creation  

**Trending Dashboard**  
- Company-scoped: pass rate trend over time, failure frequency by category  
- Highlight the top 3 most-failed tests (ongoing reliability signal)  

**Regression Alerts**  
- If a test that passed in the last N runs is now failing, mark it as "REGRESSION" in the UI  
- Badge on checklist item + separate "Regressions" summary section at top of page  

---

## Phase 4: Sean AI Integration

**Failure Summary Narratives**  
- After a run is saved, Sean analyses the FAIL + BLOCKED results  
- Generates a human-readable QA summary: "3 critical failures detected in Bank and AR/AP. Likely linked to the latest bank statement import refactor."  
- Stored as `ai_summary TEXT` on `pilot_smoke_test_runs`  

**Pattern Detection**  
- Sean identifies recurring failure patterns across runs and flags them  
- "bank_allocate_transaction has failed or been blocked in 4 of the last 5 runs"  
- Stored in Sean's knowledge system  

**Auto-Suggested Bug Report**  
- For each FAIL result, Sean drafts a structured bug ticket (title, description, steps to reproduce, expected vs actual)  
- Tester can copy/edit/submit  

---

## Phase 5: Playwright / Cypress Integration

**Semi-automated Execution**  
- For tests with deterministic UI flows, Playwright scripts can execute the test and auto-capture pass/fail  
- Manual tests (judgment-based, e.g. "VAT warnings look correct") remain manual  

**Hybrid Checklist**  
- Automated tests show status from last Playwright run  
- Manual tests remain manual with human status buttons  
- Test item has `automation_type`: `manual | automated | hybrid`  

**Playwright Run Trigger**  
- Trigger a Playwright run from the smoke test UI ("Run Automated Tests" button)  
- Results stream back in real-time to the checklist  
- Screenshots captured automatically and stored in `qa-evidence/`  

**CI/CD Integration**  
- Playwright smoke tests run as part of the deployment pipeline  
- Failing critical tests block the deployment  
- Smoke test report generated and stored for each deployment  

---

## Phase 6: Release Certification Workflow

**Run Statuses**  
Extend `pilot_smoke_test_runs` with:  
- `status`: `in_progress | complete | certified | failed`  
- `certified_by`: user ID  
- `certified_at`: TIMESTAMPTZ  
- `release_version`: TEXT  

**Certification Gate**  
- Admin/accountant can certify a completed run as "Release Certified"  
- Certification requires: 0 FAIL results on critical-severity tests, all critical tests tested  
- Certified runs cannot be edited  

**Release Notes Auto-Generation**  
- Certified runs can generate a release QA sign-off document  
- Format: Markdown, includes tester, date, build version, test results summary, any blocked items with notes  

---

## Phase 7: Multi-Tester Coordination

**Parallel Test Runs**  
- Multiple testers can work on the same run simultaneously  
- Real-time result updates via polling or WebSocket  
- Conflict resolution: last write wins per test item  

**Tester Assignment**  
- Assign specific test categories to specific testers  
- "Ruan owns Bank + VAT, Lorenzo owns AR/AP + Reports"  
- Dashboard shows per-tester progress  

**Run Merging**  
- Merge results from two separate runs into a single certified run  

---

## Phase 8: External Issue Tracker Integration

**GitHub Issues**  
- One-click create GitHub Issue from a FAIL result  
- Pre-populated with: test name, failure notes, error text, screenshot link  
- Issue link stored on the result row  

**Jira / Linear**  
- Same pattern, different target  
- Configurable per-company in AI Settings  

**Auto-close on Pass**  
- If a test was previously linked to an issue and now passes, flag the issue for auto-close  

---

## Phase 9: Deployment Gating

**Pre-deploy Smoke Gate**  
- Before a Zeabur deployment is triggered, a smoke test run must be in state `certified`  
- Run must have been completed within the last 24h  
- Zeabur pre-deploy hook calls `/api/accounting/pilot-smoke-tests/gate/check`  
- Gate returns: `{ approved: true/false, reason, lastRunId, certifiedBy }`  

**Override**  
- Super admin can override the gate with a documented reason  
- Override is logged in the audit trail  

---

## Known Constraints / Not In Scope (current build)

| Out of scope | Reason |
|---|---|
| Playwright automation | Deferred — Phase 5 |
| Screenshot uploads | Deferred — Phase 2 |
| Cross-company run comparison | Architectural decision — strict company isolation |
| Test pack editing UI | Hardcoded is intentional for v01 stability |
| Sean AI integration | Deferred — Phase 4 |
| Public read links (share run) | Security review required first |

---

*This roadmap is the authoritative forward-planning document for the Pilot Smoke Test Pack.*  
*All Phase 1 items are implemented. All Phase 2+ items are future builds — do not implement without explicit task assignment.*
