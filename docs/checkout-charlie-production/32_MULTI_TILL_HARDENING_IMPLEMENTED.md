# 32 — MULTI-TILL HARDENING IMPLEMENTED
## Checkout Charlie — Workstream 9B

**Date:** 2026-05-22
**Status:** ✅ Implemented — pilot-ready
**Scope:** Top 3 risks from Workstream 9A — no new features, no checkout flow changes

---

## What Was Fixed

### Fix 1 — Per-Till Active Session Uniqueness

**Risk closed:** RISK-02 from 9A audit

**Problem:** Two different user accounts could open sessions on the same physical till simultaneously. The old duplicate-session gate checked only `user_id` — not `till_id`. Two cashiers on the same till produced ambiguous session ownership that complicated end-of-day reconciliation.

**Two-layer fix:**

**Layer 1 — Application check (sessions.js):**
```javascript
// Check if this till already has an open session (any user, same company)
const { data: tillSession } = await supabase
  .from('till_sessions')
  .select('id, user_id')
  .eq('company_id', req.companyId)
  .eq('till_id', till_id)
  .eq('status', 'open')
  .limit(1);

if (tillSession && tillSession.length > 0) {
  return res.status(409).json({
    error: 'This till already has an open session',
    sessionId: tillSession[0].id,
  });
}
```

Returns HTTP 409 Conflict. The `sessionId` in the response tells the caller exactly which session is blocking so the operator can investigate.

**Layer 2 — Database constraint (migration 037):**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_till_sessions_till_open_unique
    ON till_sessions (company_id, till_id)
    WHERE status = 'open';
```

Partial unique index — applies only when `status = 'open'`. Closed and cashed-up sessions are not constrained (unlimited history per till is expected and correct). This is the hard safety net: if two concurrent session-open requests race through the application check simultaneously, the DB unique constraint catches the second one with a 23505 unique violation → the application catches the Supabase error and returns 500, not a duplicate session.

**Existing per-user check preserved:** The original `user_id` duplicate check still runs after the per-till check. Order: till check first (409) → user check second (400). Both checks are company-scoped (`eq('company_id', req.companyId)`).

**What does NOT change:**
- Session close flow — unchanged
- Cash-up flow — unchanged
- Reports and reconciliation — unchanged (all historical session reads are unaffected by the partial index)
- Company isolation — preserved on both checks

---

### Fix 2 — Atomic Return Stock Restoration

**Risk closed:** RISK-01 from 9A audit

**Problem:** The return route used a read-then-write pattern per item:
```javascript
// OLD — race window between SELECT and UPDATE
const { data: prod } = await supabase
  .from('products').select('stock_quantity').eq('id', ri.product_id)...
await supabase.from('products')
  .update({ stock_quantity: prod.stock_quantity + ri.quantity })...
```

Two concurrent returns of the same product both read the same pre-return stock value → both compute `qty + returned` → one write overwrites the other → net result: stock incremented once instead of twice.

**Fix — new `restore_stock_for_return` RPC (migration 037):**
```sql
UPDATE products
SET    stock_quantity = stock_quantity + p_quantity
WHERE  id            = p_product_id
  AND  company_id    = p_company_id;
