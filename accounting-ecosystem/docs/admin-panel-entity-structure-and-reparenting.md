# Admin Panel — Entity Structure & Reparenting

> Implemented: March 2026
> Files: `frontend-ecosystem/admin.html`, `backend/shared/routes/auth.js`, `backend/shared/routes/eco-clients.js`
> Status: Production-ready

---

## CHANGE IMPACT NOTE

- **Area being changed:** Admin Panel entity classification, parent-child hierarchy, account type registration persistence, standalone company adoption
- **Files/services involved:**
  - `backend/shared/routes/auth.js` — registration account_type mapping fix
  - `backend/shared/routes/eco-clients.js` — new `POST /adopt-company` route
  - `frontend-ecosystem/admin.html` — heuristic indicator badge, Adopt button, Adopt modal, JS
- **Current behaviour identified:**
  1. Registration form sent `account_type: 'accountant'` or `'business'`; backend only accepted `'accounting_practice'` or `'business_owner'` → ALL registrations stored `account_holder_type = null` → admin panel fell back to name heuristic → showed wrong type (e.g. "Quibus van Zyl" showed as Business Owner instead of Accounting Practice).
  2. Companies registered via signup appeared as separate top-level "account holders" in the admin panel; no mechanism existed to move them under a parent without re-creating them from scratch.
  3. When `account_holder_type = null`, the admin panel showed a type derived from the heuristic with no visual indication that it was unclassified, making it look authoritative.
- **Required behaviours to preserve:** Existing client cards, app toggles, billing, activate/deactivate, user management modal, move client modal, entity type edit modal — all unchanged.
- **Multi-tenant risk:** Low. Adopt operation creates a new eco_client record; it does NOT modify the adopted company's data, user access rows, or app records.
- **Relationship/data-integrity risk:** Low. Safety checks in backend prevent: double adoption, adopting a company that manages sub-clients (would orphan them), adopting own parent.
- **Safe implementation plan:** All changes additive. New route before existing POST to prevent routing conflicts. JS changes to admin.html are additive (new functions, updated badge rendering, new modal). No DB schema changes needed.

---

## 1. Entity Types and How They Are Stored

### `companies.account_holder_type` column

| Value | Meaning |
|---|---|
| `'accounting_practice'` | CA firm, bookkeeper, accounting practice managing multiple clients |
| `'business_owner'` | Business entity managing its own operations |
| `'individual'` | Sole proprietor or individual account holder |
| `null` | Not yet classified — admin panel falls back to name heuristic |

Column is added via `accounting-schema.js` auto-migration: `ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_holder_type VARCHAR(50)`.

---

## 2. Signup / Registration Classification Flow

### The Bug (fixed March 2026)

The registration form (`login.html`) set `regState.accountType` to:
- `'accountant'` when the user selected "Accounting Practice"
- `'business'` when the user selected "Business Owner"

The payload sent to `POST /api/auth/register` used `account_type: regState.accountType`.

The backend previously validated against `['accounting_practice', 'business_owner', 'individual']`, which does NOT include `'accountant'` or `'business'`. Result: `account_holder_type` was always stored as `null` for every registration.

### The Fix

`auth.js` now maps all known form values to canonical DB values:

```javascript
const accountTypeMap = {
    accountant:          'accounting_practice',
    accounting_practice: 'accounting_practice',
    business:            'business_owner',
    business_owner:      'business_owner',
    individual:          'individual',
};
const holderType = accountTypeMap[account_type] || null;
```

Both the short form (`'accountant'`/`'business'`) and canonical form are accepted. Future registrations will always store the correct type.

### Existing records with `account_holder_type = null`

All registrations before this fix have `account_holder_type = null`. These need to be manually corrected by a superadmin using the **"✎ Type"** button in the admin panel.

The admin panel now shows a **⚠ indicator** (amber badge with tooltip) on any account holder where the type is derived from the heuristic (i.e. `account_holder_type IS NULL`). This makes it easy to identify which entities need manual classification.

---

## 3. Parent-Child Relationship Model

### How the Admin Panel Groups Entities

The admin panel renders **account holders** (top-level groups) and **client cards** (children) as follows:

```
ACCOUNT HOLDER (company in companyMap)
  ├─ CLIENT CARD (eco_client.company_id = account holder's company.id)
  ├─ CLIENT CARD
  └─ CLIENT CARD
```

For a company to appear as an **account holder**:
1. Its `companies.id` must NOT be in `clientCompanyIdSet` (not a data silo)
2. It must either be in `managingCompanyIds` (has eco_clients under it) OR have `modules_enabled` set

For a client to appear **under** an account holder:
- `eco_clients.company_id` = the account holder's `companies.id`

### Two Types of Clients

| Type | How created | How appears |
|---|---|---|
| **Add Client** (via Admin Panel) | New company auto-created as data silo; eco_client links to it | Client card under correct parent |
| **Registered company** (via Signup) | Standalone company in DB; no eco_client record | Separate account holder group at top level |

The confusion: when a practice wanted "Champ Water Purification" as a client under "Quibus van Zyl", but Champ registered via signup instead of being added via Add Client, it appears as a standalone account holder — NOT as a client under Quibus.

---

## 4. Superuser Ability to Change Entity Type

The **"✎ Type"** button on each account holder header opens the **Edit Entity Classification** modal.

Options: Accounting Practice | Business Owner | Individual

API: `PATCH /api/companies/:id/account-holder-type` (superadmin only)

- Updates `companies.account_holder_type`
- Writes audit log
- Admin panel updates immediately (in-memory `companyMap` patched, panel re-rendered)

**Use this to repair all existing records where ⚠ is shown.**

---

## 5. Superuser Ability to Move / Re-Parent Clients

### Moving eco_clients between parent account holders

The **"⟳ Move"** button on each client card opens the **Move Client** modal.

API: `PATCH /api/eco-clients/:id/parent` (superadmin only)

- Changes `eco_clients.company_id` to the selected parent
- Does NOT change `eco_clients.client_company_id` (data silo preserved)
- All app data, user access, billing records intact
- After save: client card moves from old parent group to new parent group

**Use this when:** An eco_client was created with the wrong parent (e.g. defaulted to The Infinite Legacy instead of Quibus van Zyl).

### Adopting a standalone company as a client

The **"⊕ Adopt"** button on each account holder header opens the **Adopt Company as Client** modal.

API: `POST /api/eco-clients/adopt-company` (superadmin only)

**Body:**
```json
{ "company_id": <existing company ID>, "parent_company_id": <managing practice ID> }
```

**What it does:**
1. Creates a new `eco_clients` record with `company_id = parent` and `client_company_id = existing company`
2. The existing company's data is NOT changed
3. The existing company's `user_company_access` rows are NOT changed — users keep their access
4. After creation, the adopted company is in `clientCompanyIdSet` → excluded from account holder list → appears only as a client card under the chosen parent

**Safety checks enforced by backend:**
- Super admin only
- Target company must be active
- Target company must NOT already be a `client_company_id` (prevent double-adoption)
- Target company must NOT be managing active eco_clients of its own (would orphan their clients — move those first)
- Target company must NOT be the same as the parent

**Candidate filter in admin panel dropdown:**
Shows only companies that are NOT already data silos AND NOT managing other clients AND have `modules_enabled` set. Companies managing sub-clients are excluded to protect data integrity.

---

## 6. Users & Permissions Action in Admin Panel

The **"👤 Users"** button on each account holder header opens the **Users & Permissions** modal.

Displays: all `user_company_access` rows for that company (name, email, last login, role).

Role dropdown options: Business Owner | Accountant | Manager | Cashier | Employee | Viewer

API (list): `GET /api/admin/companies/:id/users` (superadmin only)
API (change role): `PUT /api/admin/companies/:id/users/:uid/role` (superadmin only)
- If new role = `business_owner`, also updates `users.role`
- Writes audit log for every change

---

## 7. How Child Clients Render Beneath a Parent

Every eco_client under any account holder renders identically:
- Client name, email/phone metadata
- App list (POS, Payroll, Accounting) with active/inactive status chips and toggle switches
- Paytime billing inline card (if Payroll is active)
- SEAN add-on sub-row (if SEAN add-on is enabled)
- Footer: "⟳ Move" button + Activate/Deactivate button

