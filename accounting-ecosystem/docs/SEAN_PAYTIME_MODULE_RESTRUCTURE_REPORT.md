# SEAN PAYTIME MODULE RESTRUCTURE REPORT

**Date:** 2026-05-30
**Status:** Implementation complete — no migrations required

---

## 1. Audit Summary

Before writing any code, the following were inspected:

| Component | Finding |
|---|---|
| Nav tabs | 8 tabs: Dashboard, Chat, Transactions, Calculator, Codex, Categories, Coaching, Teach Paytime |
| Transactions tab | Mixed: bank allocation patterns + bank transactions (bank) AND IRP5 store review queue + global library (Paytime) |
| Teach Paytime tab | 3-step wizard (paste → parse → create proposals) — separate tab |
| IRP5 learning queue | Exists in `storeReviewCard` inside tab-transactions — functional |
| Edit Draft flow | Fully built — modal with IRP5 code, item type, taxable/UIF/SDL flags, Save Draft, Approve & Sync |
| Approve & Sync flow | `requireSuperAdmin` enforced, never overwrites existing codes (Rule B9) |
| Audit trail | `sean_sync_log` table — all store actions logged |
| Global library | `sean_global_library` table — approved standards per entity type |
| Existing backend | No Paytime aggregation endpoint existed; relied on `requireSuperAdmin` store routes |

**Key finding:** The Paytime governance logic was fully built and sound. The problem was purely structural — Paytime learning was split across two different tabs with no coherent home.

---

## 2. Existing Flows Found

| Flow | Where it lived | Status |
|---|---|---|
| IRP5 store review queue | `tab-transactions` → `storeReviewCard` | Preserved, moved |
| Global library | `tab-transactions` → `storeLibraryCard` | Preserved, moved |
| Teach Sean 3-step wizard | `tab-teach` (separate tab) | Preserved, moved |
| Edit Draft modal | Modal overlay (not tab-specific) | Unchanged |
| Approve & Sync | Modal action, `POST /store/:id/edit` | Unchanged |
| Bank allocation patterns | `tab-transactions` → `learningPatternsList` | Left in hidden tab-transactions |
| Bank transactions / add txn | `tab-transactions` → `txnTableBody` | Left in hidden tab-transactions |

---

## 3. Navigation Changes

**Before:**
```
Dashboard | Chat | Transactions | Calculator | Codex | Categories | Coaching | Teach Paytime
```

**After:**
```
Dashboard | Chat | Paytime | Calculator | Codex | Categories | Coaching
```

- `Transactions` tab removed from nav (div kept hidden for backward-compat JS)
- `Teach Paytime` tab removed from nav (HTML moved into Paytime → Teach section)
- `Paytime` tab added — single entry point for all payroll intelligence

Dashboard Quick Actions updated:
- "View Transactions" → "💼 Paytime"
- "Teach SEAN" → "📝 Teach Paytime" (calls `switchPaytimeAndTeach()`)

---

## 4. New Paytime Module Structure

Sean → Paytime is now a single tab containing a 5-section sub-navigation:

```
💼 Paytime
├── 🤖 Assistant      — Payroll intelligence chat with suggested prompts
├── 📝 Teach          — Parse → Preview → Create Proposals (3-step wizard)
├── ⏳ Pending Review  — All Paytime proposals awaiting governance action
├── ✅ Approved        — Global library of approved IRP5 mappings
└── 📋 Audit History  — Read-only sync log for the current company
```

Sub-nav uses `pt-nav-btn` buttons with `data-section` attributes. `switchPaytimeSection(section)` manages visibility of `.pt-section` divs.

---

## 5. Assistant Section

**Element ID:** `ptAssistantMessages`, `ptAssistantInput`

**Function:** `sendPaytimeAssistantChat()` — sends message to the existing `/api/sean/chat` endpoint with a Paytime payroll context prefix.

**Suggested prompts (6 cards):**
- What IRP5 code should commission use?
- Why would a travel allowance be taxable?
- Variable vs Average PAYE projection?
- How does UIF apply to commission?
- What is included in gross for SDL?
- IRP5 code for provident fund employer contribution?

**Governance:** The assistant provides guidance only. It does not create proposals, approve anything, or touch Paytime data.

---

## 6. Teach Section

The existing 3-step wizard was moved from `tab-teach` into `pt-teach` with **all element IDs preserved**:
- `teachPill1/2/3`, `teachStep1/2/3`
- `teachInputText`, `teachParseStatus`
- `teachPreviewBody`, `teachFormatChip`, `teachItemCount`, `teachGlobalWarnings`
- `createProposalsBtn`, `teachResultBox`, `teachSkippedDetails`

