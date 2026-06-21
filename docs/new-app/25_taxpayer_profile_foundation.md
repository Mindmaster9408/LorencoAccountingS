# Codebox 25 — Taxpayer Profile Foundation (Individual + Company Tax Readiness)

**Status:** Complete  
**Date:** 2026-06-21  
**Module:** Practice Management — `/api/practice/taxpayer-profiles`

---

## What This Is

A structured taxpayer profiling system that lets the practice record the tax registration details, income sources, deductions, and document readiness for every client — whether individual, company, trust, partnership, or close corporation.

**This is NOT:**
- Tax calculation (no ITR12/ITR14 computation)
- SARS eFiling integration
- Provisional tax scheduling
- A SARS API proxy

**This IS:**
- A profile-per-client store for tax reference numbers, entity type, registration details
- An income source and deduction declaration tracker (what does this taxpayer earn/claim?)
- A readiness checklist to confirm required documents are in hand before filing season
- A readiness score (0–100%) computed on demand from the checklist state

---

## Database (Migration 075)

Run `accounting-ecosystem/backend/config/migrations/075_practice_taxpayer_profiles.sql` once in Supabase SQL Editor.

### Tables Created

| Table | Purpose |
|---|---|
| `practice_taxpayer_profiles` | One profile per client — type, tax refs, registration details, readiness score |
| `practice_taxpayer_income_sources` | Income type declarations per profile (salary, rental, dividends, etc.) |
| `practice_taxpayer_deductions` | Deduction declarations per profile (RA, medical, travel, etc.) |
| `practice_taxpayer_readiness_items` | Checklist items per profile — tracks whether each document has been received |

### Key Design Decisions

- `readiness_score` is `INTEGER NULL` — null means "not yet calculated", not zero.
- `readiness_status` defaults to `'unknown'` until first recalculation.
- Income sources and deductions use `active = false` for soft removal (no hard deletes).
- Readiness items use `required BOOLEAN` — optional items count toward score only when `waived` is intentional.
- `related_document_request_id` is a reference-only cross-link (no FK constraint) to `practice_document_requests`.

---

## Backend (taxpayer-profiles.js)

File: `accounting-ecosystem/backend/modules/practice/taxpayer-profiles.js`  
Mounted at: `/api/practice/taxpayer-profiles` via `practice/index.js`

### Routes (in registration order — literal before parameterized)

```
GET    /summary                                   Summary counts by type and readiness
GET    /                                          List all profiles (filters: taxpayer_type, tax_status, readiness_status, client_id)
POST   /                                          Create a new profile
GET    /:id                                       Get one profile (with client name join)
PUT    /:id                                       Update profile fields
DELETE /:id                                       Soft-delete (sets tax_status = 'ceased')

GET    /:id/income-sources                        List active income sources for a profile
POST   /:id/income-sources                        Add an income source
PUT    /:id/income-sources/:sourceId              Update an income source
DELETE /:id/income-sources/:sourceId              Soft-remove (active = false)

GET    /:id/deductions                            List active deductions for a profile
POST   /:id/deductions                            Add a deduction
PUT    /:id/deductions/:dedId                     Update a deduction
DELETE /:id/deductions/:dedId                     Soft-remove (active = false)

GET    /:id/readiness                             List readiness items + current score
POST   /:id/readiness-items                       Add a custom readiness item
PUT    /:id/readiness-items/:itemId               Update readiness item (status, notes)
POST   /:id/recalculate-readiness                 Recalculate + persist readiness score
POST   /:id/generate-default-items                Seed default checklist items for this taxpayer type
                                                  Returns 409 if items already exist (use ?force=true to append missing defaults)
```

### Readiness Algorithm

```
required_items = items WHERE required = true
if none → score = null, status = 'unknown'

done_count  = items WHERE status IN ('received', 'completed', 'waived')
score       = round(done_count / total_required * 100)

if any blocked → status = 'blocked'
else if score >= 85 → status = 'ready'
else if score >= 50 → status = 'partial'
else               → status = 'incomplete'
```

### Default Items by Taxpayer Type

| Type | Default Readiness Items |
|---|---|
| `individual` | Tax Reference Number, ID Document Copy, IRP5/IT3(a) Certificates, Medical Aid Certificate, RA Certificate (if applicable), Investment Certificates IT3(b) |
| `company` | Income Tax Reference Number, Company Registration Documents, Signed Annual Financial Statements, Trial Balance, Tax Computation Supporting Schedule |
| `trust` | Trust Deed, Trustee Resolution, Financial Statements, Trust Tax Number |
| `partnership` | Partnership Agreement, Partnership Tax Number, Financial Statements, Partner ID Documents (optional) |
| `cc` | Same as company (5 items) |

---

## Frontend (taxpayer-profiles.html + js/taxpayer-profiles.js)

### Summary Cards
- Total Profiles, Individual, Company/CC, Trust/Partnership, Ready, Blocked

### Filter Bar
- By taxpayer type, tax status, readiness status, client

### Profile List Table
Columns: Type badge, Client, Tax Reference, Tax Status badge, Readiness (% + label), Actions (View)

### Detail Modal — 4 Tabs

**Overview tab**
- Key fields grid (type, status, tax ref, ID/reg number, etc.)
- Tax status change dropdown (inline update)
- Recalculate button

**Income Sources tab**
- List of active income source declarations
- Add income source modal (type + description + notes)
- Remove button (soft delete via `active = false`)

**Deductions tab**
- List of active deduction declarations
- Add deduction modal (type + description)
- Remove button (soft delete)

**Readiness tab**
- Progress bar (colour: green=ready, amber=partial, red=blocked)
- Generate Default Items button (409 guard with confirm on re-generate)
- Add Item button
- Per-item actions: Received, Done, Block, Waive

### nav/layout.js
`Taxpayer Profiles` added as nav tab after `Compliance Packs`.

---

## Client Detail Page (Sections + Modal)

**Section 18** (`taxpayerProfilesSection`) added after section 17 (Compliance Packs):
- Shows up to 8 active profiles for the client
- "View All →" link (filters taxpayer-profiles.html to this client)
- "+ New Profile" button (lightweight create modal)

**Create Profile Modal** (`cdCreateProfileModal`):
- Fields: Taxpayer Type (required), Income Tax Reference, Tax Status, Notes
- On submit: POST `/api/practice/taxpayer-profiles` with `client_id` from URL

---

## Multi-Tenant Safety

Every query includes `.eq('company_id', req.companyId)`.  
`req.companyId` is sourced exclusively from the JWT (set by `authenticateToken` middleware).  
No user-supplied `company_id` is accepted in request bodies for protected operations.

---

## No Browser Storage

Zero use of `localStorage`, `sessionStorage`, or `safeLocalStorage` for business data.  
All profile, income source, deduction, and readiness data lives in Supabase PostgreSQL exclusively.

---

## Recommended Next Codebox

**Codebox 26 — Provisional Tax Planning + Tax Calendar Foundation**

Tracks provisional tax return due dates, estimated taxable income, and payment deadlines per taxpayer profile.  
Links to the taxpayer profile created in CB25. Feeds into the Practice Calendar (future codebox).
