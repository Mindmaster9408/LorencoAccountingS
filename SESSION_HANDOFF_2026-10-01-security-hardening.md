# Session Handoff — 2026-10-01 — Tenant-isolation & credential hardening

**Status:** Built and tested locally. **NOT committed, NOT pushed** (Ruan: "build and test first, push nothing").
**Trigger:** read-only impact audit for the planned user-profile/invite model (`docs/future-build/USER_PROFILE_MODEL_IMPACT_AUDIT_2026-10-01.md`) found live cross-tenant holes; Ruan authorised fixing them.

---

## 1. URGENT — actions only Ruan can take (no push needed)

1. **Change the master super-admin password now.** It was hardcoded in `server.js`, `config/seed.js`, test scripts and docs, and was **shown pre-filled + as visible text on the public `/sean` page** of the live site. Treat it as compromised; it stays in git history forever.
2. **Ask MJ and Anrich to change their passwords** — their initial passwords were hardcoded in `config/seed.js` and migration `028_add_anrich_superuser.sql` (git history).
3. Make sure Zeabur does **not** have `FORCE_RESET_ADMIN=true` set. If it ever is, the reset endpoint now also needs `FORCE_RESET_ADMIN_PASSWORD` (≥12 chars) — there is no default password any more.
4. Check whether an `admin@test.com` user exists in production (it is documented as a super admin with password `admin123` in `TEST-CREDENTIALS.md`). If it exists, deactivate it.
5. Run the exploitation check in §6 to see whether the eco-clients takeover hole was ever used.

---

## 2. What was changed (per file)

| File | Change | Root cause fixed |
|---|---|---|
| `backend/shared/routes/eco-clients.js` | `POST /`: non-admin may not send `client_company_id`; may only create under a practice they manage (management role); may not pre-activate Firmflow. `PUT /:id`, `DELETE /:id`: caller must manage the client's practice. `GET /:id/firm-access`: managing firm only. New helpers `canManageClientsOf`, `loadManagedClient`. | **CRITICAL:** any self-registered user could link ANY company to their own "practice" and then `select-company` into it as owner (full takeover). PUT/DELETE had no ownership check at all. |
| `backend/shared/routes/users.js` | `PUT/DELETE /:id`: target must be a member of caller's company; multi-company users' name/email/username/is_active super-admin only; delete of a multi-company user = remove from this company only; `company_ids` super-admin only. `PUT /:id/password`: only the real owner (`business_owner`), only for users exclusive to that company and not owners/super admins. `DELETE /:id/company-access`: cannot remove a higher role. Session invalidation on every access change. | Any business_owner could edit/deactivate any user platform-wide by id (P1); owner-equivalent roles could reset passwords of people who also work elsewhere (P10). |
| `backend/shared/routes/auth.js` (HIGH) | Company user create / link-existing / remove require a management role **at the target company**; role level judged at the target company; cannot remove a higher role; session invalidation on remove. Module constants moved to `config/company-modules.js`. | Any member, incl. a cashier, could create users with any role (P2). |
| `backend/shared/routes/companies.js` (HIGH) | `POST /`: non-admin always gets `BASE_MODULES` (ignores body list). `PUT /:id`: tenant guard (same rule as GET); `modules_enabled` and `is_active` super-admin only. | Anyone with COMPANIES.EDIT could edit ANY company by id — incl. bank details and active status. Companies could self-grant modules (e.g. Firmflow) (P3). |
| `backend/config/company-modules.js` (new) | `BASE_MODULES`, `trialModulesFor`, `TRIAL_PERIOD_MS` — single source for auth.js + companies.js. | Two paths decided modules separately and had drifted. |
| `backend/middleware/auth.js` (HIGH) | Session check also reads the membership's `role` + `apps_access` (same query). Token role ≠ DB role → 401 `SESSION_ROLE_CHANGED` (super_admin exempt). New `invalidateUserSessions(userId)`. Sets `req.companyAccess`. | Role changes only took effect on re-login (up to 12 h); removals up to 60 s (P7). Ruan's rule: immediate. |
| `backend/middleware/module-check.js` | Enforces `apps_access` per request (`sean` exempt). | App removal only enforced when an app was opened. |
| `backend/shared/routes/admin-panel.js` | Session invalidation on role change. | — |
| `backend/modules/pos/routes/purchase-orders.js` | `resolve-variance` filters discrepancy by `company_id`. | Could resolve another company's PO discrepancy (low impact). |
| `backend/server.js` | `/api/admin/reset-master` reads password from `FORCE_RESET_ADMIN_PASSWORD`; hardcoded password removed. | Hardcoded super-admin password in source. |
| `backend/config/seed.js` | Seed passwords from `SEED_*_PASSWORD` env vars or random; password no longer logged; force-reset needs `FORCE_RESET_ADMIN_PASSWORD`. | Hardcoded passwords for Ruan/MJ/Anrich; password printed to server log. |
| `frontend-sean/index.html` | Removed pre-filled email/password and the "Test Credentials" box. | **Live public page exposed the super-admin password.** |
| `backend/config/migrations/028_add_anrich_superuser.sql` | Plaintext password replaced with a placeholder (migration already applied — no DB effect). | — |
| `frontend-accounting/index.html.bak`, `run_storehouse_tests.mjs`, old docs/apps (`SESSION_HANDOFF_2026-04-12.md`, `LOGIN_FIX_HANDOFF.md`, `docs/FINAL_SESSION_SUMMARY.md`, `docs/PHASE3_PROGRESS_SUMMARY.md`, `Coaching app/js/auth.js`, `Lorenco Accounting/...`) | Credentials redacted / test script reads `TEST_PASSWORD`. | — |
| `backend/tests/helpers/fakeSupabase.js` (new) | Reusable in-memory Supabase stand-in + route invoker for route-level tests. | — |
| `backend/tests/users-tenant-isolation.test.js` (new, 15) · `company-users-and-companies-tenant.test.js` (new, 13) · `eco-clients-tenant.test.js` (new, 11) · `session-revocation.test.js` (new, 7) | 46 security regression tests. Each security test was confirmed to FAIL against the old code. | — |

