# SESSION HANDOFF — Zero-localStorage Audit + Eradication
**Date:** 2026-04-23  
**Scope:** Full codebase audit. Every localStorage call inventoried, risk-rated, and fixed or flagged.

---

## 1. FULL localStorage INVENTORY

### frontend-payroll/js/data-access.js
| Location | Key Pattern | Route | Risk |
|---|---|---|---|
| Safety shim (line 13-15) | any | `window.localStorage` DIRECT if polyfills.js fails | LOW — bridge overrides it immediately |
| `cacheSet()` helper | `cache_*` | native browser localStorage | BY DESIGN — offline read-only fallback, not authoritative |
| `getSession / saveSession` | `session` | LOCAL_KEYS → native browser localStorage | CORRECT — auth token |
| `getToken()` | `token` | LOCAL_KEYS → native browser localStorage | CORRECT — auth token |
| All `DataAccess.save*` API calls | varies | `/api/payroll/*` → Supabase DB | CORRECT |
| All `DataAccess.get*` cache fallbacks | `cache_*` | native browser localStorage (read-only fallback) | ACCEPTABLE — cache only, not authoritative |
| ~~`saveCurrentInputs` catch~~ | ~~`cache_emp_current_*`~~ | ~~native localStorage on API failure~~ | **FIXED** — cacheSet removed |
| ~~`saveOvertime` catch~~ | ~~`cache_emp_overtime_*`~~ | ~~native localStorage on API failure~~ | **FIXED** — cacheSet removed |
| ~~`saveShortTime` catch~~ | ~~`cache_emp_short_time_*`~~ | ~~native localStorage on API failure~~ | **FIXED** — cacheSet removed |
| ~~`saveMultiRate` catch~~ | ~~`cache_emp_multi_rate_*`~~ | ~~native localStorage on API failure~~ | **FIXED** — cacheSet removed |
| ~~`savePayslipStatus` catch~~ | ~~`cache_emp_payslip_status_*`~~ | ~~native localStorage on API failure~~ | **FIXED** — cacheSet removed |
| ~~`saveNotes` catch~~ | ~~`cache_emp_notes_*`~~ | ~~native localStorage on API failure~~ | **FIXED** — cacheSet removed |
| ~~`saveAttendance` catch~~ | ~~`cache_attendance_*`~~ | ~~native localStorage on API failure~~ | **FIXED** — cacheSet removed |
| ~~`saveHistoricalRecord` catch~~ | ~~`cache_emp_historical_*`~~ | ~~native localStorage on API failure~~ | **FIXED** — cacheSet removed |
| ~~`saveNarrative` catch~~ | ~~`cache_narrative_*`~~ | ~~native localStorage on API failure~~ | **FIXED** — cacheSet removed |
| ~~`saveHistoricalImportLog`~~ | ~~`cache_historical_import_log_*`~~ | ~~native localStorage only — NO API write~~ | **FIXED** — made no-op |
| ~~`saveAuditLog`~~ | ~~`cache_audit_log_*`~~ | ~~native localStorage only — NO API write~~ | **FIXED** — made no-op (backend handles audit) |
| ~~`appendAuditLog`~~ | ~~`cache_audit_log_*`~~ | ~~native localStorage only — NO API write~~ | **FIXED** — made no-op |
| ~~`getReportHistory`~~ | ~~`cache_report_history_*`~~ | ~~native localStorage only — dead code~~ | **FIXED** — removed entirely |
| ~~`saveReportHistory`~~ | ~~`cache_report_history_*`~~ | ~~native localStorage only — dead code~~ | **FIXED** — removed entirely |

### frontend-payroll/employee-detail.html
| Key Pattern | Route | Risk |
|---|---|---|
| `emp_overtime_*`, `emp_short_time_*`, `emp_multi_rate_*` | `safeLocalStorage.setItem` → bridge → `/api/payroll/kv` → Supabase | SAFE ✅ |
| `emp_payroll_*`, `emp_historical_*`, `emp_payslip_status_*` | `safeLocalStorage.setItem` → bridge → Supabase KV | SAFE ✅ |
| `token`, `user`, `session` | native localStorage | CORRECT — auth ✅ |

