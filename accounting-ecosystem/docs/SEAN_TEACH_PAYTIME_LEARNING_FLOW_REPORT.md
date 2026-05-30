# SEAN TEACH PAYTIME LEARNING FLOW REPORT

**Date:** 2026-05-30
**Status:** Implementation complete — migration 062 pending deployment

---

## 1. Audit Summary

A full audit of the Sean AI app and Transactions infrastructure was performed before any code was written. Key findings:

- **Sean backend** (`accounting-ecosystem/backend/sean/`) is fully built: 40+ API endpoints, 15+ database tables
- **`sean_transaction_store`** table already exists with complete approval workflow (pending → draft → approve → sync)
- **`PATCH /:id/draft`** and **`POST /:id/approve`** already implemented and working
- **`frontend-sean/index.html`** (2241 lines) already has the Transactions tab, Pending Review Queue, Edit Draft Modal, Save Draft, and Approve & Sync
- **No "Teach Sean → Paytime" parse/preview/proposals flow** existed — this is what was built

---

## 2. Files Inspected

| File | What Was Found |
|---|---|
| `backend/sean/routes.js` (879 lines) | All Sean API routes — teach parse endpoints added here |
| `backend/sean/transaction-store-routes.js` (721 lines) | Full store approval engine — existing, not modified |
| `backend/sean/knowledge-base.js` | General codex teach via LEER format — separate from Paytime flow |
| `backend/config/migrations/021_sean_store_draft_fields.sql` | Draft save fields already on store table |
| `frontend-sean/index.html` (2241 lines) | Full Sean UI — Teach Paytime tab added here |
| `database/migrations/011_sean_irp5_learning.sql` | IRP5 learning tables foundation |

---

## 3. Existing Teach Sean / Chat Flow Found

`promptTeach()` in the frontend calls a `prompt()` dialog and posts to `/api/sean/codex/teach` using the `LEER: title | content` format. This is the general codex teach for SA tax rules — not structured Paytime payroll item mapping.

The new Teach Paytime flow is separate and parallel to this.

---

## 4. Existing Transactions Paytime Queue Found

The Transactions tab already had a fully working `storeReviewCard` showing `sean_transaction_store` items with `entity_type='payroll_item'`. The Edit Draft Modal (IRP5 code, item type, taxable, UIF, SDL, pre-tax flags) and Save Draft / Approve & Sync were already implemented.

**What was added:** A new `entity_type='paytime_learning'` for Teach Sean proposals, and a new option in the `storeEntityFilter` dropdown to view these separately.

---

## 5. Parser Built — `teach-paytime-service.js`

**File:** `backend/sean/teach-paytime-service.js`

Handles three input formats:

| Format | Detection | Example |
|---|---|---|
| CSV | Lines contain `,`, first line may be header | `Commission, 3606` |
| Table | Lines contain `\|` | `Commission \| 3606 \| Yes \| Yes` |
| Bullet/text | Natural sentences or bullet points | `- Commission uses IRP5 3606 and is taxable.` |

**Fields extracted:**
- `item_name` — required for any proposal
- `irp5_code` — 4-6 digit code, validated against known SARS ranges
- `taxable` — true/false/null from "taxable"/"non-taxable"
- `affects_uif` — true/false/null from "UIF" context
- `affects_sdl` — true/false/null (CSV/table only)
- `confidence` — 0.50–0.95 based on format + code validity
- `source_text` — original line preserved for audit

**Confidence scoring:**

| Scenario | Confidence |
|---|---|
| CSV + known SARS IRP5 code | 0.95 |
| Table + known SARS IRP5 code | 0.90 |
| Bullet text + known SARS code | 0.82 |
| Valid format but unrecognised code | 0.65–0.75 |
| No IRP5 code (name only) | 0.50 |

Uncertain/missing fields are `null` — never guessed.

---

## 6. Preview Flow Built

**Frontend:** `frontend-sean/index.html` — new Teach Paytime tab

Three-step wizard:

```
Step 1: Paste Knowledge  →  Step 2: Review Preview  →  Step 3: Proposals Created
```

**Step 2 (Preview table) columns:**
- Remove ✕ button (per-row removal before import)
- Item Name (with DUPLICATE badge if intra-batch dup)
- IRP5 Code (monospace, or "— not set" indicator)
- Taxable, UIF (Yes/No/—)
- Confidence (colour-coded progress bar + %)
- Warnings (per-row)

