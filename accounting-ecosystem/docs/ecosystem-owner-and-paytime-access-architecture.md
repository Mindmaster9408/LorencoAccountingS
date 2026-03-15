# Ecosystem Owner & Paytime Access Architecture
## Lorenco Multi-Tier Permission System

**Date:** March 2026
**Status:** Phase 1 implemented
**Author:** Lorenco Engineering (Claude Code)

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:
    User access model (ecosystem-wide) + Paytime employee visibility + Owner login flow

- Files/services involved:
    backend/config/permissions.js
    backend/modules/payroll/services/paytimeAccess.js  (NEW)
    backend/modules/payroll/routes/employees.js
    backend/modules/payroll/routes/transactions.js
    backend/shared/routes/users.js
    backend/shared/routes/eco-clients.js
    backend/config/payroll-schema.js
    database/012_paytime_access_control.sql  (NEW)
    frontend-ecosystem/dashboard.html
    frontend-payroll/users.html or employee-management.html

- Current behaviour identified:
    All users with PAYROLL.VIEW role see ALL employees — no employee-level filtering.
    No leave-only vs full-payroll distinction.
    No company owner login flow — owners would have to be manually added to user_company_access.
    No employee confidentiality classification.

- Required behaviours to preserve:
    1. ALL existing payroll_admin/accountant/business_owner users must continue to see
       all employees — backward-compatible (no paytime_user_config row = unrestricted).
    2. Practice → client SSO flow must not be broken.
    3. user_company_access role assignments must remain the authoritative role source.
    4. company_id data isolation (req.companyId from JWT) must not be loosened.
    5. No changes to the POS module — only Paytime-specific enforcement added.

- Multi-tenant risk:
    HIGH. The visibility filter must be scoped to (user_id, company_id) — never
    allow a filter from one company to leak into another company's context.

- Payroll confidentiality risk:
    HIGH. Directors/top management must not be visible to restricted users even via
    direct URL, API calls, or hidden query parameters.

- Safe implementation plan:
    1. Add schema (additive only — no existing columns removed).
    2. Add service layer (paytimeAccess.js) as the single enforcement point.
    3. Apply service in routes — wrap existing queries, don't rewrite them.
    4. Zero-rows-in-paytime_user_config = unrestricted (backward-safe).
    5. Only users with explicit paytime_user_config rows are affected.
```

---

## 1. Three-Layer Access Model

### Layer A — Practice / Accountant Access
The accounting practice (managing firm) manages clients under them.

- Practice users are in `user_company_access` with `company_id = practice_company_id`
- Practice users see eco_clients WHERE `eco_clients.company_id = practice_company_id`
- Practice users SSO into client apps via `sso-launch` endpoint
- SSO validation checks: practice role ∈ `['business_owner','accountant','store_manager','super_admin']`
- Practice-side users are typically: `business_owner`, `accountant`, `payroll_admin`, `store_manager`

### Layer B — Company Owner Access
The client/business owner has their own login — scoped to their own company only.

- Owner is in `user_company_access` with `company_id = client_company_id` + `role = 'business_owner'`
- Owner sees ONLY their company in the company selector — no other clients visible
- Owner accesses apps via SSO or direct app login using `token` scoped to their company
- Owner manages their own users (can add/remove users under their company)
- Owner does NOT have access to the ECO Hub practice management screen

**How to create an owner user:**
```
POST /api/eco-clients/:ecoClientId/create-owner
Body: { full_name, email, password }
Auth: eco_token (practice user with USERS.CREATE permission)

