# 05 — Checkout Charlie: `create_sale_atomic` RPC Contract
**Phase 1, Step 3B — DESIGN ONLY. No code changes made.**
Date: 2026-05-10

---

## VERDICT SUMMARY

| Question | Answer |
|---|---|
| Is the existing route completely audited? | YES |
| All fields for all 3 tables mapped? | YES |
| Frontend response contract understood? | YES — and a pre-existing bug found |
| Pre-existing response mismatch identified? | YES — documented in Section 6 |
| RPC parameter contract locked? | YES |
| Which logic stays in Node.js? | Documented in Section 4 |
| Which logic moves to SQL? | Documented in Section 5 |
| Ready for implementation? | YES — after review of this contract |

---

## SECTION 1: CURRENT ROUTE — COMPLETE FIELD AUDIT

### 1.1 — Request body (what the frontend sends)

From `frontend-pos/index.html` line 4585-4593:

```json
{
  "tillSessionId": 5,
  "items": [
    { "productId": 1, "quantity": 2 },
    { "productId": 4, "quantity": 1 }
  ],
  "paymentMethod": "cash",
  "customerId": null
}
```

**The frontend sends NO prices, NO totals, NO VAT.** Product prices and VAT rates are looked up from the database server-side. This anti-spoofing design must be preserved.

---

### 1.2 — `sales` table — every field currently inserted

Source: `sales.js` lines 215-235

| Field | Value source | Generated where |
|---|---|---|
| `company_id` | `req.companyId` | JWT middleware |
| `sale_number` | `generateSaleNumber()` → `SAL-${Date.now()}-${rand4}` | Node.js function |
| `receipt_number` | `saleNumber.replace('SAL-', 'RC-')` | Node.js derived |
| `user_id` | `req.user.userId` | JWT |
| `cashier_id` | `req.user.userId` (denormalised alias) | JWT |
| `customer_id` | `body.customerId` (nullable) | Frontend (optional) |
| `till_session_id` | `body.tillSessionId` (nullable) | Frontend |
| `subtotal` | `Σ (unit_price × qty)` for all items | Node.js calculation |
| `discount_amount` | flat `discountAmt` or `subtotal × discount_percent / 100` | Node.js calculation |
| `vat_amount` | `Σ linePrice × (vat_rate / (100 + vat_rate))` | Node.js calculation |
| `total_amount` | `Math.max(0, subtotal - discount)` | Node.js calculation |
| `payment_method` | `body.paymentMethod` (default `'cash'`) | Frontend |
| `payment_status` | `'completed'` | Hardcoded constant |
| `status` | `'completed'` | Hardcoded constant |
| `notes` | `body.notes` (nullable) | Frontend (optional) |

---

### 1.3 — `sale_items` table — every field currently inserted

Source: `sales.js` lines 240-251

| Field | Value source | Generated where |
|---|---|---|
| `company_id` | `req.companyId` | JWT middleware |
| `sale_id` | `sale.id` (from just-created sale) | Database-returned |
| `product_id` | `item.product_id` (normalised from body) | Frontend |
| `product_name` | `product.product_name` (from DB lookup) | DB — NOT from frontend |
| `quantity` | `item.quantity` | Frontend |
| `unit_price` | `product.unit_price` (from DB lookup) | DB — NOT from frontend |
| `discount_amount` | `0` | Hardcoded constant |
| `vat_rate` | `product.vat_rate || 15` (from DB, default 15) | DB |
| `line_total` | `unit_price × quantity` | Node.js calculation |
| `total_price` | same as `line_total` | Node.js calculation (duplicate column) |

---

### 1.4 — `sale_payments` table — every field currently inserted

Source: `sales.js` lines 262-279

**Single payment (standard):**

| Field | Value source |
|---|---|
| `company_id` | `req.companyId` |
| `sale_id` | `sale.id` |
| `payment_method` | `body.paymentMethod` (default `'cash'`) |
| `amount` | `total_amount` (calculated) |
| _(reference)_ | not set for single payment |

**Split payment (payments array):**

| Field | Value source |
|---|---|
| `company_id` | `req.companyId` |
| `sale_id` | `sale.id` |
| `payment_method` | `p.payment_method || p.method || 'cash'` |
| `amount` | `p.amount` |
| `reference` | `p.reference || null` |

---

## SECTION 2: WHICH VALUES MUST NEVER COME FROM FRONTEND

These fields are computed or looked up server-side precisely to prevent price spoofing. They must NOT appear as passable parameters to the RPC from untrusted input.

