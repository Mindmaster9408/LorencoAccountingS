# User Profile + Invite Model — Ecosystem Impact Audit

**Date:** 2026-10-01
**Status:** Read-only audit. Nothing built or changed.
**Scope:** every frontend page/script in every app (460 files), plus the shared backend auth/user/company routes.
**Method:** an automated sweep classified every file by markers (auth calls, user-management calls, role/permission checks, company context, token use). Every Tier 1 file and the key backend routes were then read by hand. Nothing was exercised at runtime; findings marked *unverified* need a live check in the TEST company (Rule H1).

Design decisions this audit is measured against: see memory `project_user_profile_invite_model` / the chat of 2026-10-01 (profile-only signup, invites, owner rules, practice↔client via reg nr / client code, till-only Charlie staff, immediate revocation, notifications + "Ask my client / Ask my accountant").

---

## 1. How login and access work today (the parts the new model touches)

| Piece | Where | What it does |
|---|---|---|
| Person | `users` table | One row per login. Login accepts **username or email**. |
| Membership | `user_company_access` | `(user, company, role, apps_access, is_primary, is_active)`. Unique per user+company. Already supports one user in many companies. |
| Per-app grants | `user_app_access` | A **second** per-app mechanism alongside `apps_access`. Zero rows = all apps. |
| Per-client scope (practice staff) | `user_client_access` | Which eco_clients a practice staff member may see. Zero rows = all. |
| Firmflow roster | `practice_team_members` | A **third** identity/role layer with its own roles (owner/partner/admin/manager). Synced from users via `/api/practice/team/sync-from-users`; email self-heal in `lib/team-access.js`. Commander has a copy. |
| Till PINs | `user_pos_pins` | PIN per user per company. Collision check per company. |
| Login | `POST /api/auth/login` (`backend/shared/routes/auth.js:100`) | Builds company list from `user_company_access`, auto-selects primary/first, signs a 12h JWT with `{userId, companyId, role, isSuperAdmin, hasCoachingAccess}`. Zero companies → token with `companyId: null`. |
| Switch company | `POST /api/auth/select-company` | Re-issues JWT for another company. |
| App launch | `POST /api/auth/sso-launch` | Issues per-app token. Practice staff reach client companies via `eco_clients.company_id` (their own practice) + role, or delegated via `user_app_access` + `user_client_access`. No company → 400 "Please create or join a company first". |
| Every request | `middleware/auth.js` `_checkActiveSession` | Re-checks user active, company active, membership active. **Cached 60 s.** Role and app permissions come from the JWT, not the DB. |
| Forgot password | `/api/auth/forgot-password/request` + `/reset` | Already token-based (SHA-256, 1h, single use). Token currently written to server log for an admin to hand over; email hook placeholder ready for Resend. |
| 2FA | `twoFactor.js`, login gate | Built; gated by `TWO_FACTOR_AUTH_ENABLED`. |

**Conclusion:** the data model is already "profile + memberships". The new model is mostly a change to the *entry points* (signup, add-user, company creation) plus new pieces (invites, claim/access requests, notifications). Business data and the JWT contract can stay as they are.

---

## 2. Existing problems found during the audit (independent of the new model)

Ranked by severity. These exist **today**.