**In-memory state** — `_teachParseResult` and `_teachRows` are JS variables. Never stored in localStorage/sessionStorage.

---

## 7. Proposal Creation Flow

### Backend

**`POST /api/sean/teach/paytime/parse`** — Pure parse, no DB writes.

**`POST /api/sean/teach/paytime/proposals`** — Creates proposals in `sean_transaction_store`:

| Field | Value |
|---|---|
| `entity_type` | `paytime_learning` |
| `source_app` | `paytime` |
| `company_id` | From JWT (tenant-scoped) |
| `proposed_field` | `irp5_code` (if code present) |
| `proposed_value` | The IRP5 code |
| `change_type` | `suggested_mapping` |
| `status` | `pending` ← always, never approved |
| `source_channel` | `teach_sean` |
| `confidence` | Parser confidence score |
| `import_batch_id` | UUID from parse step |

**`GET /api/sean/teach/paytime/proposals`** — List proposals for current company, filterable by status/batchId.

### Frontend (Step 3)

Shows:
- Count created / count skipped
- Skipped details (duplicates already pending, invalid items)
- Governance notice: "These proposals are pending review"
- Buttons: Teach More Items | View in Transactions

---

## 8. Paytime Mapping Rules (Governance)

Per CLAUDE.md Part B — Rules B1–B9:

| Rule | Implementation |
|---|---|
| B2: Global changes require explicit authorization | Proposals created as `status='pending'` — never auto-approved |
| B6: Safe propagation only fills NULL/blank fields | The `/store/:id/approve` route (unchanged) already enforces this |
| B9: No auto-overwrite of intentional differences | Hard rule enforced by the approve route |
| B11: Required components | All present: parse service, proposal store, approval workflow, audit trail |

The Teach Sean route **never calls** `/approve`, `/edit`, or `/sync`. It only calls `INSERT` into `sean_transaction_store` with `status='pending'`.

---

## 9. Duplicate Handling

Three layers:

| Layer | Where | Outcome |
|---|---|---|
| Intra-batch | Parse step (in-memory) | `isDuplicate=true`, highlighted yellow in preview |
| Cross-session | Create proposals step (DB check) | Skipped with reason in `skippedDetails` |
| Item name only | normalizeKey comparison | Prevents same name+code pair from double-inserting |

The duplicate check at proposal creation queries `sean_transaction_store` for:
- `entity_type = 'paytime_learning'`
- `company_id = current company`
- `status = 'pending'`
- Same `item_key` + `proposed_value`

---

## 10. Permission / Governance Safety

| Action | Permission | Who |
|---|---|---|
| Parse input (no DB write) | `authenticateToken + requireModule('sean')` | Any authenticated user |
| Create proposals (pending only) | `authenticateToken + requireModule('sean')` | Any authenticated user (own company only) |
| View pending proposals | `authenticateToken + requireModule('sean')` | Own company (via GET endpoint) |
| Edit draft | `requireSuperAdmin` | Super admin only (via store routes) |
| Save draft | `requireSuperAdmin` | Super admin only (via store routes) |
| Approve & Sync | `requireSuperAdmin` | Super admin only (via store routes) |

Company scoping: every proposal is inserted with `company_id = req.user.companyId`. The GET endpoint filters by the same. Cross-company access is structurally impossible.

---

## 11. Audit Logging

| Event | Action in `sean_sync_log` |
|---|---|
| User parses input | `teach_sean_parsed` — item count, format, batch ID |
| Proposals created | `teach_sean_proposals_created` — created/skipped counts, batch ID |
| Reviewer saves draft | `payroll_item_learning_draft_saved` (existing, unchanged) |
| Reviewer approves | Recorded in `sean_irp5_propagation_approvals` (existing) |

Audit fields captured: authorized_by (user email), target_company_id, action, value summary, timestamp.

---

## 12. Tests

18 unit tests in `backend/tests/teach-paytime.test.js`:

| Test | What it verifies |
|---|---|
| TEST-TP-01 | CSV input → 3 items with correct name+code |
| TEST-TP-02 | Bullet/text input → items extracted |
| TEST-TP-03 | Table/pipe input → taxable + UIF mapped |
| TEST-TP-04 | Minimum: item_name alone is valid (no IRP5 required) |
| TEST-TP-05 | Missing optional fields are null, never guessed |
| TEST-TP-06 | Intra-batch duplicate detection |
| TEST-TP-07 | Empty input → success=false with error |
| TEST-TP-08 | Unparseable text → success=false |
| TEST-TP-09 | Non-numeric IRP5 field → irp5_code is null |
| TEST-TP-10 | importBatchId is always a valid UUID v4 |
| TEST-TP-11 | Confidence score in range 0.0–1.0 |
| TEST-TP-12 | CSV boolean columns (Taxable, UIF) mapped correctly |
| TEST-TP-13 | Bullet text taxable detection from natural language |
| TEST-TP-14 | normalizeKey produces correct clean keys |
| TEST-TP-15 | source_text preserved per item |
| TEST-TP-16 | Empty lines in CSV are skipped |
| TEST-TP-17 | Parse result never contains approved/synced status |
| TEST-TP-18 | warnings array always present |

To run:
```
cd accounting-ecosystem/backend
npx jest teach-paytime --verbose
```

---

## 13. Manual Verification Checklist

- [ ] Open `/sean` → Teach Paytime tab visible
- [ ] Paste CSV: `Item Name, IRP5 Code\nCommission, 3606\nTravel Allowance, 3701\nProvident Fund, 3801`
- [ ] Click "Parse & Preview" → preview shows 3 rows
- [ ] Item names and IRP5 codes are correct
- [ ] Optional fields (Taxable, UIF) show `—` when not in CSV
- [ ] Click ✕ on one row → row removed from preview
- [ ] Click "Create Learning Proposals" → success confirmation
- [ ] Switch to Transactions tab → change filter to "Teach Sean Proposals"
- [ ] 2 pending records appear (1 was removed)
- [ ] Click Edit on one record → Edit Draft modal opens
- [ ] Fill in IRP5 code, save Draft → modal shows "✓ Saved"
- [ ] Status still shows PENDING after Save Draft
- [ ] Approve & Sync is separate button → requires confirmation
- [ ] Re-import same CSV → all skipped as duplicates
- [ ] Paytime app data unchanged
- [ ] Check localStorage → no business data stored

---

## 14. No-LocalStorage Confirmation

| Data | Storage |
|---|---|
| Pasted input text | DOM textarea only — cleared on reset |
| Parse result (`_teachParseResult`) | JS variable in memory only |
| Preview rows (`_teachRows`) | JS variable in memory only |
| Pending proposals | `sean_transaction_store` DB table only |
| Auth token | `localStorage.getItem('sean_token')` — auth only, permitted |
| SSO user session | `localStorage.getItem('token')` — auth handoff only, permitted |

No business data (payroll item mappings, IRP5 codes, proposals) is stored in browser storage.

---

## 15. Cross-App Safety Confirmation

- ✅ **Sean app only changed** — `backend/sean/routes.js`, `backend/sean/teach-paytime-service.js`, `frontend-sean/index.html`
- ✅ **Paytime code not changed** — zero changes to any file under `frontend-payroll/`, `backend/modules/payroll/`
- ✅ **Paytime data not mutated by Teach Sean** — proposals are `pending` in Sean's own store; Paytime is not touched
- ✅ **No other apps changed** — Accounting, POS, Inventory, Practice, Coaching, Ecosystem dashboard untouched

---

## 16. Remaining Risks / Next Steps

| Item | Severity | Action |
|---|---|---|
| Migration 062 not yet deployed | HIGH | **Must run** `database/migrations/062_sean_store_teach_fields.sql` in Supabase SQL Editor before using Teach Sean |
| Bullet text parser accuracy on unusual formats | MEDIUM | Parser uses heuristics — add more test cases as real-world input patterns emerge. Low-confidence items flagged to user |
| `storeEntityFilter` currently shows all pending, not filtered by company | LOW | The `/store` GET endpoint requires `requireSuperAdmin` — this is correct for admin review. Company user sees their proposals via `GET /teach/paytime/proposals` |
| IRP5 code validation range | LOW | `IRP5_RANGES` in parser covers common codes; unusual codes flagged with warning but still allowed through |
| Teach Sean proposals with no IRP5 code cannot be auto-approved | INTENDED | By design — user must edit and add code via the Edit modal before Approve & Sync |

### Required deployment step

**Run migration 062 in Supabase SQL Editor before using Teach Sean:**

```sql
-- File: database/migrations/062_sean_store_teach_fields.sql
-- Adds: source_channel, confidence, import_batch_id columns to sean_transaction_store
```

Without this migration, proposals still insert (columns are additive), but `source_channel` and `confidence` fields will be rejected by the DB constraint check if PostgreSQL enforces unknown column errors.
