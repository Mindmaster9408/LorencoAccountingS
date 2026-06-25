# Lorenco Ecosystem — RLS Implementation Plan
**Date:** 2026-06-25  
**Status:** Design only — no policies applied, no production behaviour changed  
**Author:** Security audit + architecture review  
**Related:** `docs/LORENCO_ECOSYSTEM_ACCESS_FORENSIC_AUDIT_2026-06-25.md` (RISK-01)

---

## Executive Summary

The ecosystem has application-layer multi-tenancy (service-role Supabase + middleware `WHERE company_id = req.companyId`) but no database-layer RLS enforcement. RLS is enabled on all tables but no policies exist — so the service-role key bypasses it completely.

This document defines:
- Which tables can safely get RLS policies first
- Which tables are dangerous or complex
- What would break if policies were enabled today
- A phased rollout with no production risk
- Required tests before any enforcement

**The fundamental constraint:** The backend connects exclusively via the Supabase service-role key. Service-role bypasses ALL RLS policies regardless of what policies are defined. To actually enforce RLS at the database layer, the backend must forward user context to Postgres. The recommended mechanism (Phase 2) is Postgres session variables via the existing pg Pool.

---

## 1. Current Architecture

### 1.1 Database Key Usage

**All backend routes use service-role key only.**

```
database.js line 23:
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    autoRefreshToken: false,
    persistSession: false
  })
```

`supabaseAnon` is exported but no route file imports it for data queries.

Additionally, two modules create their own Supabase client directly:
- `backend/modules/practice/tax-pipeline.js` (line 14)
- `backend/modules/practice/tax-submissions.js` (line 14)

Both use `process.env.SUPABASE_SERVICE_KEY` — these must be updated when RLS enforcement begins.

### 1.2 RLS State Today

- RLS is **enabled** on all tables (standard Supabase behaviour)
- **Zero policies exist** — enabled but unenforced
- Service-role key bypasses RLS entirely regardless of policy state
- Result: RLS is architecturally inert today. No production behaviour would change if policies were added now.

### 1.3 Isolation Model

All multi-tenant isolation is currently application-layer:

```
Request → JWT (companyId embedded) → authenticateToken → req.companyId set
→ route handler → .eq('company_id', req.companyId) on every query
```

Hotfix 03 (2026-06-25) added DB-level verification that the user+company membership is still active, but the actual data queries remain application-scoped, not DB-scoped.

---

## 2. Complete Table Inventory

### 2.1 Category A — Simple Company-Scoped (Safe for Phase 3 RLS)

These tables have a single `company_id` column that defines ownership. RLS policy pattern: `company_id = current_setting('app.company_id')::int`. All routes already filter by this column.

**POS / Retail (15 tables)**

| Table | Key column | Notes |
|---|---|---|
| products | company_id | Product master |
| sales | company_id | Transaction master |
| sale_items | sale_id → company_id | Child of sales |
| customers | company_id | POS customer master |
| tills | company_id | Terminal config |
| till_sessions | company_id | Cash tracking |
| pos_daily_discounts | company_id | Promotional rules |
| pos_returns | company_id | Return/refund log |
| inventory_adjustments | company_id | Stock adjustments |
| pos_stock_takes | company_id | Count masters |
| pos_stock_take_items | company_id | Count detail |
| pos_supplier_receives | company_id | Receiving log |
| pos_supplier_receive_items | company_id | Receive detail |
| pos_stock_transfers | company_id | Transfer master |
| pos_stock_transfer_items | company_id | Transfer detail |
| loyalty_programs | company_id UNIQUE | One per company |
| loyalty_transactions | company_id | Loyalty ledger |
| customer_account_transactions | company_id | Credit ledger |
| pos_emergency_state | company_id (PK) | System state |

**Payroll (5 tables)**

| Table | Key column | Notes |
|---|---|---|
| employees | company_id | Employee master |
| payroll_runs | company_id | Pay run master |
| payroll_items | (via run) | Payroll detail |
| payroll_recon_submitted | company_id | PAYE/UIF recon |
| payroll_recon_finalized | company_id | Year-end finalization |

