# CODEBOX 04 — PRACTICE STAFF / TEAM FOUNDATION
# Implementation Record

> Date: May 2026
> Status: COMPLETE
> Prerequisite: Codebox 03 (Practice Profile Foundation) — COMPLETE

---

## 1. Summary

Built the Practice Team Members foundation for Lorenco Practice Management. Every accounting practice can now manage its internal team: add staff, assign roles, set permissions, link login accounts, and use team members in task assignment.

---

## 2. Why Team Members Are Practice-Level Records

```
practice_profiles     → the accounting FIRM itself (one per company)
practice_team_members → PEOPLE working inside that firm (many per company)
practice_clients      → the firm's own CLIENT files (many per company)
```

These three concepts are architecturally separate. A team member is NOT a client. A client is NOT a team member. The Practice Profile is NOT either of them.

---

## 3. Files Audited

| File | Key Finding |
|---|---|
| `frontend-practice/tasks.html` | `loadUsers()` calls `/api/practice/users`; `getUserName(userId)` uses `u.id === userId` |
| `backend/modules/practice/index.js` | `GET /tasks` uses `parseInt(assigned_to)` — confirms INTEGER user_id stored |
| `backend/config/migrations/007_inventory_practice.sql` | All tables use `SERIAL PRIMARY KEY`, `INTEGER REFERENCES companies(id)`, `INTEGER REFERENCES users(id) ON DELETE SET NULL` |
| `database/migrations/054_practice_profile.sql` | Confirmed INTEGER pattern, no triggers, updated_at manual |

---

## 4. Files Changed

### Created
| File | Purpose |
|---|---|
| `database/migrations/055_practice_team_members.sql` | `practice_team_members` table |
| `frontend-practice/team.html` | Team list page with add/edit/deactivate/reactivate modal |
| `frontend-practice/js/team.js` | Team page logic — list, CRUD, deactivate, reactivate, user picker |
| `practice-pilot/codebox-01-foundation/04_practice_team_foundation.md` | This file |
| `practice-pilot/codebox-01-foundation/SESSION_HANDOFF_codebox_04_practice_team.md` | Session handoff |

### Modified
| File | Change |
|---|---|
| `backend/modules/practice/index.js` | Added `GET/GET:id/POST/PUT/DELETE/PUT:reactivate` for `/api/practice/team` + `sanitizeTeamBody()` |
| `frontend-practice/js/layout.js` | Reordered nav: Dashboard → Profile → Team → Clients → Tasks → Time → Deadlines |
| `frontend-practice/tasks.html` | `loadUsers()` → calls `/api/practice/team?active=true`, filters `user_id != null && can_receive_tasks`. `getUserName()` → looks up `m.user_id === userId`, returns `m.display_name` |

---

## 5. Database Changes

### `practice_team_members` table (migration 055)

```sql
CREATE TABLE IF NOT EXISTS practice_team_members (
    id                    SERIAL PRIMARY KEY,
    company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id               INTEGER,   -- soft ref, no FK
    display_name          TEXT NOT NULL,
    email                 TEXT,
    phone                 TEXT,
    role                  TEXT NOT NULL DEFAULT 'staff'
                              CHECK (role IN ('owner','partner','manager','senior','staff','admin','reviewer','viewer')),
    job_title             TEXT,
    department            TEXT,
    default_hourly_rate   NUMERIC(12,2) CHECK (... >= 0),
    can_receive_tasks     BOOLEAN NOT NULL DEFAULT TRUE,
    can_review_work       BOOLEAN NOT NULL DEFAULT FALSE,
    can_approve_work      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    notes                 TEXT,
    settings              JSONB NOT NULL DEFAULT '{}',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by            INTEGER,
    updated_by            INTEGER
);
```

**Key design decisions:**

**`user_id` is a soft reference (no FK)** — the users table is in the auth schema. A hard FK would create cross-schema migration complexity. Validated at application layer.

**Partial unique indexes:**
- `(company_id, user_id) WHERE user_id IS NOT NULL` — prevents same login user linked to multiple team records in same company
- `(company_id, email) WHERE email IS NOT NULL AND email <> ''` — prevents duplicate email within company