| # | Severity | Finding | Where | Notes |
|---|---|---|---|---|
| P1 | **CRITICAL** | `PUT /api/users/:id` and `DELETE /api/users/:id` do not check that the target user belongs to the caller's company. Any holder of `USERS.EDIT` / `USERS.DELETE` (incl. every `business_owner`, and anyone can self-register as one) can rename, change the email of, deactivate, or strip all company access from **any user on the platform** by numeric id. Changing someone's email becomes an account takeover once email password-reset goes live. | `backend/shared/routes/users.js:294`, `:754` | `GET /:id` in the same file *does* have the membership check — the write routes were missed. Recommend fixing now, before anything else. |
| P2 | HIGH | `POST /api/auth/companies/:companyId/users` lets **any active member** of a company (incl. a cashier) create a new user with **any role** — `canManageCompanyUsers` only checks membership, and there is no `canManageRole` check (unlike `link-existing`). | `auth.js:1469` | Frontend hides the button for low roles, the API does not enforce it. |
| P3 | HIGH | `POST /api/companies` takes `modules_enabled` from the client (default `pos, payroll, accounting, sean`), sets no `account_holder_type`, no trial expiry. The main dashboard's "Create company" posts all four → free modules permanently, bypassing the 30-day trial logic in `/register`. | `companies.js:142`, `dashboard.html` `createCompany()` | Also no client code generated. |
| P4 | MEDIUM | **Root cause of "2 practices, can only get into 1":** the main dashboard always auto-selects `companies[0]` (The Infinite Legacy for super users). `selectCompany(idx)` exists but is **never called** — there is no company switcher in the UI. | `frontend-ecosystem/dashboard.html` `renderCompanies()` ~L2146, `selectCompany` ~L2288 | Confirmed from code. dashboard-v2 has its own selector (not checked live). |
| P5 | MEDIUM | Checkout Charlie's "Register your company" button calls `POST /api/auth/register-company`, which does not exist → always fails. | `frontend-pos/index.html` `registerCompany()` ~L20519 | Dead feature. |
| P6 | MEDIUM | Clients shared with another firm via "🏛 Firms" (`eco_client_firm_access`) appear in that firm's client list, but `sso-launch` only resolves eco_clients managed by the user's **own** practice → the shared firm likely gets 403 when opening an app. | `auth.js` sso-launch | *Unverified at runtime.* Central to the "other accountants request access via client code" decision. |
| P7 | MEDIUM | Role and app-permission changes live in the JWT → a demotion or app removal only takes effect on re-login (up to 12 h). Membership removal takes up to 60 s (session cache). Ruan's decision is **immediate**. | `middleware/auth.js` | Fix design: invalidate the session cache on change + re-read role/apps server-side (or a token version per user). |
| P8 | MEDIUM | Till-only cashiers created in Charlie get a username + password and **can log into the main dashboard** — login has no restriction. | `frontend-pos/index.html` `saveUser()`, `auth.js` login | Confirms the "till-only" flag is needed. |
| P9 | LOW | Login / forgot-password build the PostgREST `.or()` filter from raw input, and use `.single()` — a username equal to another user's email breaks login for both. | `auth.js:110`, forgot-password | Harden when touching login. |
| P10 | LOW | Owner/manager password reset (`PUT /api/users/:id/password`) is role-based and reaches users who also belong to **other** companies. | `users.js:456` | Conflicts with decision "owner only, not role-based, only users exclusive to that company". |

---

## 3. Entry points that must change

### 3.1 Three signup paths (must become one profile-only signup)

| Path | File | Today |
|---|---|---|
| Ecosystem signup wizard (5 steps) | `frontend-ecosystem/login.html` → `POST /api/auth/register` | User + company + trial + team users in one go |
| Paytime signup tab | `frontend-payroll/login.html` → `js/auth.js AUTH.register` → `/api/auth/register` | Company name/email then user + "account type" |
| Charlie "Register your company" | `frontend-pos/index.html` → `/api/auth/register-company` | Broken (P5) |

### 3.2 Four company-creation paths (must become one "Create company" wizard + service)

| Path | Where |
|---|---|
| Signup | `auth.js /register` (trial-aware, account_holder_type) |
| Dashboard "Create company" | `dashboard.html createCompany()` → `POST /api/companies` (P3) |
| Paytime | `frontend-payroll/js/auth.js createCompany` / `company-dashboard.html` → `POST /api/companies` |
| Practice adds a client | `POST /api/eco-clients` (auto-creates the client company + `client_code`) |

One shared backend service should own: type (business / practice / individual), trial, modules, client code, owner membership, audit.

### 3.3 Add-user paths (become "Invite")

