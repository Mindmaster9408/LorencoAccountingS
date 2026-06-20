# CODEBOX 13 — BILLING PACK NUMBERING + BILLING CONTROLS

**App:** Lorenco Practice Management
**Codebox:** 13 of ±80
**Date:** June 2026
**Status:** Code complete — apply migration 064 in Supabase before using

---

## 1. Summary

Codebox 13 adds governance, controls, and audit history to billing packs before any future invoice generation. It builds directly on the pack lifecycle (Codebox 11) and report foundation (Codebox 12).

**What was built:**
- Migration 064: 7 new columns on `practice_billing_packs` + `practice_billing_pack_events` table (9 indexes total)
- Auto-numbering: `BP-YYYY-NNNNNN` sequential per company, server-side only
- Period validation: reject period_end < period_start
- Duplicate pack protection: reject active pack for same client + same period
- Approve guard: require at least one included line + auto-recalculate before approve
- `approved_at` / `approved_by` written on approve
- `locked_at` / `locked_by` written on lock
- `cancelled_at` / `cancelled_by` written on cancel
- `logPackEvent()` helper — non-fatal event logging on every lifecycle event
- `GET /api/practice/billing/packs/:id/history` — full event log endpoint
- Status banner in pack detail modal (colour-coded per status, includes timestamps)
- History button + History modal in pack detail
- Pack number column in billing packs list table
- Pack number + status in pack detail modal subtitle
- Status banner + history CSS in practice.css (shared) and billing.html (page-scoped)
- `EVENT_TYPE_LABELS` dictionary for human-readable history event display

**What was NOT built:**
- Invoice generation
- Accounting app integration
- Sean AI
- Cross-app integrations

---

## 2. Database Changes (migration 064)

### `practice_billing_packs` — 7 new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `approved_at` | TIMESTAMPTZ | NULL | When the pack was approved |
| `approved_by` | INTEGER | NULL | User ID who approved |
| `locked_at` | TIMESTAMPTZ | NULL | When the pack was locked |
| `locked_by` | INTEGER | NULL | User ID who locked |
| `cancelled_at` | TIMESTAMPTZ | NULL | When the pack was cancelled |
| `cancelled_by` | INTEGER | NULL | User ID who cancelled |
| `billing_period_key` | TEXT | NULL | `clientId_periodStart_periodEnd` — duplicate detection key |

All nullable — only populated on the relevant lifecycle event.

### New indexes on `practice_billing_packs`

| Index | Columns | Condition |
|---|---|---|
| `idx_billing_packs_pack_number` | `(company_id, pack_number)` | WHERE pack_number IS NOT NULL |
| `idx_billing_packs_period_key` | `(company_id, billing_period_key)` | WHERE billing_period_key IS NOT NULL |

### `practice_billing_pack_events` — new table

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER IDENTITY | Primary key |
| `company_id` | INTEGER NOT NULL | Multi-tenant isolation |
| `billing_pack_id` | INTEGER NOT NULL | Which pack this event belongs to |
| `event_type` | TEXT NOT NULL | Event identifier (see allowed values below) |
| `old_status` | TEXT | Previous status (for transitions) |
| `new_status` | TEXT | New status (for transitions) |
| `actor_user_id` | INTEGER | Who triggered the event |
| `notes` | TEXT | Human-readable note or reason |
| `metadata` | JSONB NOT NULL DEFAULT '{}' | Structured extra data (pack_number, line_id, counts) |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | When the event occurred |

**Allowed event_type values:**

| Event | When logged |
|---|---|
| `pack_created` | POST /packs — new pack inserted |
| `pack_number_assigned` | POST /packs — auto-number assigned (notes = the number) |
| `pack_updated` | PUT /packs/:id — fields edited |
| `pack_recalculated` | PUT /packs/:id/recalculate |
| `pack_approved` | PUT /packs/:id/approve |
| `pack_locked` | PUT /packs/:id/lock |
| `pack_cancelled` | DELETE /packs/:id (soft cancel) |
| `pack_line_written_off` | PUT /packs/:id/lines/:lineId/writeoff |
| `pack_line_excluded` | PUT /packs/:id/lines/:lineId/exclude |

**Indexes on `practice_billing_pack_events`:**
`idx_bpe_company_id`, `idx_bpe_billing_pack_id`, `idx_bpe_event_type`, `idx_bpe_created_at`

---

## 3. Numbering Architecture

### Format
`BP-YYYY-NNNNNN` — e.g. `BP-2026-000001`, `BP-2026-000042`

