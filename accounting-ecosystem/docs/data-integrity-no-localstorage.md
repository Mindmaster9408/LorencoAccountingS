# Data Integrity — No Business Data in localStorage

**Module:** Lorenco Accounting
**Prompt phase:** Prompt 3 (Data Integrity Audit)
**Reviewed:** March 2026

---

## CHANGE IMPACT NOTE

```
CHANGE IMPACT NOTE
- Area being changed:       localStorage usage audit — remove all hardcoded demo/mock data from frontend
- Files/services involved:
    frontend-accounting/dashboard.html         — removed demoMode branch with hardcoded mock data
    frontend-accounting/contacts.html          — replaced 15 hardcoded demo contacts with real API calls
    frontend-accounting/company.html           — fixed silent error swallowing in save catch block
- Current behaviour identified:
    - dashboard.html had an if (demoMode) branch that bypassed all real API calls and injected
      hardcoded stats (25 accounts, 3 journals, 12 unmatched txns) + 3 fake journal rows
    - contacts.html had a hardcoded const contacts = [...] array of 15 fake SA businesses
      that was always used regardless of authenticated company context
    - company.html catch block showed 'Company settings saved locally (demo mode)' on any
      API failure — misleading the user that the save succeeded when it actually failed
- Required behaviours to preserve:
    - All real API calls in dashboard.html (accounts count, journals, bank, recent journals)
    - All filter/search/sort/stats in contacts.html (now wired to real data)
    - company.html save + error handling
- Risk of regression:  LOW — only removed code paths that should never have been active in production
- Safe implementation plan:
    1. dashboard.html: remove the entire if (demoMode) { ... return; } block
    2. contacts.html: add authH/apiGet/apiPut helpers, loadContacts() from suppliers + customers APIs,
       merge same-name contacts as 'both', wire all rendering to allContacts
    3. company.html: change catch to show actual error message
```

---

## Architecture Rule: No Business Data in localStorage

The Lorenco Accounting frontend uses a cloud-backed localStorage polyfill (`js/polyfills.js`).

`polyfills.js` monkey-patches `localStorage.setItem / getItem / removeItem` to:
- Route business data through `/api/accounting/kv` (stored in Supabase `accounting_kv_store`)
- Keep auth/session keys in native localStorage only (whitelist: `token`, `eco_token`, `eco_user`, `eco_companies`, `accounting_company_name`, `eco_company_name`, `eco_client_id`, `demoMode`, `isSuperAdmin`, `sso_source`, `language`, `theme`)

This means any `localStorage.setItem('someBusinessKey', data)` call is automatically cloud-backed — **but only if the page loads polyfills.js**.

### Hard rule

Business data must never be:
1. Hardcoded inline in JavaScript (fake arrays, mock objects)
2. Stored only in localStorage without a server-backed copy
3. Silently assumed to be saved when an API call fails

All business data must be loaded from and saved to the real API endpoints on every page load.

---

## demoMode Flag

`demoMode` is a localStorage key that navigation.js reads to show a demo banner UI indicator.

**`demoMode` is NEVER set to `'true'` in any production code path.** It is only cleared on logout.

No page should branch on `demoMode === 'true'` to serve hardcoded data instead of calling the real API. This pattern was removed from `dashboard.html` in March 2026.

---

## Contacts Page Architecture

`contacts.html` now loads real data from two API endpoints:

| Source | Endpoint | Contact type |
|---|---|---|
| Suppliers | `GET /api/accounting/suppliers` | `supplier` |
| Customers | `GET /api/accounting/customer-invoices/customers` | `customer` |

Contacts with the same name in both sources are merged and shown as `type: 'both'`.

### Edit/Create/Delete routing

- **Supplier contacts**: editable via `PUT /api/accounting/suppliers/:id`. New suppliers created via `POST /api/accounting/suppliers`.
- **Customer contacts**: read-only in the Contacts view. Users are directed to the Customers module (`customers.html` / `invoices.html`) for customer management.
- **Delete**: contacts cannot be deleted from the Contacts page. Users are directed to the appropriate module (Suppliers for deactivation).

---

## Files Confirmed Safe (no unsafe localStorage usage)

| File | Status | Notes |
|---|---|---|
| `js/polyfills.js` | SAFE | Cloud-backed architecture; `LOCAL_KEYS` whitelist keeps auth in native localStorage |
| `js/navigation.js` | SAFE | Only reads auth tokens, display names, `demoMode` (never set in production) |
| `bank.html` | SAFE | Uses `safeLocalStorage` wrapper (cloud-backed) for SEAN learning data |
| `dashboard.html` | FIXED (March 2026) | Removed demoMode branch; always uses real API |
| `contacts.html` | FIXED (March 2026) | Replaced hardcoded contacts array with real API calls |
| `company.html` | FIXED (March 2026) | Fixed silent error swallowing — now shows actual error to user |

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Contacts page — customer balance display
- Dependency: customer-invoices/customers endpoint returns name/email/phone only, no AR balance
- What was done now: Customer balances show R 0.00 (no balance data from customers endpoint)
- What still needs to be checked: If contacts page needs real AR balances for customers,
  add a /api/accounting/customer-invoices/ar-summary endpoint that returns balance per customer
- Risk if not checked: Customer balance column always shows R 0.00 — cosmetic issue only
- Recommended next review point: Prompt 4 or when contacts page is prioritised
```

```
FOLLOW-UP NOTE
- Area: Contacts page — full CRUD for customer contacts
- Dependency: No dedicated customer contacts endpoint (customers come from pos_customers + invoices)
- What was done now: Edit/delete of customer contacts redirects user to Customers module
- What still needs to be checked: If the Contacts page should become a first-class CRUD module,
  build a dedicated contacts table or extend pos_customers with is_ar_contact flag
- Risk if not checked: Contacts page is read-only for customers — acceptable for current scope
- Recommended next review point: When contacts module is scoped as a formal feature
```
