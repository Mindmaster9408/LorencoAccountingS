# Ecosystem QA Hub — Implementation Report

**Phase:** 1  
**Date:** May 2026  
**Status:** Implemented locally — NOT committed, NOT pushed.

---

## 1. Summary

Built an internal QA / Smoke Test Hub accessible to super admins at `/qa-hub`. Admins can create time-limited, company-and-app-scoped QA sessions for testers, then run per-app smoke test checklists and export Markdown reports.

Phase 1 is read-only and non-destructive. No normal app permissions were weakened. No business data flows through the new table or routes.

---

## 2. Files Changed

### New files

| File | Purpose |
|------|---------|
| `accounting-ecosystem/backend/config/migrations/026_ecosystem_qa_sessions.sql` | Creates `ecosystem_qa_sessions` table |
| `accounting-ecosystem/backend/shared/routes/qa-hub.routes.js` | API routes — session CRUD (super admin only) |
| `accounting-ecosystem/frontend-ecosystem/ecosystem-qa-hub.html` | Full QA Hub frontend page |
| `docs/future-build/ECOSYSTEM_QA_AND_SMOKE_TEST_ROADMAP.md` | Phase 2–N roadmap |
| `docs/testing/ECOSYSTEM_QA_HUB_IMPLEMENTATION_REPORT.md` | This file |

### Modified files

| File | Change |
|------|--------|
| `accounting-ecosystem/backend/server.js` | Added `qaHubRoutes` require + mount at `/api/ecosystem/qa-sessions` + `/qa-hub` static route |
| `accounting-ecosystem/frontend-ecosystem/admin.html` | Added "🧪 QA Hub" button in topbar linking to `/qa-hub` |

---

## 3. Security Model

| Rule | Implementation |
|------|---------------|
| Internal only | Page guarded client-side (super admin JWT check) + all API routes use `requireSuperAdmin` middleware |
| No client data exposure | `ecosystem_qa_sessions` stores only session metadata (email, mode, allowed app keys, company IDs, expiry) — no actual client data |
| Company/app scoped | `allowed_apps` and `allowed_company_ids` are stored per session — Phase 1 enforces this at the UI level only |
| Time-limited | `expires_at` required; sessions auto-expire via a background update before list responses |
| Coaching App restricted | Backend filters `coaching` out of `allowed_apps` unless both creator email and target email are `ruanvlog@lorenco.co.za` |
| No auth backdoor | New routes do not bypass `authenticateToken` or `requireSuperAdmin`. No new JWT issuance. No impersonation. |
| No localStorage business data | Checklist state is in-memory only. No `localStorage` or `sessionStorage` writes. |
| No permission weakening | No changes to `auth.js`, `permissions.js`, or any module middleware |

---

## 4. Access Modes (Phase 1)

| Mode | What it means | Phase 1 enforcement |
|------|--------------|-------------------|
| `VIEW_ONLY` | Tester can navigate and view. No mutations. | Visual / informational only — backend permissions unchanged |
| `TEST_ASSISTED` | Tester can run the smoke checklist | Same as VIEW_ONLY plus in-page checklist UI |
| `SANDBOX_WRITE` | Future — not available | Backend rejects if sent in Phase 1 |

---

## 5. QA Session Lifecycle

```
Admin creates session
      ↓
status = 'active', expires_at = future
      ↓
Tester (or admin) runs smoke tests against target apps
      ↓
Session expires naturally (auto-expire on next API call)
      OR
Admin calls POST /:id/revoke → status = 'revoked'
```

Auto-expiry is fire-and-forget: on any GET `/` or GET `/active` call, the backend issues a background update for all `active` sessions past `expires_at`. This is eventually consistent — sessions don't expire to the second, but will be cleaned up on the next hub page load.

---

## 6. App Smoke Test Packs

| App | Tests |
|-----|-------|
| Accounting App | 6 items (login, company badge, bank, reports, VAT, audit trail) |
| Paytime Payroll | 5 items (company, employees, payroll items, payrun, reports) |
| Checkout Charlie (POS) | 5 items (products, till, basket, cashup, reports) |
| Inventory / Storehouse | 4 items (items list, stock valuation, BOM, work order) |
| Practice Manager | 4 items (clients, tasks, billing, client detail) |
| Sean AI | 3 items (auth, governance, intelligence logs) |
| Coaching App | 3 items — Ruan only (login, pilot list, journey steps) |

**Total:** 30 test items across 7 apps (27 visible to non-Ruan super admins).

Each item supports: NOT TESTED / PASS / FAIL / BLOCKED + freetext notes.

---

## 7. What Was Not Implemented

| Feature | Reason |
|---------|--------|
| SANDBOX_WRITE mode | Phase 2 — requires sandbox company concept + write audit |
| Real cross-app auth delegation / impersonation | Phase 2 — requires impersonation JWT flow + full audit |
| Backend persistence of checklist state | Phase 1 is in-memory. User must "Copy Markdown" before leaving. |
| Automated smoke probes | Phase 4 — requires per-app probe scripts |
| Company filtering in session creation | Companies loaded from API for checkbox selection, but company-scoped enforcement is UI-only in Phase 1 |
| Email notification on session create/expire | Not implemented — would require email service integration |
| Per-app launch buttons scoped to session | Not implemented — tester navigates to apps manually |

---

## 8. Tests Run

None executed in this implementation session — the migration was written but not run against the database, and the backend was not started.

**Required before declaring QA Hub operational:**

1. Run migration `026_ecosystem_qa_sessions.sql` in Supabase.
2. Start the backend and verify `/api/ecosystem/qa-sessions` returns 401 without token.
3. Login as Ruan → verify `/qa-hub` opens and renders the admin view.
4. Create a session → verify it appears in the sessions table.
5. Revoke the session → verify status changes to `revoked`.
6. Verify coaching app checkbox is disabled for non-Ruan super admins.
7. Verify `Copy Markdown Report` outputs a valid Markdown table.
8. Verify no `localStorage.setItem` calls exist in `ecosystem-qa-hub.html` (search the file).
9. Login as a non-super-admin user → verify `/api/ecosystem/qa-sessions` returns 403.
10. Verify no other app routes, permissions, or middleware were affected.

---

## 9. Remaining Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Phase 1 app-scoping is UI-only | Medium | A tester who obtains a valid super-admin JWT could access any app regardless of session scope. Real enforcement requires Phase 2 impersonation tokens. |
| Auto-expiry is eventually consistent | Low | Sessions past `expires_at` are still shown as `active` until the next hub page load triggers a cleanup. Add a scheduled job in Phase 2 for hard expiry. |
| Coaching app restriction is email-based | Low | Protection depends on correct email comparison. If Ruan's email changes, update `COACHING_ALLOWED_EMAIL` in both `qa-hub.routes.js` and `ecosystem-qa-hub.html`. |
| `ecosystem_qa_sessions` migration not yet applied | High (blocks feature) | Must run `026_ecosystem_qa_sessions.sql` in Supabase before the API routes will work. |

---

## 10. Final Safety Checklist

- [x] No auth backdoor created
- [x] No normal permissions weakened
- [x] QA access is scoped (app + company) and time-limited
- [x] Coaching App not visible to non-Ruan users (both backend + frontend guards)
- [x] No localStorage / sessionStorage writes for QA state or business data
- [x] No git commit done
- [x] No push to GitHub done