Effect:
1. Creates a user in the `users` table
2. Adds user_company_access(user_id, company_id=client_company_id, role='business_owner')
3. Adds user_app_access for all apps enabled on the client
4. Returns: { user: {...}, company_id: client_company_id }
```

### Layer C — Company User Access
Owner-managed internal staff, restricted by role, app, and (in Paytime) employee visibility.

- Internal users are in `user_company_access` with `company_id = client_company_id`
- Roles: `payroll_admin`, `leave_admin`, `store_manager`, `cashier`, etc.
- App access: gated by `user_app_access` (if any rows exist — else unrestricted)
- Within Paytime: further restricted by `paytime_user_config`

---

## 2. Owner View Detection (ECO Hub Dashboard)

When a user logs in and their companies list is loaded, the backend sets
`company_type = 'client'` for companies that are a `client_company_id` in `eco_clients`,
and `company_type = 'practice'` for companies that appear as `company_id` in `eco_clients`.

The ECO Hub dashboard checks:
```javascript
const hasPractice = companies.some(c => c.company_type === 'practice');
const isOwnerOnly = !hasPractice && !isSuperAdmin;
```

- If `isOwnerOnly = true` → show **Owner Portal** view (simplified: apps + user management only)
- If `isOwnerOnly = false` → show full **Practice Management** view (current behaviour)

This ensures owners don't see the full client management screen.

---

## 3. Paytime Permission Model

### 3a. Roles with Paytime Access

| Role | Can Access Payroll | Can Approve Payroll | Notes |
|---|---|---|---|
| super_admin | ✅ All employees | ✅ | Platform-wide |
| business_owner | ✅ All employees | ✅ | Overrides all restrictions |
| accountant | ✅ All employees | ✅ | Practice/company finance |
| payroll_admin | ✅ Subject to paytime_user_config | ❌ | Restricted by config |
| leave_admin | Leave only | ❌ | NEW role — no payroll data access |
| store_manager | ❌ (no PAYROLL.VIEW) | ❌ | POS only |
| cashier | ❌ | ❌ | POS terminal only |

### 3b. Leave Admin Role

A new role `leave_admin` (level 50) can:
- `LEAVE.VIEW` — view leave requests
- `LEAVE.CREATE` — capture leave
- `LEAVE.APPROVE` — approve leave (if explicitly granted)

A `leave_admin` CANNOT:
- `PAYROLL.VIEW` — no access to payslips, salaries, or payroll transactions
- `PAYSLIPS.VIEW` — no payslip access
- `EMPLOYEES.VIEW` — no access to employee salary/bank details

### 3c. paytime_user_config

For users with `payroll_admin` role, fine-grained Paytime restrictions:

```sql
CREATE TABLE paytime_user_config (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  modules TEXT[] DEFAULT ARRAY['leave', 'payroll'],
  employee_scope VARCHAR(20) DEFAULT 'all'
    CHECK (employee_scope IN ('all', 'selected')),
  can_view_confidential BOOLEAN DEFAULT false,
  UNIQUE(user_id, company_id)
);
```

**Defaults (zero-rows = unrestricted):**
- No row in `paytime_user_config` for a user → access is unrestricted (backward-compatible)
- Existing payroll_admin users are unaffected

**Module restriction:**
- `modules = ['leave', 'payroll']` → full Paytime access (default)
- `modules = ['leave']` → leave functions only; payroll routes return 403

**Employee scope:**
- `employee_scope = 'all'` → sees all employees (subject to `can_view_confidential`)
- `employee_scope = 'selected'` → sees ONLY employees in `paytime_employee_access`
- `can_view_confidential = false` → cannot see employees with `classification IN ('confidential','executive')`
- `can_view_confidential = true` → sees all employees regardless of classification

---

## 4. Employee Confidentiality Classification

### 4a. Classification Column

```sql
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS classification VARCHAR(20)
  DEFAULT 'public'
  CHECK (classification IN ('public', 'confidential', 'executive'));
```

**Values:**
- `public` — visible to all Paytime users with PAYROLL.VIEW (default for all existing employees)
- `confidential` — visible only to users with `can_view_confidential = true`, or unrestricted users
- `executive` — same as confidential but semantically marks directors/top management

### 4b. Visibility Rules (Applied in paytimeAccess.js)

```
Rule 1: super_admin or business_owner → see ALL (no filter applied)
Rule 2: accountant → see ALL (no filter applied, trusted finance role)
Rule 3: No paytime_user_config row → see ALL (backward-compatible default)
Rule 4: paytime_user_config.employee_scope = 'selected' →
         see ONLY employees in paytime_employee_access for this user
Rule 5: paytime_user_config.employee_scope = 'all' AND can_view_confidential = false →
         see employees WHERE classification = 'public' ONLY
Rule 6: paytime_user_config.employee_scope = 'all' AND can_view_confidential = true →
         see ALL employees
