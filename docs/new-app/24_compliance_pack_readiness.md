# Codebox 24 — Annual Compliance Pack + Client Year-End Readiness Foundation

**Module:** Lorenco Practice Management  
**Codebox:** 24 of ±80  
**Date:** June 2026  
**Status:** Implemented

---

## Purpose

Build structured readiness tracking for annual and periodic compliance work per client.

This is **NOT**:
- Tax calculation
- Financial statement generation
- SARS submission

This **IS**:
- Readiness and completeness tracking only
- Answers: "Is this client ready for X?"
- Tracks what is outstanding, received, and blocking

---

## What Was Built

### Database (Migration 074)

Three tables created:

**`practice_compliance_packs`** — one pack per client per compliance period/type
- pack_type: annual_financials | company_tax | individual_tax | vat_period | payroll_annual | cipc_annual | custom
- status: draft | collecting_docs | ready_for_review | reviewed | completed | cancelled
- readiness_score: 0–100 (integer, null = not yet calculated)
- readiness_status: incomplete | partial | ready | blocked | unknown
- period_start, period_end, tax_year, financial_year_end for period scoping
- owner and reviewer team member assignments
- settings JSONB for future extensibility

**`practice_compliance_pack_items`** — checklist items per pack
- item_type: document | task | deadline | checklist | review | custom
- status: required | requested | received | completed | waived | blocked | not_applicable
- required flag: only required=true items count in readiness scoring
- not_applicable items are excluded from both numerator and denominator
- cross-links to practice_document_requests, practice_tasks, practice_deadlines

**`practice_compliance_pack_events`** — audit trail for pack lifecycle events
- event_type, old_status, new_status, actor_user_id, metadata JSONB

### Backend Routes (`/api/practice/compliance-packs`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | /summary | Summary counts by status and readiness |
| GET | / | List packs (filters: client_id, pack_type, status, readiness_status, tax_year) |
| POST | / | Create new pack |
| GET | /:id | Single pack with joins |
| PUT | /:id | Update pack fields or status |
| DELETE | /:id | Soft cancel (status → cancelled) |
| POST | /:id/recalculate-readiness | Compute score from items, persist to pack |
| GET | /:id/items | List items with live readiness calculation |
| POST | /:id/items | Add single item |
| PUT | /:id/items/:itemId | Update item (status, name, required, etc.) |
| DELETE | /:id/items/:itemId | Soft mark not_applicable (or hard delete with ?soft=false) |
| POST | /:id/generate-default-items | Create standard items for pack_type |
| POST | /:id/generate-from-documents | Link open document requests for client to pack |

### Frontend Pages

**`/practice/compliance-packs.html`** — standalone page
- Summary cards (Total Active, Collecting, Ready for Review, Readiness: Ready, Blocked)
- Toolbar filters (type, status, readiness, client)
- Pack list table with type badges, status badges, readiness indicator
- Create pack modal with auto-name from client + type + tax year
- Pack detail modal with:
  - Readiness progress bar
  - Status lifecycle selector
  - Action buttons: Recalculate Readiness, Generate Default Items, Link Document Requests, Add Item
  - Items checklist with inline status actions (✓ received, ⚠ blocked, — N/A)

**Client detail page** (`/practice/client-detail.html`) — section 17
- Shows open packs (up to 8) with readiness indicator
- "View All →" link to compliance-packs.html filtered to this client
- "+ New Pack" button opens lightweight create modal inline

---

## Readiness Calculation

### Rule (transparent, no AI)

```
required_items  = items WHERE required = true AND status != 'not_applicable'
completed_items = required_items WHERE status IN ('completed', 'received', 'waived')

readiness_score = ROUND(completed_items / required_items * 100)

readiness_status:
  - no required_items                          → unknown
  - any required item with status = 'blocked'  → blocked   (overrides score)
  - score >= 85                                → ready
  - score >= 50                                → partial
  - score < 50                                 → incomplete
```

### Key decisions

