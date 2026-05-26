# CODEBOX 05 — CLIENT PROFILE EXPANSION / CRM FOUNDATION
# Implementation Record

> Date: May 2026
> Status: COMPLETE
> Prerequisite: Codebox 04 (Practice Team Foundation) — COMPLETE

---

## 1. Summary

Expanded Lorenco Practice client management from a basic list into a full CRM foundation. Every accounting practice can now maintain structured profiles for each client: entity type, tax reference numbers, compliance flags, structured addresses, team ownership, billing defaults, and contact persons — all scoped per practice/company.

---

## 2. Architecture Recap

```
practice_profiles     → the accounting FIRM itself (one per company)
practice_team_members → PEOPLE working inside that firm (many per company)
practice_clients      → CLIENT FILES (many per company)  ← THIS CODEBOX
practice_client_contacts → CONTACTS per client (many per client)  ← NEW
```

**Critical distinction enforced throughout:**
- Practice Profile = the accounting firm's own identity
- Client Profile = the firm's CLIENT's profile
- These two are separate and must never be conflated

---

## 3. Files Changed

### Created
| File | Purpose |
|---|---|
| `accounting-ecosystem/database/migrations/056_practice_client_crm_expansion.sql` | ALTER TABLE + new contacts table |
| `accounting-ecosystem/frontend-practice/client-detail.html` | Full CRM profile page for a single client |
| `accounting-ecosystem/frontend-practice/js/client-detail.js` | Full client detail page logic — IIFE, load, save, archive, contacts |
| `practice-pilot/codebox-01-foundation/05_client_crm_foundation.md` | This file |
| `practice-pilot/codebox-01-foundation/SESSION_HANDOFF_codebox_05_client_crm.md` | Session handoff |

### Modified
| File | Change |
|---|---|
| `accounting-ecosystem/database/migrations/056_practice_client_crm_expansion.sql` | (new) |
| `accounting-ecosystem/backend/modules/practice/index.js` | Replaced basic client routes with full CRM routes + contact CRUD |
| `accounting-ecosystem/frontend-practice/clients.html` | Enhanced list: type badge, compliance flags, responsible member, View link, CRM filters, updated quick-add modal |

---

## 4. Database Changes

### Migration 056

#### A. `practice_clients` table extensions (ALTER TABLE ... ADD COLUMN IF NOT EXISTS)

| Column | Type | Purpose |
|---|---|---|
| `client_type` | `TEXT NOT NULL DEFAULT 'company' CHECK (...)` | Entity type |
| `secondary_phone` | `TEXT` | Additional phone |
| `website` | `TEXT` | Client website |
| `financial_year_end_month` | `INTEGER CHECK (1-12)` | FYE month integer (backward compat alongside `fiscal_year_end TEXT`) |
| `id_number` | `TEXT` | SA ID number (individual clients) |
| `passport_number` | `TEXT` | Passport (foreign nationals) |
| `date_of_birth` | `DATE` | DOB (individual clients) |
| `income_tax_number` | `TEXT` | SARS income tax ref |
| `paye_reference_number` | `TEXT` | PAYE ref |
| `uif_reference_number` | `TEXT` | UIF ref |
| `sdl_reference_number` | `TEXT` | SDL ref |
| `vat_registered` | `BOOLEAN NOT NULL DEFAULT FALSE` | VAT registration flag |
| `paye_registered` | `BOOLEAN NOT NULL DEFAULT FALSE` | PAYE employer flag |
| `provisional_taxpayer` | `BOOLEAN NOT NULL DEFAULT FALSE` | Provisional tax flag |
| `uif_registered` | `BOOLEAN NOT NULL DEFAULT FALSE` | UIF flag |
| `sdl_registered` | `BOOLEAN NOT NULL DEFAULT FALSE` | SDL flag |
| `coida_registered` | `BOOLEAN NOT NULL DEFAULT FALSE` | COIDA flag |
| `cipc_registered` | `BOOLEAN NOT NULL DEFAULT FALSE` | CIPC annual return flag |
| `address_line1/2/city/province/postal_code/country` | `TEXT` | Structured physical address |
| `address_province` | `TEXT CHECK (9 SA provinces)` | SA province |
| `address_country` | `TEXT NOT NULL DEFAULT 'South Africa'` | Country |
| `postal_same_as_physical` | `BOOLEAN NOT NULL DEFAULT TRUE` | Postal = physical |
| `postal_address_line1/.../postal_country` | `TEXT` | Postal address fields |
| `responsible_team_member_id` | `INTEGER` | Soft ref to `practice_team_members.id` |
| `reviewer_team_member_id` | `INTEGER` | Soft ref |
| `partner_team_member_id` | `INTEGER` | Soft ref |
| `onboarding_status` | `TEXT NOT NULL DEFAULT 'active' CHECK (...)` | Workflow state |
| `risk_rating` | `TEXT NOT NULL DEFAULT 'normal' CHECK (...)` | Risk level |
| `billing_rate_override` | `NUMERIC(12,2) CHECK (>= 0)` | Client-specific rate override |
| `billing_currency` | `TEXT NOT NULL DEFAULT 'ZAR'` | Billing currency |
| `payment_terms_days` | `INTEGER NOT NULL DEFAULT 30 CHECK (>= 0)` | Payment terms |
| `internal_notes` | `TEXT` | Internal practice notes |
| `settings` | `JSONB NOT NULL DEFAULT '{}'` | Extensibility blob |
| `created_by` | `INTEGER` | Soft ref to users |
| `updated_by` | `INTEGER` | Soft ref to users |

