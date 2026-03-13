# Control Panel Billing Architecture

> Last updated: March 2026
> Covers: Platform Control Centre (`/admin`) — billing and admin oversight view for super admins.

---

## 1. Hierarchy

```
Account Holder (Accounting Practice or Business Owner)
  └── Client (eco_client record)
        └── App (from APP_REGISTRY — POS, Paytime, Accounting, ...)
              ├── Package
              ├── Add-ons (app-specific Sean, etc.)
              └── Billing Block (app-specific metrics)
```

Every account holder group is collapsible. Every active app under a client is expandable (one at a time per client). Inactive apps appear in the list but cannot be expanded.

---

## 2. Account Holder → Client → Apps Structure

### Account Holder
- Represented by `eco_clients.company_id` (the managing accounting firm or business owner company)
- Account holder type is detected from firm name (heuristic) — a proper `account_holder_type` column on `companies` can replace this later
- Types: `accounting_practice` | `business_owner`

### Client
- One `eco_clients` row per client
- Each client has its own isolated company (`client_company_id`) for data isolation in POS/Payroll/Accounting

### Apps
- Driven by `APP_REGISTRY` in `admin.html` (see Section 5)
- Client's activated apps stored as `eco_clients.apps` TEXT[]
- Every app from the registry appears under every client, active or inactive

---

## 3. Dynamic App Registry

Apps are defined in `APP_REGISTRY` in `admin.html`. New apps added to the registry automatically appear under every client in the Control Panel — no UI rewrites required.

```javascript
const APP_REGISTRY = [
  {
    key:            'pos',           // matches eco_clients.apps array values
    name:           'Checkout Charlie',
    subtitle:       'Point of Sale',
    icon:           '🛒',
    seanAddonKey:   null,           // null = no Sean for this app
    billingMetric:  null,           // null = no billing block yet
    packageSupport: true,
  },
  {
    key:            'payroll',
    name:           'Lorenco Paytime',
    subtitle:       'Payroll Management',
    icon:           '💰',
    seanAddonKey:   'sean',         // maps to eco_clients.addons value
    seanAddonLabel: 'SEAN AI Insights for Paytime',
    billingMetric:  'employees',    // triggers employee billing block
    packageSupport: true,
  },
  {
    key:            'accounting',
    name:           'Lorenco Accounting',
    subtitle:       'General Ledger',
    icon:           '📊',
    seanAddonKey:   'sean_accounting',
    seanAddonLabel: 'SEAN AI Insights for Accounting',
    billingMetric:  null,           // billing metric TBD
    packageSupport: true,
  },
];
```

**Future extensibility:** Add a new entry to `APP_REGISTRY`. It will appear automatically for every client.

---

## 4. App Package / Add-on / Billing Model

### Package
- `eco_clients.package_name` (VARCHAR) — stored per client, applies to all apps
- Currently: only `standard` tier
- Future: per-app package tiers can be added to `APP_REGISTRY` without schema changes

### Add-ons
- `eco_clients.addons` (TEXT[]) — list of active add-on keys per client
- Add-ons are shown per-app in the expanded app view (not as a global list)
- Sean is shown under each app that has `seanAddonKey` defined

### Billing
- Each app has its own `billingMetric` in `APP_REGISTRY`
- `billingMetric: 'employees'` → Paytime employee billing block
- `billingMetric: null` → placeholder or no billing block
- Future billing metrics (e.g., `transactions`, `invoices`) can be added per-app

---

## 5. App-Specific Sean Model

Sean is rendered under each app that supports it, not as a global toggle.

| App         | Sean Addon Key      | Notes                              |
|-------------|---------------------|------------------------------------|
| Paytime     | `sean`              | Backward-compatible — existing key |
| Accounting  | `sean_accounting`   | New key stored in TEXT[] — safe    |
| POS         | none                | Sean not applicable                |

**FOLLOW-UP NOTE:** The backend `eco-clients.js` Sean sync logic currently only handles the `sean` addon key (syncing to `companies.modules_enabled`). When `sean_accounting` is activated via the Control Panel, it is correctly stored in `eco_clients.addons` but does not yet sync to `companies.modules_enabled`. This sync logic should be extended once the Accounting app's Sean module is production-ready.

---

## 6. Billing Metric Definitions — Paytime

| Metric                   | Definition                                                                 |
|--------------------------|----------------------------------------------------------------------------|
| **Active employees on system** | All employees in the `employees` table for this client where `is_active = true` |
| **Last billed**          | Employee count from last billing snapshot (`eco_clients.last_billed_employees`) |
| **Difference vs last bill** | `current_active - last_billed` — positive = new employees to bill; negative = employees left |
| **First billing state**  | When `last_billed_period` is null — clearly flagged, no misleading zeros |

### Employee Count Source of Truth

The active employee count uses two lookup methods, in priority order:

1. **Primary — by `eco_client_id`**: employees are looked up by their `eco_client_id` column directly. This is immune to any `company_id` mismatch.
2. **Fallback — by `client_company_id`**: looks up `billingSummary[client.client_company_id]` from the per-company index.

This two-tier lookup fixes the known bug where some employees are stored under a different `company_id` than `eco_client.client_company_id` (can happen for clients created before migration 005 or via manual Paytime entry).

**API endpoint:** `GET /api/eco-clients/payroll-billing-summary`
**Returns:**
```json
{
  "summary":      { "<company_id>": { "active_employees": 2 } },
  "by_client_id": { "<eco_client_id>": 2 }
}
```

