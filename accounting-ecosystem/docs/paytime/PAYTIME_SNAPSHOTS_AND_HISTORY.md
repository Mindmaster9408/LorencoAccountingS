# Paytime — Snapshots, History, and Immutability

> Last updated: 2026-04-29  
> Audited from source: `PayrollHistoryService.js`, `payruns.js`, `payroll_snapshots` schema

---

## 1. Purpose of Snapshots

A payroll snapshot is the permanent record of a payroll calculation. Once finalized, it cannot be changed. It exists so that:

1. Payslips are reproducible years after the fact without recalculating
2. SARS audits and corrections can reference the exact inputs and outputs used
3. Future engine upgrades do not invalidate historical payslips
4. The version of the engine used is permanently recorded per payslip

Every employee in every pay period has one snapshot per run. Finalized snapshots are immutable.

---

## 2. Snapshot Lifecycle

```
Draft → (optionally) Approved → Finalized → (optionally) Archived
```

| Status | `is_locked` | Meaning |
|---|---|---|
| `draft` | false | Calculation complete, not committed. Can be replaced by re-run. |
| `approved` | false | Reviewed and marked ready. Still editable. |
| `finalized` | **true** | **LOCKED. No updates permitted. Payslip is official.** |
| `archived` | true | Historical archive. Same as finalized for data purposes. |

**State transitions:**
- `POST /api/payroll/run` creates/replaces `draft` snapshots. If a `finalized` snapshot already exists for the employee+period, that employee is SKIPPED and reported in the errors list. Finalized payslips cannot be overwritten by a re-run.
- `POST /api/payroll/finalize` sets `is_locked = true` and `status = 'finalized'` for ALL draft snapshots in a period. It records `finalized_by` (user_id) and `finalized_at` (timestamp).

---

## 3. Snapshot Data Structure

Each snapshot stores the complete inputs AND complete outputs. Future code must never need to recalculate a historical payslip.

```javascript
{
  // Identity
  id:               uuid,
  company_id:       number,
  employee_id:      number,
  period_id:        number,
  period_key:       "YYYY-MM",

  // Lifecycle
  status:           "draft" | "approved" | "finalized" | "archived",
  is_locked:        boolean,

  // Complete Calculation Data
  calculation_input:  { ...full normalized input from PayrollDataService },
  calculation_output: { ...full engine output including all 17+ fields },

  // Tax Context (first-class fields for audit/IRP5 — surfaced from output)
  tax_context: {
    tax_year,
    tax_config_used,
    age_at_tax_year_end,
    rebate_primary,
    rebate_secondary,
    rebate_tertiary,
    medical_members,
    medical_credit_applied
  },

  // Engine Version (for future audit and compatibility)
  engine_version:   "2026-04-12-v1",
  schema_version:   "1.0",

  // Audit Trail
  created_by:       user_id,
  created_at:       ISO-8601,
  finalized_by:     user_id | null,
  finalized_at:     ISO-8601 | null,

  // Contextual Metadata
  metadata: {
    calculation_method:   "standard" | "prorata",
    pro_rata_factor:      number | null,
    expected_hours:       number | null,
    worked_hours:         number | null,
    pro_rata_start_date:  string | null,
    pro_rata_end_date:    string | null
  }
}
```

`calculation_input` and `calculation_output` are stored as deep copies (JSON.parse/JSON.stringify) — not references. The snapshot is completely self-contained.

---

## 4. Immutability Rules

These rules are non-negotiable. Violating them corrupts the historical payroll record.

**Rule 1:** Once `is_locked = true`, the row must not be updated by any route or service. Period.

**Rule 2:** `calculation_input` must contain the actual input values used, not references to employee records. Employee records can change — the snapshot must not change with them.

**Rule 3:** `calculation_output` must not be recomputed later. What is stored is what was calculated. If the engine is updated, old snapshots retain the old output.