### frontend-payroll/payruns.html, payroll-items.html, reports.html
All use `safeLocalStorage.getItem/setItem` for business data → bridge → `/api/payroll/kv` → Supabase. SAFE ✅

### frontend-accounting/bank.html
| Key Pattern | Route | Risk |
|---|---|---|
| `bank_allocations`, `sean_learning`, `bank_manual_transactions`, `reviewedTransactions` | `safeLocalStorage` → polyfills bridge → `/api/accounting/kv` → Supabase | SAFE ✅ |
| `token`, `user`, `eco_token` | native localStorage | CORRECT — auth ✅ |
| ~~`seanAIEnabled`~~ | ~~raw `localStorage.setItem` bypass~~ | **FIXED** → `safeLocalStorage.setItem` |

### frontend-accounting/ (all other pages)
All use `safeLocalStorage` via polyfills.js bridge → `/api/accounting/kv` → Supabase. SAFE ✅

### frontend-coaching/ — MAJOR OUTSTANDING VIOLATION
| Key Pattern | Route | Risk |
|---|---|---|
| `coaching_app_store_${userEmail}` | raw `localStorage` | 🔴 CRITICAL — ALL coaching client data is browser-only |
| `coaching_app_store` | raw `localStorage` | 🔴 CRITICAL |
| `coaching_app_current_user` | raw `localStorage` (in LOCAL_KEYS — correct) | ✅ CORRECT |
| `coaching_app_admin_mode` | raw `localStorage` (in LOCAL_KEYS — correct) | ✅ CORRECT |

**Impact**: Clearing browser history = all coaching client records permanently lost. Different device = no data. This is a pre-existing architectural decision — the coaching app was built entirely standalone. A full backend migration is required.

---

## 2. ROOT RISK SUMMARY

| # | Risk | Severity | Status |
|---|---|---|---|
| 1 | **Silent write-to-cache on API failure** — 9 save functions silently wrote data to browser localStorage instead of throwing when the API failed. User received false-success. | HIGH | **FIXED** |
| 2 | **Dead cache-only write functions** — `saveReportHistory`, `saveAuditLog`, `appendAuditLog`, `saveHistoricalImportLog` had NO API backing. If called, data was browser-only forever. | HIGH | **FIXED** |
| 3 | **Coaching app 100% browser-local** — ALL business data (client records, coaching plans, assessments) in raw `localStorage`. Zero cloud backing. | CRITICAL | **FLAGGED — Wave 2** |
| 4 | **Raw `localStorage.setItem` in bank.html** — bypassed polyfills bridge (though seanAI* is LOCAL_PFX, so net result was same). | LOW | **FIXED** |
| 5 | **Safety shim fallback** — if polyfills.js fails to load on payroll pages, shim sets `safeLocalStorage = window.localStorage`. Bridge then installs over it, so for payroll pages this is actually safe. | LOW | **NOT CHANGED — no real risk** |

---

## 3. BACKEND GAP ANALYSIS

| Function | GET backing | PUT/POST backing | Status |
|---|---|---|---|
| `getHistoricalImportLog` | `/payroll/employees/historical-log` ✅ | None (was cacheSet only) | **FIXED** — save is now a no-op; needs API endpoint if write-back required |
| `getAuditLog` | `/audit?module=payroll` ✅ | Backend middleware (auto) ✅ | **OK** — frontend save was vestigial |
| `getReportHistory` | None | None | **REMOVED** — dead code entirely |
| `getReportHistory` | None | None | **REMOVED** — dead code entirely |
| Coaching app store | None | None | **Wave 2** — full backend required |

---

## 4. SAFE REPLACEMENT PLAN

### Wave 1 — COMPLETED this session
Changes made to 2 files:

**`accounting-ecosystem/frontend-payroll/js/data-access.js`**
- 9 `DataAccess.save*` functions: removed `cacheSet()` from catch blocks. Errors now propagate to callers. No more silent browser-local fallback.
- `saveHistoricalImportLog`: made no-op with comment. Was write-only-to-cache with no API endpoint.
- `saveAuditLog` / `appendAuditLog`: made no-ops. Backend middleware handles audit server-side.
- `getReportHistory` / `saveReportHistory`: removed entirely. Dead code — cache-only, no API, no callers.

