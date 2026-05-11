# 04 — Checkout Charlie: Direct pg Connection Audit
**Phase 1, Step 3A — READ ONLY. No code changes made.**
Date: 2026-05-10

---

## VERDICT SUMMARY

| Question | Answer | Confidence |
|---|---|---|
| Is there an existing pg Pool in the ecosystem? | YES — accounting module | CONFIRMED |
| Which env var currently resolves for that pool? | `DATABASE_URL` (fallback) | CONFIRMED |
| Where does `DATABASE_URL` point? | **Zeabur PostgreSQL** | CONFIRMED |
| Does Zeabur PostgreSQL contain POS tables? | **NO** | CONFIRMED |
| POS tables live in which database? | **Supabase** | CONFIRMED |
| Are these the same database? | **NO — completely separate** | CONFIRMED |
| Is the existing pg Pool safe for POS transactions? | **UNSAFE — wrong database** | CONFIRMED |
| Is there a Supabase direct pg URL configured? | **NO — not set anywhere** | CONFIRMED |
| Recommended path for POS atomicity | **Supabase RPC (plpgsql transaction)** | CONFIRMED |

---

## SECTION 1: THE pg POOL FILE

**Path:** `accounting-ecosystem/backend/modules/accounting/config/database.js`

```javascript
const connectionString =
  process.env.ACCOUNTING_DATABASE_URL ||
  process.env.COACHING_DATABASE_URL  ||
  process.env.DATABASE_URL;

pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 15,
  ...
});
```

**Priority:** `ACCOUNTING_DATABASE_URL` → `COACHING_DATABASE_URL` → `DATABASE_URL`

The comment in the file states: *"Uses Supabase direct PostgreSQL connection (same DB as the rest of the ecosystem)."* This comment describes the intent, not the current reality. The intent was to set `ACCOUNTING_DATABASE_URL` to the Supabase direct connection string. That variable was never set.

---

## SECTION 2: WHICH ENV VAR IS ACTIVE

Inspected: `accounting-ecosystem/backend/.env`

| Variable | Set? | Value (host only — credentials masked) |
|---|---|---|
| `ACCOUNTING_DATABASE_URL` | **NOT SET** | — |
| `COACHING_DATABASE_URL` | **NOT SET** | — |
| `DATABASE_URL` | **SET** | `...@sjc1.clusters.zeabur.com:25165/zeabur` |

**Result:** The priority chain falls all the way through to `DATABASE_URL`. That is the only connection string that exists.

**Active connection:** `DATABASE_URL` → Zeabur PostgreSQL at `sjc1.clusters.zeabur.com:25165`

---

## SECTION 3: WHERE DOES EACH URL POINT?

### The two databases in this ecosystem

**Database A — Zeabur PostgreSQL**

```
Host:     sjc1.clusters.zeabur.com
Port:     25165
Database: zeabur
Env var:  DATABASE_URL
```

This is a standalone PostgreSQL instance provisioned by the Zeabur platform. It is separate from Supabase. It was originally used by modules that needed a direct pg pool (accounting module). It is labelled in the `.env` comment: `# Zeabur PostgreSQL Database`.

---

**Database B — Supabase PostgreSQL**

```
Project:  glkndlzjkhwfsolueyhk
Host:     db.glkndlzjkhwfsolueyhk.supabase.co  (direct, port 5432)
          or pooler: aws-0-[region].pooler.supabase.com (port 5432 / 6543)
Env var:  SUPABASE_URL + SUPABASE_SERVICE_KEY (JS client)
          ACCOUNTING_DATABASE_URL / COACHING_DATABASE_URL (direct pg — NOT SET)
```

The ecosystem uses the Supabase JavaScript client (`@supabase/supabase-js`) to connect to this database via the REST API. The POS module uses only this client.

---

### These are two entirely separate PostgreSQL instances

They share no tables, no schemas, no data. A write to Zeabur PostgreSQL does not affect Supabase, and vice versa.

---

## SECTION 4: WHERE DO THE POS TABLES LIVE?

All POS tables — `sales`, `sale_items`, `sale_payments`, `products`, `tills`, `till_sessions`, `customers`, `stock_adjustments` — were created via `accounting-ecosystem/database/schema.sql`, which is run against Supabase.

The POS module (`modules/pos/routes/sales.js`) exclusively uses the Supabase JS client:

```javascript
const { supabase } = require('../../../config/database');
// ...
await supabase.from('sales').insert(...)
await supabase.from('sale_items').insert(...)
await supabase.from('sale_payments').insert(...)
await supabase.rpc('decrement_stock', ...)
```

**POS tables are in Supabase (Database B). The accounting pg Pool connects to Zeabur PostgreSQL (Database A). They are different databases.**

---

