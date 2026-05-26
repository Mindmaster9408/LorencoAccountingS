# Codebox 01 — Risk Register
**Date:** May 2026  

---

| ID | Risk | Severity | Mitigation | Status |
|----|------|----------|-----------|--------|
| R01 | Migration 050 not yet applied in Supabase | High (blocks feature) | Run `050_inventory_stock_engine_hardening.sql` before going live | Open |
| R02 | `chk_current_stock_non_negative` VALIDATE CONSTRAINT fails if any row has `current_stock < 0` | Medium | Run pre-check diagnostic query; correct negative rows before migration | Open |
| R03 | PO receive was silently broken before Codebox 01 | High (existing bug) | Fixed in Codebox 01 — route no longer calls broken RPC directly | Resolved |
| R04 | `adjustStock()` still importable from stock-helpers.js | Low | Helper now throws `Error` on call; any missed call site will surface at runtime | Resolved |
| R05 | Forensic tables (`stock_valuation_movements` etc.) have no historical data | Low | Tables only populate from this point forward; backfill is a future codebox decision | Accepted |
| R06 | Concurrency test not yet executed against live DB | Medium | Test script written; requires live Supabase + applied migration | Open |
| R07 | `work_order_costs` and FIFO layer depletion on stock-out not yet implemented | Low | Architecture exists; Phase 2 of costing. Codebox 01 only creates the inbound layer rows | Accepted (Phase 2) |
| R08 | `stock_valuation_movements` has no RLS policy | Low | Module uses service role key for all mutations; RLS on these tables is a future governance task | Accepted (Phase 2) |
| R09 | `issue-materials` phase-2 loop could partially succeed if DB connection drops mid-loop | Medium | Each iteration is a separate DB transaction; partial success is visible in movement history. True all-or-nothing requires a stored procedure wrapping all iterations — Phase 2 | Accepted (Phase 2) |

---

## Open Risks Requiring Action Before Production Commit

1. **R01** — Apply migration 050 in Supabase SQL Editor
2. **R02** — Run negative stock diagnostic before migration
3. **R06** — Execute concurrency test script with a real Supabase item that has stock=100+
