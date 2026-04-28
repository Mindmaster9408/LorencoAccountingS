# Paytime Documentation

> Audit basis: Direct source reads of `accounting-ecosystem/` codebase, April 2026  
> Last updated: 2026-04-29  
> Applicable version: Commit `1353f39` (pushed April 28, 2026)

This is the index for the Paytime developer documentation suite. All documents are source-audited — they describe what the code actually does, not what it was intended to do.

Status labels used throughout: **✅ Working** | **⚠️ Partial** | **❌ Not built**

---

## Documents

| File | Purpose |
|---|---|
| [PAYTIME_MASTER_OVERVIEW.md](PAYTIME_MASTER_OVERVIEW.md) | Start here. What Paytime is, current status, key rules, where to go next. |
| [PAYTIME_ARCHITECTURE.md](PAYTIME_ARCHITECTURE.md) | Directory map, request flow, multi-tenancy, permissions, DB schema, deployment rules. |
| [PAYTIME_CAPABILITIES.md](PAYTIME_CAPABILITIES.md) | Full feature status matrix — what is working, partial, or not built. |
| [PAYTIME_WORKFLOWS.md](PAYTIME_WORKFLOWS.md) | Step-by-step workflows for common payroll operations. |
| [PAYTIME_CALCULATION_AND_TAX.md](PAYTIME_CALCULATION_AND_TAX.md) | Engine internals, SA tax tables, output contract, input assembly, all calculation rules. |
| [PAYTIME_SNAPSHOTS_AND_HISTORY.md](PAYTIME_SNAPSHOTS_AND_HISTORY.md) | Snapshot lifecycle, immutability rules, run/finalize flow, recon data sources. |
| [PAYTIME_NO_LOCALSTORAGE_RULE.md](PAYTIME_NO_LOCALSTORAGE_RULE.md) | The no-localStorage hard rule: why it exists, how polyfills.js works, how to comply. |
| [PAYTIME_RISKS_AND_PROTECTED_AREAS.md](PAYTIME_RISKS_AND_PROTECTED_AREAS.md) | Protected areas (don't regress), known gaps, compliance gaps, regression risk matrix. |
| [PAYTIME_ROADMAP.md](PAYTIME_ROADMAP.md) | What needs to be built or fixed, prioritised by impact. |

---

## Quick Start by Role

### I'm new — where do I start?
Read [PAYTIME_MASTER_OVERVIEW.md](PAYTIME_MASTER_OVERVIEW.md) first, then [PAYTIME_ARCHITECTURE.md](PAYTIME_ARCHITECTURE.md).

### I need to understand how PAYE is calculated
Read [PAYTIME_CALCULATION_AND_TAX.md](PAYTIME_CALCULATION_AND_TAX.md) — full engine internals, SA tax tables, input assembly, and all output fields.

### I'm about to modify the payroll engine or calculation path
Read [PAYTIME_RISKS_AND_PROTECTED_AREAS.md](PAYTIME_RISKS_AND_PROTECTED_AREAS.md) §1 first, then [PAYTIME_CALCULATION_AND_TAX.md](PAYTIME_CALCULATION_AND_TAX.md).

### I need to understand how to run payroll end-to-end
Read [PAYTIME_WORKFLOWS.md](PAYTIME_WORKFLOWS.md).

### I want to know what's broken or not built
Read [PAYTIME_CAPABILITIES.md](PAYTIME_CAPABILITIES.md) for a status matrix, and [PAYTIME_RISKS_AND_PROTECTED_AREAS.md](PAYTIME_RISKS_AND_PROTECTED_AREAS.md) for the risk register.

### I want to know what to build next
Read [PAYTIME_ROADMAP.md](PAYTIME_ROADMAP.md).

### I'm writing new frontend code and not sure where to store data
Read [PAYTIME_NO_LOCALSTORAGE_RULE.md](PAYTIME_NO_LOCALSTORAGE_RULE.md) before writing any line that touches storage.

### I'm debugging a snapshot or history issue
Read [PAYTIME_SNAPSHOTS_AND_HISTORY.md](PAYTIME_SNAPSHOTS_AND_HISTORY.md).

---

## Key Facts at a Glance

| Topic | Fact |
|---|---|
| Engine location | `backend/core/payroll-engine.js` |
| Engine version | `2026-04-12-v1` |
| Tax year (default) | 2026/2027 |
| Auth | JWT — `authenticateToken` + `requireCompany` on all payroll routes |
| Multi-tenancy | `company_id` on every DB query — mandatory |
| Business data storage | PostgreSQL (Supabase) — never localStorage |
| Snapshot immutability | Once `is_locked = true`, the row must never be updated |
| No-localStorage rule | `polyfills.js` monkey-patches all localStorage calls |
| Deployment | Zeabur via Dockerfile — `zbpack.json` must NEVER exist |
| SARS filing status | Calculation ✅ — Filing ❌ (EMP201/EMP501/IRP5 not yet built) |

---

## Non-Negotiable Rules (Quick Reference)

1. The engine (`payroll-engine.js`) is the **only** authority for tax calculations
2. Finalized snapshots (`is_locked = true`) are **immutable** — never update them
3. **No business data in localStorage** — all business data goes to SQL via API
4. Every DB query must include `.eq('company_id', companyId)`
5. Engine output fields are **additive only** — existing fields can never be removed or renamed
6. Sean global changes require **explicit human authorization** before propagation

For full rules, see [PAYTIME_MASTER_OVERVIEW.md](PAYTIME_MASTER_OVERVIEW.md) and CLAUDE.md.