## SECTION 5: WHAT WOULD HAPPEN IF THE ACCOUNTING pg POOL WERE USED FOR POS

If a POS transaction were attempted using `modules/accounting/config/database.js`:

```javascript
const db = require('../accounting/config/database');
const client = await db.getClient();
await client.query('BEGIN');
await client.query('INSERT INTO sales ...', [...]);   // ← targets Zeabur PostgreSQL
await client.query('INSERT INTO sale_items ...', []); // ← targets Zeabur PostgreSQL
await client.query('COMMIT');
```

The `sales` and `sale_items` tables do NOT EXIST in Zeabur PostgreSQL. Every query would fail with:

```
ERROR: relation "sales" does not exist
```

The transaction would roll back (correctly), but the sale would never be created anywhere. The entire POS sale flow would break silently for any code path that used this pool.

**Using the accounting pg Pool for POS is not just unsafe — it is non-functional. The tables do not exist there.**

---

## SECTION 6: IS THERE A SUPABASE DIRECT pg CONNECTION CONFIGURED?

### Current state: NO

A Supabase direct PostgreSQL connection (bypassing the REST API, going directly to the database server) would look like:

```
SUPABASE_DIRECT_URL=postgresql://postgres.glkndlzjkhwfsolueyhk:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
```

This variable does not exist under any name in:
- `accounting-ecosystem/backend/.env`
- `accounting-ecosystem/backend/.env.example` (only mentioned as a comment, commented out)

The `.env.example` shows the intent:
```
# COACHING_DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
# ACCOUNTING_DATABASE_URL=  (same value as COACHING_DATABASE_URL — can share)
```

But neither was ever filled in and activated. They remain commented-out documentation.

**There is currently no pg Pool anywhere in the ecosystem that connects to Supabase PostgreSQL directly.**

The Coaching app (`Coaching app/backend/`) has a direct pg pool to Supabase (`db.glkndlzjkhwfsolueyhk.supabase.co`), but that is a separate Node.js process and cannot be used by the accounting-ecosystem backend.

---

## SECTION 7: SAFETY VERDICT

```
┌─────────────────────────────────────────────────────────────────┐
│  SAFETY VERDICT: UNSAFE                                         │
│                                                                 │
│  Using the existing accounting pg Pool for POS transactions     │
│  would target Zeabur PostgreSQL.                                │
│                                                                 │
│  POS tables do not exist in Zeabur PostgreSQL.                  │
│                                                                 │
│  Every POS query through this pool would fail with:             │
│    "relation does not exist"                                    │
│                                                                 │
│  Creating a new pg Pool would require:                          │
│    - A Supabase direct connection string (not currently set)    │
│    - A new env var in Zeabur dashboard and local .env           │
│    - A new pool object scoped to POS                            │
│    - Supabase direct connections have session-mode limits       │
│      and connection count constraints                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## SECTION 8: THREE OPTIONS FOR POS ATOMICITY

### Option A — Supabase RPC (plpgsql transaction function) — RECOMMENDED

Create a `create_sale_atomic(...)` Supabase function written in plpgsql. The function performs all inserts and the stock decrement inside a single database-level transaction. The application calls one RPC and gets back the created sale.

```sql
CREATE OR REPLACE FUNCTION create_sale_atomic(
  p_company_id     INT,
  p_user_id        INT,
  p_till_session_id INT,
  p_items          JSONB,
  p_payment_method TEXT,
  p_payments       JSONB,
  ...
)
RETURNS JSONB AS $$
DECLARE
  v_sale_id   INT;
  v_sale_num  TEXT;
  v_item      JSONB;
BEGIN
  -- All of the following is one atomic transaction:
  INSERT INTO sales (...) VALUES (...) RETURNING id INTO v_sale_id;
  INSERT INTO sale_items (...) SELECT ... FROM jsonb_array_elements(p_items);
  INSERT INTO sale_payments (...) SELECT ... FROM jsonb_array_elements(p_payments);
  -- Stock decrement for each item (already atomic per item via WHERE guard)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    PERFORM decrement_stock(
      (v_item->>'product_id')::INT,
      (v_item->>'quantity')::INT
    );
  END LOOP;
  RETURN jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_num);
EXCEPTION
  WHEN OTHERS THEN
    RAISE; -- Causes plpgsql to roll back the whole function's transaction