| Field | Why it cannot come from frontend |
|---|---|
| `unit_price` | Frontend could send a lower price and pay less |
| `vat_rate` | Frontend could zero out VAT |
| `vat_amount` | Derived from locked DB prices; client cannot compute correctly |
| `subtotal` | Sum of locked prices; must be DB-authoritative |
| `total_amount` | Same as subtotal less discount |
| `product_name` (denormalized) | Could be spoofed for receipt fraud |
| `line_total` | Derived from locked prices |
| `status` | Must always be `'completed'` on creation |
| `payment_status` | Must always be `'completed'` on creation |

**The RPC will receive pre-computed values from Node.js, but Node.js must have derived them from DB prices — not from the request body.** This is unchanged from the current route.

---

## SECTION 3: VALIDATIONS THAT MUST REMAIN IN NODE.JS

These checks must not move into the SQL function. They are application-layer concerns that belong before the transaction begins.

| Validation | Where | Why it stays in Node.js |
|---|---|---|
| `authenticateToken` | middleware | JWT verification is not SQL work |
| `requireCompany` | middleware | Company context from JWT |
| `requirePermission('SALES.CREATE')` | middleware | Role check |
| Items array not empty | route guard | Body validation |
| Product IDs valid and present | product DB lookup | Ensures valid product context before entering SQL |
| Products are `is_active = true` | product DB lookup | Business rule check |
| Products belong to `company_id` | product DB lookup | Multi-tenant isolation check |
| Stock pre-check (`stock_quantity >= quantity`) | pre-check loop | Early 422 before any write happens — better UX than SQL exception |
| Payment total validation (split payments) | payment total check | 1-cent tolerance rounding logic is cleaner in Node.js |
| Sale number uniqueness guarantee | Note: currently generated in Node.js with `Date.now()` — collision risk is low but non-zero |

---

## SECTION 4: WHICH LOGIC STAYS IN NODE.JS

The Node.js route keeps everything before the database writes:

```
1. Auth + permission middleware             ← STAYS
2. Body normalisation (camelCase → snake)   ← STAYS
3. Items normalisation (productId → product_id) ← STAYS
4. Product DB lookup (prices, VAT, stock)   ← STAYS (read-only query, not in transaction)
5. Stock pre-check + 422 rejection          ← STAYS (application-layer guard)
6. Totals calculation (subtotal, VAT, discount, total) ← STAYS
7. Payment total validation                 ← STAYS
8. Sale number generation                   ← STAYS (or could move; see Section 7)
9. Items enrichment (add product fields)    ← STAYS
10. Response formatting (camelCase aliases) ← STAYS (see Section 6)
```

Steps 1–10 are NOT in the database transaction. The transaction begins only when all values are validated and ready.

---

## SECTION 5: WHICH LOGIC MOVES INTO THE SQL TRANSACTION

The SQL function receives pre-validated, pre-calculated values. Inside the function, it does only writes:

```
A. INSERT INTO sales               ← MOVES to SQL
B. INSERT INTO sale_items (batch)  ← MOVES to SQL
C. INSERT INTO sale_payments (batch) ← MOVES to SQL
D. CALL decrement_stock per item   ← MOVES to SQL (already exists as RPC)
E. RETURN created sale data        ← SQL RETURN
F. ROLLBACK on any failure         ← Implicit — plpgsql exception handling
```

The existing `decrement_stock` function is called from within `create_sale_atomic`. Because both run inside the same plpgsql transaction, a P0001 from `decrement_stock` propagates upward and rolls back all inserts.

---

## SECTION 6: PRE-EXISTING RESPONSE CONTRACT MISMATCH (IMPORTANT BUG FOUND)

**This is a discovery from the audit. It must be fixed in the implementation.**

### What the current API returns

`sales.js` line 307:
```javascript
res.status(201).json({ sale });
```

Where `sale` is the Supabase row. The response is:
```json
{
  "sale": {
    "id": 123,
    "sale_number": "SAL-1715000000-ABCD",
    "total_amount": 150.00,
    ...
  }
}
```

### What the frontend actually reads

`frontend-pos/index.html` line 4598-4602:
```javascript
const result = await response.json();
if (response.ok) {
    lastSaleId = result.saleId;        // ← undefined (not result.sale.id)
    showSaleCompleteModal(result);
```

