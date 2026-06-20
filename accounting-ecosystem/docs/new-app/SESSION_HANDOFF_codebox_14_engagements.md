# SESSION HANDOFF — Codebox 14: Client Engagements + Service Agreements Foundation

**Date:** 2026-06-20  
**Status:** Code complete — apply migration 065 in Supabase before using

---

## What Was Changed

### `backend/config/migrations/065_practice_client_engagements.sql` — NEW
- `practice_service_catalog` table (21 columns) + 3 indexes
- `practice_client_engagements` table (28 columns) + 5 indexes
- `practice_client_engagement_events` table (10 columns) + 4 indexes
- Total: 12 indexes

### `backend/modules/practice/engagements.js` — NEW
Complete Express router with 14 endpoints:

**Service Catalog (5):**
- `GET /services` — list with category + active filters
- `GET /services/:id` — single item
- `POST /services` — create
- `PUT /services/:id` — update
- `DELETE /services/:id` — soft-deactivate (`is_active = false`)

**Client Engagements (9):**
- `GET /clients/:clientId/engagements` — list with status filter
- `POST /clients/:clientId/engagements` — create (verifies client ownership)
- `GET /engagements/:id` — single
- `PUT /engagements/:id` — update (status changes blocked here; use dedicated routes)
- `PUT /engagements/:id/pause` — active → paused
- `PUT /engagements/:id/reactivate` — paused → active
- `PUT /engagements/:id/end` — any → ended (with timestamps)
- `DELETE /engagements/:id` — soft-cancel (with timestamps)
- `GET /engagements/:id/history` — event log

**Helpers:**
- `fetchEngagement(companyId, id)` — ownership-verified fetch (returns null → 404)
- `logEngagementEvent(companyId, id, eventType, opts)` — non-fatal event logging
- `sanitizeCatalogBody(body)` / `sanitizeEngagementBody(body)` — allowlist filters

### `backend/modules/practice/index.js` — MODIFIED
- Added `const engagementsRouter = require('./engagements');` after billingRouter require (line 16)
- Added `router.use('/', engagementsRouter);` before `module.exports` (after billingRouter mount)

### `backend/frontend-practice/js/layout.js` — MODIFIED
- Added `{ key: 'services', label: 'Services', href: '/practice/services.html' }` between Clients and Workflows in PAGES array

### `backend/frontend-practice/css/practice.css` — ENHANCED
Added before media query:
- `.engagement-card`, `.engagement-card-body`, `.engagement-card-name`, `.engagement-card-meta`, `.engagement-card-fee`, `.engagement-card-actions`
- `.badge-eng-active/paused/ended/cancelled` — status colour variants
- `.cat-dot` + 11 category colour variants (`.cat-vat`, `.cat-paye`, etc.)
- `.service-active`, `.service-inactive`
- `.eng-event`, `.eng-event-type`, `.eng-event-status`, `.eng-event-meta`

### `backend/frontend-practice/services.html` — NEW
- Service catalog page with category + active/inactive filters
- Table view: Name (with code badge), Category (with dot), Billing Type, Default Fee, Status, Edit
- Create/edit service modal (all catalog fields)
- Deactivate button in edit mode
- LAYOUT.init('services') — active nav key = 'services'

### `backend/frontend-practice/js/services.js` — NEW
IIFE pattern. Functions:
- `loadServices()` — GET with filters → renderServices()
- `renderServices(services)` — table rows with category dots and code badges
- `openServiceModal()` / `_openServiceModal(id)` — pre-populates or clears
- `closeServiceModal()`
- `saveService(e)` — POST or PUT
- `deactivateService()` — DELETE (soft)
- All globally exposed via `window.*`

### `backend/frontend-practice/client-detail.html` — ENHANCED
- Added section #13 `#engagementsSection` after `#complianceSuggestionsSection`
- Engagement create/edit modal (`#engagementModal`) — all fields including team pickers
- Engagement history modal (`#engHistoryModal`)

### `backend/frontend-practice/js/client-detail.js` — ENHANCED

