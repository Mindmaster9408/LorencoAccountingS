# Future Accounting Simplicity & Error Layer — Bench Blueprint

---

## Executive Summary

The Lorenco Accounting app is designed to become the simplest, most guided, and most productive accounting platform available. The future-state vision is a system where even low-skill users can operate safely, mistakes are prevented and surfaced, workflows are highly guided, and one skilled user can do the work of many. This blueprint parks the next major simplicity/error/productivity layer for later implementation, ensuring the vision is preserved without premature build or rework.

---

## Why This Layer Matters

- Reduces accounting work time drastically
- Makes the app extremely simple to use and train
- Guides users safely, preventing data destruction
- Surfaces mistakes clearly and explains them
- Enables future AI/reporting/error-detection layers
- Empowers one capable user to handle workloads of many

---

## Audit Findings — Existing Foundations

### Guided Forms & Workflows
- VAT, PAYE, and cash reconciliation screens have stepwise workflows (draft → approve → lock)
- Reconciliation checklists and status indicators present in VAT and PAYE modules
- Approval and lock buttons with confirmation dialogs

### Validation & Protection
- Backend and frontend validation for locked periods, required fields, and role-based actions
- Role/permission enforcement (ACCOUNTANT/ADMIN required for critical actions)
- Read-only rendering for locked records
- Audit trail logging for key actions

### Warning/Error Messaging
- Warning banners and status cards (e.g., VAT reconciliation status, period lock warnings)
- Error messages for failed actions, missing permissions, and invalid states

### Reports & Review Screens
- Submission history tables, audit logs, and reconciliation snapshots
- Exception surfacing in Sean payroll compliance checks

### SEAN/Codex Hooks
- Sean learning modules for bank allocation, payroll compliance, and Codex explanations
- AI guard enforcement and proposal review flows

### Workflow Staging/Approval
- Draft, approve, submit, lock stages in VAT/PAYE workflows
- Dual authorization and review queues

### Role/Permission Structures
- Permission matrix docs and UI enforcement
- Role-specific action visibility

### Mistake Prevention
- Checklist cards, confirmation dialogs, and lock protection
- Required field validation and period-specific data enforcement

---

## What Is Intentionally Not Being Built Now (Benched Items)

1. Advanced mistake-analysis report
   - Deep error/explanation dashboard for all modules
   - Benched: Requires stable posting/reporting engine

2. AI-driven correction assistant
   - Automated suggestions and fixes for detected mistakes
   - Benched: Depends on stable data and error detection

3. Deep user coaching/onboarding layer
   - Interactive training, guided onboarding, and help overlays
   - Benched: Needs stable workflows and UI

4. Full exception dashboard
   - Centralized view of all detected anomalies and exceptions
   - Benched: Requires mistake detection layer

5. Advanced operational productivity dashboards
   - Exception-only worklists, auto-suggestions, and batch review
   - Benched: Depends on stable productivity and error layers

6. Complete “mistakes made and why” reporting
   - Detailed explanation and impact analysis for each mistake
   - Benched: Needs stable explanation and reporting modules

7. Cross-module simplification superlayer
   - Unified guided workflows across all modules
   - Benched: Requires stable module integration

8. Deep auto-explanation framework
   - Automated explanations for errors, warnings, and workflow steps
   - Benched: Needs stable Codex/SEAN integration

---

## Dependencies That Must Stabilize First

- Core accounting posting engine
- Company isolation and multi-tenant protection
- VAT engine and period locking
- Chart of Accounts structure
- Reporting consistency and audit trail
- Bank allocation and reconciliation flows
- Invoice workflows
- Permissions and role enforcement
- SEAN learning hooks and Codex integration

---

## Future Mistake-Detection Report Concept

A future report will answer:
- What mistakes were made
- Where they happened
- Why they are likely mistakes
- What the impact is
- What needs to be checked/fixed

**Categories:**
1. Missing allocations
2. Suspicious allocations
3. Inconsistent VAT
4. Period issues
5. Locked-period edit attempts
6. Missing customer/supplier links
7. Duplicate/suspicious bank items
8. Report inconsistencies
9. Missing required data
10. Out-of-period anomalies

---

## Future Guided-Simplicity Model