**Indexes added:**
- `idx_practice_clients_company_type` on `(company_id, client_type)`
- `idx_practice_clients_company_onboarding` on `(company_id, onboarding_status)`
- `idx_practice_clients_company_responsible` on `(company_id, responsible_team_member_id) WHERE NOT NULL`
- `idx_practice_clients_company_risk` on `(company_id, risk_rating)`

**Key decisions:**
- `email`/`phone` kept as-is (existing primary email/phone); UI labels them "Primary"
- `fiscal_year_end TEXT` preserved for backward compatibility; `financial_year_end_month INTEGER` added alongside
- Team member refs are soft INTEGER refs (no FK) — consistent with `practice_team_members.user_id` pattern
- `address TEXT` (legacy free-text) preserved for backward compat; structured address columns added alongside

#### B. `practice_client_contacts` table (CREATE TABLE IF NOT EXISTS)

```sql
practice_client_contacts (
    id, company_id, client_id FK → practice_clients(id) ON DELETE CASCADE,
    contact_name TEXT NOT NULL, role, email, phone, mobile,
    is_primary, receives_tax_correspondence, receives_billing, receives_payroll, receives_cipc,
    notes, is_active, created_at, updated_at, created_by, updated_by
)
```

Indexes: `idx_practice_client_contacts_client`, `idx_practice_client_contacts_company_client`

---

## 5. Backend Routes Changed

