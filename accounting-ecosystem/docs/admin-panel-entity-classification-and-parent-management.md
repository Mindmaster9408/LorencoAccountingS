# Admin Panel — Entity Classification & Parent Management

> Implemented: March 2026
> Status: Production-ready
> Files: `admin.html`, `companies.js`, `eco-clients.js`, `admin-panel.js`, `accounting-schema.js`, `auth.js`

---

## CHANGE IMPACT NOTE

- **Area being changed:** Admin Panel entity management, company classification, parent-child client hierarchy, user role management
- **Files/services involved:**
  - `frontend-ecosystem/admin.html` — UI controls
  - `backend/shared/routes/companies.js` — classification API
  - `backend/shared/routes/eco-clients.js` — parent reassignment API
  - `backend/shared/routes/admin-panel.js` — new superadmin user management routes
  - `backend/config/accounting-schema.js` — `account_holder_type` column migration
  - `backend/shared/routes/auth.js` — store type at registration
  - `backend/server.js` — mount `/api/admin` routes
- **Current behaviour identified:** Admin panel used a fragile name-based heuristic (`detectFirmType`) to classify entities. `account_type` at registration was accepted but silently discarded. No way to reassign parent or manage users from admin panel.
- **Required behaviours to preserve:** Existing client cards, app toggles, billing, activate/deactivate, Infinite Legacy tree — all unchanged.
- **Admin hierarchy risk:** Low — additive changes only. No data is deleted or restructured automatically.
- **Multi-tenant risk:** Parent reassignment changes `eco_clients.company_id` only; `client_company_id` (data silo) is never touched, so all app data stays isolated per client.
- **Safe implementation plan:** DB column added via idempotent `ALTER TABLE IF NOT EXISTS`. Registration stores type on new companies. Existing records without `account_holder_type` fall through to the heuristic as before — no breakage.

---

## 1. Entity Classification Model

### `companies.account_holder_type` column

| Value | Meaning |
|---|---|
| `'accounting_practice'` | CA firm, bookkeeper, accounting practice managing multiple clients |
| `'business_owner'` | Business entity managing its own operations |
| `'individual'` | Sole proprietor or individual account holder |
| `null` | Not yet classified — UI falls back to heuristic |

**Column added via:** `accounting-schema.js` auto-migration at startup using `ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_holder_type VARCHAR(50)`.

**Heuristic fallback** (`detectFirmType()` in admin.html): Still active for records where `account_holder_type IS NULL`. Once the superadmin sets the type for existing records, the heuristic is no longer used for those records.

---

## 2. Registration Type Flow and Storage

**Signup form** sends `account_type` in the POST `/api/auth/register` body.

**Before this fix:** `account_type` was accepted in the request body but never stored anywhere. The company was created without classification.

**After this fix:** `auth.js` maps the incoming `account_type` to `account_holder_type` and inserts it into the `companies` row.

```javascript
// auth.js — company insert
const validTypes = ['accounting_practice', 'business_owner', 'individual'];
const holderType = validTypes.includes(account_type) ? account_type : null;
// ...
await supabase.from('companies').insert({ ..., account_holder_type: holderType })
```

**Supported values from the signup form:**
- `'accounting_practice'` → stored as `accounting_practice`
- `'business_owner'` → stored as `business_owner`
- Anything else / missing → stored as `null`

---

## 3. Superadmin Classification Controls in Admin Panel

### "Type" button on each account holder group

Each account holder row in the admin panel has an **"✎ Type"** button (amber/yellow).

Clicking it opens the **Edit Entity Classification** modal which shows three options:
1. Accounting Practice
2. Business Owner
3. Individual

The currently stored type (from `companies.account_holder_type`) is pre-selected.

**API called:** `PATCH /api/companies/:id/account-holder-type`

```json
{ "account_holder_type": "accounting_practice" }
```

- Super admin only (checked via `requireSuperAdmin`)
- Writes an audit log entry
- Returns the updated company object
- On success, the admin.html `companyMap` is updated in-memory and the hierarchy re-renders immediately

---

## 4. Users and Permissions Entry in Admin Panel

### "Users" button on each account holder group

Each account holder row has a **"👤 Users"** button (blue/accent).

Clicking it opens the **Users & Permissions** modal showing a table of all users linked to that company via `user_company_access`.

**Columns:** User name / email, Last login, Role (editable dropdown), Save button

**Available roles:** `business_owner`, `accountant`, `manager`, `cashier`, `employee`, `viewer`

**API for listing:** `GET /api/admin/companies/:companyId/users`
- Returns all active `user_company_access` rows joined with `users`
- Super admin only

**API for role change:** `PUT /api/admin/companies/:companyId/users/:userId/role`
- Body: `{ "role": "business_owner" }`
- Super admin only — bypasses the normal `canManageRole` hierarchy (superadmin has platform authority)
- Writes an audit log entry for every change
- If new role is `business_owner`, also updates `users.role` column

---

## 5. Business Owner Assignment from Admin Panel