The system will help low-skill users operate safely via:
- Guided workflows (stepwise, checklist-driven)
- Hidden advanced options unless authorized
- Mandatory checklists before submission
- Warnings before risky actions
- Structured review queues
- Exception-only worklists
- SEAN-backed explanations and Codex overlays
- Lock protection and role-specific simplified views

---

## Future Productivity Model

The software will enable one user to do the work of many by:
- Auto-suggestions for allocations, corrections, and workflow steps
- Exception highlighting and guided review
- Faster allocation and smarter VAT/invoice handling
- Less duplicate work and fewer training requirements
- Clearer error surfacing and stronger automation with approvals

---

## Staged Future Implementation Roadmap

### STAGE A — Foundation Stabilization
- Goal: Ensure all core modules are stable and compliant
- Dependencies: Posting engine, company isolation, VAT, COA, reporting, permissions
- Modules: All core accounting, VAT, bank, invoice, reporting
- Order: Must be stable before any simplicity/error/productivity layer

### STAGE B — Guided Simplicity Layer
- Goal: Small usability improvements, guided workflows, checklists
- Dependencies: Foundation stable
- Modules: VAT, PAYE, bank, invoice, UI
- Order: First post-stabilization layer

### STAGE C — Mistake Detection Layer
- Goal: Exception and likely-error surfacing, anomaly detection
- Dependencies: Simplicity layer, reporting stable
- Modules: Reporting, audit, SEAN, Codex
- Order: After guided workflows

### STAGE D — Explanation / Training Layer
- Goal: Explain mistakes, guide fixes, reduce training time
- Dependencies: Mistake detection, Codex/SEAN integration
- Modules: UI, Codex, SEAN, reporting
- Order: After error surfacing

### STAGE E — AI Productivity Layer
- Goal: SEAN-assisted productivity, auto-suggestions, batch review
- Dependencies: Explanation layer, AI hooks
- Modules: SEAN, UI, reporting, workflow
- Order: Final layer after all others

---

## Checklist of Items to Revisit Later

- Advanced mistake-analysis report
- AI-driven correction assistant
- Deep user coaching/onboarding layer
- Full exception dashboard
- Advanced productivity dashboards
- Complete “mistakes made and why” reporting
- Cross-module simplification superlayer
- Deep auto-explanation framework

---

## BENCHED ITEMS TO REVISIT LATER

See above checklist. These items are parked until core dependencies are stable.

---

## WHEN TO REOPEN THIS WORK

Revisit and begin implementation when:
- Core posting, VAT, COA, reporting, and permissions are stable
- Multi-tenant isolation is confirmed
- SEAN/Codex hooks are ready for integration
- No major regressions or instability in core modules

---

## CHANGE IMPACT NOTE
- Area being changed: Future-state planning, benching, and documentation
- Files/docs involved: docs/bench/future-accounting-simplicity-and-error-layer.md (created), docs/README.md (to be updated if present)
- Current state found: Foundations for guided workflows, validation, lock protection, warning messaging, audit trails, and SEAN hooks already exist
- What is being benched: All advanced simplicity/error/productivity layers beyond current foundations
- Why it is not being built now: Prevents premature build/rework; depends on core stability
- Dependencies that must stabilize first: Posting engine, VAT, COA, reporting, permissions, SEAN/Codex
- Safe future implementation path: Stage roadmap as above; revisit after foundation stabilization

---

## Assumptions & Open Questions

- Assumes all core modules will reach stable state before reopening
- Assumes SEAN/Codex integration will be ready for advanced layers
- Open question: What additional user training/onboarding needs will emerge after core stabilization?
- Open question: What regulatory changes may affect mistake detection/reporting requirements?

---

## Follow-Up Note
- Area: Future simplicity/error/productivity layer
- Dependency: Core accounting, VAT, reporting, permissions, SEAN/Codex
- What was done now: Vision parked, blueprint documented, bench structure created
- What still needs to be checked: Core module stability, readiness for advanced layers
- Risk if not checked: Premature build, wasted effort, rework
- Recommended next review point: After core stabilization and successful multi-tenant deployment

---

## Index & Navigation

This document is the parked reference for the future simplicity/error/productivity layer. Update docs/README.md or docs/index.md to link here for easy access.

---

