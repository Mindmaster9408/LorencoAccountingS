# Sean AI Coaching Tab Rebuild — Implementation Report
## Client Context Chat + Quick Actions
**Date:** 2026-05-21 | **Author:** Claude Sonnet 4.6 + Ruan van Loggerenberg

---

## 1. WHAT WAS BUILT

The coaching tab in `accounting-ecosystem/frontend-sean/index.html` was fully rebuilt from the old pattern learning tool into a client-context coaching assistant with three functional areas:

| Section | What It Does |
|---|---|
| Mode Toggle | Switch between Algemeen (general coaching chat) and Kliënt (client-specific chat) |
| Client Search | Search and select a coaching client by name (live search, Kliënt mode only) |
| Chat Interface | Send messages to Sean; in Kliënt mode, client context is injected automatically |
| Quick Actions | Three one-click actions when a client is selected |

**Quick Action outputs:**

| Button | Endpoint | What It Returns |
|---|---|---|
| Berei Sessie Voor | `POST /session-prep/:id` | Current step + step name, completed count, gauge highlights (concerns/strengths), last session summary + action items |
| Vorige Sessie Notas | `GET /clients/:id/latest-session` | Date, duration, mood before/after, summary, key insights, action items |
| Volle Profiel | `GET /clients/:id/full-profile` | Email, step, status, dream, all 9 gauges as visual bars, completed steps count, last 5 sessions |

---

## 2. FILES CHANGED

### `accounting-ecosystem/backend/sean/coaching-routes.js`
**Appended 6 new routes + 3 helpers.** All existing routes (GET /cases, POST /cases, POST /chat, POST /feedback, GET /patterns) are unchanged.

**New helpers:**
- `requireCoachingAccess` — permission middleware; checks `users.has_coaching_access = true` in ecosystem Supabase
- `COACHING_APP_URL` / `COACHING_APP_TOKEN` — process.env vars for Coaching App proxy
- `coachingAppFetch(path, opts)` — fetch wrapper for Coaching App; fails clearly with `code: 'NOT_CONFIGURED'` if env vars absent

**New routes (all require `requireCoachingAccess`):**

```
GET  /api/sean/coaching/clients/search?q=          — client name search
GET  /api/sean/coaching/clients/:id/context        — lightweight context for chat
GET  /api/sean/coaching/clients/:id/latest-session — most recent session notes
GET  /api/sean/coaching/clients/:id/full-profile   — full coaching profile
POST /api/sean/coaching/client-chat                — coaching chat with optional client context
POST /api/sean/coaching/session-prep/:id           — session preparation summary
```

### `accounting-ecosystem/frontend-sean/index.html`
**Coaching tab HTML and JS replaced.** All other tabs untouched.

---

## 3. AUTHENTICATION CHAIN

```
Browser (ecosystem JWT)
        ↓
GET/POST /api/sean/coaching/*
        ↓
authenticateToken          (ecosystem middleware, already on /api/sean router)
        ↓
requireCoachingAccess      (checks users.has_coaching_access in ecosystem DB)
        ↓  403 if not authorized
coachingAppFetch()         (proxies to Coaching App using COACHING_APP_TOKEN)
        ↓  503 if env vars missing
Coaching App /api/clients/:id
        ↓
Response returned to frontend
```

**Who has access:** Only `ruanvlog@lorenco.co.za` — the `has_coaching_access` column was set by migration `add_coaching_access.sql`. No other user can reach these routes.

---

## 4. DATA CONTRACTS

### Coaching App `GET /api/clients/:id` response
```json
{
  "success": true,
  "client": {
    "id": 1,
    "name": "Jan Smit",
    "email": "jan@example.com",
    "status": "active",
    "dream": "Finansiele vryheid binne 3 jaar",
    "current_step": 4,
    "last_session": "2026-05-15",
    "preferred_lang": "af",
    "gauges": {
      "fuel": 65, "horizon": 72, "thrust": 45,
      "engine": 58, "compass": 81, "positive": 70,
      "weight": 35, "nav": 60, "negative": 20
    },
    "steps": [
      { "step_id": "kwadrant", "step_name": "4 Quadrant Exercise", "step_order": 1, "completed": true },
      ...
    ],
    "sessions": [
      {
        "session_date": "2026-05-15",
        "duration_minutes": 60,
        "summary": "Bespreek vierde kwadrant resultate...",
        "key_insights": ["Klient het deurbraak gehad oor tyd-bestuur"],
        "action_items": ["Lees boek oor habits"],
        "mood_before": 5, "mood_after": 8
      }
    ]
  }
}
```

### Gauge scoring (9 gauges, 0–100)
- **Higher is better:** fuel, horizon, thrust, engine, compass, positive, nav
- **Lower is better:** weight (emosionele las), negative (negatiwiteit)

Session prep highlights: `weight > 60` or `negative > 60` = concern; `fuel < 40`, `thrust < 40`, etc. = concern.

