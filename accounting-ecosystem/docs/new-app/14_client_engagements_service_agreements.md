# CODEBOX 14 — CLIENT ENGAGEMENTS + SERVICE AGREEMENTS FOUNDATION

**App:** Lorenco Practice Management  
**Codebox:** 14 of ±80  
**Date:** June 2026  
**Status:** Code complete — apply migration 065 in Supabase before using

---

## 1. Summary

Codebox 14 adds the formal service register layer to the practice: what the practice offers (Service Catalog) and what each client has signed up for (Client Engagements). This is the backbone of recurring billing and capacity planning in future codeboxes.

**What was built:**

- Migration 065: 3 new tables + 12 indexes (`practice_service_catalog`, `practice_client_engagements`, `practice_client_engagement_events`)
- Backend `engagements.js` router with 14 endpoints (5 catalog + 9 engagement)
- Mounted in `index.js` at root level alongside existing `/workflows` and `/billing` routers
- New `services.html` page + `js/services.js` — service catalog management
- `Services` nav item added to `layout.js` between Clients and Workflows
- `client-detail.html` — new Engagements section (#13) + 2 modals (create/edit, history)
- `js/client-detail.js` — 12 new functions for engagement CRUD + status actions + history
- `practice.css` — engagement card styles, status badge variants, category dot colours, history event styles

**What was NOT built:**

- No auto-workflow creation (auto_create_workflow stored, not executed)
- No auto-deadline creation (auto_create_deadline stored, not executed)
- No invoicing or billing integration
- No Sean AI
- No workflow_template_id execution

---

## 2. Database Changes (migration 065)

### `practice_service_catalog`

Master list of services the practice offers. One catalog entry per service type. Used as a template when creating client engagements.

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER IDENTITY | Primary key |
| `company_id` | INTEGER NOT NULL | Multi-tenant isolation |
| `service_code` | TEXT | Short code (e.g. VAT201, AFS) |
| `service_name` | TEXT NOT NULL | Display name |
| `service_category` | TEXT NOT NULL | Allowed values (see below) |
| `description` | TEXT | Description for staff |
| `default_fee_amount` | NUMERIC(12,2) | Default fixed fee or rate |
| `default_fee_frequency` | TEXT | monthly/quarterly/biannual/annual/once_off/per_hour |
| `default_billing_type` | TEXT | fixed/hourly/retainer |
| `default_hourly_rate` | NUMERIC(12,2) | Overrides practice default when set |
| `estimated_hours_per_period` | NUMERIC(8,2) | Capacity planning |
| `default_workflow_template_id` | INTEGER | Reference only — NOT auto-executed |
| `auto_create_workflow` | BOOLEAN | Stored but NOT executed |
| `auto_create_deadline` | BOOLEAN | Stored but NOT executed |
| `is_active` | BOOLEAN | Soft-delete flag |
| `display_order` | INTEGER | Ordering in catalog list |
| `notes` | TEXT | Internal notes |
| `settings` | JSONB | Future extensibility |
| `created_at` / `updated_at` | TIMESTAMPTZ | Timestamps |

Indexes: `idx_service_catalog_company`, `idx_service_catalog_category`, `idx_service_catalog_active`

### `practice_client_engagements`

One row per formal service relationship between the practice and a client.

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER IDENTITY | Primary key |
| `company_id` | INTEGER NOT NULL | Multi-tenant isolation |
| `client_id` | INTEGER NOT NULL | FK to practice_clients |
| `service_catalog_id` | INTEGER | Optional FK to catalog (nullable — allows custom engagements) |
| `engagement_name` | TEXT NOT NULL | Display name |
| `service_category` | TEXT NOT NULL | Category |
| `status` | TEXT NOT NULL DEFAULT 'active' | active/paused/ended/cancelled |
| `start_date` / `end_date` | DATE | Engagement period |
| `responsible_team_member_id` | INTEGER | FK to practice_team_members |
| `reviewer_team_member_id` | INTEGER | — |
| `partner_team_member_id` | INTEGER | — |
| `fee_amount` | NUMERIC(12,2) | Agreed fee |
| `fee_frequency` | TEXT | monthly/quarterly/biannual/annual/once_off/per_hour |
| `billing_type` | TEXT | fixed/hourly/retainer |
| `hourly_rate` | NUMERIC(12,2) | Used when billing_type = hourly |
| `estimated_hours_per_period` | NUMERIC(8,2) | Capacity planning |
| `currency` | TEXT DEFAULT 'ZAR' | — |
| `workflow_template_id` | INTEGER | Reference only — NOT auto-executed |
| `auto_create_workflow` | BOOLEAN | Stored but NOT executed |
| `auto_create_deadline` | BOOLEAN | Stored but NOT executed |
| `notes` / `internal_notes` | TEXT | Staff notes |
| `ended_at` / `ended_by` | TIMESTAMPTZ / INTEGER | Set on `ended` status |
| `cancelled_at` / `cancelled_by` | TIMESTAMPTZ / INTEGER | Set on `cancelled` status |

Indexes: `idx_engagements_company`, `idx_engagements_client`, `idx_engagements_status`, `idx_engagements_catalog`, `idx_engagements_responsible`

### `practice_client_engagement_events`

Audit trail for every engagement lifecycle event. Non-fatal: event log failures never abort engagement operations.

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER IDENTITY | Primary key |
| `company_id` | INTEGER NOT NULL | Multi-tenant isolation |
| `engagement_id` | INTEGER NOT NULL | Which engagement |
| `event_type` | TEXT NOT NULL | Event type (see below) |
| `old_status` / `new_status` | TEXT | Status transition |
| `actor_user_id` | INTEGER | Who triggered the event |
| `notes` | TEXT | Reason or description |
| `metadata` | JSONB | Structured extra data |
| `created_at` | TIMESTAMPTZ NOT NULL | When |

**Allowed event_type values:** `engagement_created`, `engagement_updated`, `engagement_paused`, `engagement_reactivated`, `engagement_ended`, `engagement_cancelled`, `status_changed`

Indexes: `idx_engagement_events_company`, `idx_engagement_events_engagement`, `idx_engagement_events_type`, `idx_engagement_events_created`

---

## 3. Allowed Values

### service_category
`vat`, `paye`, `emp501`, `income_tax`, `annual_financials`, `bookkeeping`, `payroll`, `secretarial`, `consulting`, `cipc`, `other`

### fee_frequency
`monthly`, `quarterly`, `biannual`, `annual`, `once_off`, `per_hour`

### billing_type
`fixed`, `hourly`, `retainer`

### engagement status
`active`, `paused`, `ended`, `cancelled`

---

## 4. Status Transitions

```
active  →  paused      (PUT /engagements/:id/pause)
paused  →  active      (PUT /engagements/:id/reactivate)
active/paused  →  ended     (PUT /engagements/:id/end)
active/paused  →  cancelled  (DELETE /engagements/:id)
ended/cancelled  →  [immutable — no further transitions]
```

Editing via PUT is blocked on cancelled engagements. Editing is permitted on active, paused, and ended engagements (field changes, not status).

---

## 5. Backend API Endpoints (`engagements.js`)

### Service Catalog

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/practice/services` | List catalog items (`?category=`, `?active=`) |
| GET | `/api/practice/services/:id` | Get single item |
| POST | `/api/practice/services` | Create catalog item |
| PUT | `/api/practice/services/:id` | Update catalog item |
| DELETE | `/api/practice/services/:id` | Soft-deactivate (`is_active = false`) |

### Client Engagements

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/practice/clients/:clientId/engagements` | List client's engagements (`?status=`) |
| POST | `/api/practice/clients/:clientId/engagements` | Create engagement |
| GET | `/api/practice/engagements/:id` | Get single engagement |
| PUT | `/api/practice/engagements/:id` | Update fields (not status) |
| PUT | `/api/practice/engagements/:id/pause` | Pause active engagement |
| PUT | `/api/practice/engagements/:id/reactivate` | Reactivate paused engagement |
| PUT | `/api/practice/engagements/:id/end` | End engagement gracefully |
| DELETE | `/api/practice/engagements/:id` | Soft-cancel engagement |
| GET | `/api/practice/engagements/:id/history` | Event history |

### Router Mounting

Mounted in `index.js` via `router.use('/', engagementsRouter)` — handles `/services`, `/clients/:clientId/engagements`, and `/engagements/:id` paths without conflicting with existing client routes.

---

## 6. Frontend: Services Page (`services.html` + `js/services.js`)

### Layout
- Dark-native CSS using shared `practice.css`
- LAYOUT.init('services') — active nav key
- Filters: category dropdown + active/inactive dropdown
- Table: Name, Category, Billing Type, Default Fee, Status, Actions
- Service code shown as small accent badge in Name column

### Service Modal
- All catalog fields exposed
- "Deactivate" button shown in edit mode (visible when `is_active = true`)
- DELETE soft-deactivate — data is preserved

### Pattern
- IIFE (same as all other practice JS files)
- Functions globally exposed via `window.*`
- No localStorage for business data — all via `PracticeAPI.fetch()`

---

## 7. Frontend: Client Engagements (enhancements to `client-detail.html` / `js/client-detail.js`)

### New section (#13)
- Added after Compliance Suggestions section (`#complianceSuggestionsSection`)
- Shows automatically when client loads (hooked into `loadClient()` → `loadEngagements()`)
- `#engagementsSection` — revealed via `classList.remove('hidden')`

### Engagement cards
- One `.engagement-card` per engagement
- Shows: name, status badge (colour-coded), category dot + label, fee string, start/end dates
- Inline action buttons: Pause (active only), Reactivate (paused only), History, Edit

### Engagement modal (create/edit)
- All fields: name, category, billing type, fee, frequency, start/end dates, responsible/reviewer/partner, currency, description, notes
- Team picker loaded lazily on first open (`_engTeamLoaded` flag — avoids duplicate team fetch)
- POST for create, PUT for edit

### History modal
- Fetches `/api/practice/engagements/:id/history`
- Title updated to engagement name
- Events rendered as `.eng-event` blocks

### New functions exposed via `window.*`
`openEngagementModal`, `closeEngagementModal`, `saveEngagement`, `engagementAction`, `openEngHistoryModal`, `closeEngHistoryModal`, `_openEngagementModal`

---

## 8. Multi-Tenant Safety Review

| Operation | Verification |
|---|---|
| All catalog queries | `eq('company_id', req.companyId)` on every select/insert/update |
| `fetchEngagement()` | Filters `company_id = req.companyId` — returns null if wrong company → 404 |
| Create engagement | Verifies `practice_clients` ownership before insert |
| List engagements | `eq('company_id', req.companyId)` AND `eq('client_id', clientId)` |
| Event log | Inserts `company_id = companyId` from req — never from body |
| History query | `fetchEngagement()` ownership gate before event query |

No route trusts `company_id`, `client_id`, or `engagement_id` from the request body. All identity comes from the JWT-derived `req.companyId`.

---

## 9. localStorage / KV Audit

**CLEAN — no violations.**

| Location | Usage | Permitted? |
|---|---|---|
| `client-detail.js` init | `localStorage.getItem('token')` — auth read | Yes (Rule D2) |
| `services.js` init | `localStorage.getItem('token')` — auth read | Yes (Rule D2) |
| All engagement data | Via `PracticeAPI.fetch()` — no localStorage | Compliant |
| Service catalog data | Via `PracticeAPI.fetch()` — no localStorage | Compliant |
| Engagement history | Via `PracticeAPI.fetch()` — no localStorage | Compliant |
| Team member picker | Via `PracticeAPI.fetch()` — no localStorage | Compliant |

No engagement names, fees, statuses, catalog entries, or history events ever touch browser storage.

---

## 10. Key Design Decisions

### auto_create_workflow / auto_create_deadline — stored but not executed
These boolean flags are stored in both catalog and engagement tables for future use. The system does NOT execute them — no workflows or deadlines are created automatically. This was an explicit spec requirement.

### Catalog is optional
`service_catalog_id` is nullable on `practice_client_engagements`. An engagement can exist without being linked to the catalog, allowing ad-hoc or custom service agreements.

### Soft-cancel only
Engagements and catalog items are never hard-deleted. This preserves history and ensures billing pack references remain intact.

### Team picker loaded lazily
`_engTeamLoaded` flag in `client-detail.js` prevents a duplicate team API call every time the engagement modal is opened. The first open triggers a team fetch; subsequent opens reuse the already-populated selects.

### Router mounted at `/`
`router.use('/', engagementsRouter)` in `index.js` lets the engagements router handle `/services/*`, `/clients/:clientId/engagements`, and `/engagements/:id` paths. Express route precedence ensures existing `/clients/:id` GET in `index.js` takes priority over `/clients/:id/engagements` in the subrouter (different path depth, no conflict).

---

## 11. Migration Verification SQL

Apply migration 065 in Supabase SQL editor, then run:

```sql
-- 1. Confirm all 3 tables exist (expect 3 rows)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'practice_service_catalog',
    'practice_client_engagements',
    'practice_client_engagement_events'
  )
ORDER BY table_name;

-- 2. Confirm all 12 indexes exist
SELECT indexname FROM pg_indexes
WHERE tablename IN (
  'practice_service_catalog',
  'practice_client_engagements',
  'practice_client_engagement_events'
)
ORDER BY indexname;
```

---

## 12. Testing Steps

1. Apply migration 065 in Supabase SQL editor
2. Run verification SQL above — expect 3 tables and 12 indexes
3. Restart backend server
4. Navigate to Services page (`/practice/services.html`) — should load with empty table
5. Add service: Name="VAT Returns", Category="VAT", Fixed Fee=R500/monthly → save → appears in table
6. Edit service → all fields pre-populate correctly
7. Deactivate service → status shows Inactive; filter to "Active only" hides it
8. Open any client detail → Engagements section appears below Compliance Suggestions
9. Add engagement: Name="VAT Returns — Monthly", Category=VAT, Fee=R1500/monthly → save → card appears
10. Engagement card shows: name, Active badge, VAT category dot, fee
11. Pause engagement → button changes to Reactivate; status badge changes to Paused
12. Reactivate → Active again
13. Edit engagement → all fields pre-populate; team picker populated
14. Click History → modal opens; `engagement_created` event visible
15. After pause: History shows `engagement_paused` with old_status=active, new_status=paused
16. Services nav tab in layout → navigates to Services page; active tab highlighted
17. DevTools → Local Storage → no engagement or catalog data

---

## 13. Remaining Risks

- `actor_user_id` in history shows "User {id}" not name — acceptable for now; future: join to users table
- `logEngagementEvent()` is non-fatal fire-and-forget — failures silently drop events
- No DB FK constraints between `client_id` → `practice_clients` or `service_catalog_id` → `practice_service_catalog` — enforced at API layer only; direct DB edits could create orphans
- `workflow_template_id` stored for reference but not validated against `practice_workflow_templates` — an invalid ID is accepted silently
- Engagement list loaded on every client detail page load — no pagination yet; acceptable for practice management scale