**Accounting (10 tables)**

| Table | Key column | Notes |
|---|---|---|
| accounts | company_id | Chart of accounts |
| journals | company_id | GL transactions |
| customer_invoices | company_id | AR master |
| customer_invoice_lines | (via invoice) | AR detail |
| customer_quotes | company_id | Quote master |
| customer_quote_lines | (via quote) | Quote detail |
| accounting_items | company_id | Item master |
| customer_credit_notes | company_id | Credit notes |
| legacy_gl_import_batches | company_id | Import staging |
| legacy_gl_import_lines | (via batch) | Import rows |

**Inventory / Storehouse (6 tables)**

| Table | Key column | Notes |
|---|---|---|
| warehouses | company_id | Location master |
| inventory_items | company_id | Stock master |
| suppliers | company_id | Supplier master |
| stock_movements | company_id | Movement log |
| purchase_orders | company_id | PO master |
| purchase_order_items | (via PO) | PO detail |

**Practice Management — Core (12 tables)**

| Table | Key column | Notes |
|---|---|---|
| practice_profiles | company_id | Firm identity |
| practice_clients | company_id | Practice's client roster |
| practice_client_contacts | company_id | Client contacts |
| practice_tasks | company_id | Task master |
| practice_task_review_events | company_id | Review audit |
| practice_time_entries | company_id | Time tracking |
| practice_deadlines | company_id | Compliance calendar |
| practice_deadline_events | company_id | Deadline audit |
| practice_team_members | company_id | Staff roster |
| practice_engagements | company_id | Service engagements |
| practice_engagement_events | company_id | Engagement audit |
| practice_billing_rates | company_id | Billing config |

**Practice Tax (14 tables)**

| Table | Key column | Notes |
|---|---|---|
| practice_taxpayer_profiles | company_id | Tax data repository |
| practice_individual_tax_data | company_id | Individual returns |
| practice_individual_tax_calculations | company_id | Calculated values |
| practice_company_tax_data | company_id | Company returns |
| practice_company_tax_calculations | company_id | Calculated values |
| practice_tax_year_configuration | company_id | Year settings |
| practice_provisional_tax_planning | company_id | Provisional tax |
| practice_tax_checklist_templates | company_id | Checklist library |
| practice_tax_work_actions | company_id | Action tracking |
| practice_tax_filing_pipeline | company_id | E-filing workflow |
| practice_tax_submission_register | company_id | Filed returns register |
| practice_individual_tax_review_packs | company_id | Review pack docs |
| practice_company_tax_review_packs | company_id | Company review packs |
| practice_compliance_packs | company_id | Compliance bundles |

**SEAN AI — Company-Scoped (8 tables)**

| Table | Key column | Notes |
|---|---|---|
| sean_codex_entries | company_id | Private AI knowledge |
| sean_bank_transactions | company_id | Accounting data |
| sean_learning_log | company_id | Audit trail |
| sean_import_logs | company_id | Import tracking |
| sean_transaction_store | company_id | Payroll learning |
| sean_sync_log | company_id | Sync audit |
| sean_coaching_cases | company_id | Coaching cases |
| sean_coaching_audit_log | company_id | Coaching audit |

**Other company-scoped (3 tables)**

| Table | Key column | Notes |
|---|---|---|
| user_pos_pins | company_id + user_id | Cashier PIN auth |
| pos_pin_attempts | company_id + user_id | Auth audit |
| pos_user_product_shortcuts | company_id + user_id | UI preferences |

**Total Category A: ~93 tables**

---

### 2.2 Category B — Complex Ownership (Requires Custom Policies)

These tables need multi-company or hierarchical policies. Do NOT apply simple RLS to these.