```

### 4c. Enforcement Points

All of the following must apply the visibility filter:

| Endpoint | Filter Applied |
|---|---|
| `GET /api/payroll/employees` | Employee list filtered |
| `GET /api/payroll/employees/:id` | Single employee — 403 if not visible |
| `GET /api/payroll/transactions` | Transactions only for visible employees |
| `GET /api/payroll/employees/:id/salary` | 403 if not visible |
| `GET /api/payroll/employees/:id/bank-details` | 403 if not visible |
| `GET /api/payroll/employees/:id/historical` | 403 if not visible |

### 4d. Bypass Prevention

The visibility filter is enforced at the **service layer** (paytimeAccess.js), not just at the frontend. This means:
- Hidden menu items: won't work (backend blocks the API call)
- Direct URL access to `/payslip/emp-123`: blocked (403 if employee not in visible set)
- API calls via dev tools: blocked (same backend check)

---

## 5. paytime_employee_access Table

For users with `employee_scope = 'selected'`:

```sql
CREATE TABLE paytime_employee_access (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, company_id, employee_id)
);
```

This mirrors `user_client_access` but for employees instead of eco_clients.

**Management:**
- `GET /api/users/:id/paytime-employees` — list assigned employees
- `PUT /api/users/:id/paytime-employees` — set full employee assignment list (replace-all)

---

## 6. Module-Level Access Check

A new middleware `requirePaytimeModule(moduleName)` is inserted into Paytime routes:

```javascript
// Applied on payroll-specific routes (NOT leave routes):
router.get('/', requirePermission('PAYROLL.VIEW'), requirePaytimeModule('payroll'), ...)
```

The middleware:
1. Checks `paytime_user_config` for the current `(user_id, company_id)`
2. If no row exists → passes (unrestricted, backward-compatible)
3. If row exists AND `modules` does not include `moduleName` → 403
4. `super_admin`, `business_owner`, `accountant` always pass (skip paytime_user_config check)

---

## 7. User Management Flow (Owner Perspective)

When a company owner adds an internal user:

```
1. Owner opens user management
2. Owner fills: name, email, password, role
3. Owner selects app access (which apps this user can access)
4. If 'paytime' (Paytime) is selected:
   - Owner sets: Payroll access level (Full / Leave Only)
   - Owner sets: Employee visibility (All / Selected employees)
   - If "Selected" → owner can assign employees from their list
5. System creates:
   - user in `users` table
   - user_company_access(user_id, company_id=owner_company, role=chosen_role)
   - user_app_access rows for selected apps
   - paytime_user_config row (if Paytime settings provided)
   - paytime_employee_access rows (if selected employees provided)
```

---

## 8. Frontend Enforcement (Defence in Depth)

Both frontend AND backend enforce restrictions:

| Check | Frontend | Backend |
|---|---|---|
| Role-based route access | Navigation hides links | `requirePermission()` on every route |
| App module access | Menu items shown/hidden based on paytime_user_config | `requirePaytimeModule()` middleware |
| Employee list | `classification` badge shown; `executive` employees greyed/hidden for restricted users | `paytimeAccess.getEmployeeFilter()` applied in query |
| Payslip access | Employee selector only shows visible employees | Same filter applied at transaction query level |
| Leave vs Payroll | Leave-only users see only leave tab | `requirePaytimeModule('payroll')` blocks payroll API calls |

---

## 9. Company Type Detection in Auth Response

When `GET /api/auth/companies` or `POST /api/auth/select-company` is called,
the backend now annotates each company with `company_type`:

```json
{
  "companies": [
    {
      "id": 42,
      "company_name": "John's Hardware",
      "role": "business_owner",
      "company_type": "client"    // ← NEW: indicates this is a client company, not a practice
    }
  ]
}
```

`company_type = 'client'` means the company is a `client_company_id` in `eco_clients`.
`company_type = 'practice'` means the company is a `company_id` (managing firm) in `eco_clients`.
`company_type = 'standalone'` means it doesn't appear in `eco_clients` at all.

The ECO Hub uses this to detect owner-only logins and render the appropriate view.

---

## 10. Open Issues / Phase 2 Items

```
FOLLOW-UP NOTE
- Area: User invitation system
- What was done: Direct user creation via POST /api/eco-clients/:id/create-owner
- What still needs to be built: Email-based invite flow with time-limited tokens
- Risk if not checked: Owners must be created by practice, not self-service
- Recommended next: Invite token table + email send + claim/accept flow

FOLLOW-UP NOTE
- Area: Session revocation
- What was done: Nothing — JWT-only, 8h expiry
- Risk: Revoked/terminated users can still use valid JWT for up to 8h
- Recommended next: Token blacklist table (redis or postgres), logout endpoint invalidates server-side

FOLLOW-UP NOTE
- Area: MFA / 2FA
- What was done: Nothing
- Risk: Password compromise = full account compromise
- Recommended next: TOTP-based MFA (Google Authenticator / Authy)

FOLLOW-UP NOTE
- Area: Formal company ownership transfer
- What was done: Owner can be changed by updating role in user_company_access
- Risk: No formal approval flow, no audit of ownership changes
- Recommended next: POST /api/companies/:id/transfer-ownership endpoint with approval step

FOLLOW-UP NOTE
- Area: Leave module routes
- What was done: leave_admin role + LEAVE permissions added
- Risk: Leave routes in Paytime are not all labelled — need audit of which routes are "leave" vs "payroll"
- Recommended next: Tag all Paytime routes with their module (leave/payroll) and apply requirePaytimeModule
```

---

## 11. Audit Trail

All access control changes must be logged in `audit_log`:
- Owner user creation: `action_type = 'owner_created'`, entity = eco_client
- Paytime config change: `action_type = 'paytime_config_updated'`, entity = user
- Employee visibility assignment: `action_type = 'paytime_employees_updated'`, entity = user
- Employee classification change: `action_type = 'employee_classified'`, entity = employee
