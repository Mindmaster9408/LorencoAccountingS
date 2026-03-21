# SEAN — Payroll Sync & Transaction Store

> Implemented: March 2026
> Files:
>   - `backend/sean/transaction-store-routes.js` — new routes (SEAN Transaction Store API)
>   - `backend/sean/routes.js` — mounts `/api/sean/store`
>   - `frontend-payroll/payroll-items.html` — submits items + receives sync-back
>   - `frontend-sean/index.html` — Transaction Store UI (Paytime tab)
> Area: SEAN AI — Paytime IRP5 standardization engine (Part A + Part B)

---

## CHANGE IMPACT NOTE

- **Area being changed:** SEAN learning system (additive), Paytime payroll items (additive hooks only)
- **Files/services involved:**
  - `backend/sean/transaction-store-routes.js` — NEW file, zero impact on existing routes
  - `backend/sean/routes.js` — added `router.use('/store', ...)` at end of file
  - `frontend-payroll/payroll-items.html` — two additive hooks: `seanSubmitToStore()` and `seanSyncBackFromLibrary()`. Neither touches existing save/load logic.
  - `frontend-sean/index.html` — new Paytime panel and JS functions; zero change to bank learning, chat, calculator, or codex tabs
- **Current behaviour identified:** Payroll items saved and loaded to localStorage only. No SEAN awareness.
- **Required behaviours to preserve:** All existing Paytime payroll item CRUD, IRP5 validation, pay run calculations, and SEAN bank learning are completely unchanged.
- **Risk of regression:** None. All new code is additive. Hooks are fire-and-forget (network errors suppressed). If the backend is unavailable, Paytime continues working normally.
- **Safe implementation plan:** Pure additive. No existing function signatures changed.

---

## REQUIRED: Run this SQL in Supabase SQL Editor BEFORE deploying

```sql
-- SEAN Transaction Store: generic approval queue
CREATE TABLE IF NOT EXISTS sean_transaction_store (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     VARCHAR(50)  NOT NULL,  -- 'payroll_item', 'product', 'account', etc.
    source_app      VARCHAR(50)  NOT NULL,  -- 'paytime', 'pos', 'accounting'
    company_id      INTEGER      NOT NULL,
    submitted_by    VARCHAR(255),
    submitted_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- The full item object as submitted
    payload         JSONB        NOT NULL,

    -- Key fields for display and conflict detection
    item_key        VARCHAR(255),   -- normalised item name (snake_case, lowercase)
    item_name       VARCHAR(255),   -- display name
    proposed_field  VARCHAR(100),   -- which field is being standardised (e.g. 'irp5_code')
    proposed_value  VARCHAR(255),   -- the proposed standard value
    previous_value  VARCHAR(255),   -- prior value if this is an edit
    change_type     VARCHAR(20)  NOT NULL DEFAULT 'create',  -- 'create' | 'update'

    -- Approval workflow
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
    reviewed_by     VARCHAR(255),
    reviewed_at     TIMESTAMPTZ,
    review_notes    TEXT,

    -- Edited payload (set by /edit endpoint before approval)
    edited_payload  JSONB,

    -- Sync result (set after /approve runs _runGlobalSync)
    synced_at       TIMESTAMPTZ,
    sync_result     JSONB,

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Global library: approved standard values per entity type + item key + field
CREATE TABLE IF NOT EXISTS sean_global_library (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     VARCHAR(50)  NOT NULL,
    item_key        VARCHAR(255) NOT NULL,
    item_name       VARCHAR(255) NOT NULL,
    standard_field  VARCHAR(100) NOT NULL,
    standard_value  VARCHAR(255) NOT NULL,
    payload         JSONB,
    approved_by     VARCHAR(255) NOT NULL,
    approved_at     TIMESTAMPTZ  NOT NULL,
    source_store_id BIGINT REFERENCES sean_transaction_store(id) ON DELETE SET NULL,
    sync_count      INTEGER      NOT NULL DEFAULT 0,
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (entity_type, item_key, standard_field)
);

-- Sync audit log: records every sync-back application (who, what, where)
CREATE TABLE IF NOT EXISTS sean_sync_log (
    id                BIGSERIAL PRIMARY KEY,
    library_id        BIGINT REFERENCES sean_global_library(id) ON DELETE SET NULL,
    store_id          BIGINT REFERENCES sean_transaction_store(id) ON DELETE SET NULL,
    target_company_id INTEGER      NOT NULL,
    action            VARCHAR(30)  NOT NULL,  -- 'applied' | 'skipped_existing' | 'sync_back_applied'
    field_written     VARCHAR(100),
    value_written     VARCHAR(255),
    previous_value    VARCHAR(255),
    authorized_by     VARCHAR(255),
    notes             TEXT,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_sean_ts_status        ON sean_transaction_store (status);
CREATE INDEX IF NOT EXISTS idx_sean_ts_entity        ON sean_transaction_store (entity_type, source_app);
CREATE INDEX IF NOT EXISTS idx_sean_ts_company       ON sean_transaction_store (company_id);
CREATE INDEX IF NOT EXISTS idx_sean_gl_entity_key    ON sean_global_library (entity_type, item_key);
CREATE INDEX IF NOT EXISTS idx_sean_sync_company     ON sean_sync_log (target_company_id);
```