| Table | Problem | Required RLS Logic |
|---|---|---|
| inter_company_invoices | sender_company_id OR receiver_company_id both own the row | `(sender_company_id = app.company_id) OR (receiver_company_id = app.company_id)` |
| inter_company_relationships | Both company_a_id and company_b_id have access | Same symmetric OR pattern |
| eco_clients | managing firm (company_id) + client tenant (client_company_id) are different | Two separate policies: managing firm sees via company_id; client sees via client_company_id |
| eco_client_firm_access | Grant table — firm B can see eco_client X if firm B is in the grant table | Subquery: `firm_company_id = app.company_id OR eco_client_id IN (SELECT eco_client_id FROM eco_client_firm_access WHERE firm_company_id = app.company_id)` |
| sean_knowledge_items | company_id is nullable — NULL means global (shared across all companies) | `company_id = app.company_id OR company_id IS NULL` |
| sean_allocation_rules | is_global = true rows visible to all | `company_id = app.company_id OR is_global = true` |
| practice_workflow_templates | company_id as BIGINT but also used for global templates (nullable) | `company_id = app.company_id OR company_id IS NULL` |

---

### 2.3 Category C — Service-Role Only (Never Apply User-Facing RLS)

These tables are queried exclusively by system processes or super-admin routes. Enabling user-facing RLS policies on them would achieve nothing (still service-role) and creates maintenance risk.

| Table | Reason |
|---|---|
| users | Global table — login, admin, session management. Never user-scoped. |
| companies | Multi-tenant root — super-admin and login flows only. |
| user_company_access | Access control table itself — must remain globally queryable by auth middleware. |
| feature_flags | System-wide config — no company scope. |
| password_reset_tokens | Auth security table — scoped by user_id only, server-side only. |
| payroll_kv_store_eco | Internal KV store — queried by key prefix, not company_id. |
| sean_global_patterns | No company_id column at all — cross-company aggregations by design. |
| legacy_gl_account_mappings | Import mapping library — may be cross-company. |

---

## 3. What Would Break If We Enabled RLS Policies Today

Even if we defined correct RLS policies, the service-role key means they have zero effect — so "today" there is literally no breakage. But if we also switched to the anon key (enforcement mode), the following would break:

### 3.1 Authentication Routes (auth.js)

| Route | Query | Break Reason |
|---|---|---|
| POST /login | `FROM users WHERE email = ...` | No company_id filter — would return no rows under company RLS |
| POST /forgot-password/request | `FROM users WHERE email = ...` | Same — global user lookup |
| POST /forgot-password/reset | `FROM users WHERE id = ...` | user_id only, no company_id |
| GET /me | `FROM users WHERE id = req.user.userId` | User not in any company context at this point |
| POST /select-company | `FROM user_company_access JOIN companies` | No company filter — listing companies by user |
| POST /register | `INSERT INTO users` | No company context at registration time |

**Impact: Total auth failure. No one can log in.**

### 3.2 Admin Panel (admin-panel.js)

| Route | Query | Break Reason |
|---|---|---|
| GET /api/admin/users | `FROM users` (all users) | Cross-company; super-admin view |
| GET /api/admin/companies | `FROM companies` (all companies) | Cross-company; global admin |
| POST /api/admin/companies | `INSERT INTO companies` | No company context yet |
| PUT /api/admin/users/:id | `UPDATE users` | Global user edit |

**Impact: Admin panel becomes non-functional.**

### 3.3 ECO Clients (eco-clients.js)

| Route | Query | Break Reason |
|---|---|---|
| POST /api/eco-clients | `INSERT INTO companies` + `INSERT INTO eco_clients` | Creates new company row — no company context yet |
| GET /api/eco-clients | `FROM eco_clients JOIN companies` | Needs cross-company visibility to find managed clients |
| POST /api/eco-clients/:id/link-firm | `INSERT INTO eco_client_firm_access` | Grant table update — crosses company boundaries |

**Impact: ECO client management breaks for all practice firms.**

### 3.4 Ecosystem Companies (companies.js)

| Route | Query | Break Reason |
|---|---|---|
| GET /api/companies (super admin) | `FROM companies` (all) | Global view — blocked by company-scoped RLS |
| POST /api/companies | `INSERT INTO companies` | No company context at creation time |