END;
$$ LANGUAGE plpgsql;
```

**Advantages:**
- No new env vars
- No new connection pool
- Uses the existing proven Supabase client infrastructure
- True ACID transaction at the database level — any failure rolls back all writes
- `decrement_stock` is called from within the same transaction, so a stock failure rolls back the sale record too
- Consistent with the `decrement_stock` pattern already deployed and verified
- Supabase handles connection pooling internally

**Disadvantages:**
- More complex SQL to write and test
- Application code gets a JSON blob back instead of ORM-style rows
- Requires careful JSONB argument construction in Node.js

---

### Option B — New POS-specific pg Pool pointing to Supabase

Add a new env var `SUPABASE_DIRECT_URL` (or reuse `ACCOUNTING_DATABASE_URL`) with the Supabase direct PostgreSQL connection string. Create a new pg Pool in the POS module that uses it.

```javascript
// New file: modules/pos/config/database.js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.SUPABASE_DIRECT_URL,
  ssl: { rejectUnauthorized: false }
});

// In sales.js:
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // ... all inserts ...
  // ... call decrement_stock via EXECUTE or inline SQL ...
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

**Advantages:**
- True Node.js `BEGIN/COMMIT/ROLLBACK` — familiar pattern
- Easier to add ad-hoc SQL alongside the transaction
- Explicit rollback control in application code

**Disadvantages:**
- Requires a new env var to be set in both local `.env` and Zeabur dashboard
- Supabase's pooler has a **session-mode limit** at port 5432. The transaction mode pooler (port 6543) does NOT support `SET` commands or prepared statements across connections.
- Direct Supabase PostgreSQL connections (port 5432) use session pooling — connection count is limited by the Supabase plan. A busy POS with many concurrent sales could exhaust connections.
- Introduces a second connection mechanism alongside the Supabase JS client — two things to maintain, two failure modes
- The new pool would bypass Supabase Row Level Security (RLS). Acceptable if service-role is used, but must be explicitly considered.

---

### Option C — Accept the current partial atomicity (do nothing for now)

Current state after Phase 1 Steps 1–2:
- Stock decrement is atomic per item (RPC with `WHERE stock_quantity >= qty`)
- Sale record creation is not atomic with stock decrement
- A P0001 at step 8 leaves an orphaned sale record

**When does an orphan actually occur?**
- Only if two concurrent requests BOTH pass the pre-check (step 3) AND one of them loses the race at the RPC (step 8). The pre-check happens much earlier than the decrement; the window for a concurrent race that passes pre-check but fails at the RPC is narrow.
- In practice, only occurs during genuine concurrent cashier activity on the last unit of the same product.

**Disadvantages:**
- Orphaned sale records are hard to detect and clean up
- Misleading data (sale exists with no corresponding stock change)
- Not acceptable for a long-term production state

**Option C is noted only for completeness. It is not a recommendation.**

---

## SECTION 9: RECOMMENDATION

**Use Option A — Supabase RPC (plpgsql transaction function).**

Evidence supporting this recommendation:

1. **`decrement_stock` proves the pattern is reliable.** We created an RPC, deployed it in minutes, tested it with a live API call, and it worked exactly as designed. A `create_sale_atomic` function is the same pattern at a larger scale.

2. **No new infrastructure.** Option B requires a new env var set on Zeabur's dashboard, a new connection pool, and careful management of Supabase's connection limits. Option A uses what already exists.

3. **True atomicity.** A plpgsql function runs entirely within a single implicit transaction. Any `RAISE EXCEPTION` — including from `decrement_stock` — rolls back all writes in the function. This is exactly what is needed.

4. **RLS bypass is already in place.** The Supabase service-role client already bypasses RLS for all current POS operations. The RPC runs as the service-role user, so no regression there.

5. **The coaching app's Supabase direct connection is on a different process.** There is no safe way to borrow it. Option A doesn't need it.

---

## SECTION 10: NEXT STEP

**Phase 1 Step 3B — Design and implement `create_sale_atomic` Supabase RPC.**

Scope:
- Write the SQL function that atomically handles INSERT sales + INSERT sale_items + INSERT sale_payments + CALL decrement_stock per item
- Write the migration file (`025_pos_create_sale_atomic.sql`)
- Update `sales.js` to call the RPC instead of the current four-step sequence
- The four-step sequence (steps 4–8) is replaced by a single `supabase.rpc('create_sale_atomic', {...})` call
- The pre-check (step 3) and all auth/validation (steps 1–2) remain in Node.js — they are not expensive SQL and are good application-layer guards

**What must NOT change:**
- VAT calculation logic stays in Node.js (already computed, passed as a parameter to the RPC)
- Price locking stays in Node.js (product lookup + price read happens before the RPC call)
- All auth and permission middleware is unchanged
- The response shape (`res.status(201).json({ sale })`) is unchanged — the RPC returns the created sale as JSONB

---

*Investigation complete. No files modified.*
*`DATABASE_URL` → Zeabur PostgreSQL. POS tables → Supabase. These are different databases.*
*Existing pg Pool cannot be used for POS transactions.*
*Proceed to Phase 1 Step 3B: Supabase RPC for atomic sale creation.*