**`accounting-ecosystem/frontend-accounting/bank.html`**
- Line ~1827: `localStorage.setItem('seanAIEnabled', 'true')` → `safeLocalStorage.setItem('seanAIEnabled', 'true')`

### Wave 2 — Coaching App Migration (SEPARATE PROJECT)

**Scope**: `accounting-ecosystem/frontend-coaching/` — full rewrite of data layer.

**Required components:**
1. New Supabase table: `coaching_store` (company_id, user_email, data JSONB, updated_at)
2. New backend routes: `GET/PUT /api/coaching/store` with JWT auth + company scoping
3. Replace all `localStorage.getItem('coaching_app_store_*')` in coaching pages with API calls
4. Migrate existing browser-local data on first login (one-time migration helper)

**Files affected:**
- `frontend-coaching/index.html`
- `frontend-coaching/backup-restore.html`
- `frontend-coaching/backup-manager.html`
- `frontend-coaching/setup-admin.html`
- `frontend-coaching/restore-demo-clients.html`
- `frontend-coaching/recover-clients.html`
- All coaching pages with `coaching_app_store` reads/writes

**DO NOT start Wave 2 without a dedicated session and explicit user authorization.**

---

## 5. FILES CHANGED

| File | Change | Risk |
|---|---|---|
| `accounting-ecosystem/frontend-payroll/js/data-access.js` | Removed 9 silent cacheSet fallbacks; removed 4 dead functions; 2 functions made no-ops | LOW — none of these DataAccess.save* functions are called from any HTML page (employee-detail.html uses safeLocalStorage directly via bridge) |
| `accounting-ecosystem/frontend-accounting/bank.html` | 1 raw localStorage call → safeLocalStorage | ZERO — seanAI* is in LOCAL_PFX, behaviour identical, now consistent |

---

## 6. ARCHITECTURE CONFIRMED CORRECT

The Lorenco payroll + accounting ecosystem is genuinely cloud-backed for all business data:

```
safeLocalStorage.setItem('emp_overtime_*', data)
  → data-access.js bridge intercepts
  → kvSet() → async PUT /api/payroll/kv/:key
  → Supabase payroll_kv_store_eco (company_id + key)
  → Cleared browser = data survives ✅
  → Different device = data accessible ✅
```

Keys correctly staying in native browser localStorage:
- `token`, `user`, `session`, `eco_*`, `sso_source` — auth/session state
- `cache_*` — read-only offline fallback, never authoritative source
- `theme`, `darkMode`, `sidebar*`, `viewMode`, `seanAI*` — UI preferences

---

## 7. TESTING REQUIRED

After deployment:

1. **Payroll save test**: Open employee-detail.html → add overtime → save → clear browser storage → reload → overtime still present (proves Supabase KV backing)
2. **API failure test**: Block `/api/payroll/kv` with browser DevTools → attempt save → should see visible error (not silent success)
3. **Bank.html**: Open bank.html → confirm no console errors about seanAIEnabled

---

## 8. OPEN FOLLOW-UP NOTES

```
FOLLOW-UP NOTE
- Area: Coaching App localStorage Migration
- Dependency: Requires dedicated backend API + Supabase table
- What was done now: Audited, flagged, NOT changed
- What still needs to be checked: All frontend-coaching/*.html pages
- Risk if not checked: ALL coaching client data is browser-local. One browser clear = permanent data loss.
- Recommended next review point: Dedicated session for Wave 2 coaching migration

FOLLOW-UP NOTE
- Area: saveHistoricalImportLog — no API write endpoint
- Dependency: Backend /payroll/employees/historical-log POST endpoint
- What was done now: Frontend write made no-op (was writing only to browser cache)
- What still needs to be checked: Whether historical import log write-back is actually needed
- Risk if not checked: Historical import log is read-only from API; writes are silently dropped
- Recommended next review point: When historical import feature is next touched
```
