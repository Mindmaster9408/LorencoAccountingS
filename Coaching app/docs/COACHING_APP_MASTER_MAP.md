# COACHING APP — MASTER MAP
**The Neuro-Coach Method · Coaching Platform**

> Single authoritative reference for every developer working in this app.
> Last updated: May 2026
> Covers: architecture, every file, all API routes, all DB tables, data flows, known risks.

---

## TABLE OF CONTENTS

1. [App Overview](#1-app-overview)
2. [Folder Structure](#2-folder-structure)
3. [Root Pages](#3-root-pages)
4. [Frontend JS Map](#4-frontend-js-map)
5. [CSS Map](#5-css-map)
6. [Backend Server Map](#6-backend-server-map)
7. [Backend Routes Map](#7-backend-routes-map)
8. [Domain / Engine Map](#8-domain--engine-map)
9. [Database Map](#9-database-map)
10. [Feature Map](#10-feature-map)
11. [Data Flow Map](#11-data-flow-map)
12. [Debug Lookup Guide](#12-debug-lookup-guide)
13. [Known Risks](#13-known-risks)
14. [Rules for Future Coders](#14-rules-for-future-coders)

---

## 1. APP OVERVIEW

| Property | Value |
|---|---|
| App name | The Neuro-Coach Method — Coaching App |
| Backend | Node.js + Express.js (ES modules — `import`/`export`) |
| Backend port | 3001 |
| Database | PostgreSQL via Supabase (connection pool: pg, max 20 connections) |
| Frontend | Vanilla HTML + CSS + JS (no framework, no bundler) |
| Frontend serving | Express static from the app root (parent of `backend/`) |
| Auth | JWT — generated on login, stored as `auth_token` in localStorage, sent as `Authorization: Bearer <token>` on every API call |
| Deployment | Zeabur — Dockerfile in `accounting-ecosystem/` (see CLAUDE.md Part C for rules) |
| Languages supported | English (en), Afrikaans (af) |
| Module gating | Per-coach module access via `coach_program_access` DB table |

**What the app does:**
- Coaches log in and manage a portfolio of clients ("Pilots").
- Each client moves through a 15-step "Neuro-Coach Journey" across 3 phases.
- Coaches run the **BASIS** personality assessment (50 questions, 5 sections) and the **VITA Profile** (SPIL-E, 60 questions, 6 dimensions).
- Cockpit Gauges (9 instruments) track client emotional/performance state each session.
- A public portal allows prospective clients to self-complete a BASIS assessment → creates a Lead.
- An optional AI Assistant module provides coaching insights.

---

## 2. FOLDER STRUCTURE

```
Coaching app/
├── index.html                  ← Main SPA (Dashboard, Clients, Journey, Reports, Leads, Settings)
├── login.html                  ← Login / registration page
├── admin.html                  ← Admin panel (role=admin only)
├── client-assessment.html      ← Client-facing BASIS portal (token-gated, no coach login needed)
├── public-assessment.html      ← Public BASIS assessment — lead generation landing page
├── spil.html                   ← VITA Profile standalone page (authenticated coaches)
├── settings.html               ← (standalone settings page — rarely used; settings embedded in SPA)
├── setup-admin.html            ← One-time admin account setup page
├── styles.css                  ← Global styles
│
├── css/                        ← Feature-specific stylesheets (9 files — see CSS Map)
├── js/                         ← Frontend JavaScript modules (29 files — see JS Map)
├── images/                     ← Gauge images (fuel-gauge.png, compass-gauge.png, etc.)
├── docs/                       ← You are here
│
└── backend/
    ├── server.js               ← Express entry point, all route mounts
    ├── config/
    │   └── database.js         ← PostgreSQL pool setup, query() and getClient() helpers
    ├── middleware/
    │   ├── auth.js             ← authenticateToken, requireCoach, requireAdmin, requireClientAccess, requireModuleAccess
    │   └── auth.middleware.js  ← Duplicate/variant auth middleware (used by basis.routes.js and spil.routes.js)
    ├── routes/
    │   ├── auth.routes.js      ← /api/auth
    │   ├── clients.routes.js   ← /api/clients
    │   ├── admin.routes.js     ← /api/admin
    │   ├── ai.routes.js        ← /api/ai
    │   ├── leads.routes.js     ← /api/leads
    │   ├── kv.routes.js        ← /api/kv
    │   ├── basis.routes.js     ← /api/basis
    │   └── spil.routes.js      ← /api/spil
    ├── domain/
    │   ├── basis.engine.js     ← BASIS scoring logic
    │   ├── spil.config.js      ← SPIL dimension definitions, question keys, tie-breaker order
    │   ├── spil.engine.js      ← SPIL-E scoring logic
    │   └── spil.report.js      ← SPIL-E report generation (coach-facing + internal notes)
    ├── services/
    │   └── ai.service.js       ← AI provider abstraction (OpenAI or similar)
    ├── database/
    │   ├── schema.sql          ← Base schema — 10 tables
    │   ├── 001_add_persistence_fields.sql  ← Adds exercise_data + journey_progress to clients
    │   ├── 002_add_basis_submissions.sql   ← Creates basis_submissions table
    │   ├── 003_add_spil_profiles.sql       ← Creates spil_profiles table
    │   └── seed.sql            ← Seed data (admin user, program modules)
    ├── scripts/
    │   └── setup-database.js   ← CLI script to run schema + migrations
    └── tests/                  ← Test files
```

---

## 3. ROOT PAGES

| File | Title | Auth required | Purpose |
|---|---|---|---|
| `index.html` | Coaching App — Dashboard | Yes (JWT via api.js) | Main SPA. Contains all views: dashboard, clients, journey, leads, reports, settings. Rendered by `app.js`. |
| `login.html` | Login | No | Login form. Also handles coach registration. JS: `login.js`, `login-ui.js`. |
| `admin.html` | Admin Panel | Yes (role=admin) | User management, module access. Rendered by `admin-panel.js`. |
| `client-assessment.html` | BASIS Assessment — Client Portal | Token only (no JWT) | Client self-completes BASIS via a shareable link. Token in URL query string. JS: `client-assessment.js`. Calls `GET/PUT /api/basis/public/:token`. |
| `public-assessment.html` | Free BASIS Personality Assessment | No | Public marketing page. Visitor completes BASIS → submitted as a Lead. JS: `public-assessment.js`. Calls `POST /api/leads`. |
| `spil.html` | VITA Profiele | Yes (JWT) | Standalone VITA Profile (SPIL-E) page. Lists all profiles, create/view. JS: `spil-ui.js`. |
| `settings.html` | Settings | Yes (JWT) | Standalone settings page (rarely used; settings section also embedded in index.html SPA). |
| `setup-admin.html` | Setup Admin | No | One-time admin account creation. Use only on fresh deploy. |

---

## 4. FRONTEND JS MAP

All files live in `js/`. All are ES modules loaded via `<script type="module">` except `polyfills.js`.

### Initialization & Routing

| File | Key exports / functions | Purpose |
|---|---|---|
| `app.js` | `init()` | App entry point. Checks auth, sets up routing via sidebar nav clicks, calls `switchRoute()` to render views. Calls `renderDashboard()` on load. |
| `config.js` | `JOURNEY_STEPS[]`, `GAUGE_DEFINITIONS{}`, `GAUGE_ORDER[]`, `$()`, `$all()`, `escapeHtml()` | Global constants and DOM helpers. `JOURNEY_STEPS` defines all 15 journey step IDs and names. `GAUGE_DEFINITIONS` defines the 9 cockpit gauges. |
| `polyfills.js` | (no exports) | Browser compatibility shims. Loaded as a regular `<script>` before modules. |

### Auth & API Layer

| File | Key exports / functions | Purpose |
|---|---|---|
| `api.js` | `API_BASE_URL`, `apiRequest()`, `getAuthToken()`, `setAuthToken()`, `clearAuthToken()`, `isAuthenticated()`, `getCurrentUser()`, `logout()`, `api{}` | Core HTTP layer. All API calls use `apiRequest()`. JWT token stored as `auth_token` in localStorage. On 401 → clears token and redirects to `login.html`. Also exports `api` object with shorthand methods (`.getClients()`, `.updateClient()`, `.createClient()`, etc.). |
| `auth.js` | `getAllUsers()`, `getCurrentUser()`, `setCurrentUser()`, `isLoggedIn()`, `isAdmin()`, `getAdminMode()`, `registerUser()` | **Legacy local auth layer** — manages user state in localStorage (`coaching_app_current_user`). Contains hardcoded admin credentials. Used by `app.js` to check login state and admin mode. **Note: This is separate from the backend JWT auth.** See Known Risks #2. |
| `login.js` | (login form handling) | Handles the login form submission. Calls `POST /api/auth/login` via `api.js`. On success, stores JWT token and user info in localStorage. |
| `login-ui.js` | `showLoginScreen()`, `showUserInfo()` | Renders the login overlay and the user info badge in the sidebar. |

### Client Data Layer

| File | Key exports / functions | Purpose |
|---|---|---|
| `storage.js` | `readStore()`, `writeStore()`, `ensureStore()`, `saveClient()`, `createNewClient()` | **Data access abstraction.** `readStore()` fetches all clients from `GET /api/clients` and normalizes them. `writeStore()` is a **no-op** (legacy). `saveClient()` calls `PUT /api/clients/:id` or `POST /api/clients`. `createNewClient(name)` creates a blank client object. **No localStorage used for client data.** |
| `journey-data.js` | `JOURNEY_PHASES{}`, `JOURNEY_STEPS{}`, `normalizeClientCoachingState()`, `getJourneyProgress()` | Defines 3 phases (phase1=steps 1-6, phase2=7-12, phase3=13-17) and 17 step objects with title/icon/phase. `normalizeClientCoachingState()` maps DB snake_case → camelCase and ensures `exerciseData`, `journeyProgress`, `completedSteps`, `stepNotes` are safe objects. Called on every client read and write. `getJourneyProgress()` returns `{currentStep, percentComplete, currentPhase}`. |

### Dashboard & Clients

| File | Key exports / functions | Purpose |
|---|---|---|
| `dashboard.js` | `renderDashboard()`, `setupDashboardListeners()`, `updateStats()`, `createClientCard()` | Renders the Control Tower view. Fetches clients via `readStore()`. Renders stat cards (active/completed/avg progress). Renders client cards with phase badge, BASIS code, progress bar. |
| `clients.js` | `openClient()` | Opens the client detail view. Shows tabs: Journey Tracker, BASIS Assessment, Cockpit Gauges, VITA Profile. Each tab calls the relevant render function. |

### Journey Module

| File | Key exports / functions | Purpose |
|---|---|---|
| `journey-ui.js` | `renderJourneyTracker()` | Renders the Journey Tracker tab for a client. Step list, completion toggle, notes per step. |
| `journey-exercises.js` | (exercise form renderers) | Renders the exercise form for each journey step. Reads/writes `exerciseData` on the client object. |
| `journey-helpers.js` | (helper utilities) | Shared utilities for journey rendering (step status, progress calc, etc.). |
| `journey-report-generator.js` | (report generation) | Generates a printable/downloadable journey progress report for a client. |

### BASIS Assessment Module

| File | Key exports / functions | Purpose |
|---|---|---|
| `basis-assessment.js` | `BASIS_SECTIONS{}`, `SECTION_LABELS{}`, `BASIS_QUESTIONS{}` | Contains the 50 BASIS questions (5 sections × 10 questions each). Each question has `{id, text, reverse}`. Questions `_9` and `_10` per section are reverse-scored. |
| `basis-ui.js` | `renderBASISAssessment()` | Renders the BASIS Assessment tab within the client detail view. In-app (coach-capture) mode. |
| `basis-report-data.js` | (report data prep) | Prepares BASIS results data for report rendering. Interprets scores and section meanings. |
| `basis-report-generator.js` | (PDF/print generation) | Generates the full BASIS report document (printable/PDF). |
| `basis-report-ui.js` | `renderBASISReportViewer()` | Renders the BASIS report preview UI. Used from the Reports section. |
| `public-assessment.js` | (public form handling) | Controls the public-assessment.html page. Runs the full 50-question survey. On completion calls `POST /api/leads`. |
| `client-assessment.js` | (client portal handling) | Controls client-assessment.html. Reads the `?token=` URL param. Calls `GET /api/basis/public/:token` to load the submission, then `PUT /api/basis/public/:token` to submit. |

### VITA Profile (SPIL-E) Module

| File | Key exports / functions | Purpose |
|---|---|---|
| `spil-ui.js` | (main VITA controller) | Controls spil.html. Embeds all 60 SPIL-E questions (Afrikaans, 6 dimensions × 10). Lists all profiles, renders create/view flows. Calls `/api/spil` routes. Duplicates question definitions from `backend/domain/spil.config.js` — must be kept in sync. |
| `spil-client.js` | `renderSpilClientPanel()` | Renders the VITA Profile tab within the client detail view (`clients.js`). Links a client to their SPIL profile. |

### Other Modules

| File | Key exports / functions | Purpose |
|---|---|---|
| `gauges.js` | `renderCockpit()`, `saveGauges()` | Renders 9 cockpit gauge instruments with animated needles. Sliders and number inputs update needle position in real time. `saveGauges()` writes updated values to `PUT /api/clients/:id` (via `saveClient()`). |
| `leads.js` | `renderLeads()`, `setupLeadsListeners()`, `renderLeadsList()` | Renders the Leads section. Fetches from `GET /api/leads`. Supports filter by status (all / new / interested / contacted / converted). Convert lead to client. |
| `reports.js` | `renderReports()` | Renders the Reports section. Lists clients with BASIS status. Selects client → calls `renderBASISReportViewer()`. |
| `settings.js` | `renderSettings()` | Renders the Settings section (company branding, report template config). Reads/writes via `readStore()` / `writeStore()`. **Note: `writeStore()` is a no-op — settings may not persist unless using KV store.** |
| `admin-panel.js` | `renderAdminPanel()` | Renders the admin panel UI. Coach user management, module access toggles. Calls `/api/admin` routes. |

---

## 5. CSS MAP

All files live in `css/`. Loaded in `index.html` head. `styles.css` is the global base.

| File | Scope |
|---|---|
| `styles.css` (root) | Global layout, sidebar, main area, client cards, buttons, tabs, modals |
| `css/basis-assessment.css` | BASIS assessment question forms, progress bar, section headers |
| `css/journey.css` | Journey Tracker step list, phase badges, progress indicators |
| `css/journey-exercises.css` | Exercise forms within each journey step |
| `css/leads.css` | Leads pipeline cards, status badges, filter tabs |
| `css/login.css` | Login overlay, login form |
| `css/reports.css` | Reports page layout, client list, report preview container |
| `css/settings.css` | Settings form layout, branding color pickers |
| `css/admin-panel.css` | Admin panel user table, module access toggles |
| `css/spil.css` | VITA Profile page layout, dimension bars, profile cards |

---

## 6. BACKEND SERVER MAP

**File:** `backend/server.js`

| Responsibility | Detail |
|---|---|
| Framework | Express.js |
| Module syntax | ES modules (`import`/`export`) — requires `"type": "module"` in package.json |
| Port | `process.env.PORT \|\| 3001` |
| Security middleware | `helmet` (security headers), `cors`, `express-rate-limit` |
| Body parsing | `express.json({ limit: '10mb' })` |
| Dev logging | Request logging middleware active when `NODE_ENV !== 'production'` |
| Frontend serving | `express.static(path.join(__dirname, '..'))` — serves the app root (all HTML, css/, js/, images/) |
| SPA fallback | `GET *` → serves `index.html` (enables direct URL access to app) |
| Health check | `GET /health` → `{ status: 'ok', timestamp }` |
| Route mounts | See table below |

**Route mounts:**

| Mount path | Router file |
|---|---|
| `/api/auth` | `routes/auth.routes.js` |
| `/api/clients` | `routes/clients.routes.js` |
| `/api/admin` | `routes/admin.routes.js` |
| `/api/ai` | `routes/ai.routes.js` |
| `/api/leads` | `routes/leads.routes.js` |
| `/api/kv` | `routes/kv.routes.js` |
| `/api/basis` | `routes/basis.routes.js` |
| `/api/spil` | `routes/spil.routes.js` |

**Database (`backend/config/database.js`):**
- `pg.Pool` with `max: 20`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000`
- Supports `DATABASE_URL` env var (Supabase connection string) or individual `DB_HOST/PORT/NAME/USER/PASSWORD` vars
- SSL always enabled with `rejectUnauthorized: false`
- Exports: `query(text, params)` (async), `getClient()` (pool.connect for transactions)
- Dev mode logs every query with duration and row count

---

## 7. BACKEND ROUTES MAP

Legend: 🔓 = no auth required | 🔑 = JWT required (any authenticated user) | 👨‍💼 = coach role | 🛡️ = admin role | 🎫 = token param only

### AUTH — `/api/auth` (auth.routes.js)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | 🔓 | Email + password login. Returns JWT token + user object + moduleAccess array. Updates `last_login`. |
| POST | `/api/auth/logout` | 🔑 | Logout (JWT invalidation is client-side — remove token). |
| GET | `/api/auth/me` | 🔑 | Returns current user profile + module access. |
| POST | `/api/auth/register` | 🔓 | Register a new coach account. |
| POST | `/api/auth/change-password` | 🔑 | Change password (requires current password). |

### CLIENTS — `/api/clients` (clients.routes.js)

All routes require `authenticateToken` + `requireCoach`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/clients` | 👨‍💼 | List all clients for logged-in coach. Optional `?status=active\|all\|past`. Returns `session_count` and `last_actual_session` via JOIN. All rows passed through `normalizeClientRow()`. |
| GET | `/api/clients/:clientId` | 👨‍💼 + `requireClientAccess` | Full client detail: client row + `client_steps` + latest `client_gauges` + recent `client_sessions`. |
| POST | `/api/clients` | 👨‍💼 | Create a new client. `coach_id` set from JWT. |
| PUT | `/api/clients/:clientId` | 👨‍💼 + `requireClientAccess` | Update client (name, email, status, dream, progress, `exercise_data`, `journey_progress`, gauges, etc.). |
| DELETE | `/api/clients/:clientId` | 👨‍💼 + `requireClientAccess` | Archive or delete client. |

**`normalizeClientRow()`** (clients.routes.js): Ensures `exercise_data` and `journey_progress` are never null — protects against pre-migration rows.

### ADMIN — `/api/admin` (admin.routes.js)

All routes require `authenticateToken` + `requireAdmin`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/admin/users` | 🛡️ | List all users (id, email, first_name, last_name, role, is_active, created_at, last_login). |
| POST | `/api/admin/users` | 🛡️ | Create a new user (coach/client/admin). Password hashed with bcrypt. |
| PUT | `/api/admin/users/:userId` | 🛡️ | Update user details or toggle `is_active`. |
| GET | `/api/admin/modules` | 🛡️ | List all program modules. |
| GET | `/api/admin/coaches/:coachId/modules` | 🛡️ | Get module access list for a specific coach. |
| PUT | `/api/admin/coaches/:coachId/modules` | 🛡️ | Update module access (enable/disable) for a coach. |

### AI — `/api/ai` (ai.routes.js)

All routes require `authenticateToken` + `requireCoach` + `requireModuleAccess('ai_assistant')`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/ai/chat` | 👨‍💼 🎫module | Chat with AI about a client. Body: `{ clientId?, message }`. |
| GET | `/api/ai/insights/:clientId` | 👨‍💼 🎫module | Get AI-generated insights for a specific client. |
| GET | `/api/ai/conversations` | 👨‍💼 🎫module | Get conversation history. Optional `?clientId=` filter. |

### LEADS — `/api/leads` (leads.routes.js)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/leads` | 🔓 | Submit a new lead (from public assessment). Body: `{ name, email, phone, company, preferred_lang, basisAnswers, basisResults, coachingGoals, wantsCoaching, source }`. |
| GET | `/api/leads` | 👨‍💼 | List all leads for logged-in coach. |
| PUT | `/api/leads/:id` | 👨‍💼 | Update lead status, assign coach, mark contacted/converted. |
| DELETE | `/api/leads/:id` | 👨‍💼 | Delete a lead. |

**Note:** `leads.routes.js` self-creates the `leads` table on startup and uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to safely add newer columns to existing tables.

### KV STORE — `/api/kv` (kv.routes.js)

All routes require `authenticateToken`. Table: `coaching_app_kv_store`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/kv` | 🔑 | Return all KV pairs for authenticated user as `{ key: value }` flat object. |
| PUT | `/api/kv/:key` | 🔑 | Upsert a key for authenticated user. Body: `{ value: <any JSON> }` or raw body. |
| DELETE | `/api/kv/:key` | 🔑 | Delete a key for authenticated user. |

**Note:** KV store is per-user scoped (`user_id = String(req.user.id)`). Self-creates table on startup.

### BASIS — `/api/basis` (basis.routes.js)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/basis/public/:token` | 🎫token | Get submission info by `access_token` — used by client-assessment.html. Returns respondent name, lang, current answers, status. |
| PUT | `/api/basis/public/:token` | 🎫token | Client submits completed answers. Triggers server-side scoring (`scoreBasisAnswers()`) and sets `status = 'submitted'`. |
| POST | `/api/basis` | 🔑 | Create a new draft BASIS submission. Body: `{ respondent_name, respondent_email, respondent_phone, preferred_lang, mode, linked_client_id?, linked_lead_id? }`. |
| GET | `/api/basis` | 🔑 | List all submissions owned by authenticated user. |
| GET | `/api/basis/:id` | 🔑 | Get full submission including `basis_answers`, `basis_results`, `report_generated`, `report_editable`. |
| PUT | `/api/basis/:id` | 🔑 | Update answers, trigger re-scoring, update status, save report. |
| PUT | `/api/basis/:id/report-editable` | 🔑 | Update coach-editable report sections only. Allowed keys: `coachNotes`, `productsPage`, `invitationText`, `quotationText`. Max 10,000 chars each. |
| POST | `/api/basis/:id/generate-link` | 🔑 | Issue a new `access_token` (crypto random) for this submission. Returns shareable URL. |

**Note:** `basis.routes.js` self-creates `basis_submissions` table on startup via `ensureBasisTable()`. Imports auth from `auth.middleware.js` (not `auth.js`).

### SPIL — `/api/spil` (spil.routes.js)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/spil` | 🔑 | Create a new SPIL-E profile. Body: `{ respondent_name, respondent_email?, respondent_phone?, preferred_lang?, answers?, linked_client_id? }`. If answers provided, scores and generates report immediately. |
| GET | `/api/spil` | 🔑 | List all SPIL profiles for authenticated user. |
| GET | `/api/spil/:id` | 🔑 | Get full profile including answers, scores, ranking, spil_code, report_generated, report_internal. |
| PUT | `/api/spil/:id` | 🔑 | Update answers → recomputes scores (`buildResults()`) and regenerates report (`generateReport()`). |

**Note:** `spil.routes.js` self-creates `spil_profiles` table on startup via `ensureSpilTable()`. Imports auth from `auth.middleware.js`.

---

## 8. DOMAIN / ENGINE MAP

### `backend/domain/basis.engine.js`

Scores the 50-question BASIS assessment on the server side.

| Export | Signature | Description |
|---|---|---|
| `scoreBasisAnswers(answers)` | `(object) → {BALANS:{score,level,sum}, AKSIE:{...}, SORG:{...}, INSIG:{...}, STRUKTUUR:{...}}` | Scores all 5 sections. `score` = average 1–10. `level` = high/medium/low. `sum` = adjusted integer 0–100 (legacy format). Reverse-scored questions (\_9 and \_10 per section) are inverted: `11 - value`. |
| `toLegacyBasisResults(scored)` | `(scored) → {sectionScores:{BALANS:70,...}, basisOrder:['BALANS','SORG',...], timestamp, computedBy:'server'}` | Converts server scores to the format stored in `basis_results` column. `basisOrder` = sections ranked highest to lowest `sum`. |
| `ALL_QUESTION_KEYS` | `string[]` | All 50 question keys (`BALANS_1`…`STRUKTUUR_10`). |
| `TOTAL_QUESTIONS` | `50` | Total question count. |

**Scoring formula:**
- Each question: value 1–10
- Reverse questions: `11 - raw_value`
- Section score (sum): sum of all 10 adjusted values → range 0–100
- Section average: sum / 10 → range 0–10

---

### `backend/domain/spil.config.js`

Configuration for the SPIL-E personality model.

| Export | Type | Description |
|---|---|---|
| `SPIL_STRUCTURE` | `object` | Full config: `dimensions[]`, `tieBreakerOrder[]`, `scoring.questionsPerDimension=10`, `scoring.minPerQuestion=1`, `scoring.maxPerQuestion=10` |
| `ALL_SPIL_KEYS` | `string[]` | All 60 question keys (`STRUKTUUR_1`…`INISIATIEF_10`). |
| `SPIL_DIMENSIONS` | `string[]` | `['STRUKTUUR','PRESTASIE','INSIG','LIEFDE','EMOSIE','INISIATIEF']` |
| `TOTAL_SPIL_QUESTIONS` | `60` | Total question count. |

**Tie-breaker order** determines ranking when two dimensions have equal scores. Defined in `tieBreakerOrder`.

---

### `backend/domain/spil.engine.js`

Scores the 60-question SPIL-E assessment.

| Export | Signature | Description |
|---|---|---|
| `calculateScores(answers)` | `(object) → {STRUKTUUR:72, PRESTASIE:65, ...}` | Simple SUM per dimension. No reverse scoring. Unknown keys silently ignored. NaN values discarded. Partial answers score from answered only — no defaulting. |
| `rankDimensions(scores)` | `(scores) → string[]` | Returns dimensions sorted highest to lowest. Tie-breaker applied via `tieBreakerOrder`. |
| `buildResults(answers, validate?)` | `(object, bool?) → {scores, ranking, spil_code, answeredCount, totalQuestions, isComplete}` | Full result object. `spil_code` is ranking joined as `"INSIG – INISIATIEF – ..."`. |
| `validateAnswers(answers)` | `(object) → {valid, errors[], answeredCount}` | Validates that all 60 question keys are present and in range 1–10. |
| `TOTAL_SPIL_QUESTIONS` | `60` | Re-exported from spil.config.js. |

---

### `backend/domain/spil.report.js`

Generates human-readable SPIL-E reports.

| Export | Signature | Description |
|---|---|---|
| `generateReport(results, lang)` | `({scores, ranking, spil_code}, 'en'\|'af') → JSONB object` | Generates client-facing report. Includes dimension descriptions, top-3 strengths, development areas. Stored in `spil_profiles.report_generated`. |
| `generateInternalNotes(results, lang)` | `({scores, ranking, spil_code}, 'en'\|'af') → JSONB object` | Generates coach-internal notes. Coaching approach suggestions. Stored in `spil_profiles.report_internal`. |

---

## 9. DATABASE MAP

**Database:** PostgreSQL on Supabase.  
**Schema:** Applied manually. `schema.sql` = base tables. Three sequential migrations add columns and tables.  
**Self-creating tables:** `basis_submissions`, `spil_profiles`, `leads`, `coaching_app_kv_store` are created by their respective route files on startup — safe to deploy cold.

---

### `users`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| email | TEXT UNIQUE NOT NULL | |
| password_hash | TEXT NOT NULL | bcrypt hashed |
| first_name | TEXT | |
| last_name | TEXT | |
| role | ENUM('admin','coach','client') | |
| is_active | BOOLEAN DEFAULT true | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |
| last_login | TIMESTAMPTZ | Updated on each login |

---

### `program_modules`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| module_key | TEXT UNIQUE | e.g. `ai_assistant`, `basis`, `spil` |
| module_name | TEXT | Display name |
| description | TEXT | |
| is_default | BOOLEAN | If true, enabled for all coaches by default |

---

### `coach_program_access`
| Column | Type | Notes |
|---|---|---|
| coach_id | INT FK → users.id | |
| module_id | INT FK → program_modules.id | |
| is_enabled | BOOLEAN | |

Primary key: `(coach_id, module_id)`. Controls which features each coach can use.

---

### `clients`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| coach_id | INT FK → users.id | Required — all clients belong to a coach |
| name | TEXT NOT NULL | |
| email | TEXT | |
| phone | TEXT | |
| preferred_lang | TEXT | `'English'` or `'Afrikaans'` |
| status | ENUM('active','completed','paused','archived') | |
| dream | TEXT | Client's stated dream/goal |
| current_step | INT DEFAULT 1 | Journey step number (1–17) |
| progress_completed | INT DEFAULT 0 | Count of completed journey steps |
| progress_total | INT | Total journey steps |
| last_session | DATE | |
| **exercise_data** | **JSONB DEFAULT '{}'** | All exercise form responses. Key = step_id, value = form answers. Added in migration 001. |
| **journey_progress** | **JSONB DEFAULT {...}** | `{currentStep, completedSteps[], stepNotes{}, stepCompletionDates{}}`. Added in migration 001. |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |
| archived_at | TIMESTAMPTZ | |

---

### `client_steps`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| client_id | INT FK → clients.id ON DELETE CASCADE | |
| step_id | TEXT | Journey step identifier |
| step_name | TEXT | |
| step_order | INT | |
| completed | BOOLEAN DEFAULT false | |
| completed_at | TIMESTAMPTZ | |
| notes | TEXT | |
| why | TEXT | Client's "why" for this step |
| fields | JSONB | Step-specific form fields |

---

### `client_sessions`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| client_id | INT FK → clients.id | |
| coach_id | INT FK → users.id | |
| session_date | DATE | |
| duration_minutes | INT | |
| summary | TEXT | |
| key_insights | TEXT[] | Array of insight strings |
| action_items | TEXT[] | Array of action item strings |
| mood_before | INT (1–10) | |
| mood_after | INT (1–10) | |

---

### `client_gauges`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| client_id | INT FK → clients.id | |
| gauge_key | TEXT | One of: `fuel`, `horizon`, `thrust`, `engine`, `compass`, `positive`, `weight`, `nav`, `negative` |
| gauge_value | INT (0–100) | |
| recorded_at | TIMESTAMPTZ | |
| session_id | INT FK → client_sessions.id | Optional — which session this was recorded in |
| notes | TEXT | |

Latest gauge per key read via `DISTINCT ON (gauge_key) ORDER BY gauge_key, recorded_at DESC`.

---

### `ai_learning_data`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| coach_id | INT FK → users.id | |
| client_id | INT FK → clients.id | |
| data_type | TEXT | Classification of the learning data |
| data_content | JSONB | |
| importance_score | FLOAT | |

---

### `ai_conversations`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| coach_id | INT FK → users.id | |
| client_id | INT FK → clients.id | |
| session_id | INT FK → client_sessions.id | |
| role | TEXT | `'user'` or `'assistant'` |
| content | TEXT | Message text |
| ai_provider | TEXT | e.g. `'openai'` |
| tokens_used | INT | |

---

### `basis_submissions`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| mode | TEXT DEFAULT 'coach_capture' | `coach_capture` or `public_link` |
| status | TEXT DEFAULT 'draft' | `draft` → `submitted` → `reviewed` → `converted` |
| access_token | TEXT UNIQUE | Random token for public link sharing |
| respondent_name | TEXT NOT NULL | |
| respondent_email | TEXT | |
| respondent_phone | TEXT | |
| preferred_lang | TEXT DEFAULT 'en' | `en` or `af` |
| linked_lead_id | INT | FK to leads.id (optional) |
| linked_client_id | INT | FK to clients.id (optional) |
| created_by_user_id | INT | FK to users.id |
| **basis_answers** | **JSONB DEFAULT '{}'** | Flat: `{"BALANS_1": 7, "AKSIE_3": 5, ...}` — raw respondent answers (1–10 scale, 50 keys) |
| **basis_results** | **JSONB** | Computed: `{sectionScores:{BALANS:70,...}, basisOrder:['BALANS','SORG',...], timestamp, computedBy:'server'}` |
| **report_generated** | **JSONB** | Full rendered report (markdown snapshot) |
| **report_editable** | **JSONB DEFAULT '{}'** | Coach-editable sections: `{coachNotes, productsPage, invitationText, quotationText}` |
| source | TEXT DEFAULT 'coach_capture' | `coach_capture`, `public_link`, or `lead_conversion` |
| submitted_at | TIMESTAMPTZ | Set when status changes to `submitted` |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `access_token`, `linked_client_id`, `created_by_user_id`, `status`.
Self-created by `basis.routes.js` on startup.

---

### `spil_profiles`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| respondent_name | TEXT NOT NULL | |
| respondent_email | TEXT | |
| respondent_phone | TEXT | |
| preferred_lang | TEXT DEFAULT 'en' | `en` or `af` |
| **answers** | **JSONB DEFAULT '{}'** | Flat: `{"STRUKTUUR_1": 7, "PRESTASIE_3": 4, ...}` — 60 keys, values 1–10 |
| **scores** | **JSONB** | Per-dimension sums: `{STRUKTUUR: 72, PRESTASIE: 65, ...}` range 0–100 |
| **ranking** | **JSONB** | Ordered list: `["INSIG","INISIATIEF","PRESTASIE",...]` |
| **spil_code** | **TEXT** | Human readable: `"INSIG – INISIATIEF – PRESTASIE – EMOSIE – STRUKTUUR – LIEFDE"` |
| **report_generated** | **JSONB** | Client-facing report (from `spil.report.generateReport()`) |
| **report_internal** | **JSONB** | Coach notes (from `spil.report.generateInternalNotes()`) |
| created_by_user_id | INT | FK to users.id |
| linked_client_id | INT | FK to clients.id (optional) |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `linked_client_id`, `created_by_user_id`, `respondent_email`.
Self-created by `spil.routes.js` on startup.

---

### `leads`
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| name | TEXT NOT NULL | |
| email | TEXT | |
| phone | TEXT | |
| company | TEXT | |
| preferred_lang | TEXT | |
| message | TEXT | |
| basis_answers | JSONB | Raw answers from public assessment |
| basis_results | JSONB | Computed scores from public assessment |
| coaching_goals | TEXT | |
| wants_coaching | BOOLEAN DEFAULT false | |
| source | TEXT DEFAULT 'public_assessment' | |
| status | TEXT DEFAULT 'new' | `new`, `contacted`, `converted`, `archived` |
| coach_id | INT FK → users.id ON DELETE SET NULL | Assigned coach |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

Self-created by `leads.routes.js` on startup. Uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for newer columns.

---

### `coaching_app_kv_store`
| Column | Type | Notes |
|---|---|---|
| user_id | TEXT NOT NULL | String of users.id |
| key | TEXT NOT NULL | Arbitrary key (e.g. `appSettings`, `coachProfile`) |
| value | JSONB | Any JSON value |
| updated_at | TIMESTAMPTZ DEFAULT now() | |

Primary key: `(user_id, key)`. Per-user key-value store for settings and coach-level data.
Self-created by `kv.routes.js` on startup.

---

### Migrations (apply in order)

| File | What it does | Applied via |
|---|---|---|
| `schema.sql` | Creates all 10 base tables | `psql` or Supabase SQL editor |
| `001_add_persistence_fields.sql` | Adds `exercise_data` + `journey_progress` JSONB to `clients` | Manual |
| `002_add_basis_submissions.sql` | Creates `basis_submissions` table (superseded by auto-create in basis.routes.js) | Manual / auto |
| `003_add_spil_profiles.sql` | Creates `spil_profiles` table (superseded by auto-create in spil.routes.js) | Manual / auto |
| `seed.sql` | Admin user + default program modules | Manual (once) |

**Note:** Tables for `basis_submissions`, `spil_profiles`, `leads`, and `coaching_app_kv_store` are also self-created by their route files using `CREATE TABLE IF NOT EXISTS`. The migration files serve as the canonical schema reference.

---

## 10. FEATURE MAP

### Feature 1 — Client Management (The Control Tower)
- **Entry point:** `index.html` → `dashboard.js` → `renderDashboard()`
- **Client card data:** Loaded via `readStore()` → `GET /api/clients`
- **Open client:** `openClient(clientId)` in `clients.js`
- **Client detail tabs:** Journey Tracker, BASIS Assessment, Cockpit Gauges, VITA Profile
- **Create client:** "New Pilot" button → `createNewClient()` → `saveClient()` → `POST /api/clients`
- **Edit client:** In-form save → `saveClient()` → `PUT /api/clients/:id`
- **DB tables:** `clients`, `client_steps`, `client_sessions`, `client_gauges`

### Feature 2 — The Neuro-Coach Journey (15 steps, 3 phases)
- **Entry point:** `clients.js` → `renderJourneyTracker()` in `journey-ui.js`
- **Journey definition:** `config.js` `JOURNEY_STEPS[]` (15 steps) and `journey-data.js` `JOURNEY_STEPS{}` (17 entries with richer metadata — slight mismatch, see Known Risks #6)
- **Phases:** Phase 1 (steps 1–6 Discovery), Phase 2 (steps 7–12 Transformation), Phase 3 (steps 13–17 Mastery)
- **Exercise data:** Stored in `clients.exercise_data` JSONB. Key = step id, value = form answers
- **Progress data:** Stored in `clients.journey_progress` JSONB: `{currentStep, completedSteps[], stepNotes{}, stepCompletionDates{}}`
- **Normalization:** `normalizeClientCoachingState()` in `journey-data.js` — must be called before any client read/write
- **DB tables:** `clients` (exercise_data, journey_progress columns), `client_steps`

### Feature 3 — BASIS Personality Assessment
- **5 sections:** BALANS, AKSIE, SORG, INSIG, STRUKTUUR
- **50 questions:** 10 per section. Questions 9 and 10 per section are reverse-scored.
- **Scoring:** Server-side (`basis.engine.js`). Section score = sum of 10 adjusted values (range 0–100). BASIS code = sections ranked highest to lowest.
- **Modes:**
  - **Coach capture:** Coach fills in-app on client's behalf → `basis-ui.js` → `POST/PUT /api/basis`
  - **Public link:** Coach generates link → `POST /api/basis/:id/generate-link` → client opens `client-assessment.html?token=...` → `GET/PUT /api/basis/public/:token`
  - **Public assessment portal:** Visitor fills `public-assessment.html` → `POST /api/leads` (stored as lead, not basis_submission)
- **Report:** Generated on submission. Coach can edit 4 sections (`coachNotes`, `productsPage`, `invitationText`, `quotationText`) via `PUT /api/basis/:id/report-editable`
- **DB tables:** `basis_submissions`

### Feature 4 — VITA Profile (SPIL-E Personality Model)
- **Standalone page:** `spil.html`, controlled by `spil-ui.js`
- **6 dimensions:** STRUKTUUR, PRESTASIE, INSIG, LIEFDE, EMOSIE, INISIATIEF
- **60 questions:** 10 per dimension. All questions in Afrikaans. No reverse scoring.
- **Scoring:** Server-side (`spil.engine.js`). Dimension score = sum of 10 answers (range 0–100). SPIL code = dimensions ranked highest to lowest, joined with "–".
- **Reports:** `report_generated` (client-facing) and `report_internal` (coach notes). Both bilingual (en/af).
- **In-client panel:** `spil-client.js` → `renderSpilClientPanel()` shows VITA tab in client detail view.
- **DB table:** `spil_profiles`

### Feature 5 — Cockpit Gauges (9 instruments)
- **Gauges:** fuel (Emotional Functioning), horizon (Flow State), thrust (Power), engine (Self-Perception), compass (Direction), positive (Emotion), weight (Balance), nav (Navigation), negative (Stress)
- **Entry point:** `clients.js` → `renderCockpit()` in `gauges.js`
- **UI:** Animated gauge needles. Slider + number input per gauge.
- **Storage:** `saveGauges()` → `saveClient()` → `PUT /api/clients/:id`
- **DB table:** `client_gauges`

### Feature 6 — Leads Pipeline
- **Public source:** `public-assessment.html` → `POST /api/leads` (no auth)
- **Coach view:** `leads.js` → `renderLeads()` → `GET /api/leads`
- **Pipeline stages:** new → contacted → converted → archived
- **Convert to client:** Creates a client from lead data → `POST /api/clients`
- **DB table:** `leads`

### Feature 7 — AI Assistant (module-gated)
- **Required module:** `ai_assistant` must be enabled for coach in `coach_program_access`
- **Routes:** `POST /api/ai/chat`, `GET /api/ai/insights/:clientId`, `GET /api/ai/conversations`
- **Service:** `backend/services/ai.service.js`
- **DB tables:** `ai_learning_data`, `ai_conversations`

### Feature 8 — Reports
- **Entry point:** `app.js` → `renderReports()` in `reports.js`
- **Currently supports:** BASIS report only (viewer + PDF)
- **Render chain:** `reports.js` → `renderBASISReportViewer()` in `basis-report-ui.js` → `basis-report-generator.js`

### Feature 9 — Admin Panel
- **Entry point:** `admin.html` or `index.html` (admin-mode flag) → `renderAdminPanel()` in `admin-panel.js`
- **Functions:** Create/edit users, toggle `is_active`, manage coach module access
- **Routes:** `/api/admin/*` (admin role only)
- **DB tables:** `users`, `program_modules`, `coach_program_access`

---

## 11. DATA FLOW MAP

### Coach Login Flow
```
login.html form submit
  → login.js: POST /api/auth/login
  → Server: verify password (bcrypt), generate JWT (jsonwebtoken)
  → Response: { token, user, moduleAccess[] }
  → api.js: setAuthToken(token) → localStorage.setItem('auth_token', token)
  → localStorage.setItem('user', JSON.stringify(user))
  → window.location.href = 'index.html'
```

### Page Load / Client Data Flow
```
index.html → app.js init()
  → auth.js: isLoggedIn() checks localStorage 'coaching_app_current_user'
  → storage.js: readStore()
    → api.js: GET /api/clients
    → clients.routes.js: SELECT FROM clients WHERE coach_id = $1
    → normalizeClientRow() on each row
    → Response: { clients[] }
  → journey-data.js: normalizeClientCoachingState() on each client
  → dashboard.js: renderDashboard() renders client cards
```

### Save Client Flow
```
Any component modifies client object
  → storage.js: saveClient(client)
    → journey-data.js: normalizeClientCoachingState(client) — safety net
    → api.js: PUT /api/clients/:id (if client.id exists)
    → clients.routes.js: UPDATE clients SET ... WHERE id = $1 AND coach_id = $2
    → Supabase write
```

### BASIS Public Link Flow
```
Coach: POST /api/basis/:id/generate-link
  → crypto.randomBytes(32).toString('hex') → access_token stored in basis_submissions
  → Response: { url: '/client-assessment.html?token=<token>' }

Client opens link → client-assessment.html?token=<token>
  → client-assessment.js: reads URL param
  → GET /api/basis/public/:token → returns submission data
  → Client fills 50 questions
  → PUT /api/basis/public/:token → server scores answers → status = 'submitted'
  → Coach sees status update in their basis_submissions list
```

### Public Assessment → Lead Flow
```
Visitor opens public-assessment.html
  → public-assessment.js: runs 50-question BASIS survey
  → On submit: POST /api/leads (no auth)
    → leads.routes.js: INSERT INTO leads (name, email, basis_answers, basis_results, wants_coaching, ...)
  → Coach sees new lead in Leads section
```

### VITA Profile Flow
```
spil.html → spil-ui.js
  → GET /api/spil → list all profiles
  → Coach fills 60 questions
  → POST /api/spil (answers included) → spil.engine.js: buildResults() → spil.report.js: generateReport()
  → Profile stored in spil_profiles with scores, ranking, spil_code, reports
  → Optionally linked to client via linked_client_id
```

### KV Store Flow (settings / coach-level data)
```
settings.js or any non-client data write
  → GET /api/kv → loads all { key: value } pairs for user
  → PUT /api/kv/:key → upsert a key in coaching_app_kv_store for this user_id
```

---

## 12. DEBUG LOOKUP GUIDE

| Symptom | Where to look |
|---|---|
| Client data not loading after page refresh | `storage.js readStore()` → `GET /api/clients` → check JWT token in localStorage (`auth_token`) → check `clients.routes.js` |
| Client data not saving | `storage.js saveClient()` → `api.js apiRequest()` → `PUT /api/clients/:id` → check `normalizeClientCoachingState()` not corrupting data |
| Journey exercises not persisting | `clients.exercise_data` JSONB column → write path: `saveClient()` → `PUT /api/clients/:id` |
| Journey progress reset on reload | `clients.journey_progress` JSONB column → `normalizeClientCoachingState()` in `journey-data.js` |
| BASIS scores wrong or missing | `basis.engine.js scoreBasisAnswers()` → check reverse-scoring logic for `_9` and `_10` questions |
| BASIS public link not working | `basis_submissions.access_token` → `GET /api/basis/public/:token` → check token validity and submission status |
| VITA Profile scores wrong | `spil.engine.js calculateScores()` → check dimension key matching (STRUKTUUR_1…INISIATIEF_10) |
| VITA Profile questions not matching backend | `spil-ui.js` embeds a copy of the questions — must match `backend/domain/spil.config.js` (see Known Risks #7) |
| Gauge values not saving | `gauges.js saveGauges()` → `saveClient()` → check client object has `gauges` property |
| Lead not appearing for coach | `leads.routes.js GET /api/leads` → check `coach_id` assignment — unassigned leads may not appear per-coach |
| 401 on API calls | JWT expired or missing → `api.js clearAuthToken()` clears and redirects to login |
| 403 on AI routes | `coach_program_access` table — `ai_assistant` module not enabled for this coach |
| Table doesn't exist error on startup | Check `ensureBasisTable()`, `ensureSpilTable()`, `ensureLeadsTable()`, `coaching_app_kv_store` self-create queries in respective route files |
| Database connection failure | `backend/config/database.js` → check `DATABASE_URL` env var or individual `DB_*` vars |
| `exercise_data` or `journey_progress` is null | Pre-migration row — `normalizeClientRow()` in clients.routes.js handles this defensively |
| Admin cannot see module toggles | Check `users.role = 'admin'` — `requireAdmin` middleware rejects non-admin |
| Settings not saving | `settings.js` calls `writeStore()` which is a **no-op** — if using KV store, check `PUT /api/kv/appSettings` |

---

## 13. KNOWN RISKS

### Risk 1 — Hardcoded Admin Credentials in auth.js (SECURITY)
**File:** `js/auth.js`  
**Detail:** The legacy local auth module (`auth.js`) contains a hardcoded admin email and password in plain JavaScript source code visible to any browser user. This is the old auth system, predating the JWT backend.  
**Impact:** Credential exposure if anyone views page source.  
**Recommended action:** Remove hardcoded credentials from `auth.js`. Rely entirely on the backend JWT auth for all login validation.

### Risk 2 — Two Parallel Auth Systems
**Files:** `js/auth.js` (legacy localStorage) and `js/api.js` (JWT backend)  
**Detail:** `app.js` calls `auth.js` to check `isLoggedIn()` and `getCurrentUser()`, which reads from localStorage `coaching_app_current_user`. API calls use the JWT token from `auth_token`. These two systems can desynchronize — a user might pass the `isLoggedIn()` check but have no valid JWT, causing API 401s.  
**Recommended action:** Unify on the JWT system. Replace `auth.js` with JWT-based checks from `api.js`.

### Risk 3 — No Automated Migration Runner
**Files:** `backend/database/` migration files  
**Detail:** Migrations 001, 002, 003 must be applied manually via psql or the Supabase SQL editor. There is no `migrate.js` runner. Fresh databases need: `schema.sql` first, then `001`, `002`, `003`, then `seed.sql`.  
**Impact:** On a fresh deploy, missing `exercise_data` and `journey_progress` columns cause `normalizeClientRow()` to return defaults (safe but silent).  
**Recommended action:** Document exact apply-order in SETUP_GUIDE.md. Consider a migration runner.

### Risk 4 — Dual Auth Middleware Files
**Files:** `backend/middleware/auth.js` and `backend/middleware/auth.middleware.js`  
**Detail:** `basis.routes.js` and `spil.routes.js` import from `auth.middleware.js`. All other routes import from `auth.js`. These may have diverged. A change to one does not propagate to the other.  
**Recommended action:** Consolidate into one file (`auth.js`). Update `basis.routes.js` and `spil.routes.js` imports.

### Risk 5 — settings.js writeStore() is a No-Op
**Files:** `js/settings.js`, `js/storage.js`  
**Detail:** `settings.js` calls `writeStore(store)` which is intentionally a no-op (all writes go through individual `saveClient()` API calls). Settings data (`appSettings`) will not persist unless there is a separate `PUT /api/kv/appSettings` call.  
**Impact:** Company branding, report template settings may be lost on browser refresh.  
**Recommended action:** Verify settings save via KV store, or implement explicit `PUT /api/kv/appSettings` in `renderSettings()`.

### Risk 6 — JOURNEY_STEPS Count Mismatch
**Files:** `js/config.js` (15 steps) and `js/journey-data.js` (17 step objects)  
**Detail:** `config.js` defines an array of 15 journey steps. `journey-data.js` defines an object map with keys 1–17 (17 entries). Code using `config.js JOURNEY_STEPS.length` for `progress_total` may show 15 while journey rendering from `journey-data.js` supports 17.  
**Recommended action:** Reconcile the two definitions to the same count. Update `progress_total` accordingly.

### Risk 7 — SPIL Questions Duplicated Between Frontend and Backend
**Files:** `js/spil-ui.js` (embeds all 60 questions inline) and `backend/domain/spil.config.js` (canonical config)  
**Detail:** `spil-ui.js` contains a full copy of all 60 Afrikaans questions. If a question is corrected in `spil.config.js`, `spil-ui.js` must be manually updated to match.  
**Recommended action:** Consider serving questions via `GET /api/spil/questions` and fetching in `spil-ui.js` to eliminate the duplicate.

### Risk 8 — AI Chat Missing requireClientAccess for clientId
**File:** `backend/routes/ai.routes.js`  
**Detail:** There is a TODO comment in the AI chat route: `// This will be checked by middleware if we add requireClientAccess`. When `clientId` is provided in the chat body, ownership is not validated — a coach could theoretically query AI insights about another coach's client if they know the clientId.  
**Recommended action:** Add `requireClientAccess` check when `clientId` is present in chat request.

---

## 14. RULES FOR FUTURE CODERS

1. **Never write business data to localStorage.** All client data, assessments, leads, and coach data live in Supabase via the API. The only things permitted in localStorage are the JWT auth token (`auth_token`) and the current user object (`user`) — these are authentication state, not business data.

2. **Always call `normalizeClientCoachingState()` before using a client object.** It maps DB snake_case → camelCase and ensures all sub-fields (`exerciseData`, `journeyProgress`, `completedSteps`, `stepNotes`) are safe objects/arrays. This is the last line of defence against null pointer errors in the UI.

3. **All client saves go through `saveClient()` in `storage.js`.** Do not call `apiRequest()` directly from component files to update clients. `saveClient()` calls `normalizeClientCoachingState()` before writing — a critical safety step.

4. **`basis.routes.js` and `spil.routes.js` import auth from `auth.middleware.js`, not `auth.js`.** When adding new routes, check which middleware file you are importing from and keep it consistent.

5. **The KV store key is always `String(req.user.id)`.** When writing backend KV store code, always stringify the user ID. `user_id TEXT NOT NULL` — it is stored as text.

6. **Module access is enforced at the route level via `requireModuleAccess('module_key')`.** To add a new gated feature, add a row to `program_modules` (seed.sql) and wrap its routes with `requireModuleAccess('your_module_key')`.

7. **`basis.routes.js` and `spil.routes.js` are self-initializing.** They call `ensureBasisTable()` and `ensureSpilTable()` on module load. Safe to deploy without running migration files — tables will be created automatically. Do not remove these calls.

8. **Never add `zbpack.json` to the repo.** See CLAUDE.md Part C. Its presence causes Zeabur to ignore the Dockerfile and generate a broken build.

9. **The `normalizeClientRow()` function in `clients.routes.js` is defensive.** It exists to handle pre-migration rows where `exercise_data` and `journey_progress` are null. Do not remove it — legacy data may still exist.

10. **`writeStore()` in `storage.js` is intentionally a no-op.** It exists only for backward compatibility. Never assume data written through `writeStore()` is persisted. Use `saveClient()` for client data and `PUT /api/kv/:key` for other coach-level settings.

11. **The `auth.js` frontend module is a legacy layer that should not be extended.** Do not add new auth logic to `auth.js`. All new auth needs should go through `api.js` (JWT) and the backend `/api/auth` routes.

12. **When adding a new assessment module, follow the SPIL-E pattern:** self-creating table (idempotent `CREATE TABLE IF NOT EXISTS`), scoring engine in `domain/`, report generator in `domain/`, routes in `routes/`, frontend controller in `js/`. Keep backend scoring and frontend question display in sync.

---

*This document was generated from a systematic audit of all source files — May 2026.*
*Update this file whenever new routes, tables, files, or features are added.*
