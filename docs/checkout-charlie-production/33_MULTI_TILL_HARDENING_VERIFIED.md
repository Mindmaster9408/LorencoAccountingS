# 33 — MULTI-TILL HARDENING VERIFIED
## Checkout Charlie — Workstream 9B Verification

**Date:** 2026-05-22
**Audited by:** Claude — Principal Engineer audit pass
**Status:** ✅ 11/11 checks pass — 1 stale comment found and fixed during verification
**Pilot-safe:** Yes

---

## Verification Results

### CHECK 1 — Same till cannot open two concurrent open sessions
**PASS**

`sessions.js` lines 107–120 — the per-till check is the first guard after input validation:

```javascript
const { data: tillSession } = await supabase
  .from('till_sessions')
  .select('id, user_id')
  .eq('company_id', req.companyId)   // company-scoped
  .eq('till_id', till_id)             // till-scoped
  .eq('status', 'open')               // only active sessions
  .limit(1);

if (tillSession && tillSession.length > 0) {
  return res.status(409).json({
    error: 'This till already has an open session',
    sessionId: tillSession[0].id,
  });
}
```

Any open session for the same `(company_id, till_id)` pair — regardless of which user opened it — blocks a new session with HTTP 409 Conflict. The `sessionId` in the response gives the operator the exact blocking session ID to investigate.

Edge cases confirmed safe:
- `till_id` absent or falsy: line 96 `if (!till_id || ...)` returns 400 before this check runs
- `till_id = 0`: caught by `!till_id` guard (returns 400) — integers start at 1 in Supabase SERIAL

---

### CHECK 2 — Different tills can each have open sessions
**PASS**

The per-till check at line 111 uses `.eq('till_id', till_id)` — scoped to exactly the requesting till. Opening a session on Till 2 while Till 1 has an active session: the query finds no open session for Till 2 → check passes → INSERT proceeds normally.

Two tills on the same company can each have exactly one active session simultaneously. Three tills: three active sessions. Each independently gated.

---

### CHECK 3 — Partial unique index enforces at DB level
**PASS**

`migration 037`:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_till_sessions_till_open_unique
    ON till_sessions (company_id, till_id)
    WHERE status = 'open';
```

Partial index — the constraint only applies to rows where `status = 'open'`. Closed (`'closed'`, `'cashed_up'`) sessions are excluded from the index entirely. Multiple historical sessions per till are unconstrained, as required.

If a second INSERT for the same `(company_id, till_id)` with `status = 'open'` reaches the database, PostgreSQL raises error code `23505 unique_violation` before writing any row. No duplicate open session is possible at the DB level regardless of application behaviour.

---

### CHECK 4 — Concurrent session-open race cannot bypass protection
**PASS — with one known edge case (acceptable)**

Two simultaneous `POST /open` requests for the same `(company_id, till_id)`:

1. Both pass the application check simultaneously (each reads zero open sessions before either commits)
2. Request A's INSERT succeeds → `status = 'open'` row written
3. Request B's INSERT hits `idx_till_sessions_till_open_unique` → `23505 unique_violation` → Supabase returns error → line 149 `if (error) return res.status(500).json({ error: error.message })` → HTTP 500

**Result:** One session created. No duplicate. Request B gets HTTP 500 instead of the friendly 409.

**Why this is acceptable:** The race window is extremely narrow (both requests must query and INSERT within the same millisecond-scale transaction window). In normal retail operation, two people simultaneously trying to open sessions on the same till at the same clock-millisecond is not a realistic scenario. The application check eliminates the case in all non-racing conditions. The DB constraint eliminates it in the race. Both paths prevent the corrupt state. The 500 vs 409 distinction is UX, not correctness.

**Follow-up (future hardening):** Catch `23505` in the insert error handler and return 409 with the appropriate message. Out of scope for 9B.

---

### CHECK 5 — Return stock restoration is atomic
**PASS**

`sales.js` lines 519–534 — the read-then-write loop is gone. Each returned item calls:

```javascript
await supabase.rpc('restore_stock_for_return', {
  p_product_id: ri.product_id,
  p_quantity:   ri.quantity,
  p_company_id: req.companyId,
});
```

The RPC (migration 037):
```sql
UPDATE products
SET    stock_quantity = stock_quantity + p_quantity
WHERE  id            = p_product_id
  AND  company_id    = p_company_id;