---

## 1. Architecture Overview

### Part A — Paytime → SEAN

When an accountant creates or edits a payroll item in Paytime (`payroll-items.html`):

1. `saveItem()` saves the item to localStorage as before (unchanged)
2. Immediately after save, `seanSubmitToStore()` fires a **fire-and-forget** POST to `/api/sean/store/submit`
3. The backend creates a `sean_transaction_store` row with `status = 'pending'`
4. The call is non-blocking — if offline or server unavailable, a `console.warn` is emitted and Paytime continues normally

**What is submitted:**
```
entityType:    'payroll_item'
sourceApp:     'paytime'
companyId:     <current company ID>
itemName:      itemData.item_name
payload:       { ...full payroll item object... }
proposedField: 'irp5_code'
proposedValue: itemData.irp5_code
previousValue: <old IRP5 code if edit, else null>
changeType:    'create' | 'update'
```

**When is it submitted:** Only when `irp5_code` is set or changed. Pure name/amount edits that don't change the IRP5 code are not re-submitted.

### Part B — SEAN Transaction Store Approval Engine

In SEAN (`frontend-sean/index.html`), when the super admin selects **Paytime** in the Learning Sources panel, the **IRP5 Code Learning** module is now active and shows:

1. **Summary stats** — pending / approved / discarded counts
2. **Item table** — all store items with status chips
3. **Review Queue** — pending items with action buttons:
   - **✅ Approve & Sync** — approve the item, add to global library, sync to all eligible companies
   - **✏️ Edit** — prompt to correct the IRP5 code, then approve globally with the corrected value
   - **✗ Discard** — keep local only, no global propagation
4. **Global Library** — table of all approved standard IRP5 codes

### Part C — Sync-Back (Global → Paytime)

On every Paytime page load, `seanSyncBackFromLibrary()` runs:

1. Sends the current company's items (id, item_name, irp5_code) to `/api/sean/store/sync-back/:companyId`
2. The backend compares each item against the global library
3. For items where local `irp5_code` is blank/null AND a library entry exists → returns an `updates` array
4. Paytime applies the updates to localStorage (fills only blank/null fields)
5. If local value is set and differs from library → **silently skipped** (Rule B9 — never overwrite)

---

## 2. API Reference