All existing teach JS functions (`resetTeachFlow`, `parseTeachInput`, `confirmCreateProposals`, `_showTeachStep`, etc.) continue to work without modification.

**Text updated:** "in the **Transactions** tab" → "in **Pending Review**" (3 occurrences in step 2 and 3 text).

**Button updated:** "View in Transactions →" → "View in Pending Review →" calling `switchPaytimeToReview()`.

---

## 7. Pending Review Section

**New element IDs:** `ptEntityFilter`, `ptReviewStats`, `ptReviewBody`, `.pt-status-btn`

**Backend endpoint:** `GET /api/sean/paytime/pending-review` (new, company-scoped, no super-admin required)

**Status filter pills:** Pending | Approved | Discarded | All

**Entity type filter:** All Paytime / Payroll items (events) / Teach Sean proposals

**Row display includes:**
- Item name
- IRP5 code badge (purple) or "— no IRP5 code yet"
- Status chip (colour-coded)
- Source channel badge (`teach_sean` vs others)
- Confidence bar + percentage
- Submitted by + date + entity type

**Actions on pending rows:** Approve & Sync | ✏️ Edit | ✗ Discard — all reuse existing `approveStoreItem()`, `editStoreItem()`, `discardStoreItem()` functions.

**After-action refresh:** `approveStoreItem`, `discardStoreItem`, `saveDraft`, and `approveFromDraftModal` all now call `loadPtPendingReview()` alongside the existing `loadLearningPatterns()`.

---

## 8. Approved Knowledge Section

**New element IDs:** `ptApprovedSearch`, `ptApprovedBody`

**Backend endpoint:** `GET /api/sean/paytime/approved-knowledge` (new, reads `sean_global_library` for `payroll_item` and `paytime_learning` entity types)

**Display:** Searchable table with item name, standard field, standard value (IRP5 code), approved by, approved date, sync count.

**Client-side search:** `filterPtApproved(q)` filters the cached `_ptApprovedItems` array in memory — no re-fetch on search.

**Governance note displayed:** "Approved IRP5 mappings and standards. These sync to Paytime clients where the local value is blank — existing codes are never overwritten."

---

## 9. Audit / Sync History Section

**New element ID:** `ptAuditBody`

**Backend endpoint:** `GET /api/sean/paytime/audit` (new, reads `sean_sync_log` filtered by current company, newest first)

**Display:** Timeline-style rows with action icons, field written, value, authorized by, timestamp. Left-border colour-coded by action type:
- Green border: approved/sync actions
- Amber border: draft save
- Red border: discard
- Blue/primary border: teach/parse/create actions

**Read-only.** No actions available in this section.

---

## 10. Backend Changes

**Files modified:** `accounting-ecosystem/backend/sean/routes.js`