### Rules
- Assigned **server-side only** on pack creation — frontend cannot supply or override `pack_number`
- Sequential **per company** (not per year-company — year is embedded in the number for readability)
- Never reused — even cancelled packs retain their assigned number
- Year resets naturally — `BP-2027-000001` will be the first pack of 2027
- Existing packs with `pack_number = null` (created before this codebox) are unaffected

### Implementation (`generatePackNumber`)
1. Query `practice_billing_packs` for company, filtering `pack_number LIKE 'BP-YYYY-%'`
2. Order by `pack_number DESC`, limit 1 — gets the highest assigned number
3. Extract the 6-digit sequence suffix, add 1
4. Format with `String(seq).padStart(6, '0')`

**Concurrency safety:** App-level sequencing without a DB sequence. Safe for practice management concurrency (single-digit concurrent pack creation is the realistic ceiling). If true concurrency safety is needed in future, migrate to a PostgreSQL `SEQUENCE` per company.

---

## 4. Duplicate Prevention

### `billing_period_key` field
Generated as `clientId_periodStart_periodEnd` when both period dates are supplied.

Example: client 42, period 2026-05-01 to 2026-05-31 → key = `42_2026-05-01_2026-05-31`

### Detection logic (POST /packs)
Before inserting:
1. Build `periodKey` from `client_id`, `period_start`, `period_end`
2. If key is null (period dates missing) — skip check, allow creation
3. Query: `company_id = ? AND billing_period_key = ? AND status != 'cancelled'`
4. If matching pack found → 409 Conflict with pack number/name in error message
5. If no match → proceed with creation

**Cancelled packs are excluded from the duplicate check.** A cancelled pack's period can be re-used.

---

## 5. Lock Logic

### Status transitions (enforced at API layer)

```
draft → reviewed → approved → locked
         ↓               ↓
      cancelled       cancelled  (cancel is always allowed except for locked packs)
```

### Editing rules
| Status | Line mutations | Field edits | Reports |
|---|---|---|---|
| draft | ✅ write-off, exclude allowed | ✅ notes, proposed_value | ✅ |
| reviewed | ✅ write-off, exclude allowed | ✅ notes, proposed_value | ✅ |
| approved | ❌ blocked (EDITABLE_STATUSES) | ✅ notes, proposed_value | ✅ |
| locked | ❌ blocked | ❌ blocked | ✅ |
| cancelled | ❌ blocked | ❌ blocked | ✅ |

Line mutations (write-off, exclude) require `status IN ('draft', 'reviewed')` — the `EDITABLE_STATUSES` constant. This is stricter than the spec's "after lock" wording but is the safer business rule: once approved, the partner has signed off on the time included, so no further mutations are appropriate.

### Lock prerequisites
- Pack must be in `approved` status
- Must have at least one included line (enforced at lock route — existing from Codebox 11)
- On lock: marks all included time entries as `billing_status = 'billed'`, sets `billed_value` on each

---

## 6. Approval Logic

### Prerequisites (added in Codebox 13)
- Pack must be in `draft` or `reviewed` status
- Pack must have at least one line with `line_status = 'included'` — prevents approving empty packs
- Auto-recalculate totals before approving — ensures `billable_value`, `recoverable_value`, etc. are current

### Timestamps recorded
`approved_at = now()`, `approved_by = req.user.userId`

---

## 7. History Architecture

### `practice_billing_pack_events` table
Events are written via `logPackEvent(companyId, packId, eventType, opts)`. This is a non-fatal fire-and-forget call — a failure to log does not abort the billing operation.

### `GET /api/practice/billing/packs/:id/history`
- Returns all events for a pack, ordered by `created_at DESC` (most recent first)
- Multi-tenant: verifies `fetchPack(companyId, packId)` before querying events
- Response: `{ events: [...], pack_id: number, pack_number: string }`

### Frontend history modal
- "History" button added to pack detail actions row
- Opens `historyModal` and fetches events via `PracticeAPI.fetch()`
- `renderPackHistory()` renders each event as a `.history-event` block showing:
  - Human-readable event label (from `EVENT_TYPE_LABELS`)
  - Status transition arrow (old_status → new_status) if applicable
  - Notes (e.g. write-off reason, pack number)
  - Timestamp (locale string) + actor user ID

---

## 8. Multi-Tenant Safety Review

