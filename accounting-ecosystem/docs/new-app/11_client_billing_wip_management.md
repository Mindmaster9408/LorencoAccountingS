# CODEBOX 11 — CLIENT BILLING PREPARATION + WIP MANAGEMENT

**App:** Lorenco Practice Management
**Codebox:** 11 of ±80
**Date:** June 2026
**Status:** Code complete — migration 062 must be applied in Supabase before using

---

## 1. Summary

Codebox 11 builds the billing preparation layer between approved time entries and future invoice generation. Partners can now review WIP, group approved time into billing packs, write off irrecoverable time, and lock packs to mark entries as billed.

**What was built:**
- Migration 062: `practice_billing_packs`, `practice_billing_pack_lines` tables + 4 new columns on `practice_time_entries`
- `GET /api/practice/billing/wip` — approved unbilled time grouped by client
- `POST /api/practice/billing/packs` — create billing pack from selected approved entries
- `GET /api/practice/billing/packs` — list packs with filters
- `GET /api/practice/billing/packs/:id` — pack detail with lines
- `PUT /api/practice/billing/packs/:id` — update notes/proposed value
- `PUT /api/practice/billing/packs/:id/lines/:lineId/writeoff` — write off a line (with reason)
- `PUT /api/practice/billing/packs/:id/lines/:lineId/exclude` — exclude a line (returns entry to approved)
- `PUT /api/practice/billing/packs/:id/recalculate` — recalculate pack totals from lines
- `PUT /api/practice/billing/packs/:id/approve` — partner signs off pack
- `PUT /api/practice/billing/packs/:id/lock` — finalises pack; marks included entries as 'billed'
- `DELETE /api/practice/billing/packs/:id` — cancel pack (soft, entries returned to approved)
- `billing.html` + `js/billing.js` — billing page with WIP dashboard, WIP list, create-pack form, packs list, pack detail modal, write-off modal
- Billing pack + line status badges in `practice.css`
- `billing` nav item added to `layout.js`

**What was NOT built (excluded by CLAUDE.md permanent rules):**
- Invoice generation (Codebox 12+)
- Accounting app integration
- Sean AI
- Cross-app integrations
- Cron/scheduler automation

---

## 2. Database Changes (migration 062)

### `practice_billing_packs` — NEW TABLE

| Column | Type | Default | Purpose |
|---|---|---|---|
| `id` | INTEGER PK | IDENTITY | Pack identifier |
| `company_id` | INTEGER | — | Multi-tenant key |
| `client_id` | INTEGER | — | Which client |
| `pack_number` | TEXT | NULL | Optional billing ref |
| `pack_name` | TEXT | — | Human name for pack |
| `period_start` | DATE | NULL | Billing period start |
| `period_end` | DATE | NULL | Billing period end |
| `status` | TEXT | 'draft' | draft → reviewed → approved → locked |
| `total_hours` | NUMERIC(12,2) | 0 | All lines |
| `billable_hours` | NUMERIC(12,2) | 0 | Included lines only |
| `non_billable_hours` | NUMERIC(12,2) | 0 | Written-off lines |
| `recoverable_value` | NUMERIC(12,2) | 0 | Included + written-off recoverable |
| `writeoff_value` | NUMERIC(12,2) | 0 | Written-off amount |
| `billable_value` | NUMERIC(12,2) | 0 | What will be invoiced (included lines) |
| `proposed_invoice_value` | NUMERIC(12,2) | NULL | Partner override invoice amount |
| `notes` | TEXT | NULL | Billing notes |
| `internal_notes` | TEXT | NULL | Internal staff notes |
| `settings` | JSONB | '{}' | Future extensions |
| `created_at` | TIMESTAMPTZ | now() | — |
| `updated_at` | TIMESTAMPTZ | now() | — |
| `created_by` | INTEGER | NULL | User ID |
| `updated_by` | INTEGER | NULL | User ID |

### `practice_billing_pack_lines` — NEW TABLE

| Column | Type | Default | Purpose |
|---|---|---|---|
| `id` | INTEGER PK | IDENTITY | Line identifier |
| `company_id` | INTEGER | — | Multi-tenant key |
| `billing_pack_id` | INTEGER FK | — | References practice_billing_packs(id) ON DELETE CASCADE |
| `time_entry_id` | INTEGER | — | Source time entry |
| `client_id` | INTEGER | — | Denormalised for query performance |
| `task_id` | INTEGER | NULL | Source task |
| `workflow_run_id` | BIGINT | NULL | Source workflow run |
| `hours` | NUMERIC(12,2) | 0 | Snapshot of hours at pack creation |
| `recoverable_value` | NUMERIC(12,2) | 0 | Snapshot of recoverable at pack creation |
| `writeoff_value` | NUMERIC(12,2) | 0 | Set when line is written off |
| `billable_value` | NUMERIC(12,2) | 0 | Initially = recoverable; 0 when written off |
| `line_status` | TEXT | 'included' | included / written_off / excluded |
| `notes` | TEXT | NULL | Write-off reason stored here |
| `created_at` | TIMESTAMPTZ | now() | — |

