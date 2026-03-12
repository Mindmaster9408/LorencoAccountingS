# Sean IRP5 Learning Engine — Paytime Integration

> **Status:** Implemented (March 2026)  
> **Governed by:** CLAUDE.md Part B — Sean Controlled Learning and Global Propagation Model  
> **Architecture scope:** `source_app = 'paytime'`. Same engine handles future learning categories by passing a different `source_app`.

---

## 1. Overview

Sean observes IRP5 code assignments across all Paytime clients. When enough clients independently assign the same IRP5 code to a functionally equivalent payroll item, Sean proposes that mapping as a global standard.

An authorized Super Admin reviews the proposal and, if approved, Sean fills in missing IRP5 codes across all matching payroll items — **never overwriting an existing code, even if it looks wrong**.

---

## 2. Key Concepts

### Payroll Item → IRP5 Code mapping

Each `payroll_items_master` row now has an `irp5_code` column (VARCHAR 10, 4–6 SARS digits). When a user assigns or changes a code in Paytime, that event is recorded as a **learning event**.

### Name normalisation

Item names vary across clients ("Comm.", "Monthly Commission", "Commission"). Sean normalises names before comparing them:

- Lowercase
- Strip punctuation
- Collapse whitespace
- Remove frequency words: `monthly`, `weekly`, `annual`, `yearly`
- Remove year references: `2024`, `2025`, `2026`

**Conservative by design:** "comm" and "commission" remain distinct normalised forms. Semantic grouping is a human decision, not automated.

### Confidence scoring

```
confidence = (frequencyScore × 0.30) + (diversityScore × 0.70)
```

| Component        | Formula                                    | Cap  |
|------------------|--------------------------------------------|------|
| `frequencyScore` | `(occurrences of this code / total occurrences for this name) × 100` | 100 |
| `diversityScore` | `min(distinctClients / 10, 1) × 100`       | 100 |

**Diversity is weighted 70% / frequency 30%** because the same accountant assigning a code 10 times is less trustworthy than 10 different clients independently making the same choice.

A pattern is auto-elevated to **proposed** status when:
- `confidence ≥ 60`
- `distinctClients ≥ 2`

---

## 3. Data Model

### New columns on `payroll_items_master`

| Column                 | Type         | Purpose                         |
|------------------------|--------------|---------------------------------|
| `irp5_code`            | `VARCHAR(10)` | SARS IRP5 code (4–6 digits)     |
| `irp5_code_updated_at` | `TIMESTAMPTZ` | When the code was last set      |
| `irp5_code_updated_by` | `INTEGER`    | `users.id` of last updater      |

### New tables (migration `011_sean_irp5_learning.sql`)

| Table                            | Purpose                                                       |
|----------------------------------|---------------------------------------------------------------|
| `sean_learning_events`           | Immutable log of every IRP5 code change in Paytime           |
| `sean_irp5_mapping_patterns`     | Sean-discovered patterns: (normalised name, code) → confidence |
| `sean_irp5_propagation_approvals`| Approval lifecycle for each proposed mapping                  |
| `sean_irp5_propagation_log`      | Immutable audit trail of every propagation write or skip      |

---

## 4. Lifecycle

```
Paytime user assigns irp5_code
        ↓
items.js PUT handler → _emitIRP5Event()
        ↓
recordLearningEvent()  →  sean_learning_events (INSERT)
        ↓ (async, non-blocking)
analyzePatterns()
  ├─ Aggregate events by (normalised_name, code)
  ├─ Calculate confidence per pattern
  ├─ Upsert sean_irp5_mapping_patterns
  └─ If confidence ≥ 60 AND clients ≥ 2 → status = 'proposed'
              ↓
     _ensureProposalRows()
       └─ INSERT into sean_irp5_propagation_approvals (status='pending')

Super Admin reviews proposals in Sean webapp → /paytime
        ↓
  Approve proposal  →  approval status = 'approved',  pattern status = 'approved'
       OR
  Reject proposal   →  approval status = 'rejected',  pattern status = 'candidate'

        ↓ (only after approve)
propagateApproved()
  For each active payroll item whose normalised name matches:
    ├─ irp5_code IS NULL      → WRITE proposed code → log action='applied'
    ├─ irp5_code = proposed   → log action='skipped_existing' (no write)
    └─ irp5_code ≠ proposed  → log action='skipped_exception' (NEVER write, Rule B9)
        ↓
  approval status = 'propagated', pattern status = 'propagated'
```

---

## 5. Safety Rules (enforced in application code)

These rules are documented in **CLAUDE.md Part B** and enforced in `irp5-learning.js`:

| Rule | Behaviour |
|------|-----------|
| **B2** | No global change without explicit Super Admin authorization |
| **B6** | Only blank/null `irp5_code` values may be filled by propagation |
| **B9** | An existing `irp5_code` (even if looks wrong) is **never overwritten automatically** |
| **B7** | Clients with conflicting codes are listed as exceptions and never touched |