---

## 7. Expansion Rules

- **Account holder groups**: expandable/collapsible. Default: all expanded on load.
- **App rows**: expandable only if the app is active. Inactive apps show as non-expandable rows.
- **One app expanded at a time per client**: opening a new app automatically closes the previously open one.
- **Inactive apps**: always visible in the list. Not expandable. Toggle is available to activate.

---

## 8. Future Export Readiness

The Control Panel data pipeline is structured for future PDF/Excel export:

- All data available in `allClients` array (JS state)
- `companyMap` provides account holder details
- `billingByClient` + `billingSummary` provide billing metrics
- `APP_REGISTRY` provides app metadata

Future export can iterate:
```
allClients → group by company_id → for each client → for each app in APP_REGISTRY
  → read activation, package, addons, billing metrics
```

No structural changes are needed to support export. A future export button can call a new API endpoint that assembles the same data server-side for PDF/XLSX generation.

---

## 9. Permissions / Access

- The Control Panel is only accessible to `isSuperAdmin` users (enforced in JS auth guard + route-level)
- `GET /api/eco-clients?status=all` returns ALL clients (active + inactive) only for super admins
- Normal ecosystem views only show clients for the user's own company (separate from this panel)

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:
    frontend-ecosystem/admin.html (full Control Panel refactor)
    backend/shared/routes/eco-clients.js (billing summary endpoint)

- Files/services involved:
    accounting-ecosystem/frontend-ecosystem/admin.html
    accounting-ecosystem/backend/shared/routes/eco-clients.js
    accounting-ecosystem/docs/control-panel-billing-architecture.md (new)

- Current behaviour identified:
    - Flat client grid with firm group headers (no true hierarchy)
    - Hardcoded APP_ICONS/APP_LABELS/APP_SUBS dicts (not registry-driven)
    - Single global SEAN add-on toggle per client (not app-specific)
    - Employee count keyed by company_id only (bug: Anine shows 0)
    - No account holder expand/collapse
    - No app-level expand/collapse

- Required behaviours preserved:
    - All toggleApp() / toggleAddon() / toggleClient() / markAsBilled() calls unchanged
    - All API endpoints unchanged
    - Auth guard (isSuperAdmin check) preserved
    - Stats grid preserved
    - Filter chips preserved
    - Add Client modal preserved
    - Search functionality preserved

- Risk of regression:
    - Low: all action functions are identical API calls
    - Moderate: complete rendering rewrite — visual regression possible but
      functionally backward-compatible (all data is the same)

- Related dependencies:
    - eco-clients.js: billing summary now returns by_client_id as additional index
      (backward compatible — summary key still returned unchanged)
    - modules.js: APP_REGISTRY in frontend mirrors modules.js backend structure
      (no backend change required)

- Safe implementation plan:
    1. Backend: add by_client_id to billing summary (non-breaking addition)
    2. Frontend: rewrite admin.html with APP_REGISTRY + hierarchy rendering
    3. All existing API calls and action functions preserved intact
```

---

## FOLLOW-UP NOTES

```
FOLLOW-UP NOTE 1 — Sean Per-App Sync
- Area: eco-clients.js Sean addon sync logic
- Dependency: Backend Sean sync only handles 'sean' key → companies.modules_enabled
- Confirmed now: 'sean_accounting' stored correctly in addons array
- Not yet confirmed: 'sean_accounting' triggers correct module enable in Accounting app
- Risk if wrong: Sean Accounting add-on toggled but Accounting module not enabled for company
- Recommended next check: When Accounting Sean module is production-ready, extend
  the Sean sync block in eco-clients.js PUT route to handle 'sean_accounting'

FOLLOW-UP NOTE 2 — Account Holder Type Column
- Area: companies table, Control Panel firm type display
- Dependency: Firm type currently detected via name heuristic (contains 'accounting' etc.)
- Confirmed now: Displays correctly for known firm names
- Not yet confirmed: Correct for all future firm names
- Risk if wrong: Wrong type badge shown (cosmetic only — no business logic impact)
- Recommended next check: Add account_holder_type column to companies table and
  populate it during onboarding/firm creation

FOLLOW-UP NOTE 3 — Anine Employee Count Root Cause
- Area: Paytime billing block, employee count for 'Anine' client
- Dependency: employees.eco_client_id column must be populated for primary lookup
- Confirmed now: by_client_id lookup added to billing summary API
- Not yet confirmed: whether Anine's employee record has eco_client_id set
- Risk if wrong: Count still shows 0 (fallback to company_id lookup still active)
- Recommended next check: Run in Supabase:
    SELECT id, company_id, eco_client_id, is_active FROM employees WHERE full_name ILIKE '%anine%';
    If eco_client_id is null: run a one-time update to link employees to their eco_client
    via: UPDATE employees SET eco_client_id = <anine_eco_client_id> WHERE company_id = <anine_company_id>;

FOLLOW-UP NOTE 4 — Per-App Package Tiers
- Area: APP_REGISTRY packageSupport flag, PACKAGES array
- Dependency: Currently one PACKAGES array applies to all apps
- Confirmed now: Structure supports per-app packages in future
- Not yet confirmed: Business requirements for per-app package tiers
- Risk if wrong: None currently — standard package shown for all apps
- Recommended next check: Define per-app package tiers when billing model is finalised
```
