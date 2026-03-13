# Platform Control Centre — Data Scope & Architecture

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:     frontend-payroll/super-admin-dashboard.html
- Files involved:         super-admin-dashboard.html only (no backend changes required)
- Current incorrect behaviour:
    Page called AUTH.getAllCompaniesWithRegistered(), AUTH.getCompanyOwner(),
    AUTH.toggleCompanyStatus() — all three methods do not exist in auth.js.
    Page loaded zero data on every render. All account holders were invisible.
    The "new accounting practice not showing" bug was the symptom; the root cause
    was that the entire data pipeline was broken (returning undefined).
- Corrected behaviour:
    Page now calls three live API endpoints in parallel on load:
      GET /api/companies          → ALL companies (super admin scope)
      GET /api/eco-clients?status=all → ALL eco-clients (super admin scope)
      GET /api/eco-clients/payroll-billing-summary → employee counts
    Derives account holders from the companies response, excludes isolated
    client_company_id data records. Renders expandable hierarchy.
- Risk of regression:     Low. No backend changes. GET-only data loads.
    PUT /api/companies/:id for suspend/activate was already tested.
- Safe implementation:    All API calls use the existing token from safeLocalStorage.
    Super admin X-Company-Id header passed for company-context calls.
    Graceful error handling — retry button on load failure.
```

---

## 1. Purpose

The **Platform Control Centre** is the super-admin billing and accounts oversight screen.

It shows the full platform from above — every account holder, every managed client, and the apps active under each client.

This is NOT a user-facing dashboard. It is NOT scoped to the currently signed-in user's own clients. It is a platform-wide administrative view.

**Access:** Super admins only (`session.role === 'super_admin'` or `session.is_super_admin === true`).

---

## 2. Scope: Platform Control Centre vs Normal Ecosystem Dashboard

| Dimension | Normal Ecosystem Dashboard | Platform Control Centre |
|---|---|---|
| Companies shown | Only companies the signed-in user belongs to | **ALL** companies on the platform |
| Clients shown | Only eco-clients managed by signed-in user's practice | **ALL** eco-clients on the platform |
| Auth scope | Per-user, per-company | Super admin — platform-wide |
| Purpose | Manage your own practice and clients | Billing oversight, account holder audit, suspend/activate |
| Data source | `AUTH.getCompanies()` (returns user-scoped list) | `GET /api/companies` → super admin returns full table |

**Critical rule:** The Platform Control Centre must never be refactored to reuse the normal ecosystem client list. These are different scopes with different access requirements.

---

## 3. Account Holder → Client → App Hierarchy

```
Account Holder (company record — NOT a client_company_id)
  └─ Client (eco_client record where eco_client.company_id = account_holder.id)
       └─ Apps (eco_client.apps JSONB array: ["pos", "payroll", "accounting", ...])
```

### What is an Account Holder?

An **Account Holder** is any company record (`companies` table) that is **not** a `client_company_id` of any eco-client.

When an eco-client is created, a new isolated company is auto-created and stored as `eco_client.client_company_id`. This isolated company is the client's data silo. It is **not** an account holder — it should not appear at the top level of the Platform Control Centre.

**Account Holder identification algorithm:**
```javascript
// 1. Get all eco-clients
const allClients = await GET /api/eco-clients?status=all

// 2. Build set of all client_company_id values
const clientCompanyIdSet = new Set(
    allClients
        .filter(c => c.client_company_id)
        .map(c => Number(c.client_company_id))
)