`showSaleCompleteModal(sale)` called with `result`:
```javascript
function showSaleCompleteModal(sale) {
    // ...
    `#${sale.saleNumber}`        // ← undefined (should be result.sale.sale_number)
    `R ${sale.totalAmount.toFixed(2)}`  // ← TypeError: Cannot read 'toFixed' of undefined
    `deliverReceipt(${sale.saleId}, ...)` // ← undefined
```

And from the offline sync (line 3364-3366):
```javascript
await markSaleSynced(sale.tempId, result.saleId);    // ← undefined
`synced as ${result.saleNumber}`                      // ← undefined
```

### Impact

The sale modal currently shows `#undefined` and `R NaN` (or throws a TypeError) for every completed sale. The receipt delivery buttons call `deliverReceipt(undefined, ...)`. This is a live bug in the current frontend.

### The fix — include camelCase aliases in the response

The new implementation must return BOTH the nested `sale` object AND top-level camelCase fields to fix the pre-existing bug and retain backward compatibility:

```json
{
  "sale": { "id": 123, "sale_number": "SAL-...", "total_amount": 150.00, ... },
  "saleId": 123,
  "saleNumber": "SAL-...",
  "totalAmount": 150.00
}
```

This fixes the frontend bug **without any frontend changes** — the camelCase fields are what the frontend already expects.

---

## SECTION 7: RECOMMENDED RPC PARAMETERS

### Parameter design decisions

**Sale number generation:** Kept in Node.js. The `generateSaleNumber()` function uses `Date.now()` + 4 random chars. It could move to SQL using `EXTRACT(EPOCH FROM NOW())::BIGINT || '-' || UPPER(substr(md5(random()::text), 1, 4))`, but keeping it in Node.js avoids adding string generation logic to the SQL function and is simpler.

**Items and payments:** Passed as `JSONB` arrays. SQL's `jsonb_array_elements` unpacks them for batch insert. This avoids the complexity of PostgreSQL array types for structured data.

**Computed totals:** Passed from Node.js as pre-calculated scalars. The SQL function trusts these values because they were derived from DB prices (not from the frontend). The SQL does NOT recalculate — it uses what Node.js sends.

---

### Recommended RPC signature

```sql
CREATE OR REPLACE FUNCTION create_sale_atomic(
  -- Identity (from JWT, not from request body)
  p_company_id      INT,
  p_user_id         INT,

  -- Generated in Node.js
  p_sale_number     TEXT,
  p_receipt_number  TEXT,

  -- From request body (optional fields)
  p_till_session_id INT     DEFAULT NULL,
  p_customer_id     INT     DEFAULT NULL,
  p_payment_method  TEXT    DEFAULT 'cash',
  p_notes           TEXT    DEFAULT NULL,

  -- Calculated in Node.js from DB prices
  p_subtotal        NUMERIC,
  p_discount_amount NUMERIC DEFAULT 0,
  p_vat_amount      NUMERIC,
  p_total_amount    NUMERIC,

  -- Structured data as JSONB arrays
  p_items           JSONB,
  p_payments        JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
...
$$;
```

---

### `p_items` JSONB structure (one object per cart item)

```json
[
  {
    "product_id":   1,
    "product_name": "Milk 1L",
    "quantity":     2,
    "unit_price":   25.99,
    "vat_rate":     15,
    "line_total":   51.98,
    "discount_amount": 0
  },
  {
    "product_id":   4,
    "product_name": "Bread White",
    "quantity":     1,
    "unit_price":   18.50,
    "vat_rate":     0,
    "line_total":   18.50,
    "discount_amount": 0
  }
]
```

**Fields included:**
- `product_id` — FK for sale_items + argument to `decrement_stock`
- `product_name` — denormalised into sale_items (from DB lookup, not frontend)
- `quantity` — for sale_items + `decrement_stock` argument
- `unit_price` — for sale_items (from DB lookup)
- `vat_rate` — for sale_items (from DB, default 15)
- `line_total` — for sale_items.line_total and sale_items.total_price
- `discount_amount` — for sale_items (currently always 0)

---

### `p_payments` JSONB structure (one object per payment)

```json
[
  {
    "payment_method": "cash",
    "amount":         100.00,
    "reference":      null
  }
]
```

Or for split payment:
```json
[
  { "payment_method": "cash",   "amount": 100.00, "reference": null },
  { "payment_method": "card",   "amount":  50.00, "reference": "CARD-REF-123" }
]
```

---

### Recommended RETURN payload

The function returns a `JSONB` object with the created sale's key identifiers:

```json
{
  "sale_id":        123,
  "sale_number":    "SAL-1715000000-ABCD",
  "receipt_number": "RC-1715000000-ABCD",
  "total_amount":   150.00,
  "status":         "completed"
}
```

Node.js then builds the full response from this JSONB plus what it already knows from the product lookup and enrichedItems. It does NOT need to re-query Supabase for the created sale.

---

## SECTION 8: NODE.JS RESPONSE CONSTRUCTION (POST-RPC)

After the RPC returns, the Node.js route builds the response:

```javascript
// rpcResult = { sale_id, sale_number, receipt_number, total_amount, status }

const responsePayload = {
  // Nested sale object (current contract — keeps backward compat)
  sale: {
    id:             rpcResult.sale_id,
    sale_number:    rpcResult.sale_number,
    receipt_number: rpcResult.receipt_number,
    total_amount:   rpcResult.total_amount,
    subtotal,
    vat_amount:     vat_total,
    discount_amount: discount,
    payment_method,
    status:         'completed',
    company_id:     req.companyId,
    user_id:        req.user.userId,
  },
  // Top-level camelCase aliases (fixes pre-existing frontend bug)
  saleId:       rpcResult.sale_id,
  saleNumber:   rpcResult.sale_number,
  totalAmount:  rpcResult.total_amount,
};

res.status(201).json(responsePayload);
```

No second database read is required. The Node.js route already holds all the data needed to construct the response.

---

## SECTION 9: EXACT SALES.JS SECTIONS THAT WILL BE REPLACED

### Sections that are REMOVED (replaced by the single RPC call)

```
Lines 211-237:  ── 4. Create the sale record ──
Lines 239-258:  ── 5. Insert sale items ──
Lines 260-282:  ── 6. Insert payment records ──
Lines 284-355:  ── 7. Decrement stock (patched block) ──
Lines 302-307:  res.status(201).json({ sale });
```

These ~110 lines of sequential Supabase calls become one RPC call plus response construction.

### Sections that are UNCHANGED (kept exactly as-is)

```
Lines 124-135:  normaliseSaleBody() + body destructuring
Lines 137-151:  Items empty check + productIds dedup
Lines 153-163:  Product DB lookup (supabase.from('products').select(...))
Lines 165-179:  ── 2. Stock pre-check ──
Lines 181-209:  ── 3. Totals calculation + payment validation ──
Lines 211-213:  sale number + receipt number generation
Lines 302-305:  auditFromReq() call (moves to after successful RPC)
Lines 308-311:  catch block
```

### New section added (replaces lines 215-307)

```javascript
// ── 4. Atomic sale creation via Supabase RPC ──────────────────────────
const { data: rpcResult, error: rpcError } = await supabase.rpc('create_sale_atomic', {
  p_company_id:      req.companyId,
  p_user_id:         req.user.userId,
  p_sale_number:     saleNumber,
  p_receipt_number:  receiptNumber,
  p_till_session_id: till_session_id || null,
  p_customer_id:     customer_id || null,
  p_payment_method:  payment_method || 'cash',
  p_notes:           notes || null,
  p_subtotal:        subtotal,
  p_discount_amount: discount,
  p_vat_amount:      vat_total,
  p_total_amount:    total_amount,
  p_items:           JSON.stringify(enrichedItems.map(item => ({
    product_id:      item.product_id,
    product_name:    item.product.product_name,
    quantity:        item.quantity,
    unit_price:      item.product.unit_price,
    vat_rate:        item.product.vat_rate || 15,
    line_total:      item.line_total,
    discount_amount: 0,
  }))),
  p_payments:        JSON.stringify(payments),
});

if (rpcError) {
  const msg = (rpcError.message || '').toLowerCase();
  if (msg.includes('insufficient stock')) {
    return res.status(422).json({ error: 'Stock check failed', details: [rpcError.message] });
  }
  console.error('[Sales] create_sale_atomic failed:', rpcError);
  return res.status(500).json({ error: 'Sale creation failed', details: rpcError.message });
}

// ── 5. Audit + response ───────────────────────────────────────────────
await auditFromReq(req, 'CREATE', 'sale', rpcResult.sale_id, {
  module:   'pos',
  newValue: { saleNumber, total_amount, items: enrichedItems.length },
});

res.status(201).json({
  sale: {
    id:             rpcResult.sale_id,
    sale_number:    rpcResult.sale_number,
    receipt_number: rpcResult.receipt_number,
    total_amount:   rpcResult.total_amount,
    subtotal,
    vat_amount:     vat_total,
    discount_amount: discount,
    payment_method,
    status:         'completed',
  },
  saleId:      rpcResult.sale_id,
  saleNumber:  rpcResult.sale_number,
  totalAmount: rpcResult.total_amount,
});
```

