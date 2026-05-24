# Forensic Audit Trail Explorer — Implementation Report

**Module:** Lorenco Accounting — Administration  
**Date:** 2026-05-24  
**Status:** Phase 1 complete  
**Related roadmap:** `docs/future-build/FORENSIC_AUDIT_AND_SEAN_GOVERNANCE_ROADMAP.md`

---

## 1. Summary

Phase 1 delivers a read-only forensic audit trail explorer that aggregates events from multiple audit sources, normalizes them into a single shape, and presents them through a structured UI with severity coloring, module filtering, and expandable detail drawers.

**What it is not:**
- Not a replacement for the existing `audit-log.html` (that remains at Administration → Audit Log (Legacy))
- Not a write surface — no mutations of any kind
- Not a live-streaming system — events are fetched on demand with filters

**What changed:**
- New `auditEventNormalizer.js` service (pure functions)
- New `GET /api/accounting/audit/events` endpoint added to existing `audit.js` route
- New `audit-trail.html` frontend
- Navigation updated (Audit Trail added above legacy Audit Log)
- Future roadmap created (`FORENSIC_AUDIT_AND_SEAN_GOVERNANCE_ROADMAP.md`)

**What was not changed:**
- `accounting_audit_log` table — untouched
- `historical_comparative_audit_log` table — untouched
- All existing AuditLogger write paths — untouched
- Existing `GET /api/accounting/audit` (legacy) endpoint — untouched
- `audit-log.html` — untouched (renamed to "Audit Log (Legacy)" in nav only)
- No posting, allocation, bank, VAT, AR/AP, or journal logic touched

---

## 2. Files Changed

### New files

| File | Purpose |
|------|---------|
| `backend/modules/accounting/services/auditEventNormalizer.js` | Pure normalizer — converts rows from each audit source to the standard event shape |
| `frontend-accounting/audit-trail.html` | Forensic audit explorer UI |
| `docs/future-build/FORENSIC_AUDIT_AND_SEAN_GOVERNANCE_ROADMAP.md` | Phase 2–10 future roadmap |
| `docs/accounting/AUDIT_TRAIL_EXPLORER_IMPLEMENTATION_REPORT.md` | This file |

### Modified files

| File | Change |
|------|--------|
| `backend/modules/accounting/routes/audit.js` | Fixed stale `db` import; added `supabase` + normalizer imports; added `GET /events` route |
| `frontend-accounting/js/navigation.js` | Added "Audit Trail" link under Administration → Monitoring; renamed old link to "Audit Log (Legacy)" |

---

## 3. Event Normalization

### Standard event shape

```json
{
  "id":          "string (from source table PK)",
  "timestamp":   "ISO 8601 string",
  "companyId":   1,
  "module":      "bank | journals | vat | ar | ap | accounts | historical | opening_balances | system | ai",
  "eventType":   "BANK_RULE_ACCEPTED",
  "severity":    "info | warning | high | critical",
  "userId":      "string or null",
  "userName":    "null (Phase 1 — no user name join)",
  "actorType":   "USER | SYSTEM | AI",
  "entityType":  "BANK_ALLOCATION_RULE",
  "entityId":    "123",
  "description": "Bank allocation rule 5 suggestion accepted",
  "metadata":    { "bankTransactionId": 88, "appliedRuleId": 5 },
  "beforeData":  null,
  "afterData":   null,
  "ipAddress":   "...",
  "source":      "accounting_audit_log | historical_comparative_audit_log"
}
```

### Audit sources (Phase 1)

| Source table | Normalizer function | Timestamp column |
|---|---|---|
| `accounting_audit_log` | `normalizeAccountingLog(row)` | `created_at` |
| `historical_comparative_audit_log` | `normalizeHistoricalLog(row)` | `performed_at` |

**Phase 2** will add: `pos_audit_events` (`normalizePoLog`), Sean decision log (`normalizeSeanLog`).

### Severity mapping