| UI | API |
|---|---|
| Main dashboard → Practice Settings → Team / Users | `POST /api/users`, `PUT /api/users/:id`, `/client-access`, `/company-access`, `/password` |
| Main dashboard → client card "👤 Owner" | `POST /api/eco-clients/:id/create-owner` (409 if email exists) |
| Charlie → Users | `POST /api/auth/companies/:id/users`, `/link-existing`, `DELETE …/users/:userId`, PIN routes `/api/pos/users/:id/pin` |
| Ledger Leo → Users & Permissions | `/api/users` (list / edit / roles) |
| Paytime → users.html | `/api/users` + paytime-config / paytime-employees |
| Super admin → admin.html | `/api/admin/companies/:id/users`, role change |
| Firmflow / Commander → Team | `/api/practice/team` (+ `sync-from-users`) |

`link-existing` currently adds an existing person to a company **without their consent** — in the new model this becomes an invite they accept.

---

## 4. Per-app impact

**Tier 1** = directly changes. **Tier 2** = must be checked (role/permission or company-context logic). **Tier 3** = no change, as long as the JWT contract (`userId, companyId, role, isSuperAdmin, hasCoachingAccess`) and the per-app token hand-off stay the same. All Tier 3 files are listed in the appendix.

### Ecosystem (main dashboard) — 10 files
- **Tier 1:** `login.html` (signup wizard → profile-only, email-verify switch, consent checkbox, ID number), `dashboard.html` (company switcher P4, empty state, create-company wizard, invites, notifications, Ask my client/accountant, Owner button → invite, practice users → invites with client scope), `js/dashboard-v2.js` (second dashboard with its own select-company/sso flow — must get the same changes or be retired), `admin.html` (super admin: user/role management, firm type, flags/ban).
- **Tier 2:** `js/polyfills.js`, `sevco.html`, `ecosystem-qa-hub.html`.

### Ledger Leo (accounting) — 60 files
- **Tier 1:** `users-permissions.html` (→ invites + per-app permissions), `profile.html` (→ link to the central profile), `js/navigation.js` (has its own company switcher via select-company — keep in sync with main), `js/eco-api-interceptor.js`, `dashboard.html`.
- **Tier 2:** `accounting-diagnostics.html`, `historical-comparatives*.html`, `js/polyfills.js`.

### Paytime (payroll) — 40 files · **stability-locked (Part E)**
- **Tier 1:** `login.html` (own login + own signup tab), `index.html`, `company-selection.html`, `company-dashboard.html` (own create-company), `company-details.html`, `users.html`.
- **Tier 2 (17):** incl. `js/auth.js` (HIGH), `js/permissions.js`, `employee-detail.html` (HIGH), `payroll-execution.html` (HIGH), `payruns.html` (HIGH), `super-admin-dashboard.html`.
- Any change here needs the Change Impact Note + TEST-PAY regression gate. Payroll calculation files are **not** expected to change.

### Checkout Charlie (POS) — 6 files
- **Tier 1:** `index.html` (22k-line SPA: login, PIN login, users, link-existing, PIN management, broken register P5). Needs: till-only flag, invite instead of username/password for full-profile staff, "claim/upgrade" path for existing cashiers (keep user_id → keeps sales/cash-up history).
- Rule G2 lint before push; Rule G1 timing (Ruan said 2026-09-12 the till is not actively trading — still confirm at the time).

### Stockton (inventory) — 1 file
- **Tier 2:** `index.html` (role checks only). Entry via SSO token.

### Firmflow (practice) — 146 files · Commander (copy) — 146 files
- **Tier 1 (real impact):** `js/team.js` / `team.html` (roster ↔ invites; `practice_team_members` must be created/linked on invite accept), `js/layout.js`, `js/auth.js`, `js/profile.js`, `secretarial-governance.html`.
- **Flagged but low impact:** ~30 module scripts (tasks, deadlines, capacity, planning-board, workflows, …) that call `/api/practice/team` only to fill **staff pickers**. They stay correct as long as the roster stays in sync.
- Commander has diverged from Firmflow (144 differing files) — changes must be applied to both or Commander must be re-based.

### Coaching — 46 files
- Separate auth, Ruan-only (Rule F2). **Must not change.** Verify after the build that coaching is still invisible to everyone else.