| Operation | Verification |
|---|---|
| `generatePackNumber` | Filters `company_id = req.companyId` in sequence query |
| Period duplicate check | Filters `company_id = req.companyId` |
| `logPackEvent` | Inserts with `company_id = companyId` (from `req.companyId`) |
| `GET /history` | `fetchPack(companyId, packId)` returns null if wrong company → 404 |
| All existing routes | Already verified in Codebox 11/12 — unchanged |

No route trusts `company_id` from the request body. All company context comes from `req.companyId` (JWT-derived).

---

## 9. localStorage / KV Audit

**CLEAN — no violations.**

| Location | Usage | Permitted? |
|---|---|---|
| `billing.js` `viewReport()` | `localStorage.getItem('token')` — auth read | Yes (Rule D2) |
| `billing.js` `downloadPdf()` | `localStorage.getItem('token')` — auth read | Yes (Rule D2) |
| `openHistoryModal()` | Uses `PracticeAPI.fetch()` — no localStorage | N/A — compliant |
| Status banner | Renders from pack API response — no localStorage | Compliant |
| Pack number | From API response — no localStorage | Compliant |

No numbering state, billing controls state, billing history, or pack audit history written to browser storage at any point.

---

## 10. Manual Tests

1. **Numbering:** Create first pack → verify `pack_number = BP-YYYY-000001` in DB and pack detail subtitle
2. **Numbering sequence:** Create second pack for same company → verify `BP-YYYY-000002`
3. **Cross-company numbering:** Log in as different company → their sequence is independent
4. **Period validation:** Create pack with `period_end` < `period_start` → expect 400 error
5. **Duplicate detection:** Create pack for client A, period 2026-05-01–2026-05-31 → attempt second pack for same client + period → expect 409 with pack reference
6. **Duplicate cancelled:** Cancel the first pack → attempt same period again → expect success (cancelled packs excluded from check)
7. **Approve guard — empty pack:** Write off or exclude ALL lines → attempt approve → expect 400 "no included lines"
8. **Approve:** Approve a pack with included lines → verify `approved_at` and `approved_by` set in DB
9. **Lock:** Lock an approved pack → verify `locked_at` and `locked_by` set in DB
10. **Cancel:** Cancel a pack → verify `cancelled_at` and `cancelled_by` set in DB
11. **Status banner:** Open each lifecycle status pack → verify correct colour banner and timestamp
12. **Pack number in list:** Billing packs table shows "Ref" column with `BP-YYYY-NNNNNN`
13. **History button:** Click History → modal opens → events listed (pack_created, pack_number_assigned at minimum)
14. **History after approve:** Approve → open History → `pack_approved` event visible with status transition
15. **History write-off:** Write off a line → History shows `pack_line_written_off` with reason
16. **DevTools Local Storage:** No numbering, history, or billing controls data in localStorage
17. **Cross-company history:** `/api/practice/billing/packs/:otherId/history` → 404

---

## 11. Remaining Risks

- `generatePackNumber` uses app-level sequencing (no DB sequence). Race condition possible if two packs are created for the same company within milliseconds. Mitigation: practice management creates one pack at a time; acceptable risk. Future: DB sequence if needed.
- `billing_period_key` uniqueness is enforced at app layer only, not by a DB unique constraint. Race condition possible (same caveat). DB partial unique index could be added in a future migration if needed.
- `actor_user_id` in history events stores the user ID as an integer. The history modal displays "User {id}" rather than a name. Future: join to users table for display name.
- `logPackEvent` is fire-and-forget — if Supabase insert fails, the event is silently dropped. This is intentional (billing operations must not fail due to event logging), but means history could have gaps if the database is under stress.
- `report_version` (from migration 063) still not auto-incremented on pack updates — tracked as future follow-up.

---

## 12. Recommended Codebox 14

**Client Engagements + Service Agreements Foundation**

Now that the practice has:
- Clients (CB 01-06)
- Workflows + deadlines (CB 07-09)
- Time tracking (CB 10)
- WIP + billing packs (CB 11)
- Billing reports (CB 12)
- Pack governance + history (CB 13)

The next logical layer is **formal service relationships**:

- `practice_engagements` table: client + service type + fee + recurrence + start/end
- Service types: bookkeeping, payroll, VAT, annual financials, tax returns, secretarial, consulting
- Engagement ownership (assigned partner, assigned preparer)
- Recurring fee amount + frequency (monthly, quarterly, annual)
- Link engagements to workflow templates (engagement type → auto-workflow)
- Link time entries to engagement (what service was the time for?)
- Engagement billing: default billing pack parameters derived from engagement
- Engagement status: active, paused, completed, cancelled

This becomes the master service register for the practice — what we do for each client, at what fee, and who is responsible.