---

## SECTION 10: RISKS TO AVOID

### Risk 1 — `p_items` JSONB field names must match SQL exactly

The SQL function will access items using JSONB operators:
```sql
(item->>'product_id')::INT
(item->>'quantity')::INT
(item->>'line_total')::NUMERIC
```

Field names in the JSONB must match exactly what the SQL function expects — snake_case. The Node.js side must NOT pass camelCase keys into the JSONB (e.g. `productId` would fail to cast with `->>'product_id'`).

**Guard:** Use an explicit `.map()` on `enrichedItems` when building `p_items` to ensure snake_case keys.

### Risk 2 — NULL handling for optional JSONB fields

Fields like `reference` in payments can be null. PostgreSQL's JSONB handles `null` values correctly, but the Node.js `JSON.stringify` of `null` produces `"null"` as a JSON value, which Supabase will pass correctly as SQL `NULL` when cast.

### Risk 3 — `total_price` vs `line_total` in sale_items

The current insert sets BOTH `line_total` AND `total_price` to the same value. The schema has both columns. The SQL function must insert both. If only one is inserted, rows where only one column is queried will return NULL for the other.

### Risk 4 — Payment construction must happen before the RPC call

Currently, payment records are constructed at lines 262-279 using logic that handles both single and split payments. This logic must run BEFORE the `create_sale_atomic` call so the `p_payments` JSONB is ready. The logic itself is unchanged — only its timing moves from "before insert" to "before RPC call".

### Risk 5 — `auditFromReq` must happen AFTER the RPC, with the real sale ID

Currently audit logs at line 302 use `sale.id` from the just-created record. With the RPC, the sale ID comes from `rpcResult.sale_id`. The audit log call is correct as long as it runs after a successful RPC response.

### Risk 6 — Error message matching for insufficient stock detection

The P0001 detection uses `rpcError.message.toLowerCase().includes('insufficient stock')`. The `decrement_stock` function raises:
```
'Insufficient stock for product %: cannot decrement by %'
```

This string includes `'insufficient stock'` — the check works. However, if the `RAISE EXCEPTION` message in `decrement_stock` ever changes, this string check would break. This is acceptable for now but should be noted.

---

## SECTION 11: RECOMMENDED IMPLEMENTATION ORDER

### Step A — Write migration `025_pos_create_sale_atomic.sql`

Create the SQL function. Test it in isolation by calling it from the Supabase SQL Editor with a sample payload:
```sql
SELECT create_sale_atomic(
  1,            -- company_id
  1,            -- user_id
  'SAL-TEST-01', 'RC-TEST-01',
  5, NULL, 'cash', NULL,
  100.00, 0, 13.04, 100.00,
  '[{"product_id":1,"product_name":"Test","quantity":1,"unit_price":100.00,"vat_rate":15,"line_total":100.00,"discount_amount":0}]'::JSONB,
  '[{"payment_method":"cash","amount":100.00,"reference":null}]'::JSONB
);
```

Expected: returns `{ sale_id: N, sale_number: "SAL-TEST-01", ... }` and the row exists in `sales`.

### Step B — Patch `sales.js` (replace lines 215-307)

Replace the four sequential Supabase calls with the single RPC call plus response construction as described in Section 9. Keep all pre-RPC logic unchanged.

### Step C — Code review against the contract

Verify:
- `p_items` JSONB uses snake_case field names
- `p_payments` JSONB is built correctly for both single and split
- Response includes both nested `sale` AND top-level `saleId`/`saleNumber`/`totalAmount`
- Error handling covers P0001 (insufficient stock) and generic 500
- `auditFromReq` uses `rpcResult.sale_id` not `sale.id`

### Step D — Test the scenarios from the test plan (14_TEST_PLAN.md)

Minimum required before deploying:
- T4.1 Standard cash sale
- T5.1 Standard card sale
- T6.1 Split cash + card
- T7.2 Account sale
- T10.2 Oversell attempt (should 422)
- T3.6 Empty cart (should 400 before reaching RPC)

---

*Contract locked. No code changes made in this step.*
*Next step: Phase 1 Step 3C — implement migration 025 and patch sales.js.*