| Severity | Example event types |
|----------|-------------------|
| `critical` | `CROSS_COMPANY_ATTEMPT`, `FAILED_REVERSAL`, `INTEGRITY_FAILURE`, `FINALIZED_EDIT_BLOCKED` |
| `high` | `JOURNAL_REVERSED`, `REVERSE`, `LOCKED_PERIOD_ATTEMPT`, `YEAR_END_CLOSE`, `BATCH_FINALIZED`, `DEACTIVATE` |
| `warning` | `BANK_RULE_OVERRIDDEN`, `RULE_OVERRIDDEN`, `VAT_WARNING`, `VAT_PERIOD_LOCKED`, `DELETE`, `BATCH_ARCHIVED` |
| `info` | Everything else (CREATE, UPDATE, BANK_RULE_ACCEPTED, etc.) |

Resolution order: exact match in `SEVERITY_EXACT` → keyword scan → default `'info'`.

### Module inference

Module is inferred from `entity_type` (more specific) then `action_type` prefix. Entity-type prefix rules take priority:

| Entity type prefix | Module |
|---|---|
| `BANK_*` | `bank` |
| `JOURNAL*` | `journals` |
| `VAT*` | `vat` |
| `CUSTOMER*` | `ar` |
| `SUPPLIER*` | `ap` |
| `ACCOUNT` (exact) | `accounts` |
| `HISTORICAL*` | `historical` |
| `OPENING_BALANCE*` | `opening_balances` |
| `AI*`, `SEAN*` | `ai` |
| Fallback | `system` |

---

## 4. API Endpoint

### `GET /api/accounting/audit/events`

| Parameter | Type | Applied at | Description |
|-----------|------|-----------|-------------|
| `fromDate` | date string | DB | Filter events on or after this date |
| `toDate` | date string | DB | Filter events on or before this date (23:59:59 appended) |
| `eventType` | string | DB | Exact match on `action_type` / `action` |
| `userId` | string | DB | Match on `actor_id` (accounting log only) |
| `search` | string | DB + post | ILIKE `%search%` on `reason` field (DB); also description/eventType/entity (post) |
| `module` | string | Post-normalization | Match on inferred module |
| `severity` | string | Post-normalization | Match on resolved severity |
| `limit` | integer | Post | Max events to return (default 100, max 500) |
| `offset` | integer | Post | Pagination offset |

**Response:**
```json
{ "events": [...], "total": 42 }
```

`total` is the count of events after all filters, up to the fetch cap. It is approximate when `module` or `severity` filters reduce the set significantly — documented limitation of Phase 1.

**Permission required:** `audit.view` (admin + accountant)

### Query strategy

Two queries fire in parallel (`Promise.all`):
1. `accounting_audit_log` with DB-level date/eventType/userId/search filters
2. `historical_comparative_audit_log` with DB-level date/eventType filters

Each query fetches up to `offset + limit + 200` rows. Results are normalized, merged, sorted descending by timestamp, then post-filtered by module/severity/search, then paginated.

If `historical_comparative_audit_log` does not exist (migration 042 not applied), the query error is swallowed and treated as an empty result — the endpoint still returns accounting events.

---

## 5. Multi-Tenant Safety

- `company_id` is always `req.user.companyId` — never accepted from query params
- Both DB queries include `.eq('company_id', companyId)` as the first filter
- The endpoint uses `hasPermission('audit.view')` — only admin and accountant roles can access
- No cross-company event leakage is possible: each source table is filtered by company_id at the query level

---

## 6. Performance Approach

- Default limit: 100 events
- Maximum limit enforced at server: 500
- Fetch cap per source: `offset + limit + 200` (prevents unbounded queries)
- Both source queries run in parallel (not sequential)
- Date filters significantly reduce result size for the common case (last 7 days = default)
- No full-table scans: `accounting_audit_log` has `idx_accounting_audit` on `company_id`; `historical_comparative_audit_log` has `idx_hcal_company_id` and `idx_hcal_performed_at`

**Phase 1 known limitation:** For queries with module or severity filters, the server fetches up to `offset + limit + 200` rows per source before filtering. This is acceptable for Phase 1 where result sets are small. Phase 2 will introduce a materialized view or pre-computed severity/module columns for DB-level filtering.

---

## 7. Frontend — `audit-trail.html`