### `practice_time_entries` — 4 new columns

| Column | Type | Purpose |
|---|---|---|
| `billing_pack_id` | INTEGER FK NULL | Which pack contains this entry (null = not packed) |
| `billing_reviewed_at` | TIMESTAMPTZ NULL | When the billing pack was locked |
| `billing_reviewed_by` | INTEGER NULL | Who locked the billing pack |
| `writeoff_reason` | TEXT NULL | Why the entry was written off |

---

## 3. Billing Pack Lifecycle

```
draft
  │
  ├── PUT /approve  → approved
  │                      │
  │                      └── PUT /lock → locked  (time entries → 'billed')
  │
  ├── PUT /approve ← reviewed ← [partner marks as reviewed in future UI]
  │
  └── DELETE → cancelled  (time entries returned to 'approved')
```

**Status transitions enforced by backend:**
- `writeoff` and `exclude` actions: only allowed on `draft` or `reviewed` packs
- `approve`: from `draft` or `reviewed`
- `lock`: only from `approved`
- `cancel`: any status except `locked` (locked packs cannot be undone)

---

## 4. WIP Logic

`GET /api/practice/billing/wip` returns:
- Only `billing_status = 'approved'` entries (partner has already signed off on these)
- Only `billing_pack_id IS NULL` (not already in a pack)
- Only `time_type = 'billable'` (internal/admin/non-billable time has no WIP value)
- Grouped by client: `by_client[]` with `client_id`, `client_name`, `total_hours`, `total_recoverable`, `entry_count`
- `grand_total_hours`, `grand_total_recoverable`, `total_entries`

This is the source data for billing pack creation. The time.html page has its own WIP dashboard showing all time by status.

---

## 5. Billing Pack Creation Rules

POST /api/practice/billing/packs enforces:
1. All `time_entry_ids` must belong to `req.companyId` (multi-tenant)
2. All entries must belong to the same `client_id` (one pack = one client)
3. All entries must have `billing_status = 'approved'`
4. No entry may already have a `billing_pack_id` set (prevents double-packing)
5. Totals are calculated server-side from the entries (never trusted from frontend)
6. Each entry gets `billing_pack_id` set to the new pack
7. Each entry's `billable_value` in the line = `recoverable_value` (full rate, before any write-offs)

---

## 6. Write-Off Logic

`PUT /packs/:id/lines/:lineId/writeoff`:
- Pack must be `draft` or `reviewed`
- Line must be `included`
- Requires `reason` in body
- Sets `line_status = 'written_off'`
- Sets `line.writeoff_value = line.recoverable_value`
- Sets `line.billable_value = 0`
- Sets `time_entry.billing_status = 'written_off'`
- Sets `time_entry.writeoff_value = line.recoverable_value`
- Sets `time_entry.writeoff_reason = reason`
- Triggers `recalculatePack()` to update pack totals
- Audit logged: `billing_line_written_off`

---

## 7. Exclude Logic

`PUT /packs/:id/lines/:lineId/exclude`:
- Pack must be `draft` or `reviewed`
- Line must be `included` (cannot exclude a written-off line)
- Sets `line_status = 'excluded'`
- Sets `line.billable_value = 0`
- Clears `time_entry.billing_pack_id = NULL` (entry is free again)
- Time entry `billing_status` STAYS `approved` (not changed — it goes back to WIP)
- Triggers `recalculatePack()`
- Audit logged: `billing_line_excluded`

---

## 8. Lock (Finalise) Logic

`PUT /packs/:id/lock`:
- Pack must be `approved`
- Pack must have at least one `included` line
- For each included line's `time_entry_id`:
  - `billing_status → 'billed'`
  - `billing_reviewed_at → now()`
  - `billing_reviewed_by → req.user.userId`
  - `billed_value → line.billable_value`
- Pack `status → 'locked'`
- Audit logged: `billing_pack_locked`
- **This action is irreversible** (locked packs cannot be cancelled)

---

## 9. Cancel Logic

`DELETE /packs/:id`:
- Pack must NOT be `locked` or already `cancelled`
- For `included` lines: `time_entry.billing_pack_id → NULL`
  (time entries stay `approved`, just free from the pack)
- For `written_off` lines: `time_entry.billing_pack_id → NULL`
  (time entry stays `written_off` — write-off decision survives cancellation)
- Pack `status → 'cancelled'`
- Pack + lines remain in DB for audit trail (no hard delete)
- Audit logged: `billing_pack_cancelled`