// 3. From all companies, exclude client data silos
const accountHolders = allCompanies.filter(c => !clientCompanyIdSet.has(Number(c.id)))
```

### Empty Account Holders Must Appear

If an accounting practice was just created and has zero clients:
- It is still present in the `companies` table
- It does NOT appear in any `eco_client.company_id`
- It does NOT appear in any `eco_client.client_company_id`
- Therefore it **passes the exclusion filter** and appears as an account holder
- It renders with `0 clients` and an empty client section

This is the correct behaviour. A newly created practice must always appear.

---

## 4. API Endpoints Used

### `GET /api/companies`
- Super admin: returns ALL company records from the `companies` table, ordered by `company_name`
- Regular user: returns only companies the user has access to via `user_company_access`
- Used to get the full list of companies for account holder determination

### `GET /api/eco-clients?status=all`
- Super admin with `?status=all`: returns ALL eco-clients including inactive ones
- Regular user: returns only eco-clients managed by their company
- Used to get all clients and their `company_id` (managing practice) + `apps` array

### `GET /api/eco-clients/payroll-billing-summary`
- Returns `{ summary: { [company_id]: { active_employees: N } }, by_client_id: { [eco_client_id]: N } }`
- Used to show employee counts per client and per account holder
- Preferred lookup: `by_client_id[eco_client_id]` (more accurate)
- Fallback: `summary[client_company_id].active_employees`

### `PUT /api/companies/:id`
- Requires `requireCompany` middleware → super admin provides `X-Company-Id` header with their own company ID
- Requires `COMPANIES.EDIT` permission → `super_admin` role has this permission
- Used for suspend (`is_active: false`) and activate (`is_active: true`) actions

---

## 5. Filtering Rules

### Status filter (UI tabs: All / Active / Inactive)
- `All`: no status filtering — all account holders shown
- `Active`: only companies where `is_active !== false`
- `Inactive`: only companies where `is_active === false`

Default view: `All` — all account holders visible.

### Search
Searches across:
- Account holder `company_name`
- Account holder `contact_email` / `email`
- Client names (`eco_client.name`) under the account holder
- Client emails under the account holder

An account holder appears in search results if its own name matches OR if any of its clients' names match.

### What filters must NOT do
- Must not drop account holders because they have zero clients
- Must not drop account holders because they have no billing history
- Must not drop account holders because they were recently created
- Active/inactive filter only applies to the account holder status, never to client count or app state

---

## 6. Empty / Partial State Handling

| Situation | Behaviour |
|---|---|
| Account holder exists, zero clients | Shows in list with "0 clients" and "No clients yet" when expanded |
| Account holder exists, clients have no apps | Shows clients with "no apps" label instead of chips |
| Account holder exists, billing data missing | Shows "0 emp" safely (billing call has `.catch(() => {})` fallback) |
| Account holder newly created | Appears immediately on next page load (no caching blocks it) |
| API call fails | Shows error state with Retry button |

---

## 7. Why New Account Holders Must Always Appear

New practices must appear in the Platform Control Centre because:

1. **They exist in `companies` table** — `GET /api/companies` returns them (super admin scope)
2. **They have no `client_company_id` entry** — so they are NOT excluded by the account holder filter
3. **No billing/client history required** — the hierarchy explicitly allows `0 clients`
4. **No caching** — the page reloads live data on every visit and every Refresh click

The only scenario where a new practice would not appear is if the API call itself fails — which is handled by the error state + retry button.

---

## 8. Cache Invalidation / Refresh

The Platform Control Centre has **no client-side data cache**.

Every page load and every Refresh button click calls:
```
GET /api/companies
GET /api/eco-clients?status=all
GET /api/eco-clients/payroll-billing-summary
```
in parallel. Data is always fresh from the database.

There is no `availableCompanies` localStorage key used here (that is the normal user-scoped cache used by other pages — explicitly NOT used here).

---

## 9. Related Documents

| Document | Link |
|---|---|
| Ecosystem Architecture | `docs/ecosystem-architecture.md` |
| Data Persistence Policy | `docs/DATA_PERSISTENCE_POLICY.md` |
| CLAUDE.md — Part A (Regression Prevention) | `CLAUDE.md` |
| eco-clients backend route | `backend/shared/routes/eco-clients.js` |
| companies backend route | `backend/shared/routes/companies.js` |
