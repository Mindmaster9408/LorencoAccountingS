# Lorenco Ecosystem — Permission Architecture

> **Version:** 2.0 — March 12, 2026  
> **Scope:** Full ecosystem (Checkout Charlie POS, Lorenco Paytime, Lorenco Accounting, SEAN AI, Coaching)

---

## Overview

Access control in the ecosystem is a **three-tier gate**. Every authenticated API request must pass all three levels before reaching business logic.

```
Tier 1 — Server Level:    ENV flag (MODULE_POS_ENABLED etc.)
Tier 2 — Company Level:   companies.modules_enabled[] in the database
Tier 3 — User Level:      user_app_access table (per-user, per-company)
Tier 4 — Client Level:    user_client_access table (per-user, per-company, per-client)
```

If a request passes Tier 3 it still goes through **role-based permission checks** (`config/permissions.js`) on a per-action basis.

---

## Identity Layers

### Layer 1: Global User (`users` table)
A person. One row per email address. Fields: `id`, `username`, `email`, `password_hash`, `full_name`, `is_super_admin`, `is_active`.

- `role` column on this table is **legacy / do not trust** — the live role is always from `user_company_access.role`.
- `is_super_admin` is the only field used from here at auth time (to bypass company access checks for platform admins).

### Layer 2: Company Membership (`user_company_access` table)
A user's relationship to a company. Fields: `user_id`, `company_id`, `role`, `is_primary`, `is_active`.

- **Role** here is the authoritative role for that company context.
- A user may belong to multiple companies (e.g. an accountant with several clients).
- The JWT embeds `companyId` + `role` from whichever company was selected at login.

### Layer 3: App Access (`user_app_access` table) — added Migration 009
Per-user, per-company, per-app grants. Fields: `user_id`, `company_id`, `app_key`, `granted_by`, `granted_at`.

**Enforcement rule:**
- If **zero rows** exist for a `(user_id, company_id)` pair → user has access to ALL company-enabled apps (backward-compatible default).
- If **any rows** exist for that pair → user may only access apps listed in those rows.

This means: adding even one app restriction to a user immediately restricts them to only that app (and others explicitly granted). This is intentional and deliberate. Administrators who want to restrict a user must set all the apps they *should* access, not just the ones to block.

### Layer 4: Client Access (`user_client_access` table) — added Migration 010
Per-user, per-company, per-eco_client grants. Fields: `user_id`, `company_id`, `eco_client_id`, `granted_by`, `granted_at`.

**Enforcement rule (same pattern as app access):**
- If **zero rows** exist for a `(user_id, company_id)` pair → user sees ALL company clients (backward-compatible default).
- If **any rows** exist → `GET /api/eco-clients` is filtered to only those `eco_client_id`s.

Super admins and explicit `?company_id=` scoping bypass this filter.

### Layer 5: Company Module Gate (`companies.modules_enabled[]`)
Which apps the company has purchased/activated. A user cannot access an app the company hasn't enabled, even if `user_app_access` grants it.

### Layer 6: Server Module Gate (ENV flags)
Which apps are enabled on the server at all. Overrides everything. Typically all-on in production.

---

## Roles

| Role | Level | Can Create Users With Role Level |
|---|---|---|
| `super_admin` | 100 | Any |
| `business_owner` | 95 | ≤ 94 (all except business_owner and above) |
| `accountant` | 90 | ≤ 89 |
| `corporate_admin` | 90 | ≤ 89 |
| `store_manager` | 70 | ≤ 69 |
| `payroll_admin` | 70 | ≤ 69 |
| `assistant_manager` | 50 | ≤ 49 |
| `shift_supervisor` | 40 | ≤ 39 |
| `senior_cashier` | 30 | ≤ 29 |
| `cashier` | 20 | ≤ 19 |
| `trainee` | 5 | None |

`canManageRole(managerRole, targetRole)` requires `managerLevel > targetLevel` (strictly greater — cannot create peers).

---

## First-User Bootstrap Rule

When a user registers and creates a company, they are **always** assigned `business_owner` as their company role, regardless of `account_type`.