**New variables:**
- `_editingEngagementId` — tracks which engagement is being edited
- `_engTeamLoaded` — lazy-load flag for team pickers in engagement modal
- `ENG_CATEGORY_LABELS`, `ENG_FREQ_LABELS`, `ENG_EVENT_LABELS` — display dictionaries

**New functions (all exposed via `window.*`):**
- `loadEngagements()` — GET client engagements → renderEngagements()
- `renderEngagements(engagements)` — engagement cards with inline action buttons
- `_populateEngTeam()` — lazy-loads team members into engagement modal selects
- `_openEngagementModal(id)` — pre-populate or clear; loads team on first open
- `openEngagementModal()` — opens for create
- `closeEngagementModal()`
- `saveEngagement(e)` — POST (create) or PUT (edit)
- `engagementAction(id, action)` — pause/reactivate/end/cancel with confirm
- `openEngHistoryModal(id)` — fetch + render history
- `renderEngHistory(events)` — `.eng-event` blocks
- `closeEngHistoryModal()`

**Modified `loadClient()`:**
- Added `document.getElementById('engagementsSection').classList.remove('hidden');`
- Added `loadEngagements();` — auto-loads on client page open

---

## What Was NOT Changed
- All Codebox 11-13 billing routes: unchanged
- All client routes (`/clients`, `/clients/:id`, contacts): unchanged
- Compliance suggestions section: unchanged
- Payroll module: not touched
- No auto-workflow or auto-deadline execution was added

---

## Audit Findings

### localStorage — CLEAN
- No engagement or catalog data in any browser storage
- Only auth token reads (permitted by Rule D2)
- `_engTeamLoaded` flag is a JavaScript runtime variable only — never in localStorage

### Multi-tenant safety — VERIFIED
- All catalog routes filter `company_id = req.companyId`
- Create engagement verifies `practice_clients.company_id = req.companyId` before insert
- `fetchEngagement()` filters `company_id` — null result → 404 for wrong company
- Event log always inserts `company_id` from `req.companyId`

### Existing behaviour preserved
- All existing client detail sections (contacts, compliance suggestions): intact
- Existing `loadClient()` logic: preserved; only 2 lines added (show section + loadEngagements call)
- Existing layout PAGES array: new entry only; no existing entries modified
- practice.css: new rules added before media query; no existing rules changed

---

## Migration Verification SQL

After applying 065, run in Supabase SQL editor:

```sql
-- Tables (expect 3 rows)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'practice_service_catalog',
    'practice_client_engagements',
    'practice_client_engagement_events'
  )
ORDER BY table_name;

-- Indexes (expect 12 rows)
SELECT indexname FROM pg_indexes
WHERE tablename IN (
  'practice_service_catalog',
  'practice_client_engagements',
  'practice_client_engagement_events'
)
ORDER BY indexname;
```

---

## Testing Steps

1. Apply migration 065 in Supabase SQL editor
2. Run verification SQL — expect 3 tables, 12 indexes
3. Restart backend server
4. Verify `Services` tab appears in nav between Clients and Workflows
5. Services page loads with empty table and "+ Add Service" button
6. Add a service → appears in table with category dot and code badge
7. Edit service → fields pre-populate; deactivate button visible
8. Open client detail → Engagements section visible below Compliance Suggestions
9. Add engagement → card appears; status = Active (green)
10. Pause → status = Paused (yellow); Pause button → Reactivate button
11. Reactivate → Active again
12. History button → events listed (engagement_created, engagement_paused, engagement_reactivated)
13. End engagement via Edit → engagementAction confirm dialog → status = Ended
14. DevTools Local Storage → no engagement or catalog data

---

## Remaining Risks

- `actor_user_id` in history shows raw ID, not user name — future: join to users table for display
- No DB FK constraints between engagement→client or engagement→catalog — orphan risk via direct DB edits
- `workflow_template_id` not validated against `practice_workflow_templates` — invalid IDs accepted silently
- `logEngagementEvent()` is non-fatal fire-and-forget; event log gaps possible under DB stress
- No pagination on engagement list (client-detail.js) — acceptable at current scale
