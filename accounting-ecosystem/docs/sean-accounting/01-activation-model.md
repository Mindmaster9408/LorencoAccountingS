# Sean AI — Activation Model (Accounting)

> **Status:** FUTURE DESIGN — NOT YET IMPLEMENTED  
> **Scope:** Accounting App — Sean activation per client  
> **Last updated:** May 2026

---

## 1. Core Principle

Sean AI features in the Accounting App are **opt-in per client/company**.

A company that has not been activated for Sean AI must not see or use any AI-assisted functionality. The activation flag is checked server-side and respected client-side.

---

## 2. Activation Scope

Sean activation is **module-specific**. A company may have Sean enabled for:

- Bank Allocation intelligence (see `bank-allocation/`)
- Chart of Accounts AI assist (see `chart-of-accounts/`)
- Future modules independently

Activation for one module does not imply activation for all modules.

---

## 3. Where the Activation Flag Lives

**Proposed location:** Company record in the database.

Suggested fields:
```sql
-- Future migration: ADD COLUMN IF NOT EXISTS to companies table
sean_active          BOOLEAN DEFAULT false,
sean_modules_enabled JSONB   DEFAULT '{}',  -- e.g. {"bank_allocation": true, "coa_assist": false}
```

The ecosystem superuser/admin layer controls these flags. Accountants do not control their own Sean activation.

---

## 4. Frontend Behavior When Sean Is Inactive

| Element | Behavior when Sean inactive |
|---|---|
| AI Allocate button (bank transactions) | Hidden OR visible but disabled with tooltip "Sean AI not activated for this client" |
| AI Suggest button (COA) | Hidden OR disabled |
| Any Sean-powered UI panel | Hidden entirely |
| Sean confidence badge on suggestions | Never shown |

**Preferred behavior:** Hidden entirely (cleaner UX). Disabled-with-tooltip only if the user needs to know Sean exists but requires activation.

**Decision to make at implementation time:** Whether to show a "Sean not activated — contact your administrator" state or simply hide all AI elements.

---

## 5. Server-Side Enforcement

Even if a frontend check is bypassed, the backend Sean routes must validate that Sean is active for the requesting company before processing any AI request.

Pattern:
```javascript
// Pseudo-code — not yet implemented
const seanActive = await isSeanActive(req.user.companyId, 'bank_allocation');
if (!seanActive) return res.status(403).json({ error: 'Sean AI not activated for this company' });
```

---

## 6. Activation Workflow (Future)

1. Superuser (Ruan / MJ / Anton) activates Sean for a company from the ecosystem control panel.
2. Flag is written to the company record.
3. Next time the accountant opens the Accounting App, Sean features appear.
4. No client-side caching of activation state beyond session auth (re-check on each page load or session).

---

## 7. Relationship to Existing Sean Engine

The existing Sean engine (`backend/sean/`, `frontend-sean/`) already has a module visibility model (`SEAN_MODULE_REGISTRY` in `frontend-sean/index.html`). The accounting activation model extends this — activation adds a **per-company** gate on top of the existing **per-app** module visibility gate.

Two-layer gate:
1. **App-level:** Is this Sean module relevant to the Accounting App? (existing — `SEAN_MODULE_REGISTRY`)
2. **Company-level:** Is Sean activated for this specific company? (future — this document)

---

## 8. Open Questions (Resolve at Implementation Time)

- Should activation be per-module granular or binary (all-or-nothing per client)?
- Who in the ecosystem can activate Sean — only superusers, or also client admins?
- Should there be a trial/preview mode (limited suggestions without learning)?
- How is the activation flag refreshed in JWT claims vs. fetched fresh each session?
