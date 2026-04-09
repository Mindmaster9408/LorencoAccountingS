# Login Fix Handoff — Lorenco Ecosystem (lorenco.zeabur.app)

## Problem Summary
The login screen at `https://lorenco.zeabur.app` returns **401 Invalid Credentials** for the master admin user, even with correct credentials. Occasionally the server returns **502 Bad Gateway** after variable changes trigger a redeploy.

---

## Credentials (Master Admin)
- **Email:** `ruanvlog@lorenco.co.za`
- **Password:** `Mindmaster@277477`
- **Role:** `super_admin`, `is_super_admin: true`

---

## Stack
- **Backend:** Node.js / Express — `accounting-ecosystem/backend/server.js`
- **Database:** Supabase (PostgreSQL) — service-role client
- **Auth:** bcrypt password hashing + JWT tokens
- **Hosting:** Zeabur (Docker, Root Directory = `accounting-ecosystem`)
- **Supabase project:** `https://glkndlzjkhwfsolueyhk.supabase.co`

---

## Root Causes Identified

### 1. `JWT_Secret` casing bug (MAIN recurring issue)
The Zeabur Variable was named `JWT_Secret` (mixed case).  
The code reads `process.env.JWT_SECRET` (all caps).  
On Linux, env vars are **case-sensitive** — so `JWT_SECRET` was always `undefined`.  
This caused tokens to be signed with no real secret, breaking auth after every restart.

**Fix applied:** Renamed Zeabur variable from `JWT_Secret` → `JWT_SECRET`  
**Current status:** Value was accidentally set to placeholder `your_jwt_secret_key_here_change_this_in_production_12345678901234567890`  
**Required value:** `charlie_jwt_secret_2024_secure_random_key_xyz789`

### 2. Missing Supabase env vars in Zeabur (historic cause)
The `.env` file is excluded from Docker via `.dockerignore` (correct for security).  
At some point the Zeabur Variables tab was missing `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`.  
These are now confirmed present in Zeabur Variables.

### 3. User password hash mismatch (possible secondary cause)
The seed (`backend/config/seed.js`) only creates the master admin if **no users exist**.  
If the user already exists in Supabase with a different/corrupted password hash, the seed skips silently and the login keeps failing.

---

## What Was Built to Fix This

### A. `forceResetMasterAdmin()` — startup reset guard
**File:** `accounting-ecosystem/backend/config/seed.js`  
Added a function that runs on startup **only when `FORCE_RESET_ADMIN=true`** is set.  
It finds the master admin user and updates:
- `password_hash` (fresh bcrypt hash of `Mindmaster@277477`)
- `is_active = true`
- `is_super_admin = true`
- `role = 'super_admin'`

If the user doesn't exist at all, it creates them from scratch.

### B. `/api/admin/reset-master` — HTTP reset endpoint
**File:** `accounting-ecosystem/backend/server.js` (around line 163)  
A GET endpoint that:
- Returns `403 Disabled` if `FORCE_RESET_ADMIN !== 'true'`
- Otherwise connects to Supabase and resets the master admin password directly
- Returns JSON: `{ success: true, action: 'updated'|'created', id: '...' }`

**To trigger:** Visit `https://lorenco.zeabur.app/api/admin/reset-master` in browser  
**Guard:** Requires `FORCE_RESET_ADMIN=true` in Zeabur Variables  
**Current result:** Returns `{"error":"TypeError: fetch failed"}` — meaning the endpoint ran but Supabase connection is failing

---

## Current Zeabur Variables Status

| Variable | Status |
|---|---|
| `SUPABASE_URL` | ✅ Set |
| `SUPABASE_SERVICE_KEY` | ✅ Set |
| `SUPABASE_ANON_KEY` | ✅ Set |
| `JWT_SECRET` | ⚠️ Set but wrong value (placeholder) — needs correct value |
| `FORCE_RESET_ADMIN` | ✅ Set to `true` |
| `NODE_ENV` | ✅ Set |
| `MODULE_POS_ENABLED` | ✅ Set |
| `MODULE_SEAN_ENABLED` | ✅ Set |

---

## Immediate Steps to Fix

1. **In Zeabur Variables**, update `JWT_SECRET` to:
   ```
   charlie_jwt_secret_2024_secure_random_key_xyz789
   ```

2. **Wait for Zeabur to redeploy** (~30 seconds)

3. **Visit** `https://lorenco.zeabur.app/api/admin/reset-master`  
   Expected response: `{"success":true,"action":"updated","id":"..."}`

4. **Try logging in** with `ruanvlog@lorenco.co.za` / `Mindmaster@277477`

5. **If login works**, go to Zeabur Variables and **delete `FORCE_RESET_ADMIN`** to disable the reset endpoint

6. **If still 502**, check Zeabur Runtime Logs for the startup crash reason

---

## Key Files
| File | Purpose |
|---|---|
| `accounting-ecosystem/backend/config/seed.js` | Master admin seed + `forceResetMasterAdmin()` |
| `accounting-ecosystem/backend/server.js` | `/api/admin/reset-master` endpoint (~line 163) |
| `accounting-ecosystem/backend/shared/routes/auth.js` | Login route (`POST /api/auth/login`) |
| `accounting-ecosystem/backend/middleware/auth.js` | JWT verification middleware |
| `accounting-ecosystem/backend/config/database.js` | Supabase client setup |

---

## Notes
- The 502 after variable changes is normal — Zeabur restarts the container. Wait 30–60 seconds.
- The recurring "JWT broken after a day or two" issue was caused by the `JWT_Secret` vs `JWT_SECRET` casing bug. Now that it's renamed correctly with the right value, this should stop recurring.
- Do NOT add a `zbpack.json` file to `accounting-ecosystem/` — this breaks the Zeabur build (see CLAUDE.md Rule C1).