**Soft delete only** — `DELETE /api/practice/team/:id` sets `is_active = false`. No hard deletes. Historical assignments are preserved.

**`updated_at` manual** — consistent with all other practice routes (no DB trigger).

---

## 6. Backend Routes Added

All routes inherit `authenticateToken` + `requireModule('practice')` from router registration.

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/practice/team` | List team (query: `active`, `role`, `search`, `page`, `limit`) |
| `GET` | `/api/practice/team/:id` | Single member (company-scoped) |
| `POST` | `/api/practice/team` | Create member (company_id from JWT) |
| `PUT` | `/api/practice/team/:id` | Update member (company-scoped) |
| `DELETE` | `/api/practice/team/:id` | Soft deactivate (is_active = false) |
| `PUT` | `/api/practice/team/:id/reactivate` | Reactivate member |

**`sanitizeTeamBody()` allowlist:**
`user_id`, `display_name`, `email`, `phone`, `role`, `job_title`, `department`, `default_hourly_rate`, `can_receive_tasks`, `can_review_work`, `can_approve_work`, `is_active`, `notes`, `settings`

**`company_id` never accepted from request body** — always sourced from `req.companyId` (JWT).

**Audit logging:**
- `CREATE` on POST
- `UPDATE` on PUT
- `DEACTIVATE` on DELETE
- `REACTIVATE` on PUT/:id/reactivate
- All logged via `auditFromReq(req, action, 'practice_team_member', id, { module: 'practice' })`

---

## 7. Frontend Page Added

`/practice/team.html` — Team Members list page.

**Features:**
- Search (name, email, job title, department)
- Role filter (All Roles / Owner / Partner / Manager / Senior / Staff / Admin / Reviewer / Viewer)
- Active/Inactive/All status filter
- Table view: Name+subtitle, Role badge, Contact, Rate/hr, Permissions, Login linked badge, Status, Edit
- Add / Edit modal with 5 sections: Identity, Role & Position, Login Account Link, Permissions, Notes
- Deactivate button in modal (confirms before action)
- Reactivate button in modal (shown when member is inactive)
- Pagination (20 per page, client-side)
- Loading / empty / error states

---

## 8. Task Assignment Impact

### What Changed

`tasks.html` `loadUsers()` now calls:
```javascript
GET /api/practice/team?active=true
```
Instead of: `GET /api/practice/users`

Picker filter: only team members where `user_id != null` AND `can_receive_tasks !== false`.

Option value = `member.user_id` (integer) — same as before (user's id in users table).
`practice_tasks.assigned_to` field unchanged — still stores an integer user_id.

### Backward Compatibility

Existing task assignments where `assigned_to` = user_id continue to work.

If a team member with the matching `user_id` exists → `getUserName()` returns `display_name`.

If no matching team member → falls back to `'User #' + userId` (graceful degradation).

### Constraint: Unlinked Team Members Cannot Receive Tasks

Team members with `user_id = null` appear on the Team page but are excluded from the task picker. This is correct — `practice_tasks.assigned_to` requires a user_id. A future migration can add `assigned_team_member_id` to support unlinked members.

---

## 9. Validation Rules

| Rule | Enforcement |
|---|---|
| `display_name` required | Backend 400 + HTML `required` |
| `role` must be valid value | Backend 400 against `TEAM_ROLES` array |
| `default_hourly_rate >= 0` | DB CHECK constraint |
| `can_receive_tasks / can_review_work / can_approve_work` are booleans | JS coercion from string select value |
| `user_id` is integer | `parseInt(userIdRaw)` in JS |
| No duplicate `(company_id, user_id)` | Partial unique DB index → 409 from backend |
| No duplicate `(company_id, email)` | Partial unique DB index → 409 from backend |

---

## 10. Multi-Tenant Safety Review

- All `GET /api/practice/team` queries filter by `req.companyId` ✅
- All `GET /api/practice/team/:id` verify `company_id = req.companyId` ✅
- All `PUT/DELETE/reactivate` first verify ownership: `SELECT id WHERE id=:id AND company_id=req.companyId` ✅
- `company_id` never accepted from request body (always from JWT) ✅
- `created_by` / `updated_by` set from `req.userId` (server-side) ✅

---

## 11. localStorage / Browser Storage Review

Grep results (unchanged from Codebox 03):
```
js/polyfills.js:32  — localStorage.setItem (allowlist-gated, auth only)
js/auth.js:49,58,83 — safeLocalStorage.setItem (token, availableCompanies, session)
```

**New files `team.html`, `team.js`:** zero localStorage writes. All data via API. ✅

---

## 12. Audit Logging

Events logged via existing `auditFromReq()` pattern:

| Event | Action String | When |
|---|---|---|
| Team member created | `'CREATE'` | POST success |
| Team member updated | `'UPDATE'` | PUT success |
| Team member deactivated | `'DEACTIVATE'` | DELETE success |
| Team member reactivated | `'REACTIVATE'` | PUT /:id/reactivate success |

Extra: `{ module: 'practice' }` passed explicitly (consistent with other practice module audit calls).

---

## 13. Tests Run

- localStorage grep: no new writes ✅
- Backend insertion point verified (profile section → team section → clients section) ✅
- tasks.html `loadUsers()` and `getUserName()` updated and verified ✅

---

## 14. Manual Verification Checklist

1. Run `055_practice_team_members.sql` in Supabase SQL Editor
2. Open Lorenco Practice from ECO dashboard
3. Confirm navigation shows: Dashboard → Profile → Team → Clients → Tasks → Time → Deadlines
4. Open Team page — confirm empty state shows
5. Add team member (with linked user account) → confirm it appears in list
6. Add team member (without linked user) → confirm it appears as "No login" badge
7. Edit team member → confirm values populate correctly and save
8. Deactivate team member → confirm disappears from Active filter
9. Switch filter to "Inactive" → confirm deactivated member appears
10. Reactivate from Inactive view → confirm member returns to active
11. Open Tasks page → confirm assignee picker shows only linked team members
12. Confirm task assignee picker does NOT show unlinked team members
13. Create/assign a task → confirm assignment saves and displays correctly
14. Confirm no team data in DevTools → Application → Local Storage
15. Open unauthenticated → confirm redirect to `/`
16. Confirm Profile, Clients, Time, Deadlines pages still load correctly

---

## 15. Remaining Risks

| # | Risk | Severity | Recommended Action |
|---|---|---|---|
| RF01 | Unlinked team members (no user_id) cannot receive tasks — no UI warning shown | MEDIUM | Add a notice in the team modal: "Link a login account to enable task assignment" |
| RF02 | If user leaves company (user_company_access deactivated) but team member has their user_id, that user still appears in task picker until manually deactivated in team | LOW | Codebox 05: sync team active state with user_company_access |
| RF03 | `GET /api/practice/team` without pagination limit returns all records — for large teams, this could be slow | LOW | Acceptable for current practice scale; server-side pagination params are already supported |
| RF04 | `req.userId` may not be set in all auth paths — `created_by`/`updated_by` may be null | LOW | Acceptable; field is optional and for audit enrichment only |
| RF05 | Task picker now falls back to `'User #' + userId` for users with no team member record | LOW | Migrate existing users to team members on first setup |

---

## 16. Recommended Codebox 05

**Goal:** Client Profile Expansion / CRM Foundation

**Reason:** Practice Profile (Codebox 03) defines the firm. Team (Codebox 04) defines internal people. The next logical building block is stronger Client Profiles before workflows, compliance calendars, billing, and tax modules become useful.

**Scope:**
1. Expand `practice_clients` with additional CRM fields (contact persons, billing contact, communication preferences)
2. Build `client.html` — single client view with embedded Tasks / Time / Deadlines tabs
3. Add client contact persons sub-table (`practice_client_contacts`)
4. Add client notes/activity log
5. Link client fiscal year end to auto-suggest provisional tax deadlines
6. Connect team member as "responsible person" for a client
