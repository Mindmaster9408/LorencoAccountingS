# Codebox 66 — Secretarial Document Checklist + Governance Evidence Requests

> App: Lorenco Practice Management
> Status: Complete — migration 124 not yet applied to Supabase — nothing committed or pushed
> **Delivered after Codebox 67** (Secretarial Statutory Calendar) due to a sequencing mix-up in the prompts — see Architect Freedom #1 for the full explanation and how the two codeboxes were reconciled.

## Purpose

An evidence layer on top of the existing Document Requests module: what evidence is required, why, whether it's been received, whether it's been verified. Answers "which evidence is outstanding," "which statutory process is blocked," "which governance evidence is complete," "which BO verification still lacks support."

**DO NOT BUILD: document storage, file uploads, an attachment system, a document viewer, duplicate document requests, duplicate document tables.** `practice_document_requests` (migration 073, `document-requests.js`) remains the sole owner of documents — this module only links to it.

## Architect Freedom — Scope Decisions & Deviations

1. **This codebox was delivered out of sequence — Codebox 67 (Statutory Calendar) arrived first by mistake, and its migration consumed the number "123" that this codebox's own spec asked for.** Rather than overwrite an already-applied migration (a genuinely destructive, high-risk action against a live database), this codebox's migration was renumbered to **124** — the next available slot — with the renumbering documented at the top of the migration file itself. Everything else about this codebox was built exactly as specified; only the migration filename/number differs from the literal instruction.
2. **A real, valuable side-effect of the out-of-order delivery: Codebox 67 had already identified and documented the exact gap this codebox needed to fill.** Codebox 67's `secretarial-calendar.js` shipped with an explicit follow-up note: `'evidence_complete'` dependencies "always require manager confirmation... revisit when a document/evidence checklist module is eventually built." That module now exists. `_isDependencySatisfied()` in `secretarial-calendar.js` was updated (additively — no other logic touched) to check a linked evidence checklist's live readiness via this codebox's new `getChecklistReadiness()` export, closing the loop predicted in that earlier handoff.
3. **"BO readiness uses evidence completion. No duplicate readiness logic" is satisfied by delegation, not by rebuilding.** An audit confirmed `practice_bo_readiness_items` (Codebox 65) already IS a fully-formed, evidence-style checklist specifically for Beneficial Ownership (owner_identity, owner_address, trust_deed, etc., with its own required/requested/received/verified/waived/blocked/not_applicable status vocabulary). Rather than create a second, parallel set of evidence items for `source_type = 'bo_verification'` checklists, this module's evidence checklist row exists purely for reference/linking (title, source, template) — its actual items and readiness are delegated entirely to `beneficial-ownership.js` (`generateReadinessItems()`, newly exported additively, and `getBeneficialOwnershipProfile()`, already exported). `getChecklistReadiness()` branches on `source_type` and never queries `practice_secretarial_evidence_items` for a BO-sourced checklist.
4. **Document Request integration is read-and-insert only — `document-requests.js` itself is never modified.** An audit confirmed `document-requests.js` exports nothing beyond its router and has no event/webhook mechanism. Rather than risk changing a working, existing module to add a push notification when a request completes, this module instead pulls the current `request_status` live every time a checklist or item is read (`_syncItemFromDocumentRequest()`) — the same "always fresh, never stale" discipline used everywhere else in this session. A manual `POST /checklists/:id/sync` endpoint exists for an explicit refresh, but reads always self-sync regardless.
5. **Verification is always a distinct, explicit manager action — never inferred from a document request being received.** When a linked document request's status becomes `received`, the evidence item's status becomes `received` too (not `verified`) — even for items where `verification_required = false`, the "received → verified" step (or simply treating non-verification-required "received" as done, which `_computeReadinessFromItems()` already does) is never silently skipped by the sync helper. `PUT /items/:id/verify` is the only path to `verified`, always attributable to a specific reviewer.
6. **Default templates are a manager-editable, persisted version of Codebox 63's `CHECKLIST_DEFAULTS` constant** — the same evidence sets (Director Appointment, Resignation, Share Transfer, etc.) that were previously hardcoded JS are now real, editable rows in `practice_secretarial_evidence_templates`, seeded idempotently on first use per company (`_ensureDefaultTemplates()` never overwrites a manager's own edits on subsequent calls).
7. **The `evidence_complete` dependency link (`depends_on_checklist_id`) is an additive `ALTER TABLE` on Codebox 67's already-applied `practice_statutory_dependencies` table**, not a new table — a small, safe, purely additive schema change (`ADD COLUMN IF NOT EXISTS`) that lets a statutory schedule item point at a specific evidence checklist for automatic resolution, rather than always falling back to "requires manager confirmation."
8. **`governance_complete` dependencies remain manual-only in this pass** — Codebox 64's resolutions/meetings have their own workflow-status lifecycle (draft/approved/signed/implemented, etc.), which is a genuinely different concept from "evidence of this resolution existing has been received/verified." Wiring that up was judged out of scope for this codebox's explicit ask (which is about the Document Requests integration specifically); the `resolution`/`minutes` evidence templates DO generate real checklist items (signed resolution, attendance record, etc.) that a manager can track evidence for, independent of the resolution's own workflow status.

## Database — Migration 124

Four new tables: `practice_secretarial_evidence_templates`, `practice_secretarial_evidence_checklists`, `practice_secretarial_evidence_items`, `practice_secretarial_evidence_events` (append-only). Plus one additive `ALTER TABLE` on `practice_statutory_dependencies` (Codebox 67). Full field-by-field rationale in the migration's own header and per-table comments.