To make a user a Business Owner within a specific company:

1. Open the Admin Panel at `/admin`
2. Find the correct account holder group
3. Click **"👤 Users"** button
4. In the Users modal, find the target user
5. Change their Role dropdown to **"Business Owner"**
6. Click **"Save"**

This is scoped to that specific company only — the user becomes Business Owner **within that company**, not globally.

**Note:** This does NOT make the user a super admin. Super admin status is controlled separately via `users.is_super_admin`.

---

## 6. Parent-Child Client Reassignment Flow

### Problem solved

When clients were added from the admin panel without explicitly selecting a parent, they defaulted to the JWT's `companyId` (often Infinite Legacy). This caused clients to appear under the wrong parent.

### "Move" button on each client card

Every client card now has a **"⟳ Move"** button (purple).

Clicking it opens the **Move Client** modal with a dropdown of all account holder companies.

**API called:** `PATCH /api/eco-clients/:id/parent`

```json
{ "company_id": 42 }
```

**Safety rules enforced:**
- Super admin only
- Target company must be active
- Cannot assign a client to its own data silo company (`client_company_id`)
- Writes an audit log entry
- `client_company_id` is NEVER changed — all POS/Payroll/Accounting data for that client stays intact
- Existing app activation state is preserved

**After save:** The client card disappears from the old parent group and appears under the new parent group in the admin panel (via in-memory update + re-render).

### Parent selector in "Add Client" modal

The "Add Client" modal now includes a **"Parent Account Holder"** dropdown at the top, showing all account holder companies.

When selected, the `company_id` is sent in the POST body, ensuring the new client is attached to the correct parent from creation.

If not selected, the existing fallback logic applies (JWT `companyId`, then primary company, then first company).

---

## 7. App Tree Rendering Rules

The admin panel renders each account holder group with:
- Account holder name and classification badge
- "👤 Users" and "✎ Type" action buttons
- Collapsed/expandable client list
- Each client card shows: app rows (POS, Payroll, Accounting), Paytime billing inline (if active), SEAN add-on rows, footer with Move + Activate/Deactivate buttons

This rendering is based on `eco_clients.company_id` grouping — all clients with the same `company_id` appear under that company as account holder.

The same structure applies equally to Infinite Legacy and all other account holders. There is no special-casing for any firm.

---

## 8. Multi-Tenant Safety Rules

| Operation | What is Changed | What is NOT Changed |
|---|---|---|
| Edit entity type | `companies.account_holder_type` | All linked eco_clients, users, app data |
| Move client to new parent | `eco_clients.company_id` | `eco_clients.client_company_id`, all app data in client's isolated company |
| Change user role | `user_company_access.role` for that company | User's access to other companies, `users.is_super_admin` |
| Assign business owner | `user_company_access.role` + `users.role` | No other company memberships affected |

**Tenant leakage protections:**
- `PATCH /companies/:id/account-holder-type` — `requireSuperAdmin` guard
- `PATCH /eco-clients/:id/parent` — `isSuperAdmin` check inline
- `GET /admin/companies/:id/users` — `requireSuperAdmin` guard
- `PUT /admin/companies/:id/users/:uid/role` — `requireSuperAdmin` guard
- Parent dropdown only shows account holder companies — not client data silos

---

## 9. API Reference

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `PATCH` | `/api/companies/:id/account-holder-type` | superadmin | Update entity classification |
| `PATCH` | `/api/eco-clients/:id/parent` | superadmin | Reassign client to new parent |
| `GET` | `/api/admin/companies/:id/users` | superadmin | List users for any company |
| `PUT` | `/api/admin/companies/:id/users/:uid/role` | superadmin | Change user role |

---

## 10. Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Existing records without account_holder_type
- Dependency: Superadmin must manually classify existing companies via the "Type" button
- Confirmed now: New registrations store the correct type automatically
- Not yet confirmed: Backfill script for existing records
- Risk if not checked: Existing records continue to use name heuristic, which may misclassify some firms
- Recommended next check: After first admin session — walk through each account holder and set type

FOLLOW-UP NOTE
- Area: Registration form frontend (login.html or create-company flow)
- Dependency: The signup form must send account_type matching 'accounting_practice' or 'business_owner'
- Confirmed now: auth.js correctly stores whatever is sent
- Not yet confirmed: Whether the signup form actually sends these exact string values
- Risk if not checked: If form sends different values (e.g. 'practice', 'owner'), they will be stored as null
- Recommended next check: Audit the signup/create-company frontend form field values

FOLLOW-UP NOTE
- Area: Admin panel Users modal — no inline user invite/add
- Dependency: The modal shows existing users only; adding new users to an account holder from admin panel is not yet wired
- Confirmed now: Viewing and editing roles works
- Not yet confirmed: Whether superadmin needs to add users to other companies from admin panel
- Risk if not checked: Low — admins can still use the per-company users.html for additions
- Recommended next check: Raise if the use case is needed in practice
```
