# Codebox 12 — AI Operational Guidance Architecture

**Date:** 2026-05-30

---

## Philosophy

The AI operational layer in Storehouse is advisory-only. It explains, diagnoses, and recommends — but never mutates data, bypasses governance, or becomes a source of truth.

This is the contract with Sean AI:

> Sean reads operational context. Sean explains and advises. Sean never acts.

---

## What Was Built (Codebox 12)

### 1. Operational Health Engine (`operationalHealthService.js`)

Runs 10 diagnostic checks per company. Returns structured findings with:
- `type` — machine-readable issue identifier
- `severity` — critical / warning / info
- `title` — human-readable
- `count` — how many entities affected
- `affected` — up to 5 example entities
- `recommendation` — what to do
- `sean_hook` — the insight key Sean can request for deeper explanation

**Health checks implemented:**
| Check | Severity | Trigger |
|---|---|---|
| `items_missing_cost` | critical | Items with stock > 0 but avg_cost = 0 |
| `overdue_pos` | warning | POs in approved/ordered past expected_date |
| `wo_stuck` | warning | WOs in_progress > 7 days |
| `overcommitted` | critical | Net reservations > current_stock |
| `items_no_warehouse` | warning | Items with no warehouse_id |
| `items_no_base_unit` | info | Items without base_unit set |
| `unapproved_counts` | warning | Submitted counts older than 3 days |
| `no_default_warehouse` | info | Company has no default warehouse |
| `no_suppliers` | info | No active suppliers |
| `high_wastage` | warning | Batches with yield < 90% in last 30 days |

### 2. Inventory Insight Service (`inventoryInsightService.js`)

Maps each `sean_hook` to a structured explanation containing:
- `title` — the question being answered
- `explanation` — what caused this and why it matters
- `impact` — operational and financial consequences
- `recommendation` — concrete next steps
- `prevention` — how to avoid recurrence

**Insight types:**
- `stock_valuation_gap`
- `overdue_procurement`
- `production_blockage`
- `stock_shortage`
- `warehouse_gap`
- `uom_gap`
- `count_backlog`
- `yield_variance`
- `config_gap`
- `onboarding`

### 3. API Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/inventory/health` | INVENTORY.VIEW | Run all health checks, return issues + insights |
| `GET /api/inventory/onboarding` | INVENTORY.VIEW | Setup progress checklist |
| `GET /api/inventory/insights` | INVENTORY.VIEW | List available insight types |
| `GET /api/inventory/insights/:type` | INVENTORY.VIEW | Get specific insight explanation |
| `GET /api/inventory/sean-context` | INVENTORY.VIEW | Read-only summary for Sean AI |

---

## Sean AI Integration Contract

### What Sean CAN do:
- `GET /api/inventory/sean-context` — read operational summary
- `GET /api/inventory/health` — read current issues
- `GET /api/inventory/insights/:type` — read explanations
- `GET /api/inventory/reports/*` (with COST_VIEW) — read reporting data
- `GET /api/inventory/items` — read item list
- `GET /api/inventory/onboarding` — read setup status

### What Sean CANNOT do (hard architecture rule):
- POST / PUT / DELETE to any inventory endpoint
- Call `adjustStockTx()` or any stock mutation path
- Approve documents on behalf of a user
- Bypass `requirePermission()` middleware
- Read another company's data (company isolation applies equally to Sean)

### Integration Pattern:

```
User asks Sean about Storehouse
  ↓
Sean calls GET /api/inventory/sean-context
  ↓
Sean reads { system_status, critical_issues, warnings, onboarding_pending }
  ↓
Sean calls GET /api/inventory/insights/:type for deeper context
  ↓
Sean generates natural-language guidance using the structured data
  ↓
User reads Sean's advice and takes manual action in Storehouse
  ↓
Backend enforces permissions, mutations flow through normal routes
```

This ensures Sean's guidance is grounded in real-time data and its actions are bounded by Storehouse governance.

---

## Extending the Health Engine

To add a new health check:
1. Write an `async function checkXxx(supabase, companyId)` in `operationalHealthService.js`
2. Return `null` if no issue found
3. Return a finding object with: `type, severity, title, count, affected, recommendation, sean_hook`
4. Add the function to the `checkFns` array in `runHealthChecks()`
5. Add the corresponding insight to `INSIGHTS` in `inventoryInsightService.js`

No route changes needed — the health endpoint runs all registered checks automatically.