### Sean
- `frontend-sean/index.html` — token consumer (Tier 1 by marker; reads ecosystem token).
- `sean-webapp` (Next.js) has its **own** user store (`lib/auth.ts`, `CORE_SUPER_USERS`, allow-list, Prisma sessions). Not deployed. Out of scope for phase 1; must be aligned before it goes live.

### Collector (+ public upload page) — 4 files
- Token-link based uploads, no user identity. No change.

---

## 5. Backend changes implied

| Area | Change |
|---|---|
| `auth.js` `/register` | Profile only (+ ID number checksum, consent timestamp, email-verify flag off). |
| New | Invites table + routes (create / list mine / accept / decline / revoke / expiry 7 days), in-app pending invites, copyable link. |
| New | Company creation service (one path, §3.2) incl. client code for every company. |
| New | Claim / access-request by reg nr or client code; approval by owner, or by managing accountant when no owner. |
| New | Notifications + "Ask my client / Ask my accountant" messages. |
| New | Forensic audit log for invites/roles/access (append-only). |
| `users.js` | Fix P1/P10; owner-only reset, only for users exclusive to that company. |
| `auth.js` company users | Fix P2; `link-existing` → invite. |
| `companies.js` | Fix P3. |
| `middleware/auth.js` | Immediate revocation (P7). |
| `sso-launch` | Support firm-access clients (P6). |
| Ownership | Multiple owners, transfer, last-owner guard. |
| POS | Till-only flag; block main-dashboard login for till-only (P8); claim/upgrade path. |
| Permissions | Consolidate `apps_access` vs `user_app_access` before adding per-app permissions. |

Protected files touched (Part E): `backend/shared/routes/auth.js`, `companies.js`, `backend/middleware/auth.js`, `backend/config/permissions.js`, `frontend-payroll/js/auth.js` and payroll pages above. Ruan's instruction: the regression gate applies to **all apps** for this project.

---

## 6. Data clean-up to check before switching on

Read-only DB queries still to run (not done in this audit):
1. Same person, multiple `users` rows (same ID number / name+phone / similar emails).
2. Logins shared by more than one person (e.g. a till login).
3. Till-only users that have a password + email (P8).
4. Companies with no `business_owner` membership (practice-managed only).
5. Companies created via `POST /api/companies` with free modules (P3).
6. eco_clients without `client_code`; companies without any code.

---

## 7. Not verified / follow-up

```
FOLLOW-UP NOTE
- Area: whole profile/invite project
- Dependency: Resend key (~2–3 weeks), CLO answers (see CLO/2026-10-01_Gebruikersprofiele_Regsvrae.md)
- What was done now: static read of all 460 frontend files (automated) + hand review of Tier 1 and the shared auth/user/company routes
- What still needs to be checked: P1–P10 live in TEST company; P6 at runtime; dashboard-v2 behaviour; the §6 data queries
- Risk if not checked: P1 is exploitable today by any self-registered business owner
- Recommended next review point: fix P1 (and P2/P3) as a separate, small security task before the profile project starts
```

---

## Appendix — Tier 3 files (no change expected if the JWT/token contract is kept)

**frontend-ecosystem** (3): `client-detail.html`, `dashboard-v2.html`, `js/update-check.js`

**frontend-accounting** (51): `accounting-periods.html`, `accounts.html`, `aged-creditors.html`, `aged-debtors.html`, `audit-log.html`, `audit-trail.html`, `balance-sheet.html`, `bank-reconciliation.html`, `bank-rules.html`, `bank-staging.html`, `bank.html`, `cash-reconciliation.html`, `cashflow.html`, `company.html`, `contacts.html`, `control-account-reconciliation.html`, `credit-notes.html`, `customer-list.html`, `customer-receipts.html`, `customer-transactions.html`, `customers.html`, `division-pl.html`, `general-ledger-full.html`, `general-ledger.html`, `invoices.html`, `journals.html`, `js/companyContextBadge.js`, `js/cosmic-bg.js`, `js/ledger.js`, `js/sean-chat-widget.js`, `js/theme-guard.js`, `legacy-gl-import.html`, `opening-balances.html`, `paye-config.html`, `paye-reconciliation.html`, `paye.html`, `pilot-controls.html`, `pilot-smoke-tests.html`, `products-services.html`, `purchase-analysis.html`, `quotes.html`, `reports.html`, `sales-analysis.html`, `settings.html`, `supplier-invoice-ocr-review.html`, `supplier-transactions.html`, `suppliers.html`, `system-health.html`, `trial-balance.html`, `vat-return.html`, `vat.html`