**Rule 4:** `engine_version` and `schema_version` must be stored. They identify what engine produced the output. This is critical for debugging if a tax calculation is questioned years later.

**Rule 5:** Corrections require a new snapshot, not a mutation. The correction workflow (not yet built — see PAYTIME_ROADMAP.md) must create a new snapshot with `status = 'corrected'` or similar, linking to the original snapshot ID. The original is preserved unchanged.

---

## 5. Re-Run Behaviour

When `POST /api/payroll/run` is called for a period that already has snapshots:

| Existing state | Action |
|---|---|
| No snapshot | Creates new draft |
| Draft snapshot | Replaces with new draft (upsert) |
| Finalized snapshot | **Skips employee, adds to errors list** |

The API response includes both `processed` (succeeded) and `errors` (skipped) arrays, so the caller always knows exactly which employees were updated and which were protected.

---

## 6. Payroll Run Header Record

Each call to `POST /api/payroll/run` creates a `payroll_runs` header record with:
- `run_id` (UUID)
- `period_key`
- `company_id`
- `created_by`
- `created_at`

Individual employee snapshots reference the `run_id`. This allows the Pay Runs page to show all employees calculated in a single batch run.

---

## 7. History Retrieval

### Run History

`GET /api/payroll/history?period_key=YYYY-MM`

Returns all payroll run headers for the company, with per-employee snapshot summaries. Used by the Pay Runs page.

`GET /api/payroll/history/run/:runId`

Returns the full detail of one run (all employee snapshots for that run_id).

### Employee Period History

`GET /api/payroll/calculate/history/:employeeId/:periodKey`

Returns the snapshot for a specific employee in a specific period. Used by the Employee Detail page to show historical payslips.

---

## 8. PAYE Reconciliation Data Sources

The PAYE reconciliation page aggregates data from two tables:

| Table | What it contains |
|---|---|
| `payroll_transactions` | Transaction-level breakdown records from finalized live payroll runs |
| `payroll_historical` | Imported historical data (prior periods, mid-year company starts) |

Both are merged by `GET /api/payroll/recon/summary?taxYear=YYYY/YYYY`. The reconciliation page shows a unified view regardless of whether data came from live payroll runs or CSV import.

**Known issue:** `historical-import.html` currently writes imported records directly to localStorage, NOT to `payroll_historical`. This means historical import data is not visible to the recon API endpoint. The recon page falls back to `ReconService.buildPayrollTotals()` (localStorage-based) which sees the imported data — but only while that browser session's localStorage persists. See PAYTIME_RISKS_AND_PROTECTED_AREAS.md.

---

## 9. Engine Version Compatibility

Future engine upgrades must follow these rules:

1. **Never recalculate finalized snapshots.** Snapshots are self-contained. If re-displayed, use `calculation_output` exactly as stored.
2. **Never remove output fields.** The schema version `1.0` output contract includes 17+ fields. All must remain. New fields can be appended.
3. **Increment `ENGINE_VERSION`** when any calculation logic changes. Store the new version string in all new snapshots.
4. **Increment `SCHEMA_VERSION`** only when the output structure changes in a breaking way (field removed, field meaning changed, field order changed — none of which should happen).

If a bug in the engine is discovered that affects already-finalized payslips, the correct resolution is a correction run (new snapshot) — NOT retroactively updating the stored output of the old snapshot.

---

## Related Documents

- [PAYTIME_ARCHITECTURE.md](PAYTIME_ARCHITECTURE.md) — Request flow, database tables
- [PAYTIME_CALCULATION_AND_TAX.md](PAYTIME_CALCULATION_AND_TAX.md) — Engine output contract, tax tables
- [PAYTIME_WORKFLOWS.md](PAYTIME_WORKFLOWS.md) — How payroll runs and finalization work in practice
- [PAYTIME_ROADMAP.md](PAYTIME_ROADMAP.md) — Correction workflow (not yet built)