The safety check in `propagateApproved()` is a **hard code check**, not just a comment:

```javascript
if (!existing.irp5_code) {
  // WRITE — code is null or empty string
} else if (existing === proposedCode) {
  // log skipped_existing — already correct, no write needed
} else {
  // SAFETY RULE B9: NEVER overwrite — log skipped_exception
}
```

---

## 6. API Endpoints

All endpoints mount under `/api/sean/paytime/` (authenticated via `authenticateToken`).

| Method | Path                        | Auth required              | Purpose                                           |
|--------|-----------------------------|----------------------------|---------------------------------------------------|
| `POST` | `/irp5-event`               | Any authenticated user     | Paytime items.js calls this on every irp5 change  |
| `POST` | `/analyze`                  | `requireSuperAdmin`        | Manually trigger pattern analysis                  |
| `GET`  | `/patterns`                 | `requirePermission('PAYROLL.VIEW')` | List discovered patterns             |
| `GET`  | `/proposals`                | `requireSuperAdmin`        | List pending approval proposals                   |
| `POST` | `/proposals/:id/approve`    | `requireSuperAdmin`        | Approve a proposal                                |
| `POST` | `/proposals/:id/reject`     | `requireSuperAdmin`        | Reject a proposal (with optional reason)          |
| `POST` | `/proposals/:id/propagate`  | `requireSuperAdmin`        | Execute propagation for an approved proposal      |
| `GET`  | `/exceptions`               | `requireSuperAdmin`        | List clients with conflicting codes               |
| `GET`  | `/stats`                    | `requirePermission('PAYROLL.VIEW')` | Learning system summary counts         |
| `GET`  | `/log`                      | `requireSuperAdmin`        | Propagation audit log                             |

---

## 7. Sean Webapp UI

**URL:** `/paytime` (accessible from the Sean webapp dashboard)

The Paytime Intelligence page provides:
- **Stats cards**: total learning events, patterns, pending approvals, propagations, avg confidence, proposed count
- **Proposals tab**: per-proposal cards with approve/reject/propagate actions; shows will-be-filled list, exceptions list, already-correct list
- **All Patterns tab**: full pattern table with confidence badges and status pills
- **Run Analysis button**: manually triggers `POST /analyze`

---

## 8. Required Environment Variables

### `sean-webapp/.env.local`

```
ECOSYSTEM_API_URL=https://your-ecosystem-backend.com
ECOSYSTEM_API_TOKEN=your-service-token-here
```

These are used by the Next.js proxy route at `app/api/paytime/[[...path]]/route.ts` which forwards requests from the Sean webapp to the ecosystem backend's `/api/sean/paytime/*` endpoints.

---

## 9. Database Migration

Run migration `011_sean_irp5_learning.sql` against the Supabase instance before using this feature:

```bash
# Via Supabase CLI
supabase db push

# Or directly via psql
psql $DATABASE_URL < accounting-ecosystem/database/011_sean_irp5_learning.sql
```

The migration uses `IF NOT EXISTS` / `IF NOT EXISTS` guards so it is safe to re-run.

---

## 10. Running Tests

```bash
cd accounting-ecosystem/backend
npm test
```

Test file: `tests/irp5-learning.test.js`  
51 tests covering: `normalizeName`, `calculateConfidence`, `recordLearningEvent`, `approveProposal`, `rejectProposal`, `propagateApproved` (including all 3 safety scenarios), IRP5 code format validation.

---

## 11. Source Files

| File | Purpose |
|------|---------|
| `accounting-ecosystem/database/011_sean_irp5_learning.sql` | DB migration |
| `accounting-ecosystem/backend/sean/irp5-learning.js` | Core learning service |
| `accounting-ecosystem/backend/sean/irp5-routes.js` | Express API routes |
| `accounting-ecosystem/backend/sean/routes.js` | Mounts IRP5 routes at `/api/sean/paytime/*` |
| `accounting-ecosystem/backend/modules/payroll/routes/items.js` | Emits learning events on IRP5 code create/change |
| `sean-webapp/app/api/paytime/[[...path]]/route.ts` | Next.js proxy to ecosystem backend |
| `sean-webapp/app/paytime/page.tsx` | Paytime Intelligence UI page |
| `sean-webapp/app/dashboard/page.tsx` | Dashboard with "Paytime IRP5" nav link |
| `accounting-ecosystem/backend/tests/irp5-learning.test.js` | Tests |

---

## 12. Extending to Other Source Apps

To use this engine for a different learning category (e.g. accounting transaction mappings):

1. Pass `source_app: 'accounting'` (or any string) to all service calls
2. The same tables and engine handle it — patterns are partitioned by `source_app`
3. Add new routes at a different mount path (e.g. `/api/sean/accounting/*`)
4. The approval workflow, safety rules, and audit trail apply identically

No code changes to the core service are required.