All routes under `/api/sean/store`. JWT required (`token` in localStorage for Paytime, `eco_token` for SEAN).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/submit` | any auth | Submit item to queue |
| GET | `/` | super_admin | List all store items (filter: entityType, sourceApp, status) |
| GET | `/pending` | super_admin | List pending items only |
| POST | `/:id/approve` | super_admin | Approve + sync globally |
| POST | `/:id/discard` | super_admin | Discard, keep local only |
| POST | `/:id/edit` | super_admin | Edit payload then approve |
| POST | `/:id/sync` | super_admin | Re-run sync for approved item |
| GET | `/library` | any auth | Global library (filter: entityType) |
| GET | `/library/:entityType` | any auth | Library items for entity type |
| GET | `/sync-log` | super_admin | Sync audit log |
| POST | `/sync-back/:companyId` | any auth | Returns applicable library updates for a company |

---

## 3. Safety Rules (CLAUDE.md Part B, Rules B6/B9)

| Rule | Implementation |
|------|----------------|
| **Never auto-overwrite** | `sync-back` only fills fields where `localFieldValue` is null/undefined/empty |
| **Conflicts flagged, not touched** | If local value differs from library → silently skipped. Logged as `skipped_existing`. |
| **Approve required before sync** | `/approve` must be called before global library entry exists. No auto-propagation. |
| **Super admin only for review** | `/pending`, `/approve`, `/discard`, `/edit` all require `requireSuperAdmin` |
| **Every sync logged** | `sean_sync_log` records every application, skip, and sync-back action |

---

## 4. Generic Engine — Future Entity Types

The engine is not Paytime-specific. To add a new entity type (e.g. POS products, Chart of Accounts):

1. Submit with a different `entityType` (e.g. `'product'`, `'account'`)
2. No backend code changes needed
3. In SEAN index.html, add a new entry in `SEAN_MODULE_REGISTRY` with the relevant apps
4. For server-backed entity types (unlike payroll items which are localStorage), extend `_runGlobalSync()` to write directly to the DB

---

## 5. Follow-Up Notes

```
FOLLOW-UP NOTE
- Area: SEAN Transaction Store — server-backed entity sync
- What was done: Generic engine built. For 'payroll_item' (localStorage), sync-back is on page load.
- Not yet done: For server-backed entities (e.g. accounting accounts), _runGlobalSync() does not yet
  write directly to the DB. It only updates the library counter and returns a 'sync_back_on_load' note.
- Risk if not done: Accounting-based entity types cannot auto-sync to DB until _runGlobalSync() is extended.
- Recommended: When the first server-backed entity type is added, extend _runGlobalSync() with a
  switch on entity_type to run the appropriate DB write (with the same blank-only safety rule).

FOLLOW-UP NOTE
- Area: SEAN index.html — storeReviewCard and storeLibraryCard position
- What was done: Cards added inside the right column of the learning panel grid.
- Not yet done: The storeEntityFilter dropdown currently only has 'payroll_item' and 'all'.
  When new entity types are added, this dropdown should be populated dynamically from the library.
- Risk if not done: Low — currently only payroll_item is in use.

FOLLOW-UP NOTE
- Area: Paytime sync-back — conflict reporting
- What was done: Conflicting (different) values are silently skipped and logged in sean_sync_log.
- Not yet done: No UI in Paytime to show the accountant "SEAN has a global standard of 3606 for
  Commission, but you have 3699 — would you like to update?"
- Risk if not done: The accountant will not know there is a different global standard unless they
  look at SEAN. This is intentional for now (non-intrusive).
- Recommended: If conflict visibility becomes important, add a dismissible banner in payroll-items.html
  showing conflicts after sync-back runs.
```

---

## 6. Testing Checklist

**Submit flow (Paytime → SEAN):**
- [ ] Create a new payroll item with an IRP5 code → item appears in SEAN Transaction Store pending queue
- [ ] Edit the same item, change IRP5 code → a new 'update' item appears (or existing pending updated)
- [ ] Edit item but DON'T change IRP5 code → nothing submitted to store
- [ ] Server offline → Paytime continues normally, console.warn logged

**Approval flow (SEAN super admin):**
- [ ] Select Paytime in Learning Sources → IRP5 Code Learning panel appears
- [ ] Pending items show in review queue with Approve / Edit / Discard buttons
- [ ] Click Approve → item moves to approved, appears in Global Library
- [ ] Click Discard → item moves to discarded, not in library
- [ ] Click Edit → prompt asks for corrected IRP5 code → on confirm, item approved with edited value

**Sync-back (Global Library → Paytime):**
- [ ] Approve an item globally → open Paytime as a DIFFERENT company that has the same item name with blank IRP5 code → on page load, IRP5 code is auto-filled
- [ ] Open Paytime as a company that has a DIFFERENT IRP5 code for the same item → code is NOT overwritten
- [ ] Check Supabase: sean_sync_log has a 'sync_back_applied' row for the filled company
- [ ] Check Supabase: sean_sync_log has NO row for the conflicting company (skipped silently)

**Generic engine:**
- [ ] Submit with entityType='product' → appears in /api/sean/store with correct entity_type
- [ ] GET /api/sean/store?entityType=payroll_item → only payroll items returned
- [ ] GET /api/sean/store/library?entityType=payroll_item → only payroll_item library entries returned