**Rationale:** `account_type` describes what *kind* of organisation was created (e.g. `'accountant'` means an accounting practice), not the first user's access level within it. The founder of any organisation must have `business_owner` so they can:
1. Manage and invite other users.
2. See the Client Management section on the dashboard.
3. Pass `canManageRole` checks when assigning roles to new users.

Staff added *later* by the business owner can have any role including `accountant`.

---

## JWT Payload

```json
{
  "userId": 1,
  "username": "jane@practice.co.za",
  "email": "jane@practice.co.za",
  "fullName": "Jane Smith",
  "companyId": 5,
  "role": "business_owner",
  "isSuperAdmin": false,
  "iat": 1710000000,
  "exp": 1710028800
}
```

- `companyId` and `role` are set by the `select-company` flow and change when the user switches company.
- `isSuperAdmin` bypasses Tier 2, Tier 3, and role-level checks. It is set from `users.is_super_admin` at login and embedded permanently in the token.

---

## Dashboard Visibility Rules

| Section | Visible When |
|---|---|
| Client Management | `isSuperAdmin` OR role ∈ `{business_owner, super_admin, store_manager, accountant}` |
| Super Admin section | `isSuperAdmin` only |
| Admin Panel button | `isSuperAdmin` only |
| App cards | Company has app in `modules_enabled[]` (super admin sees all) |
| SEAN AI card | Super admin only (product decision — hardcoded) |
| Coaching card | Super admin OR email = `ruanvlog@lorenco.co.za` (intentional early-access gate) |
| "Apps" button per user | Visible to `business_owner` and `super_admin` only (via `loadPracticeUsers`) |
| "Clients" button per user | Visible to `business_owner` and `super_admin` only (via `loadPracticeUsers`) |
| Client chips per user row | Shows null=All clients / []=None / [n]=n restricted (from `GET /api/users` `clients[]`) |

---

## User Management Flows

### Adding a user to a practice (dashboard → Practice Settings → Team)
1. Admin fills: Full Name, Email, Password, Role, optional App Access checkboxes.
2. `POST /api/users` is called with `{ ..., role, apps: ['pos','payroll'] | null }`.
3. Backend creates user row, inserts `user_company_access`, then (if `apps` is non-null array) inserts rows into `user_app_access`.
4. If `apps` is `null` (no checkboxes selected) → no restriction rows are created → user inherits company-level access.

### Changing a user's app access (Practice Settings → Team → "Apps" button)
1. Opens an inline prompt with current apps.
2. Calls `PUT /api/users/:id` with `{ apps: [...] }` or `apps: null` to remove all restrictions.
3. Backend deletes all existing `user_app_access` rows for that `(user_id, company_id)` pair, then inserts the new set.

### Restricting a user's client visibility (Practice Settings → Team → "Clients" button)
1. "Clients" button opens a **modal** populated with all practice clients from `GET /api/eco-clients`.
2. "All clients (unrestricted)" checkbox at top — when checked, disables individual boxes.
3. Calls `PUT /api/users/:id/client-access` with `{ clients: [id,...] | null }`.
   - `null` → remove all restrictions (sees all clients)
   - `[]` → no clients visible
   - `[1,2,3]` → exactly those eco_client_ids
4. Backend deletes existing `user_client_access` rows for the pair, then inserts the new set.

### Removing a user from a practice
- `DELETE /api/users/:id/company-access` — sets `user_company_access.is_active = false`.
- Does **not** delete the global user account (they may belong to other companies).
- Does **not** delete `user_app_access` rows (cleaned up lazily via `ON DELETE CASCADE` if the user is ever fully deleted).

---

## Database Schema Summary