### Replaced basic client routes with full CRM routes

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/practice/clients` | Enhanced: added filters for `client_type`, `onboarding_status`, `risk_rating`, `responsible_team_member_id`, `vat_registered`, `paye_registered`, `provisional_taxpayer`; search extended to VAT/reg number |
| `GET` | `/api/practice/clients/:id` | Unchanged |
| `POST` | `/api/practice/clients` | Now uses `sanitizeClientBody()` with full CRM allowlist; validates `client_type`, `onboarding_status`, `risk_rating`; sets `created_by`; audit logged |
| `PUT` | `/api/practice/clients/:id` | Now uses `sanitizeClientBody()`; verifies ownership first; validates enums; sets `updated_by`; audit logged |
| `DELETE` | `/api/practice/clients/:id` | **NEW** — soft archive: `is_active=false, onboarding_status='archived'`; audit `ARCHIVE` |

**New: Contact CRUD routes**
| Method | Route | Description |
|---|---|---|
| `GET` | `/api/practice/clients/:id/contacts` | List active contacts (ordered: primary first) |
| `POST` | `/api/practice/clients/:id/contacts` | Create contact (validates client ownership) |
| `PUT` | `/api/practice/clients/:clientId/contacts/:contactId` | Update contact |
| `DELETE` | `/api/practice/clients/:clientId/contacts/:contactId` | Soft deactivate |

**New helpers:**
- `sanitizeClientBody()` — full allowlist with 45+ fields, blocks `id`/`company_id`/`created_at`
- `sanitizeContactBody()` — allowlist for contact fields
- `CLIENT_TYPES`, `CLIENT_ONBOARDING_STATUSES`, `CLIENT_RISK_RATINGS` enum arrays

---

## 6. Frontend Pages

### `clients.html` — Enhanced list page

- Table columns: Client (name + type badge), Contact (email + phone), Responsible (team member name), Compliance (VAT/PAYE/PT badges), FY End, Status, Actions
- New filter: **Client Type** (dropdown, client-side)
- Existing filter: Status (active/inactive/all)
- Quick-add modal now includes: `client_type`, `financial_year_end_month`, `responsible_team_member_id`, plus all original fields
- Edit modal now shows "Open Full Profile →" link to `client-detail.html?id=X`
- Team members loaded on init for responsible member picker
- IIFE pattern (converted from inline script with top-level vars)

### `client-detail.html` + `js/client-detail.js` — Full CRM profile page

**Entry:** `/practice/client-detail.html?id={clientId}`

**11 sections:**
1. Identity (name, entity type, industry, FY end)
2. Registration Numbers (reg, VAT, income tax, PAYE ref, UIF ref, SDL ref)
3. Individual Taxpayer (shown only when `client_type=individual`: ID number, passport, DOB)
4. Contact Details (primary email/phone, secondary phone, website)
5. Physical Address (structured: line1/2, city, province, postal code, country)
6. Postal Address (hidden when "same as physical" is checked)
7. Practice Ownership (responsible, reviewer, partner — team member pickers)
8. Compliance & Registration (7 checkboxes: VAT, PAYE, PT, UIF, SDL, COIDA, CIPC)
9. Workflow Status (onboarding_status, risk_rating, is_active)
10. Billing Defaults (rate override, currency, payment terms)
11. Notes (client notes + internal notes as separate fields)

**Contact Persons section (outside form — separate save flow):**
- Table with name, contact, correspondence badges, Edit
- Add/edit/deactivate contact modal

**JavaScript features:**
- `toggleIndividualFields()` — shows/hides section 3 based on `client_type`
- `togglePostalAddress()` — shows/hides postal section based on checkbox
- `archiveClient()` — calls `DELETE /api/practice/clients/:id`, then redirects to list
- Contact CRUD via separate API calls, list reloads after each change
- `_openContactModal(id)` fetches contacts fresh from API to get latest data before editing

---

## 7. Multi-Tenant Safety Review

- All client routes filter by `req.companyId` ✅
- `PUT/DELETE` verify ownership with separate SELECT before update ✅
- Contact routes verify client ownership (`client_id + company_id`) before acting ✅
- `company_id` never accepted from request body ✅
- `created_by`/`updated_by` set from `req.userId` (server-side) ✅
- `sanitizeClientBody()` blocks `id`, `company_id`, `created_at` ✅

---

## 8. localStorage / Browser Storage Review

- `clients.html` (rewritten): zero localStorage writes ✅
- `client-detail.html` + `client-detail.js`: zero localStorage writes ✅
- Auth guard reads `localStorage.getItem('token')` — permitted (auth token, not business data) ✅

---

## 9. Backward Compatibility

- `email`/`phone` columns preserved (existing data intact) ✅
- `fiscal_year_end TEXT` preserved (existing data intact) ✅
- `address TEXT` preserved (existing data intact) ✅
- `GET /clients` still accepts `is_active` filter (existing client code still works) ✅
- Existing client row in tasks.html still loads client name from `practice_clients:client_id(name)` — unchanged ✅
- Existing `saveClient()` in quick-add modal still works — same POST body fields still accepted ✅

---

## 10. Validation Rules

| Rule | Enforcement |
|---|---|
| `name` required | Backend 400 + HTML `required` |
| `client_type` must be valid enum | Backend 400 against `CLIENT_TYPES` |
| `onboarding_status` must be valid | Backend 400 against `CLIENT_ONBOARDING_STATUSES` |
| `risk_rating` must be valid | Backend 400 against `CLIENT_RISK_RATINGS` |
| `billing_rate_override >= 0` | DB CHECK constraint |
| `payment_terms_days >= 0` | DB CHECK constraint |
| `financial_year_end_month BETWEEN 1 AND 12` | DB CHECK constraint |
| `address_province` must be valid SA province | DB CHECK constraint |
| `contact_name` required | Backend 400 + HTML `required` |
| Contact client ownership verified | Backend: client SELECT before insert/update |

---

## 11. Audit Logging

| Event | Action | Entity |
|---|---|---|
| Client created | `CREATE` | `practice_client` |
| Client updated | `UPDATE` | `practice_client` |
| Client archived | `ARCHIVE` | `practice_client` |
| Contact created | `CREATE` | `practice_client_contact` |
| Contact updated | `UPDATE` | `practice_client_contact` |
| Contact deactivated | `DEACTIVATE` | `practice_client_contact` |

---

## 12. Manual Verification Checklist

1. Run `056_practice_client_crm_expansion.sql` in Supabase SQL Editor
2. Open Clients page — confirm existing clients show with new columns (type badge, compliance, responsible)
3. Add new client via quick-add modal — confirm `client_type` and responsible member fields work
4. Open existing client → "View" → confirm client-detail.html loads with all fields
5. Save a client from detail page → confirm all sections save and reload correctly
6. Add an Individual client → confirm "Individual Taxpayer" section appears
7. Uncheck "postal same as physical" → confirm postal address section appears
8. Assign responsible/reviewer/partner team members → confirm saves
9. Check compliance flags → save → reload → confirm flags persisted
10. Add contact person → confirm appears in contacts table
11. Edit contact → modify → save → confirm updated
12. Remove contact → confirm disappears from list
13. Archive client from detail page → confirm redirect to list, client marked inactive
14. Confirm no client/contact data in DevTools → Application → Local Storage
15. Open `/practice/client-detail.html` without auth → confirm redirect to `/`
16. Open `/practice/client-detail.html` without `?id=` → confirm redirect to `/practice/clients.html`
17. Confirm Tasks, Time, Deadlines pages still load and function correctly

---

## 13. Remaining Risks

| # | Risk | Severity | Recommended Action |
|---|---|---|---|
| RF01 | `address TEXT` (legacy) and structured address columns can diverge — no sync logic | LOW | Codebox 06: when structured address is saved, optionally back-fill legacy `address` field for backward compat |
| RF02 | `fiscal_year_end TEXT` (legacy) and `financial_year_end_month INTEGER` can diverge | LOW | Codebox 06: UI migration prompt to convert legacy text to integer |
| RF03 | `is_primary` contact flag not enforced as unique at DB level — multiple primaries possible | LOW | Acceptable; enforced in UI only. Future: add partial unique index if needed |
| RF04 | Individual taxpayer fields (ID number, passport, DOB) not validated for format | MEDIUM | Future: SA ID number Luhn-check, date range validation |
| RF05 | Contact modal fetches full contact list on open (to find contact by ID) — inefficient for large contact lists | LOW | Acceptable for current practice scale; future: `GET /contacts/:contactId` endpoint |

---

## 14. Recommended Codebox 06

**Goal:** Tasks + Deadlines Client Linking / Practice Workflow

**Scope:**
1. Add client context tabs to `client-detail.html` — Tasks / Time / Deadlines embedded per client
2. Auto-suggest provisional tax deadlines from `financial_year_end_month`
3. Time tracking entries linked to client + team member
4. Client-filtered reports (time spent, task status per client)
5. Deadline bulk-create from compliance flags (if VAT registered → VAT201 deadlines)