This structure is produced by `buildClientCard()` + `buildAppRow()` and is identical for all account holders — there is no special-casing for The Infinite Legacy or any other holder.

---

## 8. Safety Considerations

### Multi-tenant isolation rules

| Operation | Changed | NOT Changed |
|---|---|---|
| Set entity type | `companies.account_holder_type` | All linked eco_clients, users, app data |
| Move client (PATCH /parent) | `eco_clients.company_id` | `eco_clients.client_company_id`, all app data |
| Adopt company | New eco_client row created | The adopted company record, its users, its app data |
| Change user role | `user_company_access.role` | Other company memberships, `users.is_super_admin` |

### Adopt operation — what is safe and what is not

**Safe:** Adopting a company that has no eco_clients of its own and no active clients managing role. The company's data silo stays intact; users who had direct access still have it.

**Not safe (blocked):** Adopting a company that is itself managing eco_clients. Those clients have `company_id` pointing to the adopted company. After adoption, that company would be excluded from the account holder list, orphaning those clients visually. The backend rejects this with an error listing the blocking clients. **Resolution:** Move those clients to a different parent first using "⟳ Move", then adopt.

---

## 9. Migration / Repair for Existing Incorrect Data

### Step 1: Fix entity types

For each account holder with a **⚠ indicator** in the admin panel:
1. Click **"✎ Type"**
2. Select the correct classification
3. Save

This sets `account_holder_type` in the database. The ⚠ indicator disappears.

### Step 2: Fix parent-child relationships

**Scenario A: eco_client is under wrong parent (e.g. under The Infinite Legacy instead of Quibus)**
1. Click **"⟳ Move"** on the client card
2. Select the correct parent account holder
3. Save

**Scenario B: company registered via signup should be a client under a practice**
1. Navigate to the target parent account holder
2. Click **"⊕ Adopt"**
3. Select the standalone company from the dropdown
4. Save

After adoption:
- The standalone company no longer appears as a top-level account holder
- It appears as a client card under the selected parent
- Its app toggles show (all inactive by default — activate as needed)
- App data in the existing company remains intact

---

## 10. Preventing Recurrence

**Registration** (fixed): `auth.js` now maps `'accountant'` → `'accounting_practice'` and `'business'` → `'business_owner'`. Future registrations always persist the correct type.

**Add Client in Admin Panel**: The parent dropdown is always shown and pre-populates account holders. The `company_id` is sent in the POST body so the new client always lands under the selected parent.

**Adopt** (new): When a company registers via signup but should be under a practice, use Adopt rather than re-creating from scratch.

---

## 11. API Reference

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `PATCH` | `/api/companies/:id/account-holder-type` | superadmin | Change entity classification |
| `PATCH` | `/api/eco-clients/:id/parent` | superadmin | Move eco_client to different parent |
| `POST` | `/api/eco-clients/adopt-company` | superadmin | Adopt standalone company as eco_client |
| `GET` | `/api/admin/companies/:id/users` | superadmin | List users for any company |
| `PUT` | `/api/admin/companies/:id/users/:uid/role` | superadmin | Change user role |

---

## 12. Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Existing companies with account_holder_type = null (pre-fix registrations)
- What was done: Registration flow now stores correct type going forward
- Not yet done: Backfill existing null records
- How to fix: Superadmin walks through each ⚠-badged account holder in admin panel,
  clicks "✎ Type", selects correct classification, saves
- Risk if not done: Name heuristic continues to show potentially wrong type for old records
- Recommended: Do this immediately after deployment

FOLLOW-UP NOTE
- Area: Adopted companies — app activation
- After adopting a standalone company, all apps show as "Inactive" on the new eco_client
  because eco_clients.apps starts as an empty array
- The underlying company may have apps active in its companies.modules_enabled
- These are two separate fields — eco_clients.apps controls what is shown in admin panel
- Action required: Activate the relevant apps on the client card after adoption

FOLLOW-UP NOTE
- Area: Companies managing sub-clients — cannot be adopted
- The backend blocks adoption of any company that manages active eco_clients
- To resolve: use "⟳ Move" on each of their sub-clients first, then adopt
- This is intentional to prevent orphaning their clients
```