---

## 10. recalculatePack() Helper

Internal server-side function called after any line mutation:
```
For each line in pack:
  - included:    billable_hours += hours; recoverable_value += rv; billable_value += bv
  - written_off: non_billable_hours += hours; writeoff_value += wv; recoverable_value += rv
  - excluded:    total_hours counted only (not billable or non_billable)

Pack totals updated: total_hours, billable_hours, non_billable_hours,
                     recoverable_value, writeoff_value, billable_value
```

Also available as `PUT /packs/:id/recalculate` for manual triggering (e.g. after data correction).

---

## 11. Backend API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/practice/billing/wip` | Approved unbilled time grouped by client |
| POST | `/api/practice/billing/packs` | Create billing pack |
| GET | `/api/practice/billing/packs` | List packs (filters: client_id, status) |
| GET | `/api/practice/billing/packs/:id` | Pack + all lines |
| PUT | `/api/practice/billing/packs/:id` | Update notes / proposed_invoice_value |
| PUT | `/api/practice/billing/packs/:id/lines/:lineId/writeoff` | Write off line (requires reason) |
| PUT | `/api/practice/billing/packs/:id/lines/:lineId/exclude` | Exclude line from billing |
| PUT | `/api/practice/billing/packs/:id/recalculate` | Recalculate pack totals |
| PUT | `/api/practice/billing/packs/:id/approve` | Partner approves pack |
| PUT | `/api/practice/billing/packs/:id/lock` | Lock pack — marks entries as billed |
| DELETE | `/api/practice/billing/packs/:id` | Cancel pack (soft) |

### Multi-tenant safety
- All routes: `req.companyId` from JWT (never from body)
- `verifyClient()` checks client ownership before pack creation
- All pack/line fetches filter by `company_id`
- `time_entry_ids` verified against `req.companyId` before packing
- `approved_by` and `created_by` from `req.user.userId` only

---

## 12. localStorage Audit Result

**Clean.** Audit confirmed:
- `localStorage.getItem('token')` — auth read only (permitted Rule D2)
- `PracticeAPI.fetch()` — all billing data through API
- No billing pack data, WIP data, write-off decisions, or recovery values in browser storage

---

## 13. Frontend — billing.html + js/billing.js

### Sections
1. **WIP Dashboard** — 4 stat cards: WIP Recoverable, Open Packs Value, Billed This Month, Written Off
2. **Two-panel layout:**
   - Left: Approved time entries grouped by client, expandable, checkbox selection
   - Right: Create Billing Pack form (client, name, period, notes)
3. **Billing Packs list** — table with filters, Open button
4. **Pack Detail modal** — summary stats, lines table, write-off/exclude actions, approve/lock/cancel
5. **Write-off modal** — mandatory reason field

### Entry selection rules (enforced in JS)
- Single-client constraint: all selected entries must belong to the same client
- Auto-populates client selector when first entry is checked
- Prevents mixing clients (toast error + checkbox reverted)

### Key functions
- `loadWip()` — calls `GET /billing/wip`, renders expandable client sections
- `createPack()` — validates + calls `POST /billing/packs`, auto-opens new pack
- `openPackDetail(id)` — calls `GET /billing/packs/:id`, renders lines
- `submitWriteoff()` — calls `PUT /packs/:id/lines/:lineId/writeoff`
- `excludeLine(id)` — calls `PUT /packs/:id/lines/:lineId/exclude`
- `approvePack()` — calls `PUT /packs/:id/approve`
- `lockPack()` — calls `PUT /packs/:id/lock` with confirmation
- `cancelPack()` — calls `DELETE /packs/:id` with confirmation

---

## 14. Migration Command

Apply migration 062 in Supabase SQL editor:
```
File: accounting-ecosystem/backend/config/migrations/062_practice_billing_wip_management.sql
```

Verify with the built-in verification query at the bottom of the migration file.

---

## 15. Future Invoice Readiness

The billing pack in its `locked` state contains everything needed to generate an invoice:
- `client_id` → client details
- `billable_value` → invoice total (before tax)
- `proposed_invoice_value` → partner override
- `period_start` / `period_end` → invoice period
- `pack_name` → invoice description
- Lines → invoice line items
- `settings` JSONB → future: fee caps, discount %, client billing ref, tax rate

Codebox 12 can read locked packs and produce billing reports or invoice drafts without changing any of the data structures in Codebox 11.

---

## 16. Recommended Codebox 12

**Billing Pack PDF / Client Billing Report Foundation**

After WIP packs exist:
- Generate a readable billing review report per pack (for partner internal review)
- Client-facing billing statement (what we're about to invoice)
- Recovery analysis per client (billed vs recoverable vs written-off over time)
- Fee estimates vs actual time comparison per workflow run