- `not_applicable` items are excluded from both sides of the ratio (they don't drag the score down)
- `waived` items count as done (a decision was made to waive — that's valid completion)
- `blocked` status overrides numeric scoring — one blocker = pack is blocked
- Score is stored on the pack after explicit `POST /:id/recalculate-readiness` — not auto-computed on every item save (keeps intent explicit, avoids hidden state changes)

---

## Default Items per Pack Type

### annual_financials (9 items)
Bank statements, Trial balance, Debtors listing, Creditors listing, Fixed asset register, Loan confirmations (optional), Inventory valuation (optional), Payroll reports, VAT recon support (optional)

### company_tax (5 items)
Signed AFS, Tax computation support, SARS statement of account, Provisional tax history, Assessed losses support (optional)

### individual_tax (6 items)
IRP5/IT3(a), Medical tax certificate (optional), Retirement annuity certificate (optional), Travel logbook (optional), Rental income schedule (optional), Investment certificates (optional)

### vat_period (5 items)
VAT invoices, Bank statements, Output VAT listing, Input VAT support, Import documents (optional)

### payroll_annual (4 items)
Payroll reports, EMP501 support, IRP5 reconciliation, UIF/SDL summaries

### cipc_annual (4 items)
Company resolution, Annual return form, Beneficial ownership declaration, Director/member details (optional)

### custom (0 items — manual build)

---

## Audit Events Logged

| Event | When |
|-------|------|
| compliance_pack_created | Pack created |
| compliance_pack_updated | Status changed |
| compliance_pack_cancelled | Pack soft-cancelled |
| compliance_pack_readiness_recalculated | Readiness recalculated |
| compliance_pack_item_added | Item added (via audit log) |
| compliance_pack_item_updated | Item status changed (via audit log) |
| compliance_pack_defaults_generated | Default items batch created |
| compliance_pack_documents_generated | Document requests linked as items |

---

## Multi-Tenant Safety

- All queries include `.eq('company_id', req.companyId)` — no cross-company data possible
- Client, owner, and reviewer IDs verified against company before create
- Pack ownership verified before any item or action route
- No hardcoded company IDs anywhere

---

## No Browser Storage

No business data written to localStorage, sessionStorage, or safeLocalStorage KV bridge. All reads and writes go through API endpoints backed by Supabase PostgreSQL tables.

---

## Files Created / Modified

| File | Action |
|------|--------|
| `accounting-ecosystem/backend/config/migrations/074_practice_compliance_packs.sql` | Created |
| `accounting-ecosystem/backend/modules/practice/compliance-packs.js` | Created |
| `accounting-ecosystem/backend/modules/practice/index.js` | Modified (router import + mount) |
| `accounting-ecosystem/backend/frontend-practice/compliance-packs.html` | Created |
| `accounting-ecosystem/backend/frontend-practice/js/compliance-packs.js` | Created |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Modified (nav item added) |
| `accounting-ecosystem/backend/frontend-practice/client-detail.html` | Modified (section 17 + create modal) |
| `accounting-ecosystem/backend/frontend-practice/js/client-detail.js` | Modified (load + render + modal functions) |

---

## Testing Checklist

- [ ] Run migration 074 in Supabase SQL Editor
- [ ] Create annual_financials pack for a client
- [ ] Generate default items
- [ ] Mark 2–3 items received
- [ ] Recalculate readiness — verify score and status
- [ ] Mark one item blocked — verify readiness_status = 'blocked'
- [ ] Mark blocked item N/A — verify it drops out of calculation
- [ ] Link document requests via generate-from-documents
- [ ] Verify no duplicate links if called twice
- [ ] Create pack from client detail page
- [ ] View section 17 on client detail
- [ ] Verify "View All →" filters to this client
- [ ] Verify no localStorage/sessionStorage writes
- [ ] Create pack for company A, verify not visible from company B
- [ ] Cancel a pack — verify soft cancel (status = cancelled, not deleted)
- [ ] Status lifecycle: draft → collecting_docs → ready_for_review → reviewed → completed

---

## Recommended Codebox 25

**Taxpayer Profile Foundation — Individual + Company Tax Readiness**

We now have documents (Codebox 23) and compliance packs (Codebox 24). The next logical step is to build structured taxpayer profiles — capturing the data needed to prepare income tax returns before any calculation happens.

- Individual taxpayer profile: employment income, rental, business income, deductions, RA, medical
- Company taxpayer profile: AFS references, tax computation inputs, provisional tax history
- These feed directly into the company_tax and individual_tax compliance packs
