# Codebox 29 — Tax Constant Tables + SARS Tax Year Configuration Foundation

**Status:** Complete  
**Date:** 2026-06-21  
**Module:** Practice Management — `/api/practice/tax-configs`

---

## What This Is

Moves SA SARS individual tax constants (brackets, rebates, credits, deduction limits) out of hardcoded JS and into a controlled, versioned, database-managed configuration system.

**This is NOT:**
- A live SARS API feed
- Automatic SARS rate updates
- Tax filing or submission
- Tax advice

**This IS:**
- Database-backed tax year configs with full lifecycle (draft → active → archived)
- Per-config bracket editor (add/edit/delete)
- Rebates, thresholds, medical credits — all editable per config
- Deduction limit storage (RA %, RA cap, s18A %) — for future cap enforcement
- Audit event log per config change
- Lock mechanism — prevents further editing after accountant sign-off
- Seed helper — copies hardcoded JS constants into DB as draft configs
- Calculation engine updated to use DB constants first, JS fallback second
- Warning flags on every calculation showing constant source

---

## Database (Migration 079)

Run `accounting-ecosystem/backend/config/migrations/079_practice_tax_year_configuration.sql` once in Supabase SQL Editor.

### Tables Created

| Table | Purpose |
|---|---|
| `practice_tax_year_configs` | One config per tax year / country / scope (company_id null = global) |
| `practice_tax_brackets` | One bracket row per tax bracket per config |
| `practice_tax_config_events` | Audit event log per config action |

### Indexes (13 total)

5 on `practice_tax_year_configs` (company, year, country, status, year+status+country composite)  
4 on `practice_tax_brackets` (company, config, year, config+order)  
3 on `practice_tax_config_events` (config, company, config+created_at DESC)

### Key schema notes

- `company_id NULL` = global config (visible to all companies)
- `company_id SET` = company-specific override (reserved for future use — not yet used in routing)
- `marginal_rate` stored as percentage (e.g. `18.0000` = 18%) — divided by 100 when loaded by calculation engine
- `status` must be `draft` → `active` → `archived` (controlled transitions)
- `locked_at` set by PUT /:id/lock — once locked, brackets and values cannot be edited

---

## Backend Router (tax-config.js)

File: `accounting-ecosystem/backend/modules/practice/tax-config.js`  
Mounted at: `/api/practice/tax-configs`

### Routes (registration order — specific before generic)

```
POST  /seed-from-js                    Seed draft configs from JS constants (skip existing years)
GET   /:id/brackets                    List brackets for a config
POST  /:id/brackets                    Add bracket to config
GET   /:id/events                      Audit event history
PUT   /:id/brackets/:bracketId         Update bracket
DELETE /:id/brackets/:bracketId        Delete bracket (hard delete — data entry correction)
PUT   /:id/activate                    Transition: draft/archived → active (archives any existing active for same scope/year)
PUT   /:id/archive                     Transition: any → archived
PUT   /:id/lock                        Lock config permanently
GET   /:id                             Get config + brackets
PUT   /:id                             Update config fields
GET   /                                List configs (filter: tax_year, status, country_code)
POST  /                                Create config (always draft, always global scope)
```

### Access control

Global configs (`company_id = null`) are accessible to all authenticated companies.  
`verifyConfigOwnership()` accepts: config.company_id is null OR config.company_id matches caller's company.

### Activation rule

When activating a config, any other currently active config for the same `tax_year + country_code + company_id scope` is automatically archived first. Only one active config per year per scope.

### Seed logic

`POST /seed-from-js`:
- Reads `TAX_YEAR_CONSTANTS` from `individual-tax-constants.js`
- For each year: checks if a global config for that year already exists
- If yes: returns `action: 'skipped'` (never duplicates)
- If no: inserts config row + bracket rows
- Note: `marginal_rate` in JS constants is decimal (0.18) → stored as percentage (18.0000) in DB

---

## Calculation Engine Update (individual-tax-calculations.js)

`runDraftCalculation()` now uses this resolution order:

```
1. Query practice_tax_year_configs WHERE tax_year=? AND status='active' AND country_code='ZA'
   AND (company_id IS NULL OR company_id = req.companyId)
   ORDER BY company_id DESC NULLS LAST   ← company-specific preferred over global

2. If found → load practice_tax_brackets for config_id → build bracket array → use these constants
   constantSource = 'db'
   tax_table_version = '[DB] ' + config_name

3. If not found → getConstants(taxYear) from individual-tax-constants.js (JS fallback)
   constantSource = 'js_fallback'
   tax_table_version = '[JS] ' + jsConsts.version
   warning flag: DB_TAX_CONFIG_NOT_FOUND_USING_JS_FALLBACK

4. If neither → constants = null, hasBrackets = false
   warning flag: TAX_CONSTANTS_MISSING_CALC_LIMITED
```

**Backward compatibility:** The JS fallback produces byte-identical results to the previous CB28 calculation — all existing draft calculations remain valid. The fallback just adds a warning flag.

---

## Frontend

### Tax Config page (tax-configs.html + js/tax-configs.js)

Accessible at `/practice/tax-configs.html`

**Features:**
- Config list with status badges, quick Activate/Archive buttons
- Filter by year and status
- "Seed from JS Constants" — one-click seeding with result report
- "New Config" — create blank config
- Config detail modal (5 tabs):
  - **Overview** — name, dates, source note, notes; Activate/Archive/Lock actions
  - **Brackets** — table view, inline add form, per-bracket Edit modal (update/delete)
  - **Rebates & Credits** — primary/secondary/tertiary rebates; thresholds; medical credits
  - **Deduction Limits** — RA %, RA cap, s18A %
  - **History** — event log

**Lock behaviour:**
- Once locked, edit buttons on brackets are hidden, save buttons are blocked on backend
- Lock info message shown in overview tab

**No browser storage:** Zero `localStorage`, `sessionStorage`, or `safeLocalStorage` for tax config data.

### Nav

Added to `layout.js` PAGES array: `{ key: 'tax-configs', label: 'Tax Config', href: '/practice/tax-configs.html' }`

---

## Multi-Tenant Safety

- `GET /` returns `company_id IS NULL OR company_id = req.companyId` — global + company-specific only
- `verifyConfigOwnership()` checks same rule before any mutation
- Calculation engine: `company_id IS NULL OR company_id = req.companyId` — never uses another company's config
- No `company_id` accepted from request body for config creation (always null/global via this API)

---

## Workflow: First Use

1. Navigate to Tax Config page
2. Click "Seed from JS Constants" → creates draft configs for 2023–2026
3. Open a config (e.g. 2026) → verify bracket values against SARS published rates
4. Edit/correct any values in Brackets, Rebates & Credits tabs
5. Save
6. Click Activate → config becomes active
7. Run a draft calculation in Individual Tax → it now uses DB config instead of JS fallback
8. Optionally lock the config after accountant sign-off

---

## Recommended Next Codebox

**Codebox 30 — Individual Tax Review Pack + Draft Tax Report Foundation**

Now that calculations have versioned DB-backed constants:
- Create a printable/exportable review pack per tax return
- Summary: taxpayer details, tax year, income summary, deduction summary
- Draft calculation section with calculation lines, warning flags, assumptions
- Reviewer sign-off section (name, date, notes)
- Status trail (history tab)
- PDF export or print-friendly HTML view