### Filters
- From date / To date — default last 7 days, auto-loads on open
- Module dropdown (10 options: bank, journals, vat, ar, ap, accounts, historical, opening_balances, system, ai)
- Severity dropdown (info, warning, high, critical)
- Event Type free text (exact match passed to backend)
- User ID free text
- Search free text (Enter key triggers search)

### Table columns
`Timestamp | Severity | Module | Event Type | Entity | Actor | Description | Details`

### Severity coloring
- Row left-border: critical = red, high = orange, warning = amber
- Severity badge: info = blue, warning = amber, high = orange, critical = red
- Module badge: colour-coded per module (10 distinct colours)

### Detail drawer
- Opens on "Details" click; collapses previous drawer automatically
- Sections (only shown when present): Description, Metadata, Before, After, IP, Source table
- JSON rendered via `JSON.stringify(obj, null, 2)` — all content HTML-escaped before injection
- No `innerHTML` injection from raw API data — `esc()` applied to all values

### Safe metadata rendering
```javascript
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```
JSON objects are rendered via `esc(JSON.stringify(obj, null, 2))` — never `dangerouslySetInnerHTML` equivalent.

### No localStorage business data
- Auth token read from `localStorage` (permitted — RULE D2 exemption for auth tokens)
- No business data written to `localStorage`, `sessionStorage`, or KV bridge

---

## 8. Future Sean Compatibility

The normalizer and endpoint are already structured for Sean AI events:

- `actorType: 'AI'` is a valid value — rendered as "Sean AI" in the actor cell
- `module: 'ai'` has a dedicated badge colour (violet)
- `source` field distinguishes where the event came from — a future `normalizeSeanLog()` function adds `source: 'sean_decision_log'`
- Severity levels `high` (confidence drop) and `warning` (recommendation overridden) are already mapped

When Sean Phase 2 is activated, the only change needed is:
1. Add `normalizeSeanLog()` in `auditEventNormalizer.js`
2. Add a third parallel query to `GET /events` for the Sean decision log table
3. No frontend changes required — the event shape is identical

---

## 9. Tests

| # | Test | How to verify |
|---|------|--------------|
| 1 | Endpoint returns company-scoped events only | Log an event for Company A; query as Company B; confirm not returned |
| 2 | Date filters work | Set `fromDate`/`toDate` to a range with known events; confirm only in-range events returned |
| 3 | Module filter works | Set `module=bank`; confirm only bank events returned |
| 4 | Severity filter works | Set `severity=critical`; confirm only critical events returned |
| 5 | EventType filter works | Set `eventType=BANK_RULE_ACCEPTED`; confirm only matching events |
| 6 | Search filter works | Set `search=eskom`; confirm only events with "eskom" in description |
| 7 | Pagination works | Set `limit=10`, confirm 10 events; `offset=10`, confirm next 10 |
| 8 | Historical log included | Apply migration 042; create a historical comparative batch; confirm event appears in trail |
| 9 | Missing historical table handled | If migration 042 not applied, endpoint still returns accounting events (no 500 error) |
| 10 | Metadata renders safely | Detail drawer shows `<script>` tags as literal text, not executed |
| 11 | No localStorage business data | DevTools → Application → Storage = only auth token, no audit event data |
| 12 | No cross-company leakage | Switch company; confirm previous company's events not visible |
| 13 | Existing GET /audit untouched | Legacy audit-log.html still works with `/api/accounting/audit` |
| 14 | No mutation possible | No POST/PUT/DELETE routes added; all endpoints are GET only |

---

## 10. Remaining Risks

| Risk | Severity | Mitigation |
|------|---------|-----------|
| `total` count is approximate when module/severity post-filters reduce result set | Low | Documented; acceptable for Phase 1; Phase 2 will use DB-level module/severity columns |
| User names not shown (actor_id only) | Low | Phase 2 will join `users` table via Supabase foreign key select |
| `historical_comparative_audit_log` UUID IDs vs integer IDs in accounting_audit_log | Low | Both normalized to string `id` field — no collision risk |
| Large audit history (>10,000 events) may cause slow merged sort | Low | Fetch cap of `offset + limit + 200` per source bounds memory use |
| `pos_audit_events` not yet included | Low | Phase 2 addition — POS events are a separate concern not needed for accounting pilot |