```sql
-- Core identity
users (id, username, email, password_hash, full_name, is_super_admin, is_active)

-- Company membership + per-company role
user_company_access (user_id, company_id, role, is_primary, is_active)

-- Company definition + module gate
companies (id, company_name, trading_name, modules_enabled[], subscription_status, is_active)

-- Per-user app access (Migration 009)
user_app_access (id, user_id, company_id, app_key, granted_by, granted_at)
-- UNIQUE (user_id, company_id, app_key)
-- Zero rows for a pair = unrestricted; any rows = restrict to those apps only

-- Per-user client access (Migration 010)
user_client_access (id, user_id, company_id, eco_client_id, granted_by, granted_at)
-- UNIQUE (user_id, company_id, eco_client_id)
-- Zero rows for a pair = unrestricted; any rows = restrict to those clients only

-- Cross-app client registry
eco_clients (id, company_id, name, apps[], client_company_id, ...)

-- Firm-to-client read-only visibility (Migration 008)
eco_client_firm_access (client_id, firm_company_id, granted_at)
```

---

## Files Reference

| File | Purpose |
|---|---|
| `backend/middleware/auth.js` | JWT decode, `requireCompany`, `requirePermission`, `requireRole`, `requireSuperAdmin` |
| `backend/middleware/module-check.js` | Three-tier module gate (`requireModule`) |
| `backend/config/permissions.js` | ROLE_LEVELS, PERMISSIONS matrix, `canManageRole`, `hasPermission` |
| `backend/shared/routes/auth.js` | Login, register, select-company, /me, /companies, SSO launch (app gate + eco_client chain) |
| `backend/shared/routes/users.js` | User CRUD — returns `apps[]` + `clients[]`; handles `PUT /:id/client-access` |
| `backend/shared/routes/eco-clients.js` | Client CRUD — `GET /` filtered by `user_client_access` per-user grants |
| `backend/config/modules.js` | Module definitions + ENV flag checks |
| `database/009_user_app_access.sql` | Migration — creates `user_app_access` table |
| `database/010_user_client_access.sql` | Migration — creates `user_client_access` table |
| `frontend-ecosystem/dashboard.html` | Main portal — app grid, client mgmt, practice settings, app+client chips per user |

---

## SSO Launch — Cross-Company Access for Accountants

`POST /api/auth/sso-launch` issues an app-scoped JWT. Two security checks added:

**1. `user_app_access` gate** — Checks if the user has explicit app grants for `(user_id, companyId)`. If grants exist and `targetApp` is not in them, the launch is rejected with 403. Zero grants = unrestricted.

**2. Accountant cross-company chain** — An accountant managing a client doesn't need a direct `user_company_access` row for that client's isolated company. The handler resolves:
```
user → user_company_access (practice_company) → eco_clients → client_company_id (target)
```
If the user belongs to the **managing practice** with role ∈ `{business_owner, accountant, store_manager, super_admin}`, the token is issued for the client company with the user's practice role.

This eliminates the need to create `user_company_access` rows for every accountant ↔ every client company.

---

## Known Intentional Restrictions

1. **SEAN AI visible to super admin only** — Product gate. Remove the guard in `renderApps()` to open it to companies that have `sean` in `modules_enabled`.
2. **Coaching visible to one email** — Early-access gate. Change the email check or make it module-based when the app is ready for general release.
3. **`canManageRole` is strictly greater** — A `business_owner` (95) cannot create another `business_owner` (95) — they can only create staff with lower roles. Super admins can create any role.

---

## Future Follow-Ups

**FOLLOW-UP NOTE**
- Area: `changeUserApps` UI polish
- What was done: App access is managed via a `prompt()` dialog.
- What still needs: Replace with a checkbox modal matching the `changeUserClients` modal style.
- Risk if not done: No risk — UX debt only.

**FOLLOW-UP NOTE**
- Area: `users.role` column drift
- What was done: JWT role always comes from `user_company_access.role`. The `users.role` column is not written to by any current code path (it's a legacy field).
- What still needs: A migration to DROP the column or document it as a legacy cache.
- Risk if not done: Future code might accidentally read `users.role` and get stale data.

**FOLLOW-UP NOTE**
- Area: `user_client_access` — SSO launch boundary
- What was done: Client scoping is enforced at `GET /api/eco-clients` level for the managing practice context.
- What still needs: If an accountant SSOs into a client's isolated company, app-level data access is unrestricted once inside. Acceptable for the current access model but should be re-evaluated when fine-grained report access is needed.
- Risk if not done: Low — the gate applies at the ecosystem list view level.