## Backend — `secretarial-evidence.js`

### Endpoints (~20)

Summary, full CRUD for Templates, Checklists (+ generate, regenerate, sync), nested Items (+ link/create document request, verify, waive), and events.

## Evidence Engine

`getChecklistReadiness(cid, checklist)` — the single entry point for "is this checklist's evidence complete." For `bo_verification`, delegates entirely to Beneficial Ownership (see Architect Freedom #3). For everything else, computes a score/status from live-synced item statuses using the same 85/50 ready/partial/incomplete thresholds established elsewhere in this session.

## Template Logic

`_ensureDefaultTemplates()` seeds 14 named templates (matching the spec's examples exactly) plus a `custom` fallback, per company, idempotently. `_resolveTemplateTypeFromSource()` maps a checklist's trigger (a Codebox 63 change case's `change_type`, a governance resolution/meeting, BO verification, or annual return) onto the matching template — a deliberate many-to-one simplification (e.g. both address-change types map to one "Address Change" template).

## Document Request Integration

See Architect Freedom #4-#5. `_createLinkedDocumentRequest()` inserts directly into the existing `practice_document_requests` table using its exact column shape (confirmed by audit) — never a new table. `_syncItemFromDocumentRequest()` is the pull-based, always-live sync mechanism.

## Workflow Integration

`POST /checklists/generate` accepts `source_type` + `source_id` (a Codebox 63 change case, a Codebox 64 resolution/meeting, a BO verification, or an annual return) or `manual`. Regeneration (`POST /checklists/:id/regenerate`) is idempotent — only missing evidence types are added, existing items and their statuses are untouched.

## Secretarial Integration

- **Management Dashboard**: a new "Evidence Readiness" KPI section, reusing `getEvidenceSummary()` directly (extracted from the router's own `/summary` logic — no duplicate aggregation).
- **Planning Board**: an `evidence_blocked` flag (blocked, required evidence items only — the same deliberately lightweight direct-query pattern as every other Planning Board badge this session), rendered as a "📎 Evidence Blocked" badge.
- **Statutory Calendar**: `evidence_complete` dependencies now resolve automatically via a linked checklist (see Architect Freedom #2).

## Frontend

`secretarial-evidence.html` + `js/secretarial-evidence.js` (prefix `se`): summary cards, 3 tabs (Templates / Evidence Checklists / Events). The Checklists tab's detail view clearly marks BO-delegated checklists as such (no duplicate items shown) and provides inline actions to link/create a document request, verify, or waive each evidence item. No document viewer, no file upload UI, no chart library, no AI.

## localStorage Findings

Zero matches for `localStorage`/`sessionStorage`/`indexedDB`/`safeLocalStorage` across the migration, `secretarial-evidence.js`, both new frontend files, and every edited file (`beneficial-ownership.js`, `secretarial-calendar.js`, `index.js`, `layout.js`, `management-dashboard.js`, `js/management-dashboard.js`, `management-dashboard.html`, `planning-board.js`, `js/planning-board.js`). Confirmed via grep.

## Multi-Tenant Safety

Every query scoped to `company_id`. Document request links are independently re-verified against the checklist's own `client_id` before being accepted. Reads unrestricted per-user; writes and workflow actions manager-gated.

## Files Created

| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/migrations/124_practice_secretarial_evidence.sql` | 4 tables + additive dependency-linkage column |
| `accounting-ecosystem/backend/modules/practice/secretarial-evidence.js` | Router + evidence engine + template/BO-delegation/document-request logic |
| `accounting-ecosystem/backend/frontend-practice/secretarial-evidence.html` | Secretarial Evidence UI |
| `accounting-ecosystem/backend/frontend-practice/js/secretarial-evidence.js` | Secretarial Evidence UI logic |
| `docs/new-app/66_secretarial_evidence.md` | This file |
| `docs/new-app/SESSION_HANDOFF_codebox_66_secretarial_evidence.md` | Handoff |

## Files Modified

| File | Change |
|---|---|
| `accounting-ecosystem/backend/modules/practice/beneficial-ownership.js` | Added `generateReadinessItems` export (purely additive) |
| `accounting-ecosystem/backend/modules/practice/secretarial-calendar.js` | Requires `secretarial-evidence.js`; `evidence_complete` dependencies now resolve automatically via a linked checklist; `POST /dependencies` accepts/validates `depends_on_checklist_id` |
| `accounting-ecosystem/backend/modules/practice/index.js` | Mounted `secretarial-evidence` router |
| `accounting-ecosystem/backend/frontend-practice/js/layout.js` | Added "Secretarial Evidence" nav entry |
| `accounting-ecosystem/backend/modules/practice/management-dashboard.js` | Requires `secretarial-evidence.js`; added `evidence_readiness` block to `computeSummary()` |
| `accounting-ecosystem/backend/frontend-practice/js/management-dashboard.js` | Renders the new Evidence Readiness KPI section |
| `accounting-ecosystem/backend/frontend-practice/management-dashboard.html` | Added `kpiEvidenceReadiness` section |
| `accounting-ecosystem/backend/modules/practice/planning-board.js` | `_buildTeamItemPool()` attaches `evidence_blocked` flag per item |
| `accounting-ecosystem/backend/frontend-practice/js/planning-board.js` | Renders the "Evidence Blocked" badge on work items |
