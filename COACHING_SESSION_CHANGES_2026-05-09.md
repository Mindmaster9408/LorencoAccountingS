# COACHING APP CHANGES LOG — SESSION MAY 9 2026
## STATUS: SYSTEM BROKEN — DO NOT DEPLOY FURTHER

This document records everything done in the coaching app during this session.
The changes broke the system because:
1. Code was updated to query `coaching_` prefixed tables (e.g. `coaching_clients`)
2. But the actual database on Zeabur's self-hosted Supabase still has the OLD unprefixed table names (`clients`, `users`, etc.)
3. So the app can't find any clients — everything shows empty

---

## THE 3 COMMITS THAT WERE PUSHED (all on GitHub main branch)

### Commit 1: `38ca8d2` — Photo/Notes fix
**Date:** May 9 2026 16:12
**What it did:** Fixed photo and notes not saving when editing a client.
**Files changed:**
- `Coaching app/backend/database/004_add_client_photo_notes.sql` ← CREATED (migration SQL to add photo/notes columns)
- `Coaching app/backend/routes/clients.routes.js` ← Modified PUT route to include photo + notes in UPDATE query

---

### Commit 2: `347dfad` — Table rename (THE BREAKING CHANGE)
**Date:** May 9 2026 16:31
**What it did:** Changed ALL SQL queries in the backend from old table names to `coaching_` prefixed names.
**Files changed (9 files):**
- `Coaching app/backend/middleware/auth.js` — `users` → `coaching_users`, `clients` → `coaching_clients`, etc.
- `Coaching app/backend/routes/admin.routes.js` — all table refs prefixed
- `Coaching app/backend/routes/ai.routes.js` — `ai_conversations` → `coaching_ai_conversations`
- `Coaching app/backend/routes/auth.routes.js` — all table refs prefixed
- `Coaching app/backend/routes/basis.routes.js` — `basis_submissions` → `coaching_basis_submissions`
- `Coaching app/backend/routes/clients.routes.js` — all table refs prefixed
- `Coaching app/backend/routes/leads.routes.js` — `leads` → `coaching_leads`
- `Coaching app/backend/routes/spil.routes.js` — `spil_profiles` → `coaching_spil_profiles`
- `Coaching app/backend/services/ai.service.js` — all table refs prefixed
- `Coaching app/backend/database/005_migrate_to_ecosystem_supabase.sql` ← CREATED

**WHY IT BROKE:** The database on Zeabur still has `clients`, `users`, etc. — NOT `coaching_clients`, `coaching_users`. So every query fails silently and clients disappear.

---

### Commit 3: `cd49270` — Migration endpoint (added to try to fix it, not yet run)
**Date:** May 9 2026 17:49
**What it did:** Added a one-time migration API endpoint to rename the tables in the live database.
**Files changed:**
- `Coaching app/backend/routes/migrate.routes.js` ← CREATED (migration endpoint)
- `Coaching app/backend/server.js` ← Modified to mount the migration route at `/api/migrate`

**STATUS:** This endpoint was never successfully run because we didn't know the coaching app's real Zeabur URL.

---

## TO FULLY REVERT EVERYTHING (restore original state)

Run this git command to undo all 3 commits and restore the exact state before this session:

```
git revert cd49270 347dfad 38ca8d2 --no-commit
git commit -m "revert: undo coaching_ table rename and migration — system broken"
git push origin main
```

OR hard reset to before commit 38ca8d2:
```
git reset --hard 109c862
git push origin main --force
```

**Commit 109c862** = the last known good state before any of today's changes.

---

## WHAT THE DATABASE ACTUALLY IS

- The coaching app on Zeabur does NOT use the standalone Zeabur postgres at `sjc1.clusters.zeabur.com:20200`
- That standalone postgres is completely empty (verified during this session)
- The coaching app uses the **self-hosted Supabase** running inside Zeabur (the `postgresql` service in the self-hosted Supabase stack)
- The self-hosted Supabase internal postgres is NOT directly reachable from outside Zeabur
- The actual table names in that database are: `clients`, `users`, `client_sessions`, `client_steps`, `client_gauges`, `leads`, `spil_profiles`, `coach_program_access`, `program_modules`, `ai_conversations`, `ai_learning_data` (all UNPREFIXED)

---

## ORIGINAL WORKING TABLE NAMES (what the database actually has)

| Old Table Name (in DB) | What Code Now Expects (broken) |
|---|---|
| clients | coaching_clients |
| users | coaching_users |
| client_sessions | coaching_client_sessions |
| client_steps | coaching_client_steps |
| client_gauges | coaching_client_gauges |
| leads | coaching_leads |
| spil_profiles | coaching_spil_profiles |
| coach_program_access | coaching_coach_program_access |
| program_modules | coaching_program_modules |
| ai_conversations | coaching_ai_conversations |
| ai_learning_data | coaching_ai_learning_data |
| basis_submissions | coaching_basis_submissions |

---

## SIMPLEST FIX (when ready)

**Option A — Revert code (recommended fastest):**
Revert all 3 commits. Go back to commit `109c862`. The original unprefixed table names work. Then apply ONLY the photo/notes fix on top (which just needs the SQL UPDATE to include the `photo` and `notes` columns).

**Option B — Run the migration endpoint:**
If Zeabur redeploys with commit `cd49270`, find the coaching app's real URL from Zeabur dashboard, then:
1. Add env var `MIGRATION_SECRET=anything` in Zeabur coaching app service
2. Call `POST https://REAL-URL/api/migrate/rename-tables?secret=anything`
3. This renames the DB tables to match the new code
4. After success, remove the migration route from server

---

## SESSION DATE
May 9, 2026