**frontend-payroll** (17): `js/attendance.js`, `js/banking-formats.js`, `js/bulk-import-utils.js`, `js/cosmic-bg.js`, `js/data-access.js`, `js/export-formats.js`, `js/feature-flags.js`, `js/mobile-utils.js`, `js/narrative-generator.js`, `js/payroll-engine.js`, `js/payroll-items-helper.js`, `js/pdf-branding.js`, `js/recon-service.js`, `js/sean-helper.js`, `js/sidebar.js`, `js/update-check.js`, `paye-reconciliation.html`

**frontend-pos** (5): `icons/gen-icons.js`, `js/update-check.js`, `product-import.html`, `service-worker.js`, `supabase-config.js`

**frontend-coaching** (38): `backup-manager.html`, `backup-restore.html`, `clear-data.html`, `client-assessment.html`, `index.html`, `js/admin-panel.js`, `js/api.js`, `js/app.js`, `js/backup.js`, `js/basis-assessment.js`, `js/basis-report-data.js`, `js/basis-ui.js`, `js/client-assessment.js`, `js/clients.js`, `js/config.js`, `js/dashboard.js`, `js/gauges.js`, `js/journey-data.js`, `js/journey-report-generator.js`, `js/journey-ui.js`, `js/leads.js`, `js/login-ui.js`, `js/public-assessment.js`, `js/question-builder.js`, `js/reports.js`, `js/settings.js`, `js/spil-client.js`, `js/spil-questions.js`, `js/storage.js`, `js/vita-report-panel.js`, `js/vita-ui.js`, `login.html`, `public-assessment.html`, `recover-clients.html`, `restore-demo-clients.html`, `settings.html`, `setup-admin.html`, `vita.html`

**frontend-sean** (0): —

**frontend-practice** (104): `alert-rules.html`, `automation.html`, `beneficial-ownership.html`, `billing.html`, `capacity.html`, `client-detail.html`, `client-health.html`, `client-onboarding.html`, `client-success.html`, `communications.html`, `company-tax.html`, `compliance-packs.html`, `compliance.html`, `delegation.html`, `document-requests.html`, `engagement-management.html`, `engagement-periods.html`, `entity-lifecycle.html`, `executive-reporting.html`, `individual-tax.html`, `js/alert-rules.js`, `js/api.js`, `js/automation.js`, `js/beneficial-ownership.js`, `js/billing.js`, `js/client-onboarding.js`, `js/cosmic-bg.js`, `js/deadline-utils.js`, `js/engagement-management.js`, `js/entity-lifecycle.js`, `js/individual-tax.js`, `js/knowledge-base.js`, `js/kpi-history.js`, `js/notifications.js`, `js/operational-health.js`, `js/partner-review-packs.js`, `js/pilot-readiness.js`, `js/polyfills.js`, `js/practice-sop.js`, `js/pricing-review.js`, `js/profitability.js`, `js/quality-management.js`, `js/risk-register.js`, `js/sars-recon.js`, `js/secretarial-calendar.js`, `js/secretarial-evidence.js`, `js/secretarial-governance.js`, `js/secretarial-integrity.js`, `js/secretarial-workflows.js`, `js/tax-checklists.js`, `js/tax-completion.js`, `js/tax-configs.js`, `js/tax-disputes.js`, `js/tax-payments.js`, `js/tax-pipeline.js`, `js/tax-submissions.js`, `js/time.js`, `js/work-authorization.js`, `js/workflow-editor.js`, `knowledge-base.html`, `kpi-history.html`, `learning-centre.html`, `management-dashboard.html`, `notifications.html`, `operational-health.html`, `partner-review-packs.html`, `pilot-readiness.html`, `planning-board.html`, `practice-sop.html`, `pricing-review.html`, `profile.html`, `profitability.html`, `provisional-tax.html`, `quality-management.html`, `reminders.html`, `resource-forecasting.html`, `risk-register.html`, `sars-recon.html`, `secretarial-calendar.html`, `secretarial-evidence.html`, `secretarial-integrity.html`, `secretarial-workflows.html`, `secretarial.html`, `services.html`, `skills-matrix.html`, `strategic-planning.html`, `tasks.html`, `tax-actions.html`, `tax-bulk-operations.html`, `tax-checklists.html`, `tax-completion.html`, `tax-configs.html`, `tax-dashboard.html`, `tax-disputes.html`, `tax-payments.html`, `tax-pipeline.html`, `tax-reports.html`, `tax-submissions.html`, `taxpayer-profiles.html`, `time.html`, `work-authorization.html`, `work-queue.html`, `workflow-template.html`, `workflows.html`