**Impact: Company management route fails.**

### 3.5 Practice Tax Pipeline and Tax Submissions

These files create their own Supabase client with `process.env.SUPABASE_SERVICE_KEY` directly. Even in enforcement mode they would bypass RLS — but this means they would NOT be protected by RLS either. Must be refactored before RLS means anything for these modules.

### 3.6 Inter-Company Invoicing

`inter_company_invoices` queries must see rows where the requester is EITHER the sender OR the receiver. Simple company-scoped RLS with `company_id = app.company_id` would only show half the invoices.

### 3.7 SEAN Global Patterns

`sean_global_patterns` has no `company_id` column. Any SELECT policy on this table would return zero rows under user-context because there is no column to match against.

---

## 4. The Enforcement Architecture Problem

### 4.1 Why Service Role + RLS = No Protection

```
Backend request → service role key → Supabase
                                         ↓
                              RLS policies? BYPASSED.
                              Every row visible.
                              app-layer WHERE clauses are the only guard.
```

Service-role key is a superuser key. It bypasses all RLS unconditionally. This is by design — Supabase needs it for admin operations. But using it for ALL queries means RLS is permanently inert.

### 4.2 The Required Architecture Shift

To enforce RLS, the backend must pass user context to Postgres so policies can evaluate it. Two viable mechanisms:

**Mechanism 1 — Postgres session variables via pg Pool (Recommended)**

The backend already has a `pg.Pool` connected to Supabase's direct Postgres endpoint (used for migrations). For user-facing queries:

```javascript
// Before any user data query in a request:
await pool.query(`SELECT set_config('app.company_id',   $1, true)`, [String(req.companyId)]);
await pool.query(`SELECT set_config('app.user_id',      $2, true)`, [String(req.user.userId)]);
await pool.query(`SELECT set_config('app.is_super_admin', $3, true)`, [String(req.user.isSuperAdmin)]);
```

RLS policy:
```sql
CREATE POLICY "company_isolation" ON practice_clients
  USING (
    company_id = current_setting('app.company_id', true)::integer
    OR current_setting('app.is_super_admin', true)::boolean = true
  );
```

Pros: No Supabase Auth migration required. Works with existing JWT auth.  
Cons: Requires all routes to use pg Pool queries instead of Supabase JS client. Significant migration effort.

**Mechanism 2 — Custom Supabase JWT (Medium effort)**

Configure Supabase to trust our JWT_SECRET. Then use the anon key + forward our JWT token to Supabase:

```javascript
// Create per-request Supabase client with user's JWT
const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${req.token}` } }
});
```

RLS policy using JWT claims:
```sql
CREATE POLICY "company_isolation" ON practice_clients
  USING (
    company_id = (auth.jwt()->>'companyId')::integer
    OR (auth.jwt()->>'isSuperAdmin')::boolean = true
  );
```

Pros: Uses Supabase native JWT claim extraction. Cleaner policies.  
Cons: Must create a per-request Supabase client on every request. Performance impact. Must configure Supabase project JWT secret to match ours.

---

## 5. Phased Implementation Plan

### Phase 0 — NOW (Design Only, Zero Risk)

**Status: This document is Phase 0.**

Actions:
- [x] Audit all tables and classify ownership
- [x] Identify cross-company queries that break under enforcement
- [x] Document the enforcement architecture problem
- [ ] Get team agreement on enforcement mechanism (pg Pool vs anon key JWT)

No code changes. No policy changes. Production unchanged.

---

### Phase 1 — Write Policies, No Enforcement (Safe to deploy any time)

**Goal:** Define all RLS policies in SQL without enforcement. Since the backend uses service-role, adding policies changes nothing in production.

**Why this is safe:** Service-role key bypasses all policies unconditionally. Adding policies to a service-role-only backend is like writing comments — they are evaluated for anon/authenticated roles only.

**What to do:**

Create `backend/config/migrations/091_rls_policies_phase1.sql`:

```sql
-- PHASE 1 RLS POLICIES — DEFINED BUT NOT ENFORCED
-- Backend uses service-role key which bypasses all policies.
-- These are pre-staged for Phase 3 enforcement.