```

The arithmetic is evaluated atomically at `UPDATE` time under a row-level lock. No read needed. Two concurrent calls both apply their full increment independently. No overwrite race possible.

**Updated return route (sales.js):**
```javascript
// NEW — single atomic UPDATE via RPC; no read, no race window
const { error: stockErr } = await supabase.rpc('restore_stock_for_return', {
  p_product_id: ri.product_id,
  p_quantity:   ri.quantity,
  p_company_id: req.companyId,
});
if (stockErr) {
  // Non-fatal: pos_returns record is already committed.
  console.warn('[Sales] restore_stock_for_return non-fatal error:', stockErr.message, ...);
}
```

**Error handling:** The RPC raises `PRODUCT_NOT_FOUND` if the product does not exist in the company. This is treated as non-fatal at the application layer — the `pos_returns` record is already committed when the stock restoration loop runs. The original code silently skipped missing products (`if (prod) { ... }`); the new code logs a console warning instead. Audit record (SALE_RETURNED) is unaffected.

**What does NOT change:**
- `create_sale_atomic` — not touched
- `decrement_stock_v2` — not touched
- `pos_returns` insert — unchanged (before the stock loop)
- Return audit events (SALE_RETURNED) — unchanged
- Return validation logic — unchanged

---

### Fix 3 — Abandoned Session Audit Flood Protection

**Risk closed:** RISK-11 from 9A audit

**Problem:** `GET /api/pos/recovery/sessions` fired `ABANDONED_SESSION_DETECTED` for every stale session on every manager page load. A manager polling the recovery page every 30 seconds with 3 stale sessions generated 6 audit rows per minute — 360 per hour — for sessions that hadn't changed.

**Fix — batch dedup check before firing (recovery.js):**

The session-classification loop and the audit-event firing are now separate steps:

1. **Build arrays** (same as before, no audit calls):
   ```
   stale[] ← sessions open > 8h
   open[]  ← sessions open ≤ 8h
   pending_cashup[] ← closed sessions
   ```

2. **One batch query** for all stale session IDs: which ones already have an `ABANDONED_SESSION_DETECTED` event in the last 24 hours?
   ```javascript
   const { data: recentEvents } = await supabase
     .from('pos_audit_events')
     .select('till_session_id')
     .eq('company_id', req.companyId)
     .eq('action_type', POS_EVENTS.ABANDONED_SESSION_DETECTED)
     .in('till_session_id', staleIds)
     .gte('created_at', since24h);
   ```

3. **Fire only for newly-detected sessions** (not already in recentEvents set):
   ```javascript
   const alreadyReported = new Set(recentEvents.map(e => e.till_session_id));
   for (const s of stale) {
     if (!alreadyReported.has(s.id)) {
       posAuditFromReq(req, POS_EVENTS.ABANDONED_SESSION_DETECTED, { ... });
     }
   }
   ```

**Behaviour:**
- First time a session is detected as stale → event fires → recorded in `pos_audit_events`
- Next 24 calls within the same hour → batch query finds the existing event → no new events fired
- After 24 hours, if the session is still stale → one more event fires (daily detection record)
- Response payload (`{ open, stale, pending_cashup }`) is identical — no client-side changes needed

**Performance:** The dedup query uses the existing `idx_pos_audit_category_type` index on `(company_id, action_category, action_type, created_at DESC)` plus `idx_pos_audit_session` on `till_session_id`. For pilot scale (< 10 stale sessions), this is a fast indexed lookup. Added one query per `GET /recovery/sessions` call when stale sessions exist; zero overhead when there are no stale sessions (`if (stale.length > 0)` guard).

**What does NOT change:**
- Response shape — identical `{ open, stale, pending_cashup }`
- All other recovery routes — unchanged
- `ABANDONED_SESSION_DETECTED` event schema — same fields, same metadata
- Audit log append-only guarantee — not weakened (no deletes, no updates)

---

## Files Changed

| File | Change |
|---|---|
| `accounting-ecosystem/database/migrations/037_pos_multi_till_hardening.sql` | NEW — partial unique index on `till_sessions` + `restore_stock_for_return` RPC |
| `accounting-ecosystem/backend/modules/pos/routes/sessions.js` | Added per-till open session check before per-user check (lines ~104–130) |
| `accounting-ecosystem/backend/modules/pos/routes/sales.js` | Replaced read-then-write return stock loop with `restore_stock_for_return` RPC call |
| `accounting-ecosystem/backend/modules/pos/routes/recovery.js` | Separated stale session classification from audit event firing; added 24h batch dedup |

---

## What Was NOT Changed

| Area | Reason |
|---|---|
| `create_sale_atomic` RPC | Not involved in any of the three fixes |
| `decrement_stock_v2` RPC | Not changed — companion function `restore_stock_for_return` added alongside it |
| Session close / cash-up routes | Not touched — fixes are in session open and the recovery list route only |
| `checkout()` in `index.html` | Not touched — all fixes are backend-only |
| All other recovery routes (`/queue/retry`, `/queue/abandon`, etc.) | Not touched |
| `posAuditLogger.js` | No new event types needed — existing `ABANDONED_SESSION_DETECTED` reused |
| Reconciliation routes | Not touched |
| IndexedDB offline queue | Not touched |
| Any frontend file | Not touched |

---

## Test Criteria

| # | Test | Expected Result |
|---|---|---|
| T1 | Open a session on Till 1 as User A. Try to open another session on Till 1 as User B. | HTTP 409 `{ error: 'This till already has an open session', sessionId: <id> }` |
| T2 | Open a session on Till 1. Open a session on Till 2 (different till). | Both succeed. Each till has its own active session. |
| T3 | Try to open a second session on the same till while the first is open, even as the same user. | HTTP 409 from till check (before the user check fires). |
| T4 | Close Till 1 session. Open a new session on Till 1 (different user, new shift). | Succeeds — partial index only constrains `status = 'open'` rows. |
| T5 | Process a return. Check `products.stock_quantity` for the returned item. | Stock increased by the returned quantity. |
| T6 | Process two concurrent returns of the same item. | Both increments applied — stock increased by the sum of both quantities. No overwrite. |
| T7 | Load `/api/pos/recovery/sessions` once when 2 sessions are stale. | 2 `ABANDONED_SESSION_DETECTED` events in `pos_audit_events`. |
| T8 | Load `/api/pos/recovery/sessions` 10 more times without the stale sessions changing. | No new `ABANDONED_SESSION_DETECTED` events. Total stays at 2. |
| T9 | Normal checkout through the POS (create sale, complete payment). | No regression — checkout flow, audit events, stock decrement all unchanged. |
| T10 | No business data in localStorage/sessionStorage. | Browser DevTools → Application → Storage: only `token` and `isSuperAdmin`. |

---

## Deployment Steps

### 1. Run migration 037 in Supabase SQL Editor

```sql
-- Paste contents of 037_pos_multi_till_hardening.sql
-- Both statements are idempotent (IF NOT EXISTS / CREATE OR REPLACE)
```

**Order matters:** Run migration 037 before deploying the updated `sessions.js` and `sales.js`. If `restore_stock_for_return` does not exist when a return is processed, the RPC call will return an error (logged as non-fatal warning — no crash, no data loss, but stock is not restored). The migration must be live first.

### 2. Deploy backend

Standard deployment. No environment variable changes required.

### 3. Verify

- Open the recovery panel, observe no audit flood on repeated loads
- Open a session on one till, attempt to open on the same till — expect 409
- Process a return, verify stock increased correctly

---

## Architecture Boundaries Preserved

- Backend/database remains authoritative — both the application check and the DB unique index enforce the till uniqueness rule independently
- No browser storage added — all three fixes are backend-only
- Audit trail integrity preserved — `pos_audit_events` append-only triggers not affected
- Sale creation flow untouched — `create_sale_atomic` RPC not modified
- Company isolation enforced on all new queries (`eq('company_id', req.companyId)` on every Supabase call)