**frontend-commander** (104): `alert-rules.html`, `automation.html`, `beneficial-ownership.html`, `billing.html`, `capacity.html`, `client-detail.html`, `client-health.html`, `client-onboarding.html`, `client-success.html`, `communications.html`, `company-tax.html`, `compliance-packs.html`, `compliance.html`, `delegation.html`, `document-requests.html`, `engagement-management.html`, `engagement-periods.html`, `entity-lifecycle.html`, `executive-reporting.html`, `individual-tax.html`, `js/alert-rules.js`, `js/api.js`, `js/automation.js`, `js/beneficial-ownership.js`, `js/billing.js`, `js/client-onboarding.js`, `js/cosmic-bg.js`, `js/deadline-utils.js`, `js/engagement-management.js`, `js/entity-lifecycle.js`, `js/individual-tax.js`, `js/knowledge-base.js`, `js/kpi-history.js`, `js/notifications.js`, `js/operational-health.js`, `js/partner-review-packs.js`, `js/pilot-readiness.js`, `js/polyfills.js`, `js/practice-sop.js`, `js/pricing-review.js`, `js/profitability.js`, `js/quality-management.js`, `js/risk-register.js`, `js/sars-recon.js`, `js/secretarial-calendar.js`, `js/secretarial-evidence.js`, `js/secretarial-governance.js`, `js/secretarial-integrity.js`, `js/secretarial-workflows.js`, `js/tax-checklists.js`, `js/tax-completion.js`, `js/tax-configs.js`, `js/tax-disputes.js`, `js/tax-payments.js`, `js/tax-pipeline.js`, `js/tax-submissions.js`, `js/time.js`, `js/work-authorization.js`, `js/workflow-editor.js`, `knowledge-base.html`, `kpi-history.html`, `learning-centre.html`, `management-dashboard.html`, `notifications.html`, `operational-health.html`, `partner-review-packs.html`, `pilot-readiness.html`, `planning-board.html`, `practice-sop.html`, `pricing-review.html`, `profile.html`, `profitability.html`, `provisional-tax.html`, `quality-management.html`, `reminders.html`, `resource-forecasting.html`, `risk-register.html`, `sars-recon.html`, `secretarial-calendar.html`, `secretarial-evidence.html`, `secretarial-integrity.html`, `secretarial-workflows.html`, `secretarial.html`, `services.html`, `skills-matrix.html`, `strategic-planning.html`, `tasks.html`, `tax-actions.html`, `tax-bulk-operations.html`, `tax-checklists.html`, `tax-completion.html`, `tax-configs.html`, `tax-dashboard.html`, `tax-disputes.html`, `tax-payments.html`, `tax-pipeline.html`, `tax-reports.html`, `tax-submissions.html`, `taxpayer-profiles.html`, `time.html`, `work-authorization.html`, `work-queue.html`, `workflow-template.html`, `workflows.html`

**frontend-inventory** (0): —

**frontend-collector** (3): `index.html`, `js/api.js`, `js/app.js`

**frontend-collector-public** (1): `index.html`