-- Helper function: get current app company_id (set per-request via set_config)
CREATE OR REPLACE FUNCTION app_company_id()
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::integer
$$;

-- Helper function: is the current session a super admin?
CREATE OR REPLACE FUNCTION app_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.is_super_admin', true), '')::boolean
$$;

-- Example for one Category A table (practice_clients):
ALTER TABLE practice_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "practice_clients_company_isolation"
  ON practice_clients
  USING (
    app_is_super_admin() = true
    OR company_id = app_company_id()
  );

-- Repeat for all Category A tables...
```

Apply the same pattern to all 93 Category A tables. No behaviour change.

**Testing for Phase 1:** None required. Policies are inert under service-role.

---

### Phase 2 — Enforcement Infrastructure (Medium effort, targeted scope)

**Goal:** Build the mechanism to pass user context to Postgres per request. Test against a non-production table first.

**What to do:**

1. Add a `createUserScopedClient(req)` function to `database.js`:

```javascript
function createUserScopedClient(req) {
  // Creates a client that enforces RLS by forwarding our JWT.
  // Requires SUPABASE_ANON_KEY in env and Supabase project configured
  // to accept our JWT_SECRET.
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${req.headers.authorization?.split(' ')[1]}` }
    }
  });
}
```

OR, for the pg Pool approach:

```javascript
async function withUserContext(pool, req, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.company_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.is_super_admin', $3, true)`,
      [String(req.companyId || ''), String(req.user.userId), String(!!req.user.isSuperAdmin)]
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

2. Pick ONE low-risk, low-traffic table (e.g., `pos_user_product_shortcuts`) and convert its routes to use the user-scoped client. Verify RLS policy blocks cross-company access in a staging environment.

3. Fix `tax-pipeline.js` and `tax-submissions.js` to use the shared service-role client from `database.js` instead of creating their own.

**Testing for Phase 2:**
- User A with companyId=1 cannot query pos_user_product_shortcuts rows owned by companyId=2
- Super admin CAN query any company's rows
- Performance: measure p95 latency before/after

---

### Phase 3 — Rollout Category A Tables (Significant effort, high reward)

**Goal:** Enforce RLS for all 93 simple company-scoped tables.

**Migration order (lowest to highest risk):**

```
Wave 1 (UI-preference / non-critical):
  pos_user_product_shortcuts, pos_pin_attempts, user_pos_pins

Wave 2 (Inventory / Storehouse):
  warehouses, inventory_items, suppliers, stock_movements,
  purchase_orders, purchase_order_items

Wave 3 (Practice Management — non-tax):
  practice_profiles, practice_team_members, practice_clients,
  practice_client_contacts, practice_tasks, practice_time_entries,
  practice_deadlines

Wave 4 (Practice Tax — most sensitive):
  practice_taxpayer_profiles, practice_individual_tax_data,
  practice_company_tax_data, practice_tax_filing_pipeline,
  practice_tax_submission_register [and all other practice_tax_* tables]

Wave 5 (Payroll — stability-locked, highest risk):
  employees, payroll_runs, payroll_items,
  payroll_recon_submitted, payroll_recon_finalized

Wave 6 (Accounting):
  accounts, journals, customer_invoices, [and all accounting_* tables]

Wave 7 (POS Transactions — highest volume):
  sales, sale_items, customers, products, tills, [all pos_* tables]

Wave 8 (SEAN AI):
  sean_codex_entries, sean_bank_transactions, [all company-scoped sean_* tables]
```

**Gate for each wave:** Wave N cannot begin until Wave N-1 has passed all regression tests in staging AND no incidents in 72 hours of production traffic.

---

### Phase 4 — Category B Complex Tables (High effort, expert design required)

**Goal:** Custom policies for inter-company, eco-client, and SEAN global tables.

Must be designed individually. No mass rollout.

**Table-specific design:**

| Table | Policy Design |
|---|---|
| inter_company_invoices | Two SELECT policies: one for sender_company_id, one for receiver_company_id |
| eco_clients | SELECT: `company_id = app_company_id() OR client_company_id = app_company_id()` |
| eco_client_firm_access | SELECT via function: check grant table for current firm |
| sean_knowledge_items | `company_id = app_company_id() OR company_id IS NULL` |
| sean_allocation_rules | `company_id = app_company_id() OR is_global = true` |

Phase 4 requires staging validation before any production deployment.

---

### Phase 5 — Category C Tables (System tables — permanent service-role)

`users`, `companies`, `user_company_access`, `feature_flags`, `password_reset_tokens`, `sean_global_patterns`, `payroll_kv_store_eco` remain service-role only. No user-facing RLS policies needed or wanted.

If in the future a specific user-facing read endpoint is added for any of these (e.g., a user reading their own profile), a targeted policy may be appropriate — but only for that specific operation.

---

## 6. Required Tests Before Any Enforcement Rollout

The following tests must pass in staging before enabling enforcement for each Phase 3 wave. Apply Paytime regression discipline (RULE E3 equivalent) to every wave.

### 6.1 Isolation Tests

```
TEST-RLS-01: Company A user reads only Company A rows from the target table.
TEST-RLS-02: Company B user reads only Company B rows (no bleed from A).
TEST-RLS-03: Super admin reads rows from all companies.
TEST-RLS-04: Super admin writes rows to companies they are not primarily assigned to.
TEST-RLS-05: User with revoked company access gets 0 rows (post-revocation).
TEST-RLS-06: Disabled user gets 0 rows.
```

### 6.2 Application Function Tests

```
TEST-RLS-07: Full POS checkout flow completes successfully (after Wave 7).
TEST-RLS-08: Payroll execute returns correct payslip (after Wave 5). Run full TEST-PAY-01 to TEST-PAY-14.
TEST-RLS-09: Practice client list returns correct subset per practice firm.
TEST-RLS-10: Tax filing pipeline saves and retrieves filing records correctly.
TEST-RLS-11: Accounting journal entries post and retrieve correctly.
TEST-RLS-12: SEAN learn + recall cycle works within company scope.
```

### 6.3 Edge Cases

```
TEST-RLS-13: Request with no companyId in JWT (pre-company-selection) receives no data rows.
TEST-RLS-14: Inter-company invoice is visible to both sender AND receiver after Phase 4.
TEST-RLS-15: Global SEAN patterns visible to all companies after Phase 4.
TEST-RLS-16: Performance: p95 latency delta is < 10 ms vs baseline for all wave tables.
```

### 6.4 Auth Flow Tests

```
TEST-RLS-17: Login succeeds (users table remains service-role; no RLS on login query).
TEST-RLS-18: Company selection returns correct company list.
TEST-RLS-19: SSO launch resolves eco_client correctly.
TEST-RLS-20: Password reset flow completes end-to-end.
```

---

## 7. Rollback Plan

### 7.1 Per-Table Rollback

Each phase creates policies via named migrations. Rollback:

```sql
-- Drop specific policies without disabling RLS
DROP POLICY IF EXISTS "practice_clients_company_isolation" ON practice_clients;
```

Policies can be dropped without restarting the server. The table remains RLS-enabled but unenforced (returns to current state).

### 7.2 Emergency Rollback — Revert to Service-Role Only

If an enforcement wave causes production incidents:

1. **Immediate (< 5 min):** In the database.js, switch the per-request client back to service-role. All policies become inert. No data loss, no restart required.

2. **Full revert (< 15 min):** Drop all Phase 3 policies via migration script. Apply `092_rls_rollback.sql`:

```sql
-- Emergency rollback: drop all user-context RLS policies
-- Service-role enforcement resumes automatically.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE policyname LIKE '%company_isolation%'
  ) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;
```

This script is idempotent. Safe to run multiple times.

### 7.3 What Rollback Does NOT Fix

- If rows were incorrectly written during an enforcement bug (e.g., wrong company_id), rollback does not fix data. Check audit_log before rollback to assess.
- Rollback does not restore sessions. Users may need to re-login if JWT context setup was part of the enforcement mechanism.

---

## 8. Answers to the Five Required Questions

### Q1: Which tables are safe for simple RLS first?

**93 tables in Category A** — all tables with a single `company_id` column where every existing route already filters by that column. Start with the lowest-traffic tables (UI preferences, inventory). See Wave 1–3 in Section 5 Phase 3.

The safest single table to start with (proof of concept, Phase 2): `pos_user_product_shortcuts` — low traffic, no compliance implications, easy to verify.

### Q2: Which tables are dangerous or complex?

**8 Category B tables** — inter_company_invoices, inter_company_relationships, eco_clients, eco_client_firm_access, sean_knowledge_items (nullable company_id), sean_allocation_rules (is_global flag), sean_global_patterns (no company_id column), practice_workflow_templates (nullable company_id).

**8 Category C tables** — system tables that must remain service-role-only forever: users, companies, user_company_access, feature_flags, password_reset_tokens, payroll_kv_store_eco, sean_global_patterns, legacy_gl_account_mappings.

Most dangerous Wave in Phase 3: Wave 5 (Payroll) and Wave 7 (POS transactions). These are the highest-volume, compliance-critical tables. Full TEST-PAY-01 to TEST-PAY-14 regression required before payroll wave.

### Q3: What would break if we enable policies today?

**Everything in the auth flow.** Login, password reset, company selection, `/api/auth/me`, and registration all query `users` and `companies` without company context. Enabling user-facing RLS on these tables while the backend has no mechanism to pass user context would return zero rows — complete auth failure.

Additionally: Admin panel, ECO client management, company creation, and inter-company invoicing all break. SEAN global patterns return zero rows permanently (no company_id column).

**Nothing breaks if we only define policies** (no enforcement mechanism added). Service-role key makes defined policies inert.

### Q4: What is the safest Phase 1?

**Define policies only.** Write the SQL for all 93 Category A policies and deploy them. No enforcement mechanism is added. No code changes. Service-role continues to bypass everything. This achieves:

- Policies are written, reviewed, and committed before any enforcement risk
- Infrastructure is staged and ready when Phase 2 begins
- Zero production risk

The only task with production risk is Phase 2 (adding the enforcement mechanism to forward user context to Postgres).

### Q5: What tests must pass before rollout?

All 20 tests in Section 6 must pass in staging. Priority order:

1. TEST-RLS-17 to TEST-RLS-20 (auth) — gates everything else
2. TEST-RLS-01 to TEST-RLS-06 (isolation) — core RLS correctness
3. TEST-RLS-16 (performance) — POS speed-critical paths must not degrade by > 10ms p95
4. TEST-RLS-07 to TEST-RLS-12 (application regression) — per wave, must match existing behaviour
5. TEST-RLS-13 to TEST-RLS-15 (edge cases) — after complex tables in Phase 4

---

## 9. Pre-Implementation Decisions Required

Before any Phase 1 code is written, these decisions must be made:

| Decision | Option A | Option B |
|---|---|---|
| Enforcement mechanism | pg Pool session variables (`set_config`) | Supabase anon key + JWT forwarding |
| Timeline | Phase 1 immediately (policies only) | Hold until enforcement mechanism chosen |
| Payroll wave sequencing | Run independently with full TEST-PAY-01–14 gate | Block until TEST-PAY suite is automated |
| Service-role carve-outs | Super admin bypass via `app_is_super_admin()` function | Separate service-role client for admin routes only |

**Recommendation:** Choose pg Pool session variables (Option A). The pg Pool already exists in the codebase (used for migrations). It avoids creating per-request Supabase clients and works with the existing custom JWT auth without configuring Supabase's JWT secret.

---

*This document describes design intent only. No RLS policies have been applied. No production behaviour has been changed. Review and approve before any Phase 1 SQL is written.*
