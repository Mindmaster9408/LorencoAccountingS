# Ecosystem QA & Smoke Test — Future Build Roadmap

**Status:** Phase 1 shipped (May 2026). This document describes Phases 2–N.

---

## 1. Full Cross-App QA Orchestration

**Current state:** Admin creates a session, tester runs checklist manually in browser.

**Future:**
- QA session is linked to a specific app version / build hash.
- Admin can trigger a "QA run" that opens all target apps in a controlled sequence.
- Run results aggregated into a single report per session.
- Webhook / notification when a run completes.

**Prerequisites:** Per-app version tagging at deployment time.

---

## 2. Read-Only Impersonation with Strict Audit

**Current state:** Session metadata only. No actual cross-user auth delegation.

**Future:**
- A tester with a valid QA session token can authenticate to specific apps as a scoped read-only observer.
- Backend must issue a short-lived impersonation JWT scoped to: specific company + specific app + VIEW_ONLY permission set.
- Every page load and API call under impersonation is logged to `qa_session_audit_log`.
- Impersonation must be distinguishable from normal auth in all audit trails.

**Security requirements:**
- Impersonation token must never grant write permissions.
- Token TTL ≤ session `expires_at`.
- Any impersonation attempt outside the session's `allowed_company_ids` must be blocked at middleware level.
- No impersonation of super admin or business owner roles.

---

## 3. Test Data Sandboxes

**Current state:** Tests run against live (but non-production) company data.

**Future:**
- "Sandbox company" concept: a company flagged `is_sandbox = true`.
- Sandbox companies can be seeded with deterministic test data.
- QA session can be scoped to sandbox companies only.
- Sandbox data can be reset between runs without affecting real companies.

**Prerequisites:**
- `is_sandbox` column on `companies` table.
- Seed scripts per app module.
- Sandbox reset API endpoint (super admin only).

---

## 4. App-Specific Automated Smoke Probes

**Current state:** Manual checklist — tester clicks through each test.

**Future:**
- Each app defines a `smoke-probe.js` that runs a set of API calls verifying the app is operational.
- Probes run server-side on a schedule or on-demand from the QA Hub.
- Results stored in `qa_probe_results` table.
- QA Hub shows a real-time probe status dashboard.

**Example probe for Accounting:**
```javascript
// smoke-probe/accounting.js
export async function probe(companyId, token) {
    await get('/api/companies', token);                      // company list
    await get(`/api/accounting/accounts?company=${companyId}`, token); // chart of accounts
    await get(`/api/accounting/bank?company=${companyId}`, token);     // bank transactions
    return { status: 'pass', testedAt: new Date() };
}
```

---

## 5. Sean-Assisted QA Explanations

**Current state:** Raw pass/fail/blocked with freetext notes.

**Future:**
- Tester can click "Ask Sean" on a FAIL or BLOCKED item.
- Sean receives: test description, failure notes, recent error logs for that app.
- Sean responds with: likely cause, suggested fix, whether similar failures occurred before.
- Sean's response is embedded inline in the checklist item.

**Privacy:** Sean must not surface Coaching App data in QA context unless current user is Ruan.

---

## 6. QA Session Recordings / Evidence Packs

**Current state:** Tester produces a Markdown report by clicking "Copy."

**Future:**
- Browser extension or desktop agent can record session screenshots.
- Each checklist item can have attached screenshots.
- At session end, an "Evidence Pack" ZIP is generated: Markdown report + screenshots + API response logs.
- Evidence Pack stored in Supabase Storage, linked to the QA session record.

---

## 7. Security Approval Workflow

**Current state:** Only super admins can create sessions. No secondary approval.

**Future:**
- For sessions with `SANDBOX_WRITE` mode (Phase 3): requires a second super admin to approve before session activates.
- Approval request sent via email/notification.
- Approval expires after 1 hour.
- Full audit trail of who approved, when, from which IP.

---

## 8. Time-Limited Support Access

**Current state:** No support-team access concept.

**Future:**
- Separate `support_sessions` concept for external support staff.
- Support sessions are narrower than QA sessions: single company, single app, VIEW_ONLY.
- Support sessions require client/company owner consent (consent flag on `companies` table).
- Support access is shown to the company owner in their company settings page.
- All support API calls logged separately from normal audit trail.

---

## 9. Client Support Mode

**Current state:** N/A.

**Future:**
- A client (end-customer) can grant temporary support access to a Lorenco support agent.
- Client logs into their app, goes to Settings → Support Access → Generate Support Token.
- Support token is time-limited (max 4 hours), single-company, read-only.
- Support agent enters token in the QA Hub → Hub issues a support JWT.
- Client can revoke at any time from their settings page.

---

## 10. Legal / Audit Considerations

Before Phase 2+ is implemented, the following must be reviewed:

| Item | Consideration |
|------|--------------|
| POPIA / GDPR | Any access to client data by a tester must be logged and justifiable. Client consent may be required. |
| Employment law | Impersonating an employee's session for testing may have HR implications. Use sandbox data instead. |
| Tax data sensitivity | Payroll and SARS data must never be accessed in a QA context unless explicitly authorised by the client. |
| Audit trail retention | QA session audit logs must be retained for the same period as normal audit logs (7 years recommended for tax-adjacent systems). |
| Data residency | Evidence packs containing client data must be stored in compliant regions. |

---

*Created: May 2026. Update this document before implementing any Phase 2+ feature.*
