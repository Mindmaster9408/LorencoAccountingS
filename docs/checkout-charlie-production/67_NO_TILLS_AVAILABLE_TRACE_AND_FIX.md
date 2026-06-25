# Codebox 67 — "No Tills Available" Trace and Fix
## Checkout Charlie

**Status:** Root-caused and fixed  
**Date:** 2026-06-25  
**Reported symptom:** POS shows "No tills available" after login while logged into a valid client/company

---

## Trace

### 1. Where does "No tills available" trigger?

`manageSession()` in `frontend-pos/index.html` — called when user clicks "Manage Till" with no open session.

```javascript
// Line 4576 — inside manageSession() else branch (no open session)
const tillsResponse = await fetch(`${API_URL}/pos/tills`, {
    headers: { 'Authorization': `Bearer ${token}` }
});
const tillsResult = await tillsResponse.json();

if (tillsResult.tills.length === 0) {
    showNotification('No tills available', 'error');  // ← the error
    return;
}
```

### 2. Which endpoint is called?

`GET /api/pos/tills` → backend: `backend/modules/pos/routes/tills.js`

```javascript
router.get('/', async (req, res) => {
    const { data, error } = await supabase
        .from('tills')
        .select('*')
        .eq('company_id', req.companyId)   // scoped to JWT company
        .eq('is_active', true)             // only active tills
        .order('till_number');
    res.json({ tills: data || [] });
});
```

### 3. Is the company context correct?

Yes. `req.companyId` comes from the JWT (set at select-company / pin-login). The frontend uses the server-signed JWT — not a localStorage company_id. Company context is correct.

### 4. Does this company have till rows in the DB?

**No.** The `tills` table is empty for this company. This is the true root cause.

### 5. Why are there no till rows?

Because **the Settings → Tills UI does not exist**. It was referenced in the code but never implemented:

| Problem | Detail |
|---------|--------|
| No "Tills" sidebar item in Settings | Could not navigate to it |
| No `id="tillsSection"` HTML element | `document.getElementById('tillsSection')` → `null` |
| `loadSettingsTills()` never defined | `showSettings('tills')` would silently fail |
| No "Create Till" UI | No way to create a till without direct DB/API access |

The only way a till can exist is if someone manually created one via:
- Direct Supabase dashboard SQL
- Direct `POST /api/pos/tills` API call

### 6. Is the `tills` table itself missing?

The `tills` table is defined in `database/schema.sql` (one-time manual apply). It was NOT in `pos-schema.js` (the auto-migration that runs on every server startup). On fresh deployments, the table may not exist at all.

### 7. Does `checkSession()` show this error?

No. `checkSession()` at login shows "Please open a till session" if no session is open — it does NOT check for tills. The "No tills available" only appears when the user actually clicks "Manage Till" to open a session.

### 8. What happens if tills exist but are inactive?

The GET endpoint has `eq('is_active', true)` — inactive tills are excluded. The user would also see "No tills available" (before fix: same generic message). After fix: the message now guides to Settings → Tills.

---

## Root Cause Summary

> **The company has no rows in the `tills` table because the Settings → Tills UI was never implemented.** The message "No tills available" is accurate — there are no tills — but provides no guidance on how to fix it.

---

## Fixes Applied

### Fix 1 — `pos-schema.js` — Auto-migrate `tills` table

Added `CREATE TABLE IF NOT EXISTS tills (...)` + all `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for the emergency columns (from migration 038). Also added `till_sessions` and `pos_emergency_state` for complete fresh-deployment safety.

**Effect:** Server startup now auto-creates these tables if they don't exist. Idempotent — no impact on existing deployments.

### Fix 2 — `tills.js` GET — `include_inactive` query param

```javascript
// Before: always filtered to is_active = true
// After:
if (!req.query.include_inactive) {
    query = query.eq('is_active', true);
}
```

`GET /api/pos/tills` continues to return only active tills by default (no behavioral change for `manageSession()`). `GET /api/pos/tills?include_inactive=true` returns all tills for the settings view.

### Fix 3 — `tills.js` PATCH — Allow editing name/number/location

Previously only accepted `is_active`. Now accepts `till_name`, `till_number`, `location` as well.

### Fix 4 — `manageSession()` — Better error message

```javascript
// Before
showNotification('No tills available', 'error');

// After
showNotification('No active till configured. Go to Settings → Tills to create one.', 'error');
```

### Fix 5 — Settings sidebar — "Tills" menu item added

```html
<div class="settings-menu-item manager-only" onclick="showSettings('tills', event)">Tills</div>
```

Only visible to managers+ (`.manager-only` class). `showSettings('tills')` now resolves to the real `tillsSection` element.

### Fix 6 — `tillsSection` HTML added

New section inside `.settings-content`, after `generalSection`. Contains:
- A header row with "Tills" heading and "+ Add Till" button
- An inline create form (`createTillForm`) — hidden by default
  - Till Name (required)
  - Till Number (required)
  - Location (optional)
  - Cancel / Create Till buttons
- A table showing all tills (active + inactive) with status badge and Activate/Deactivate toggle

### Fix 7 — `loadSettingsTills()`, `renderTillsTable()`, `saveTill()`, `toggleTillActive()` — New functions

| Function | Purpose |
|----------|---------|
| `loadSettingsTills()` | Fetches all tills (`?include_inactive=true`), renders table |
| `renderTillsTable(tills)` | Renders the tills tbody with status badge + action button |
| `showCreateTillForm()` | Shows the inline create form |
| `hideCreateTillForm()` | Hides and clears the create form |
| `saveTill()` | POST to `/api/pos/tills` with name/number/location |
| `toggleTillActive(id, active)` | PATCH to `/api/pos/tills/:id` with `{ is_active: !active }` |

---

## Verification Checklist

| # | Test | Expected |
|---|------|----------|
| 1 | Company with no till → Manage Till | "No active till configured. Go to Settings → Tills to create one." |
| 2 | Settings → Tills sidebar item visible (manager+) | Navigates to tillsSection |
| 3 | Settings → Tills section loads | Table shows "No tills yet. Click + Add Till..." |
| 4 | Click "+ Add Till" | Inline form appears |
| 5 | Fill name + number + Save | Till created, table refreshes with Active status |
| 6 | Manage Till after creating till | Opening balance prompt → session opens → "Till Open" status |
| 7 | Deactivate a till | Status changes to Inactive; reactivate works |
| 8 | Company with inactive till → Manage Till | "No active till configured. Go to Settings → Tills to create one." |
| 9 | Company with active till → Manage Till → enter balance | Session opens normally |
| 10 | Settings → Tills does NOT show for cashier roles | `.manager-only` class hides it |

---

## Files Changed

| File | Change |
|------|--------|
| `backend/config/pos-schema.js` | Added `tills`, `till_sessions`, `pos_emergency_state` auto-migration |
| `backend/modules/pos/routes/tills.js` | GET: added `include_inactive` param; PATCH: allowed name/number/location updates |
| `frontend-pos/index.html` | Settings sidebar "Tills" item; `tillsSection` HTML; 6 new JS functions; improved error message |

---

## Remaining Setup Gap

**No "Quick Setup" onboarding flow.** A brand-new company has no till, no products, and no way to know what to configure first. A future improvement: show a "Getting Started" checklist after first login (e.g., "1. Create a till  2. Add products  3. Open a session").

This is tracked as a follow-up — not in scope for this fix.