**3 new endpoints added** (before TEACH SEAN routes):

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/sean/paytime/pending-review` | `authenticateToken + requireModule('sean')` | Company-scoped Paytime store items |
| `GET /api/sean/paytime/approved-knowledge` | `authenticateToken + requireModule('sean')` | Global library (payroll/paytime entity types) |
| `GET /api/sean/paytime/audit` | `authenticateToken + requireModule('sean')` | Company sync log history |

All three are **read-only** aggregation endpoints. No writes. No governance changes. No new tables.

---

## 11. Governance Safety

| Governance Rule | Status |
|---|---|
| Teach creates pending proposals only | ✅ Unchanged — `POST /teach/paytime/proposals` sets `status='pending'` |
| Save Draft ≠ Approve | ✅ Unchanged — `PATCH /store/:id/draft` never changes status |
| Approve & Sync requires super-admin | ✅ Unchanged — `requireSuperAdmin` on `/store/:id/approve` and `/store/:id/edit` |
| No auto-overwrite of existing IRP5 codes | ✅ Unchanged — Rule B9 enforced in `_runGlobalSync()` |
| Audit trail preserved | ✅ All store actions still log to `sean_sync_log` |
| Paytime app untouched | ✅ Zero changes outside `frontend-sean/` and `backend/sean/routes.js` |

---

## 12. Tests Run

The following were verified by inspection:

1. ✅ All existing teach JS function IDs present in new HTML (`teachStep1/2/3`, `teachPill1/2/3`, etc.)
2. ✅ `resetTeachFlow()` references confirmed present and unchanged
3. ✅ `confirmCreateProposals()` redirects to `switchPaytimeToReview()` not `switchTab('transactions')`
4. ✅ `approveStoreItem`, `discardStoreItem`, `saveDraft`, `approveFromDraftModal` all call `loadPtPendingReview()` after action
5. ✅ `switchTab('paytime')` calls `loadPaytimeModule()`
6. ✅ `loadPaytimeModule()` calls `switchPaytimeSection(_paytimeSection)` — defaults to 'assistant'
7. ✅ 3 new backend endpoints registered before `module.exports`
8. ✅ `tab-transactions` div is hidden but present — all legacy JS functions still have their DOM elements
9. ✅ No duplicate element IDs (teach IDs moved, not duplicated)
10. ✅ `escHtml()` used throughout new Paytime JS functions

---

## 13. Manual Verification Checklist

- [ ] Sean loads — `tab-paytime` is hidden initially, `tab-dashboard` is active
- [ ] Click **Paytime** in nav → Paytime module opens on Assistant section
- [ ] 6 prompt cards visible; click one → assistant chat fires
- [ ] Type a payroll question → response rendered in assistant messages
- [ ] Click **Teach** sub-nav → 3-step wizard visible (same as before)
- [ ] Paste CSV, parse → preview table shows
- [ ] Remove a row → row disappears from preview
- [ ] Create proposals → step 3 shows success + "View in Pending Review →" button
- [ ] Click "View in Pending Review →" → Pending Review section opens
- [ ] Pending items load; status filter pills work (Pending / Approved / All)
- [ ] Entity type filter changes results
- [ ] Click **Edit** on a pending item → Edit Draft Modal opens
- [ ] Fill IRP5 code, click **Save Draft** → "✓ Saved" indicator, status remains PENDING
- [ ] Click **Approve & Sync** → confirmation dialog, then success alert
- [ ] Click **Approved** sub-nav → approved knowledge table loads
- [ ] Search filters the approved table client-side
- [ ] Click **Audit History** sub-nav → audit log loads
- [ ] Check that **Transactions** tab is gone from nav
- [ ] Check that **Teach Paytime** tab is gone from nav
- [ ] Confirm no Paytime app files changed
- [ ] Inspect browser localStorage — no business data stored

---

## 14. No-LocalStorage Confirmation

| State | Storage |
|---|---|
| Active Paytime sub-section (`_paytimeSection`) | JS variable in memory — cleared on page refresh |
| Active review status filter (`_ptReviewStatus`) | JS variable in memory |
| Approved items cache (`_ptApprovedItems`) | JS array in memory — used for client-side search only |
| Pending proposals | `sean_transaction_store` DB only |
| Auth token (`sean_token`) | localStorage — auth only, permitted |
| SSO user | localStorage — auth handoff only, permitted |

No business data (payroll items, IRP5 codes, proposals, approvals) is stored in browser storage.

---

## 15. Cross-App Safety Confirmation

- ✅ **Sean app only changed** — `frontend-sean/index.html`, `backend/sean/routes.js`
- ✅ **Paytime app untouched** — zero changes to `frontend-payroll/`, `backend/modules/payroll/`
- ✅ **Governance preserved** — no approval or sync paths were modified
- ✅ **No automatic Paytime mutation** — all mutations still require explicit super-admin approval
- ✅ **Accounting app untouched** — zero changes to `frontend-accounting/`, `backend/modules/accounting/`
- ✅ **No other apps changed** — POS, Inventory, Practice, Coaching, Ecosystem dashboard untouched

---

## 16. Remaining Risks / Future Expansion

| Item | Severity | Notes |
|---|---|---|
| `GET /paytime/pending-review` returns company's own items only | INTENDED | Super admin can still use the hidden `tab-transactions` div's store routes for cross-company view |
| `GET /paytime/approved-knowledge` returns global library without company context | LOW | Global library is read-only; safe for all authenticated users to see |
| Audit history shows only `target_company_id` matches | LOW | Items created via `teach_sean_parsed` event have `target_company_id` set — verify in integration test |
| Mobile layout for sub-nav pills | LOW | `paytime-subnav` uses `flex-wrap:wrap` and `min-width:90px` — should be usable on narrow screens; verify on real device |
| Assistant section uses general `/api/sean/chat` with a prompt prefix | MEDIUM | For more accurate payroll answers, a dedicated Paytime chat endpoint with payroll-specific context would improve quality. Tracked as future enhancement. |

### Future expansion (clean path)

The 5-section layout is designed to scale:
- **Assistant** — can be upgraded to a dedicated payroll chat endpoint with IRP5 codex context
- **Teach** — can be extended to support more knowledge types (UIF rules, SDL rules, payslip items)
- **Pending Review** — can add batch-approve, batch-discard, import batch grouping view
- **Approved Knowledge** — can add category filters (earnings / deductions / allowances)
- **Audit History** — can add date range filters, export to CSV
