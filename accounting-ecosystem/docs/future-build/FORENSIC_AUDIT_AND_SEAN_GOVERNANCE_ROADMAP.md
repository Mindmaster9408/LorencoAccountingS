# Forensic Audit & Sean Governance — Future Roadmap

**Status:** Phase 1 (Audit Trail Explorer) shipped.  
**Last updated:** 2026-05-24  
**Related implementation:** `docs/accounting/AUDIT_TRAIL_EXPLORER_IMPLEMENTATION_REPORT.md`

---

## 1. Ecosystem-Wide Audit Explorer

### Current state (Phase 1)
Phase 1 covers `accounting_audit_log` and `historical_comparative_audit_log` only, scoped to the authenticated company.

### Future vision
A unified forensic console that spans all apps in the ecosystem — POS, Payroll, Accounting, Sean — in a single timeline.

### What this requires
- A shared cross-app audit aggregation layer or federated query service
- The POS `pos_audit_events` table is already structured for this (company-scoped, ISO timestamps)
- Payroll audit trail currently fragmented — would need centralisation first
- Sean AI decision log (see Section 2) as a first-class audit source
- Company-level event stream: one timeline, all apps, chronologically ordered
- Role-based visibility: cashier sees POS events; accountant sees accounting events; admin sees all

### Schema addition needed
```sql
-- Shared audit correlation table (future)
CREATE TABLE ecosystem_audit_correlation (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    INTEGER NOT NULL,
  app           VARCHAR(30) NOT NULL,  -- 'accounting', 'pos', 'payroll', 'sean'
  source_table  VARCHAR(100) NOT NULL,
  source_id     TEXT NOT NULL,
  correlated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 2. Sean Decision Tracing

### Goal
Every action Sean takes or recommends must be traceable. Investigators and accountants must be able to see:
- What Sean was asked
- What data Sean accessed
- What recommendation Sean made
- What confidence level Sean had
- Whether the recommendation was accepted, overridden, or ignored
- What the downstream effect was (journal created? rule applied?)

### Decision trace shape
```json
{
  "traceId":        "uuid",
  "companyId":      1,
  "sessionId":      "uuid",
  "requestedAt":    "2026-05-24T09:12:34Z",
  "input":          { "type": "bank_allocation", "description": "ESKOM ...", "amount": -1250.00 },
  "dataAccessed":   ["bank_allocation_rules", "accounts"],
  "recommendation": { "accountId": 12, "accountCode": "6500", "confidence": 95 },
  "outcome":        "accepted",   // accepted | overridden | ignored
  "outcomeDeltaMs": 3400,          // how long before user acted
  "journalId":      null
}
```

### Audit event type
`SEAN_RECOMMENDATION_MADE`, `SEAN_RECOMMENDATION_ACCEPTED`, `SEAN_RECOMMENDATION_OVERRIDDEN`

---

## 3. AI Explainability Layer

### Goal
Accountants and auditors need to understand *why* Sean made a recommendation. "Sean suggested account 6500 Electricity" is not enough for a SARS audit — the trail needs to show the basis for the suggestion.

### Explainability fields (future `accounting_audit_log` metadata)
```json
{
  "sean_confidence":    87,
  "sean_basis":         ["bank_allocation_rule:12", "historical_allocation:bank_txn:45678"],
  "sean_pattern":       "eskom ref",
  "sean_rule_matched":  true,
  "sean_fallback_used": false
}
```

### UI addition
Audit Trail drawer: when `source === 'sean'`, show a dedicated "AI Explainability" section with the confidence, basis, and pattern fields rendered as structured cards (not raw JSON).

---

## 4. Cross-App Forensic Timeline

### Goal
Given a company ID, produce a complete chronological timeline of everything that happened — across POS, Payroll, Accounting, and Sean — for a given date range.

### Use cases
- Client has disputed a transaction: show the full flow from POS sale → bank transaction → allocation → VAT posting
- SARS audit query: show all activity for a specific VAT period across all apps
- Fraud investigation: show all actions by a specific user across all apps

### Implementation approach
- A new `/api/forensic/timeline` endpoint (not under any one app's module)
- Federated query across all app audit tables
- Correlated events linked by `company_id` + `timestamp` proximity
- Optional correlation hints: `saleId`, `journalId`, `bankTransactionId`, `vatPeriod`

---

## 5. Immutable Audit Snapshots

### Goal
At period-end (month, quarter, financial year), produce a cryptographically signed snapshot of all audit events for that period. The snapshot proves the audit trail has not been tampered with.

### Mechanism
1. At period lock, hash the ordered set of audit events for the period: `SHA-256(JSON.stringify(sortedEvents))`
2. Store the hash in `audit_period_snapshots` table alongside period metadata
3. Expose a verification endpoint: `GET /api/accounting/audit/verify-period?period=2026-03`
4. On verification: re-query the events, re-hash, compare — returns pass/fail + delta if tampered

### Why this matters
SARS or legal proceedings may require proof that the audit trail existed at a specific point in time and has not been altered. A signed snapshot provides that proof without requiring a blockchain.

---

## 6. Period-Lock Violation Tracking

### Current state
`LOCKED_PERIOD_ATTEMPT` is mapped as `high` severity in the normalizer. When a user attempts to post to a locked period, this event is logged.

### Future additions
- Count of violations per user per period → expose as a "violation score" in the audit explorer
- Alert threshold: if a user has > 3 violations in 24 hours, trigger a `SUSPICIOUS_PERIOD_OVERRIDE_PATTERN` critical event
- Admin review queue: locked period violations requiring sign-off before the user can attempt again

---

## 7. AI Confidence History

### Goal
Track how Sean's confidence in a given pattern changes over time as it learns from more allocations.

### Storage
```sql
CREATE TABLE sean_confidence_history (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  normalized_pattern TEXT NOT NULL,
  confidence     NUMERIC(5,2) NOT NULL,
  basis_count    INTEGER NOT NULL,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Use in Audit Trail
When displaying a `SEAN_RECOMMENDATION_MADE` event, show the confidence trend: "Was 72% last month, now 89%."

### Pilot value
During the 6-month pilot, this table would accumulate real confidence data that can be reviewed to determine when Sean's suggestions are ready for Phase 2 activation.

---

## 8. User Behavior Anomaly Detection

### Goal
Flag statistically unusual patterns in user audit activity. Examples:
- A user posts unusually large journals outside business hours
- A user reverses more journals in one week than in the entire prior month
- A user repeatedly attempts locked-period access

### Mechanism (Phase 1 of this feature)
A batch job or cron that runs nightly:
1. Fetch the last 90 days of audit events per user per company
2. Compute per-user baselines (average events per day, types, hours)
3. Flag deviations > 2 standard deviations as `ANOMALY_DETECTED` events
4. Surface in Audit Trail with `critical` severity

### Non-automated (no auto-blocks)
Anomalies are flagged for human review only. The system never auto-locks a user. The accountant or admin reviews and decides.

---

## 9. Audit Export Packs

### Goal
Generate a downloadable, formatted PDF/Excel audit pack for a specific date range, module, or compliance period.

### Use cases
- SARS VAT audit: export all VAT-related audit events for a period as a signed PDF
- Legal proceedings: export all actions on a specific transaction as a forensic report
- Client handover: export a complete audit trail when transferring client books

### Included sections in an audit pack
1. Cover page: company, period, generated by, generated at, hash
2. Summary statistics: total events by severity, by module, by user
3. Critical events (highlighted)
4. High-severity events
5. Warning events
6. Full event log in chronological order
7. Appendix: raw JSON metadata for each event

---

## 10. Legal / Forensic Evidence Mode

### Goal
When an investigation requires absolute forensic-grade output (legal proceedings, regulatory inquiry, CIPC compliance):

1. The "Evidence Mode" endpoint requires a special `audit.forensic` permission (admin only)
2. Events are returned with a chain-of-custody header: every API call is itself logged with the requester's identity
3. The response includes a cryptographic digest of the returned dataset
4. Download is logged as a `FORENSIC_EXPORT` critical audit event
5. Future: export with digital signature from a trusted timestamping authority (RFC 3161)

---

## 11. Sean Governance Hooks (Phase 2 of Bank Rules Roadmap)

When Sean AI bank suggestion (Phase 2) is activated:

- Every `SEAN_RECOMMENDATION_MADE` event must appear in the Audit Trail with module = `ai`
- Confidence is always shown in the detail drawer
- `SEAN_RECOMMENDATION_OVERRIDDEN` is `warning` severity
- `SEAN_CONFIDENCE_DECLINED` (confidence dropped > 15 points on a pattern) is `high` severity

The normalizer already maps `actorType: 'AI'` correctly. The `/events` endpoint is already future-ready for Sean events — no endpoint changes required, only new event types in the source data.

---

## Phase 1 → Phase 2 Upgrade Path

| Phase 1 (Shipped) | Phase 2 (Next) |
|---|---|
| `accounting_audit_log` + `historical_comparative_audit_log` | + `pos_audit_events` + Sean decision log |
| Company-scoped | + cross-company for super admins |
| Event explorer UI | + period snapshot verification |
| Normalizer: 2 sources | + N sources via adapter pattern |
| No user name join | + users table join for display names |
| Pagination via merged sort | + DB-level pagination with materialized view |

The normalizer's adapter pattern (`normalizeAccountingLog`, `normalizeHistoricalLog`, …) is already designed for extension — adding a new source is a matter of writing one new normalize function and adding one more parallel query to the `/events` route.

---

*This roadmap is a living document. Update it when phases are scoped, started, or completed.*
