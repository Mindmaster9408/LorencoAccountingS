# SEAN × Paytime Payroll Items Integration

**Implemented:** 2026-03-21
**Migration required:** `database/015_sean_transaction_store.sql`

---

## CHANGE IMPACT NOTE

- **Area being changed:** SEAN Transactions → Paytime + Transaction Store DB tables + IRP5 sync engine
- **Files/services involved:**
  - `database/015_sean_transaction_store.sql` (new — creates missing DB tables)
  - `backend/sean/irp5-routes.js` (new routes: `GET /items`, `PUT /items/:id`)
  - `backend/sean/transaction-store-routes.js` (`_runGlobalSync` upgraded to direct DB)
  - `frontend-sean/index.html` (Payroll Items card + `loadPayrollItems()` + module registry)
  - `backend/tests/sean-paytime-integration.test.js` (40 new tests)
- **Current behaviour identified:**
  - SEAN Transactions → Paytime showed IRP5 Transaction Store but errored with "could not find table sean_transaction_store" because the DB migration was never run
  - Payroll items could only be managed from `frontend-payroll/payroll-items.html`
  - `_runGlobalSync` said payroll items were "localStorage-based" (incorrect — they are server-backed via `payroll_items_master`)
- **Required behaviours preserved:**
  - Existing Paytime `payroll-items.html` works unchanged
  - IRP5 learning event emission from `items.js` works unchanged
  - IRP5 patterns/proposals/propagation engine unchanged
  - Multi-tenant isolation: items API is superadmin-only for cross-client view; company-scoped for regular users
- **Multi-tenant risk:** LOW — new routes require `requireSuperAdmin`; company scope enforced
- **Payroll integrity risk:** ZERO — sync only fills NULL codes; never overwrites existing

---

## Audit Findings

### What Existed Before This Integration

| Component | Status |
|---|---|
| `payroll_items_master` table | ✅ Server-backed via Supabase |
| `GET /api/payroll/items` | ✅ Company-scoped, active items |
| `POST /api/payroll/items` | ✅ Full validation, IRP5 event emission |
| `PUT /api/payroll/items/:id` | ✅ Company-scoped, IRP5 event emission |
| IRP5 learning → patterns → proposals → propagation | ✅ Complete engine |
| `GET /api/sean/paytime/patterns` etc. | ✅ IRP5 governance routes |
| `sean_transaction_store` DB table | ❌ Code existed, migration never run |
| `sean_global_library` DB table | ❌ Code existed, migration never run |
| `sean_sync_log` DB table | ❌ Code existed, migration never run |
| Cross-client payroll items view in SEAN | ❌ Not built |
| `_runGlobalSync` direct DB sync for payroll items | ❌ Said "localStorage-based" (wrong) |

---

## Architecture

```
PAYTIME (frontend-payroll/payroll-items.html)
    │
    ├── GET  /api/payroll/items             [company-scoped list]
    ├── POST /api/payroll/items             [create + IRP5 event]
    └── PUT  /api/payroll/items/:id         [update + IRP5 event]
         │
         └── _emitIRP5Event() → IRP5Learning.recordLearningEvent()
              │
              └── analyzePatterns() → patterns → proposals → approve → propagate


SEAN (frontend-sean/index.html) → Transactions → Paytime
    │
    ├── IRP5 Code Learning panel (Transaction Store governance)
    │   ├── GET /api/sean/store?entityType=payroll_item&sourceApp=paytime
    │   ├── POST /api/sean/store/:id/approve  →  _runGlobalSync()
    │   │        └── Direct DB: UPDATE payroll_items_master SET irp5_code WHERE irp5_code IS NULL
    │   └── GET /api/sean/store/library?entityType=payroll_item
    │
    └── Payroll Items — All Clients panel (NEW)
        ├── GET /api/sean/paytime/items           [cross-client listing]
        │   ├── Superadmin: all companies (optional ?companyId= filter)
        │   └── Regular user: own company only
        │
        ├── PUT /api/sean/paytime/items/:id        [IRP5 code update, superadmin]
        │   ├── Same validation as items.js (4–6 digit SARS code)
        │   └── Emits IRP5 learning event (non-blocking)
        │
        └── makePayrollItemGlobal() flow:
            ├── POST /api/sean/store/submit        [submit to governance queue]
            └── POST /api/sean/store/:id/approve   [immediately approve → _runGlobalSync]
```

---

## SEAN Payroll Items Panel — UI Guide

The Payroll Items panel appears in **SEAN → Transactions → Paytime**, below the IRP5 Transaction Store.

### Filters
- **Company dropdown** — filter to one company or see all
- **Type dropdown** — Earnings / Deductions / Company Contributions
- **Missing IRP5 only** — toggle to show only items without a code

### Summary Stats
Shows: Total Items · IRP5 Coded · Missing IRP5

### Per-Item Actions

| Action | Behaviour |
|---|---|
| **Set IRP5** | Prompts for 4–6 digit code; updates this specific item immediately via `PUT /api/sean/paytime/items/:id`; emits IRP5 learning event |
| **Change** | Same as Set IRP5 — appears when item already has a code |
| **🌐 Global** | Sets the code as a global standard; submits to Transaction Store + immediately approves; `_runGlobalSync` applies code to all matching items with blank codes across all companies |

---

## Database Migration (`015_sean_transaction_store.sql`)

Creates three tables (idempotent — `IF NOT EXISTS`):

### `sean_transaction_store`
Generic approval queue for any entity type submitted from any app.