---

## 5. NO-BROWSER-STORAGE COMPLIANCE (RULE D)

| State | Storage Type | Compliant? |
|---|---|---|
| Selected client | JS variable `_coachingClient` | YES — in-memory only |
| Chat history | DOM only (innerHTML) | YES — not persisted |
| Client context for chat | Fetched fresh on each message | YES — server-side |
| Mode (algemeen/client) | JS variable `_coachingMode` | YES — in-memory only |
| Search results | DOM only | YES — not persisted |
| Auth token used | `localStorage.sean_token` | YES — auth token only (Rule D2 exception) |

---

## 6. AUDIT LOGGING

All new routes write to `sean_coaching_audit_log` via the existing `auditLog()` helper:

| Action | Triggered By |
|---|---|
| `coaching_client_search` | GET /clients/search |
| `coaching_client_context_fetched` | GET /clients/:id/context |
| `coaching_latest_session_fetched` | GET /clients/:id/latest-session |
| `coaching_full_profile_fetched` | GET /clients/:id/full-profile |
| `coaching_client_chat` | POST /client-chat |
| `coaching_session_prep_generated` | POST /session-prep/:id |

---

## 7. DEPLOYMENT SETUP REQUIRED

Add to Zeabur ecosystem backend environment:

```
COACHING_APP_URL=https://<coaching-app-hostname>
COACHING_APP_TOKEN=<valid Coaching App JWT for the coach service account>
```

To get a `COACHING_APP_TOKEN`: log in to the Coaching App as the coach account, copy the JWT from the response to `POST /api/auth/login`. Store as env var.

**Until these are set:** All new coaching client routes return `503 { error: '...not configured...', code: 'NOT_CONFIGURED' }`. The frontend displays an Afrikaans message: "Coaching koppeling nie opgestel nie."

---

## 8. WHAT WAS AUDITED BEFORE BUILDING

| Audit Item | Finding |
|---|---|
| Coaching App server | Port 3001, own PostgreSQL (Supabase), own JWT auth |
| Canonical client table | `coaching_clients` (confirmed in clients.routes.js) |
| Client API response shape | `GET /api/clients/:id` returns `{ client: { ...steps[], gauges{}, sessions[] } }` |
| BASIS data | `basis_submissions` table, `linked_client_id` FK; no direct `/api/basis?client_id=X` endpoint |
| Auth system | Own JWT; ecosystem cannot reuse ecosystem tokens — must use service token |
| has_coaching_access | Migration `add_coaching_access.sql` confirmed; only `ruanvlog@lorenco.co.za` has access |
| Existing coaching routes | 5 routes in coaching-routes.js — all preserved unchanged |
| Coaching App aliases | `/api/coaching/clients` is an alias for `/api/clients` in server.js |
| Node version | >=18.0.0 — native `fetch` available, no extra dependency needed |
| Frontend api() helper | Throws on non-2xx; 401 → logout; error message comes from `data.error` |

---

## 9. WHAT WAS NOT BUILT (OUT OF SCOPE)

- **BASIS profile in coaching tab:** `basis_submissions` table exists but no direct `?client_id=X` filter endpoint. BASIS data can be added later by querying the list and filtering. Not included — would add Coaching App round-trips without a direct endpoint.
- **Real-time AI responses:** Sean is rule-based (pattern engine), not an LLM. The `client-chat` route injects client context as a prefix and uses `CoachingEngine.findSimilarCases()`. For true AI responses, `ANTHROPIC_API_KEY` + a proper AI call would need to be wired in.
- **Chat history persistence:** Chat clears on page refresh (by design — Rule D prohibits localStorage for business data). If persistence is required, a `POST /api/sean/coaching/conversation` endpoint backed by a new SQL table is needed.
- **Session creation from Sean:** Sean can view sessions but cannot create them. Session creation belongs to the Coaching App.

---

## 10. TEST CHECKLIST

After setting env vars in Zeabur:

- [ ] Open Sean → Coaching tab → default shows Algemeen mode
- [ ] Switch to Kliënt → search panel appears
- [ ] Type 2+ chars → client results appear within 300ms
- [ ] Select a client → badge appears, quick action buttons appear
- [ ] Send a message in Kliënt mode → typing indicator → response with client context
- [ ] Berei Sessie Voor → shows step name, gauge highlights, last session summary
- [ ] Vorige Sessie Notas → shows session date, mood, summary, insights, actions
- [ ] Volle Profiel → shows gauge bars, step count, recent sessions
- [ ] Clear client (x button) → resets to Kliënt mode without selected client
- [ ] Switch to Algemeen → client section hidden, chat still works
- [ ] Non-coaching user logs in → coaching client routes return 403
- [ ] Env vars not set → routes return 503 with readable Afrikaans error message
- [ ] No coaching data written to localStorage (browser devtools → Application → Storage)