```

Single statement. The right-hand side `stock_quantity + p_quantity` is evaluated at UPDATE time under a row-level lock acquired implicitly by PostgreSQL. No preceding SELECT. No read-then-write window.

Confirmed removed (Grep over all backend routes): the pattern `.select('stock_quantity')` followed by `.update({ stock_quantity: prod.stock_quantity + ...})` no longer exists in the return path. The old dead code is gone.

---

### CHECK 6 — Concurrent returns restore stock correctly
**PASS**

Two concurrent calls to `restore_stock_for_return` for the same product (e.g., product P, initial stock = 5, both return 2 units):

- Call A acquires row lock on product P
- Call A evaluates `5 + 2 = 7`, writes `stock_quantity = 7`, releases lock
- Call B acquires row lock on product P (had been waiting)
- Call B evaluates `7 + 2 = 9` (reads from the committed post-A state), writes `stock_quantity = 9`, releases lock

Final: `stock_quantity = 9`. Correct — `5 + 2 + 2 = 9`. Neither call overwrites the other.

This is the standard behaviour of atomic row-level UPDATE in PostgreSQL. Confirmed by reading the plpgsql function: no `PERFORM pg_advisory_lock()`, no `SELECT FOR UPDATE` — both are unnecessary because the row-level UPDATE lock is implicit.

---

### CHECK 7 — `restore_stock_for_return` handles missing products safely
**PASS**

RPC raises `PRODUCT_NOT_FOUND` if `UPDATE` affects 0 rows:
```sql
IF rows_affected = 0 THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: product % not found in company %...';
END IF;
```

Application response (sales.js lines 529–533):
```javascript
if (stockErr) {
  console.warn('[Sales] restore_stock_for_return non-fatal error:',
    stockErr.message, '| product_id:', ri.product_id);
}
```

Execution continues. The loop processes remaining items. Audit events (`SALE_RETURNED`) fire normally. HTTP 201 is returned. The `pos_returns` record is already committed before this loop runs — the return is recorded regardless.

This matches the old behaviour: the original code silently skipped missing products with `if (prod) { ... }`. The new code emits a console warning — marginally better observability.

---

### CHECK 8 — `ABANDONED_SESSION_DETECTED` no longer floods on repeated page loads
**PASS**

`recovery.js` — the audit event firing is now gated by a 24-hour dedup check:

```javascript
if (stale.length > 0) {
    const staleIds = stale.map(s => s.id);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: recentEvents } = await supabase
        .from('pos_audit_events')
        .select('till_session_id')
        .eq('company_id', req.companyId)
        .eq('action_type', POS_EVENTS.ABANDONED_SESSION_DETECTED)
        .in('till_session_id', staleIds)
        .gte('created_at', since24h);

    const alreadyReported = new Set(
        (recentEvents || []).map(e => e.till_session_id)
    );

    for (const s of stale) {
        if (!alreadyReported.has(s.id)) {
            posAuditFromReq(req, POS_EVENTS.ABANDONED_SESSION_DETECTED, { ... });
        }
    }
}
```

**Call 1 (first detection):** `recentEvents` is empty → `alreadyReported` is empty → event fires for each stale session.

**Calls 2–N within 24h:** `recentEvents` contains the events from Call 1 → `alreadyReported` has all stale session IDs → `!alreadyReported.has(s.id)` is false for all → no events fired.

**After 24h (session still stale):** `gte('created_at', since24h)` no longer matches the original event → `alreadyReported` is empty again → one more event fires. This is correct behaviour — a daily re-detection record is useful for auditors to know the session was still unresolved.

**Type safety confirmed:** `s.id` from `till_sessions` and `e.till_session_id` from `pos_audit_events` both return as JavaScript `number` from Supabase. `Set.has()` uses SameValueZero (equivalent to `===` for numbers). Comparison is correct.

**Performance:** The dedup query is guarded by `if (stale.length > 0)` — zero overhead when there are no stale sessions (the common case). One additional query when stale sessions exist, covered by the existing `idx_pos_audit_category_type` index on `(company_id, action_category, action_type, created_at DESC)` combined with `idx_pos_audit_session` on `till_session_id`.

---

### CHECK 9 — Abandoned session detection still works on first occurrence
**PASS**

The `stale[]` array is built by the same classification loop as before:
```javascript
if (ageHours > STALE_SESSION_HOURS) {
    stale.push({ ...s, age_hours: Math.round(ageHours) });
}
```

`STALE_SESSION_HOURS = 8` — unchanged. The classification logic is identical. The response payload `{ open, stale, pending_cashup }` is identical. Managers see the same data as before.

The only change is when the audit event fires — on first detection only, not on every page load.

---

### CHECK 10 — No checkout regressions
**PASS**

Verified by reading each changed route section:

| Route | Changed? | Verdict |
|---|---|---|
| `POST /api/pos/sessions/open` | ✅ Per-till check added before INSERT | Safe — existing session-close/cashup routes unchanged |
| `GET /api/pos/sessions` | No | Unchanged |
| `GET /api/pos/sessions/current` | No | Unchanged |
| `GET /api/pos/sessions/pending-cashup` | No | Unchanged |
| `POST /api/pos/sessions/:id/close` | No | Unchanged |
| `POST /api/pos/sessions/:id/complete-cashup` | No | Unchanged |
| `POST /api/pos/sales` (create) | No | Unchanged — `create_sale_atomic` RPC not touched |
| `GET /api/pos/sales` | No | Unchanged |
| `GET /api/pos/sales/:id` | No | Unchanged |
| `POST /api/pos/sales/:id/void` | No | Unchanged |
| `POST /api/pos/sales/:id/return` | ✅ Stock loop replaced | Same flow, same audit events, same response shape |
| `GET /api/pos/recovery/sessions` | ✅ Audit dedup added | Same response payload, same classification logic |
| All other recovery routes | No | Unchanged |

The `decrement_stock_v2` and `create_sale_atomic` RPCs are confirmed not touched (Grep for both strings — only referenced in sales.js comments and migration 030/027 files).

---

### CHECK 11 — No localStorage/sessionStorage business data added
**PASS**

Grep for `localStorage`, `sessionStorage`, `indexedDB` across all modified backend route files: **zero matches** in any of the three changed route files. The only file in the `routes/` directory containing those strings is `kv.js` — not modified in this workstream.

All three fixes are backend-only. No frontend files were touched.

---

## Bug Found and Fixed

| # | Bug | Severity | Status |
|---|---|---|---|
| B1 | JSDoc comment in `recovery.js` line 44 still said "Fires ABANDONED_SESSION_DETECTED for each stale session found (fire-and-forget)" — inaccurate after the dedup change | LOW (documentation) | Fixed during this verification — updated to accurately describe the 24h dedup behaviour |

---

## Known Limitations (Not Bugs)

### L1 — Concurrent race returns HTTP 500 instead of 409
When two session-open requests race through the application check simultaneously, the second one hits the DB unique constraint and receives HTTP 500 with the Postgres error message rather than the friendly "This till already has an open session" 409. Data integrity is fully protected — no duplicate session is created. This is a UX improvement to track, not a correctness issue.

**Classification:** Acceptable edge case. Non-blocking for pilot. Catching `23505` error codes in the insert handler for a friendlier response is a tracked future improvement.

---

## Remaining Multi-Till Risks (Post-9B)

All RISK-01, RISK-02, RISK-11 from the 9A audit are now closed.

| Risk ID | Description | Severity | Status |
|---|---|---|---|
| RISK-04 | Idempotency SELECT→INSERT race on concurrent sync | MEDIUM | Open — accepted for pilot (single-tab per till) |
| RISK-05 | In-memory stock drift over long sessions (no periodic product refresh) | MEDIUM | Open — display only, DB authoritative |
| RISK-06 | `updateOfflineBanner()` full-table reads from IndexedDB | MEDIUM | Open — fast at pilot volume |
| RISK-09 | Multi-tab concurrent sync (per-tab syncInProgress flag) | MEDIUM | Open — accepted for pilot (single-tab per till) |
| RISK-12 | No manager session close action in recovery panel | LOW | Open — operational gap, not data integrity |
| RISK-14 | `stockPolicyCache` shared across companies (not per-company Map) | LOW | Open — single-company pilot, no impact |
| RISK-15 | SW registration failure + force update gate gap | LOW | Open — accepted for pilot |

None of these are blockers for a controlled pilot under the operational limits documented in Workstream 9A.

---

## Pilot-Safe Concurrency Verdict

**Multi-till hardware isolation: ✅ Enforced**
One active session per till, per company. Two-layer protection (application 409 + DB unique constraint). No data corruption path under concurrent session-open races.

**Return stock atomicity: ✅ Enforced**
Concurrent returns of the same product both apply their full increment. PostgreSQL row-level locking prevents any overwrite race.

**Audit log integrity: ✅ Preserved**
`ABANDONED_SESSION_DETECTED` fires once per detection per 24-hour window. Audit table remains forensically useful. Append-only enforcement not affected.

**Checkout flow: ✅ No regression**
Sale creation, payment processing, stock decrement, session close, cash-up, offline queue — all unchanged.

**Workstream 9B is pilot-safe.**

---

## Files Verified

| File | Checks |
|---|---|
| `accounting-ecosystem/database/migrations/037_pos_multi_till_hardening.sql` | CHECK 3, 4, 5, 6, 7 |
| `accounting-ecosystem/backend/modules/pos/routes/sessions.js` | CHECK 1, 2, 3, 4, 10 |
| `accounting-ecosystem/backend/modules/pos/routes/sales.js` | CHECK 5, 6, 7, 10 |
| `accounting-ecosystem/backend/modules/pos/routes/recovery.js` | CHECK 8, 9, 10 |
| `accounting-ecosystem/backend/modules/pos/services/posAuditLogger.js` | CHECK 8 (POS_EVENTS.ABANDONED_SESSION_DETECTED constant confirmed) |

## Fix File

| File | Fix |
|---|---|
| `accounting-ecosystem/backend/modules/pos/routes/recovery.js` — JSDoc at line 42 | Updated to accurately describe the 24h dedup behaviour |