Earlier the same day (already pushed, `4373c32`): Firmflow per-client activation + rebranded client filters on the main dashboard.

---

## 3. What was confirmed

- Full jest suite: **775 tests, 757 pass, 18 fail** — the 18 failures (7 suites) are identical to the pre-change baseline taken this morning (pre-existing: missing `sean/invoice-ocr-service`, payroll-employee-sync, teach-paytime, pdf parsers, etc.). **No new failures.**
- `npm run lint`: 4 errors / 182 warnings — identical to baseline. All changed files lint clean.
- Local server boot on port 3999 against the real DB (startup routines are the same idempotent ones every deploy runs): healthy, all modules active, seeds skipped (users exist). Read-only smoke: protected routes 401 without token, 403 with an invalid token, reset-master 403, all app pages 200, `/sean` no longer contains credentials.
- Write-route sweep: 1313 write routes in 229 backend files scanned; 64 suspicious update/delete statements and 83 unscoped handlers reviewed by hand. Only the holes above were real. Coaching skipped (Ruan-only app).

## 4. What was NOT changed (and why)

- **P4** main dashboard has no company switcher (root cause of "2 practices, can only get into 1") — UI work, part of the profile project.
- **P5** Charlie "Register your company" calls a non-existent endpoint — part of the signup redesign.
- **P6 / P11** practice staff (non-super-admin) working in a client company via the eco_clients chain: `sso-launch` ignores firm-access shares, and the session check requires a direct membership row so such tokens are likely 403'd on every request. Fixing means the middleware must *grant* access through the chain — needs its own design + live verification. Unverified at runtime.
- Ruan's other uncommitted work in the tree (accounting, tills.js, sean-webapp, …) was not touched and must not be included in this commit.

## 5. Testing required before/after push (in "Infinite Legacy — TEST", company 51 — Rule H1)

1. Main dashboard: add a client, edit its apps (+ Firmflow on an accounting-practice client), deactivate it, Manage Firms.
2. Ledger Leo → Users & Permissions: edit a user, change role, remove a user.
3. Paytime → users: edit + reset password as owner; try as administrator (should be refused with a clear message).
4. Charlie → Settings → Users: add user, link existing user, remove user, PIN set.
5. Change a test user's role while they are logged in → their next action should ask them to log in again.
6. Regression gate (Part E): TEST-PAY-11/12/13 at minimum — company switching, multi-tenant isolation; payroll calculation files were not touched.
7. Charlie: Rule G2 lint done; confirm till not trading before push (Rule G1 / feedback memory).

## 6. Exploitation check (run read-only in Supabase SQL editor)

```sql
-- eco_clients linking a practice to a company that already existed before the link
-- (legit cases: super-admin "adopt company"). Anything else is suspicious.
SELECT ec.id, ec.name, ec.company_id AS practice_id, ec.client_company_id,
       c.company_name, c.created_at AS company_created, ec.created_at AS linked_at
FROM eco_clients ec
JOIN companies c ON c.id = ec.client_company_id
WHERE c.created_at < ec.created_at - interval '1 minute'
ORDER BY ec.created_at DESC;
```

```
FOLLOW-UP NOTE
- Area: platform security / profile project
- Dependency: Ruan rotating passwords; live test in TEST company
- What was done now: tenant guards + credential removal + 46 regression tests, local boot smoke
- What still needs to be checked: §5 live tests, §6 query, P6/P11 eco-chain session gap, admin@test.com account
- Risk if not checked: the takeover hole and the public password are live until this is pushed and passwords rotated
- Recommended next review point: immediately after push
```