| Column | Type | Notes |
|---|---|---|
| `entity_type` | VARCHAR(50) | `'payroll_item'`, `'product'`, etc. |
| `source_app` | VARCHAR(50) | `'paytime'`, `'accounting'`, etc. |
| `company_id` | INTEGER | FK → companies.id |
| `item_name` | VARCHAR(255) | Human-readable display name |
| `item_key` | VARCHAR(255) | Normalised key (lowercase, stripped) |
| `payload` | JSONB | Full item snapshot |
| `proposed_field` | VARCHAR(100) | Field being standardised (e.g. `irp5_code`) |
| `proposed_value` | TEXT | Proposed standard value |
| `status` | VARCHAR(20) | `pending` → `approved` \| `discarded` |

### `sean_global_library`
Approved global standards. One row per `(entity_type, item_key, standard_field)`.

| Column | Type | Notes |
|---|---|---|
| `entity_type` | VARCHAR(50) | Matches transaction store |
| `item_key` | VARCHAR(255) | Normalised item name |
| `standard_field` | VARCHAR(100) | e.g. `irp5_code` |
| `standard_value` | TEXT | The approved value |
| `sync_count` | INTEGER | How many times synced out |
| UNIQUE | `(entity_type, item_key, standard_field)` | One standard per item + field |

### `sean_sync_log`
Immutable audit trail of every sync action.

| Column | Type | Notes |
|---|---|---|
| `action` | VARCHAR(50) | `applied` \| `skipped_existing` \| `skipped_exception` \| `error` |
| `target_company_id` | INTEGER | Which company was affected |
| `field_written` | VARCHAR(100) | Which field |
| `value_written` | TEXT | What was written |
| `previous_value` | TEXT | What was there before (null = was blank) |

---

## Synchronisation Rules (CLAUDE.md Part B)

| Rule | Enforcement |
|---|---|
| Only fill blank/null codes (Rule B6) | `_runGlobalSync` checks `isBlank` before any UPDATE |
| Never overwrite existing different codes (Rule B9) | Different existing code → `action='skipped_exception'`, never updated |
| Exception clients flagged, not touched | Logged in `sean_sync_log` with `action='skipped_exception'` + note |
| Every sync action logged | `sean_sync_log` records applied/skipped/exception/error |
| Superadmin authorisation required | `PUT /items/:id` and store approve both require `requireSuperAdmin` |
| IRP5 learning event emitted on code change | `PUT /items/:id` calls `IRP5Learning.recordLearningEvent()` (non-blocking) |

---

## Conflict Handling

When `_runGlobalSync` runs for a payroll_item irp5_code:

1. **Null code** → `applied` — code is written to `payroll_items_master`, logged
2. **Same code already** → `skipped_existing` — no change, logged
3. **Different code exists** → `skipped_exception` — **never touched**, logged with note "Exception: has different code. Manual review required."

To see exceptions after a sync: `GET /api/sean/store/sync-log?action=skipped_exception`

---

## API Reference

### New Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/sean/paytime/items` | Any auth | List payroll items (superadmin = all; user = own company) |
| PUT | `/api/sean/paytime/items/:id` | Superadmin | Update IRP5 code on a specific payroll item |

### Query Params — GET /items

| Param | Default | Notes |
|---|---|---|
| `companyId` | none | Filter to specific company (superadmin only) |
| `type` | none | `earning` \| `deduction` \| `company_contribution` |
| `missingIrp5` | `false` | `true` = only items where `irp5_code IS NULL` |
| `includeInactive` | `false` | `true` = include inactive items (superadmin only) |

### PUT /items/:id body

```json
{
  "irp5_code": "3601",
  "reason": "Set from SEAN governance view"
}
```

Pass `null` to clear a code. IRP5 code must be 4–6 digit SARS numeric format.

---

## Testing

```bash
cd accounting-ecosystem/backend
npx jest tests/sean-paytime-integration.test.js
# 40 tests — A through F coverage
```

Test coverage:
- **A** — GET/PUT items endpoint structure (route existence, auth requirements)
- **B** — `_runGlobalSync` direct DB sync logic (null check, exception path, sync_log)
- **C** — IRP5 code validation (4–6 digit regex)
- **D** — `normalizeKey` idempotency and cross-company matching
- **E** — Multi-tenant isolation (company scope, superadmin gates)
- **F** — Regression — all existing IRP5 routes preserved

---

## Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: Database migration
- Required action: Run 015_sean_transaction_store.sql in Supabase SQL Editor
- Risk if skipped: ALL SEAN Transaction Store views will continue to error with
  "could not find table sean_transaction_store"

FOLLOW-UP NOTE
- Area: Payroll Items governance — future tax tables module
- What is done: Page architecture is structured (module registry pattern) to allow
  a future "Tax Tables" module to be added alongside Payroll Items under Paytime.
  Add it to SEAN_MODULE_REGISTRY with apps: ['paytime'] and wire into loadLearningPatterns().
- Not yet built: Tax tables governance view in SEAN.

FOLLOW-UP NOTE
- Area: Sync-back on Paytime page load
- What is done: /store/sync-back/:companyId route exists and Paytime could call it
  on page load to pick up global library standards for items with blank codes.
- Not yet wired: payroll-items.html does not currently call this endpoint on load.
  When wired: open payroll-items.html → POST /api/sean/store/sync-back/:companyId
  → apply updates to blank irp5_code fields locally.

FOLLOW-UP NOTE
- Area: Exception resolution workflow
- Gap: When skipped_exception items exist (different code), there is no UI workflow
  to review and selectively override them. Currently requires direct DB edit.
- Future: Add an "Exceptions" panel under Payroll Items showing skipped_exception
  entries from sean_sync_log, with per-item "Override" action (requires confirmation).
```
