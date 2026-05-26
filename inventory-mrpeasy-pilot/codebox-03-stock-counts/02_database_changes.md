# Codebox 03 — Database Changes
**Migration:** `052_inventory_stock_counts.sql`  
**Run after:** Migration 050, Migration 051 (Codebox 02)

---

## TABLE: `stock_count_sessions`

Session header. One row per count event.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `company_id` | UUID NOT NULL | Multi-tenant isolation — every query must filter on this |
| `session_number` | VARCHAR(50) NOT NULL | Auto-generated `SC-YYYYMMDD-XXXX`. Unique per company. |
| `warehouse_id` | BIGINT FK→inventory_warehouses | Optional scope filter |
| `count_type` | VARCHAR(20) NOT NULL | `'full'` / `'cycle'` / `'spot'` / `'recount'` |
| `status` | VARCHAR(20) NOT NULL DEFAULT `'in_progress'` | Lifecycle status — see architecture doc |
| `started_by` | UUID NOT NULL | `req.user.userId` at creation |
| `approved_by` | UUID | Set when approved/rejected |
| `started_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `submitted_at` | TIMESTAMPTZ | Set on submit |
| `approved_at` | TIMESTAMPTZ | Set on approve/reject |
| `applied_at` | TIMESTAMPTZ | Set on apply |
| `notes` | TEXT | Optional notes |
| `blind_count` | BOOLEAN DEFAULT FALSE | If true, counters cannot see system quantities until submitted |
| `freeze_inventory` | BOOLEAN DEFAULT FALSE | Field captured; enforcement deferred |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ DEFAULT NOW() | |

**Constraints:**
- `chk_scs_count_type` — enforces valid count_type values
- `chk_scs_status` — enforces valid status values
- `uq_scs_session_number_company` — UNIQUE (company_id, session_number)

---

## TABLE: `stock_count_lines`

One line per item per session. System quantity is snapshotted at creation (immutable reference).

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `company_id` | UUID NOT NULL | |
| `session_id` | BIGINT FK→stock_count_sessions ON DELETE CASCADE | |
| `item_id` | BIGINT FK→inventory_items | |
| `system_quantity` | NUMERIC(15,4) NOT NULL | Snapshot at session creation — never changes |
| `counted_quantity` | NUMERIC(15,4) | NULL until counter records it |
| `variance_quantity` | NUMERIC(15,4) | `counted - system`, calculated on submit |
| `average_cost` | NUMERIC(15,4) | Snapshot at session creation |
| `variance_value` | NUMERIC(15,4) | `variance_quantity × average_cost`, calculated on submit |
| `variance_reason` | VARCHAR(50) | CHECK: `damaged / theft / data_entry_error / receiving_error / production_waste / found_stock / system_error / other` |
| `variance_notes` | TEXT | Optional free-text explanation |
| `recounted` | BOOLEAN DEFAULT FALSE | Flag if line was recounted |
| `recounted_by` | UUID | Who recounted |
| `recounted_at` | TIMESTAMPTZ | When recounted |

---

## TABLE: `stock_count_approvals`

Immutable approval audit trail. INSERT-only — never updated or deleted.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `company_id` | UUID NOT NULL | |
| `session_id` | BIGINT FK→stock_count_sessions ON DELETE CASCADE | |
| `approved_by` | UUID NOT NULL | User who took the action |
| `approval_action` | VARCHAR(30) NOT NULL | CHECK: `'approved' / 'rejected' / 'recount_required'` |
| `approval_notes` | TEXT | Required reason (recommended) |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |

---

## INDEXES

| Index | Table | Columns | Purpose |
|---|---|---|---|
| `idx_scs_company` | stock_count_sessions | company_id | Company isolation |
| `idx_scs_status` | stock_count_sessions | company_id, status | Status filter on list |
| `idx_scs_started_at` | stock_count_sessions | company_id, started_at DESC | Date-range queries |
| `idx_scl_session` | stock_count_lines | session_id | Join from sessions |
| `idx_scl_company` | stock_count_lines | company_id | Company isolation |
| `idx_scl_item` | stock_count_lines | item_id | Item lookups |
| `idx_sca_session` | stock_count_approvals | session_id | Join from sessions |
| `idx_sca_company` | stock_count_approvals | company_id | Company isolation |
| `idx_sca_approver` | stock_count_approvals | approved_by | Auditor queries |

---

## DEPLOYMENT ORDER

```
1. Run migration 050 (if pending)
2. Run migration 051 (Codebox 02 schema)
3. Run migration 052 (THIS FILE — Codebox 03)
4. Push code → Zeabur redeploys
5. Verify zbpack.json does NOT exist in accounting-ecosystem/
```
