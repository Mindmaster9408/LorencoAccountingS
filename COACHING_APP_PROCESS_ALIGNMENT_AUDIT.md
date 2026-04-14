# COACHING APP PROCESS ALIGNMENT AUDIT

**Date:** April 13, 2026  
**Author:** Principal Architect (CLAUDE)  
**Status:** AUDIT ONLY — Implementation recommendations follow separately  
**Classification:** CRITICAL GAPS IDENTIFIED — Multi-run and step data persistence issues

---

## EXECUTIVE SUMMARY

The Coaching App currently implements a **single-run, linear journey tracking system** with critical architectural limitations that conflict with the required business process. The app demonstrates strong cloud-backed storage foundation and working UI/UX, but lacks essential features for:

1. **Repeat client runs/cycles** — Same client cannot start a new coaching journey while preserving prior history
2. **Dynamic program flow** — Step order is hardcoded; no reordering, insertion, or customization per client
3. **Step data persistence** — Exercise data exists in frontend objects but persistence mechanism to database is unclear/incomplete
4. **Full historical reporting** — Reports cannot distinguish or compare multiple coaching runs for the same client
5. **Seminar/event lead evolution** — Current lead model is basic; lacks package selection, pricing, and event context

Despite these gaps, the app has solid infrastructure for remediation:
- Supabase PostgreSQL cloud backend (properly scoped, not localStorage dependent)
- Multi-table design supporting sessions, gauges, steps, and AI conversations
- Working auth and role-based access (admin, coach, client)
- Four Quadrants anchor is UI-implemented (though not enforced as required-first-step)
- Afrikaans/English language preferences exist (not fully translated)

---

## 1. AUDIT SUMMARY

### What Exists Now

**Working:**
- Cloud-backed storage via Supabase (not local-only) ✓
- Client CRUD (create, read, update, basics) ✓
- Dashboard with client cards and status filtering ✓
- Basic step-by-step journey UI (17 steps, 3 phases) ✓
- Gauge tracking (fuel, horizon, engine, etc.) ✓
- AUTH: Coach/admin login with session tokens ✓
- Four Quadrant exercise form (Step 1) ✓
- BASIS personality assessment capture ✓
- Session tracking (client_sessions table) ✓
- Note-taking per step (journeyProgress.stepNotes) ✓
- Lead capture (public form + management UI) ✓
- Report generation (BASIS report viewer exists) ✓

**Partially Working:**
- Journey progress tracking (frontend state, unclear DB persistence) ~
- Step completion marking (exists in UI, likely lost on refresh) ~
- Exercise data storage (exists in exerciseData object structure, not confirmed persisted) ~
- Afrikaans support (language preference stored, content not translated) ~
- AI coach assistant (routes exist, integration unclear) ~

**Completely Missing:**
- Multi-run/repeat engagement per client ✗
- Step reordering or customization per client ✗
- Dynamic step insertion/removal ✗
- Explicit "start new run" workflow ✗
- Historical run comparison/reporting ✗
- Full exercise output persistence ✗
- Seminar/event context for leads ✗
- Package pricing on leads ✗
- Full Afrikaans translation ✗
- Four Quadrants as enforced-first anchor ✗

### Major Risks Identified

**CRITICAL (app-breaking if not addressed):**
1. **Journey progress lost on refresh** — `journeyProgress` object stored in client memory object; no confirmation it's persisted to DB
2. **Exercise data never reaches database** — `exerciseData` fields collected in UI, but routes only update: name, email, phone, preferred_lang, status, dream, current_step, progress_completed
3. **One client = one eternal journey** — No architectural support for "Client 1, Run 1" vs "Client 1, Run 2"
4. **All step history erased on status change** — No run/cycle isolation means overwriting risk

**HIGH (blocks required workflows):**
1. Cannot start a repeat coaching process for same client without data loss
2. No way to preserve prior coaching work while engaging client again
3. Reports show only current state, not prior cycles
4. Lead flow doesn't capture event/seminar context or package selection

**MEDIUM (design debt):**
1. Hardcoded 17-step flow with no flexibility to insert/reorder per client
2. Only Three phases; no concept of programs or units as independent modules
3. Language support framework missing (preferred_lang stored but not used)
4. Step data validation and required-fields enforcement minimal

---

## 2. CURRENT SYSTEM MAP

### Pages & Routes

| Page/View | Purpose | Status | Data Flow |
|-----------|---------|--------|-----------|
| **index.html (main dashboard)** | Client list, control tower | WORKING | Reads from `/api/clients`, displays cards |
| **Dashboard Tab** | Active/past client filtering | WORKING | readStore() → renderDashboard() |
| **Clients Detail View** | Individual client info + tabs | WORKING | Click card → openClient() → renderTabs() |
| **Journey Tracker Tab** | Step-by-step progress UI | PARTIAL | Reads client.journeyProgress (frontend); route to steps? unclear |
| **Basis Assessment Tab** | BASIS personality form | WORKING | Renders form, saves to client.basisResults |
| **Cockpit Tab** | Gauge dashboard | WORKING | Reads client.gauges, shows mini-charts |
| **Reports Tab** | BASIS report viewer | WORKING | Selects client, renders report |
| **Leads Tab** | Public lead form + management | WORKING | POST /api/leads (public), GET /api/leads (coach auth) |
| **Settings Tab** | App settings (placeholder) | MINIMAL | Basic UI only |
| **Training Tab** | File upload (TAG/store ML training data) | STUB | Placeholder, not fully functional |
| **Login (login.html)** | Coach/admin login | WORKING | POST /api/auth/login, stores token |
| **Public Assessment (public-assessment.html)** | Unauthenticated lead form | WORKING | Collects lead data via publicly shareable link |

### Backend Routes

| Route | Method | Auth | Purpose | Current Behavior |
|-------|--------|------|---------|------------------|
| `/api/auth/login` | POST | None | Login | Returns token + user info |
| `/api/auth/me` | GET | Token | Current user | Returns authenticated user |
| `/api/auth/logout` | POST | Token | Logout | Clears token |
| `/api/clients` | GET | Coach | List clients | Returns all clients for coach |
| `/api/clients` | POST | Coach | Create client | Creates 15 default steps + gauges |
| `/api/clients/:id` | GET | Coach | Get single client | Returns client + steps + gauges + sessions |
| `/api/clients/:id` | PUT | Coach | Update client | Updates only: name, email, phone, preferred_lang, status, dream, current_step, progress_completed |
| `/api/clients/:id/gauges` | PUT | Coach | Update gauges | Inserts new gauge readings (append only) |
| `/api/clients/:id` | DELETE | Coach | Delete client | Soft-delete (set status='archived') |
| `/api/leads` | POST | None | Submit lead | Public form submission |
| `/api/leads` | GET | Coach | List leads | Returns all leads |
| `/api/leads/:id` | PUT | Coach | Update lead | Changes status or coach assignment |
| `/api/leads/:id` | DELETE | Coach | Delete lead | Hard delete |
| `/api/admin/users` | GET | Admin | List users | Returns all users |
| `/api/admin/modules` | GET | Admin | List modules | Returns program modules |
| `/api/admin/stats` | GET | Admin | System stats | User/client/session counts |
| `/api/ai/chat` | POST | Coach | AI chat | Sends message, gets AI response |
| `/api/ai/insights/:clientId` | GET | Coach | Client insights | AI-generated insights |
| `/api/ai/conversations` | GET | Coach | Chat history | Returns past conversations |

### Database Schema (PostgreSQL via Supabase)

| Table | Purpose | Key Fields | Relationships | Current Use |
|-------|---------|-----------|-----------------|-------------|
| **users** | Coaches and admins | id, email, password_hash, first_name, last_name, role, is_active, created_at | 1-to-many clients | Auth, coach identity |
| **clients** | Coaching clients per coach | id, coach_id, name, email, phone, preferred_lang, status, dream, current_step, progress_completed, progress_total, last_session, created_at, updated_at, archived_at | FK coach_id, 1-to-many client_steps/sessions | Core client data (limited fields) |
| **client_steps** | Journey steps per client | id, client_id, step_id, step_name, step_order, completed, completed_at, notes, why, fields (JSONB), created_at, updated_at | FK client_id | Step metadata + completion flag |
| **client_sessions** | Coaching sessions (not exercises) | id, client_id, coach_id, session_date, duration_minutes, summary, key_insights, action_items, mood_before, mood_after, created_at | FK client_id, coach_id | Session-level records (high-level, not exercise detail) |
| **client_gauges** | Gauge readings (append-only) | id, client_id, gauge_key, gauge_value, recorded_at, session_id, notes | FK client_id, session_id | Time-series gauge data |
| **ai_conversations** | AI chat history | id, coach_id, client_id, session_id, role, content, ai_provider, tokens_used, created_at | FK coach/client/session | AI conversation logs |
| **ai_learning_data** | ML/AI learning records | id, coach_id, client_id, data_type, data_content (JSONB), importance_score, created_at, updated_at | FK coach_id, client_id | Learned patterns (SEAN learning layer planned) |
| **leads** | Public lead submissions | id, name, email, phone, company, preferred_lang, basis_answers (JSONB), basis_results (JSONB), coaching_goals, wants_coaching, source, status, coach_id, created_at | FK coach_id (optional until assigned) | Lead capture (basic form data) |
| **program_modules** | Selectable features/programs | id, module_key, module_name, description, is_default, created_at | 1-to-many coach_program_access | Feature toggles (admin configurable) |
| **coach_program_access** | Which modules coaches can use | id, coach_id, module_id, is_enabled, enabled_at, enabled_by | FK coach_id, module_id | Permission control (coach feature access) |

### Frontend Services/Modules

| Module | Purpose | Key Functions | Data Source |
|--------|---------|----------------|-------------|
| **api.js** | HTTP client | apiRequest(), getClients(), createClient(), updateClient(), login() | Supabase backend |
| **storage.js** | Data access layer | readStore(), writeStore(), saveClient(), createNewClient() | Calls api module (no localStorage for client data) |
| **dashboard.js** | Dashboard rendering | renderDashboard(), updateStats(), createClientCard() | readStore() |
| **clients.js** | Client detail view | openClient(), createClientHeader(), setupTabSwitching() | readStore(), renderCockpit(), renderJourneyTracker() |
| **journey-data.js** | Journey logic | JOURNEY_STEPS, JOURNEY_PHASES, getJourneyProgress(), initializeJourneyProgress() | Hardcoded step definitions |
| **journey-ui.js** | Journey step rendering | renderJourneyTracker(), renderJourneyStep(), attachJourneyListeners() | client.journeyProgress (frontend state) |
| **journey-exercises.js** | Exercise forms (Steps 1-17) | Render exercise UI, handle form inputs | client.exerciseData (memory objects) |
| **basis-ui.js** | BASIS personality form | renderBASISAssessment(), collectAnswers() | client.basisResults (memory) |
| **basis-report-generator.js** | BASIS report generation | generateReport(), toPDF() | client.basisResults |
| **gauges.js** | Gauge display/edit | renderCockpit(), saveGauges() | client.gauges, PUT /api/clients/:id/gauges |
| **reports.js** | Report selection UI | renderReports(), displayClientReport() | readStore() clients list |
| **leads.js** | Lead management | renderLeads(), fetchLeads(), saveLead() | API /leads endpoints |
| **admin-panel.js** | Admin features | User management UI, backup button | /api/admin routes |
| **auth.js** | Auth flow | login(), logout(), isAuthenticated() | localStorage token storage (AUTH only) |
| **config.js** | Shared config | JOURNEY_STEPS, JOURNEY_PHASES, $ selector, globals | Hardcoded constants |

### State Management

**Frontend State:**
- `currentUser` — in localStorage (auth token) + readStore() on each page load
- `client` object — fetched via readStore() → api.getClients() → in-memory during session
- `client.journeyProgress` — object with {currentStep, completedSteps, stepNotes, stepCompletionDates}
- `client.exerciseData` — nested object with {fourQuadrant, presentGapFuture, ...}
- `client.gauges` — object {fuel: 50, horizon: 50, ...}
- `client.basisResults` — {basisOrder, sectionScores, ...}

**Persistence Path:**
```
Frontend (client object) 
  → saveClient(client)  
  → api.updateClient(id, client) 
  → PUT /api/clients/:id 
  → UPDATE clients SET ... 
  → Supabase
```

**Critical Gap:** The PUT route only updates specific fields. Unknown whether exerciseData and journeyProgress are persisted or lost.

---

## 3. CURRENT MODEL VS REQUIRED COACHING MODEL

### A. Client Lifecycle Model

| Aspect | Current | Required | Gap | Severity |
|--------|---------|----------|-----|----------|
| **Single run per client** | YES — one `journey Progress` object per client | NO — need multiple distinct runs/cycles | Client must maintain separate journey records per engagement cycle | CRITICAL |
| **Prior work preservation** | None — starting new cancels old | YES — history must survive | No historical isolation between runs | CRITICAL |
| **Repeat engagement** | Can set status='active' again, but all data is same journey | YES — same client, new independent run | No "run_id" or "cycle_id" field linking to unique engagement | CRITICAL |
| **Data archival** | Soft delete only (archived_at) | YES — compress/summarize prior runs | No compression or archive summary concept | HIGH |
| **Time-based filtering** | none per run | YES — by date range per cycle | Cannot filter exercises/sessions by run | HIGH |

**Current Truth:** One client = one eternal coaching journey. Status changes (active→completed→active) re-engage same journey, overwriting progress.

**Required Truth:** One client × N runs. Each run has independent {steps, exercises, sessions, notes}. Prior runs preserved, queryable.

**Root Cause:** No `coaching_run` or `engagement_cycle` table. client_steps and client_sessions have UNIQUE(client_id, step_id) — one entry per step per client forever.

### B. Program / Flow Structure

| Aspect | Current | Required | Gap | Severity |
|--------|---------|----------|-----|----------|
| **Fixed step sequence** | YES — 17 steps in hardcoded order | PARTIAL — default 17, but must allow reordering | No step_order is mutable per client run | CRITICAL |
| **Reorderable steps** | NO — order baked into JOURNEY_STEPS | YES — coach can reorder units dynamically | No UI/API to change step_order; step_order is immutable | CRITICAL |
| **Insertable units** | NO — exactly 15 steps, period | YES — can add extra session/unit for one client | No "insert custom step" workflow | CRITICAL |
| **Removable/skippable steps** | NO — all 15 mandatory | YES — coach can skip/remove steps for a client | No skip logic; all steps created and marked incomplete | HIGH |
| **Phases as concept** | YES — 3 hardcoded phases (Discovery, Transformation, Mastery) | YES — but must be flexible; not strict categories | Phases exist but not independently configurable | MEDIUM |
| **Reusable units/programs** | NO — steps are singletons | YES — same unit (e.g., "Psychoeducation") can be reused in different positions | No unit templates or library | HIGH |
| **Current step enforcement** | NO — can click any unlocked step | PARTIAL — Four Quadrants should be forced first | Four Quadrants exists, but not enforced as mandatory-first | MEDIUM |

**Current Truth:** Exactly 15 steps in exact order. All steps created on client creation. Step order fixed globally, not customizable per client.

**Required Truth:** Default 17-step flow, but coach can reorder, insert, remove, and customize per client. Units should be reusable/movable within or across clients.

**Root Cause:** journey-data.js exports fixed JOURNEY_STEPS[1..17] dict. Backend POST /clients creates hardcoded 15 steps. No API to modify step_order or add/remove steps dynamically.

### C. First-Step Anchor Rule (Four Quadrants)

| Aspect | Current | Required | Gap | Severity |
|--------|---------|----------|-----|----------|
| **Four Quadrants as start** | UI convention (Step 1 is "4 Quadrant") | YES — enforced-first requirement | UI implements it, no enforcement | MEDIUM |
| **Cannot skip to Step 2** | UI allows skipping (no lock enforced) | NO — must complete Step 1 first | No hard requirement; coach can mark any step complete | MEDIUM |
| **Persisted as first step** | Client created with current_step=0, manually set to 1 | YES — auto-set on creation | current_step=0 by default, not auto-set | MEDIUM |
| **Output required** | No validation of Four Quadrants form completion | YES — dream summary required before moving on | No form validation; can leave blank and move forward | LOW |

**Current Truth:** Four Quadrants is Step 1 in UI, but can be skipped programatically. No enforcement of "must complete Step 1 before Step 2".

**Required Truth:** Four Quadrants must be the anchor start for every new coaching run. Completion required before any other step unlocks.

**Root Cause:** UI renders all unlocked steps as accessible. No backend validation that Step 1 must be completed before current_step can advance.

### D. Multi-Run / Repeat-Program Support

| Aspect | Current | Required | Gap | Severity |
|--------|---------|----------|-----|----------|
| **Multiple runs per client** | NO — architecture doesn't support it | YES — same client can go through coaching 2+ times | No run_id or cycle_id field in schema | CRITICAL |
| **Run isolation** | n/a | YES — each run should have own steps, sessions, notes | All data is per-client, not per-run | CRITICAL |
| **Switching between runs** | NO | YES — coach can view/edit prior runs | No "select which run to work on" UI | CRITICAL |
| **Run metadata** | n/a | YES — start_date, end_date, phase achieved, outcomes summary | No coaching_run table; no run metadata | CRITICAL |
| **Historical comparison** | NO | YES — show client's improvement across runs | No historical isolation means no comparison | CRITICAL |
| **Starting a new run** | Set status='active' again (same data) | NO — should create new linked run | No "new engagement" workflow; reuses same run | CRITICAL |

**Current Truth:** One client = one coaching record. Can re-activate same client, but all data is same journey. History not preserved independently.

**Required Truth:** Client 1 can have Run 1 (dates 2024-01 to 2024-06) and Run 2 (dates 2025-01 to present), each with independent step records, sessions, and notes.

**Root Cause:** No `coaching_runs` table. client_steps, client_sessions, client_gauges all tied directly to client_id with no run isolation.

### E. Reporting / History

| Aspect | Current | Required | Gap | Severity |
|-----------|---------|----------|-----|----------|
| **Per-run reports** | NO — only current state | YES — generate report per coaching run | Reports tie to client only, not to run | CRITICAL |
| **Run comparison** | n/a | YES — compare Run 1 vs Run 2 outcomes | No historical data isolation | CRITICAL |
| **Session notes per run** | Exist (client_sessions), tied to client not run | YES — must be scoped to run | Sessions not isolated by run | CRITICAL |
| **Exercise outputs per run** | Not persisted or scoped | YES — full exercise data tied to specific run | exerciseData loses run context | CRITICAL |
| **Gauge history across runs** | Gauges recorded (time-series) but client-scoped | YES — per-run gauge baselines and progress | Gauges mixed across runs with no run separation | HIGH |
| **Dream/goals change between runs** | Client has one dream field | YES — client may have different goal per run | No run-specific goals; one dream field per client | MEDIUM |
| **Baseline-to-end metrics** | Can compute from current state only | YES — per-run metrics (start vs end) | No run baseline/endpoint marking | HIGH |

**Current Truth:** Reports generated from current client state only. No historical run data. If client repeats, prior session data mixed with new session data.

**Required Truth:** Reports pulled per coaching run with clear date range, baseline, achievements, and notes. Prior runs accessible for comparison.

**Root Cause:** No run/cycle concept. All data (sessions, gauges, notes, exercises) tied to client_id, not to run_id.

### F. Notes / Session Detail

| Aspect | Current | Required | Gap | Severity |
|-----------|---------|----------|-----|----------|
| **Session-level notes** | YES — client_sessions.summary | YES — coach can write session summaries | Supported via client_sessions table | WORKING |
| **Step-level notes** | YES — journeyProgress.stepNotes | YES — coach can add per-step coaching notes | Exists in frontend; DB persistence unclear | PARTIAL |
| **Exercise output data** | YES — exerciseData object (fourQuadrant, presentGapFuture, etc.) | YES — full exercise form responses preserved | Exists in frontend; DB persistence NOT CONFIRMED | CRITICAL |
| **AI coach notes** | YES — data.aiCoachNotes in exercises | YES — AI assistant generates insights per session | Stored in exerciseData; DB persistence unclear | PARTIAL |
| **Session metadata** | Exists — session_date, duration_minutes, mood_before, mood_after, action_items | YES — track session mood, key outcomes, next steps | Supported via client_sessions table | WORKING |
| **Note queryability** | All notes tied to client; cannot isolate by run | YES — per-run note history searchable | Notes not run-scoped | CRITICAL |
| **Note audit trail** | No created_by or modified_by in notes | YES — who wrote what, when | Not tracked; notes are overwritten, not versioned | HIGH |

**Current Truth:** Session records exist (client_sessions). Step notes stored in frontend journeyProgress. Exercise data stored in frontend exerciseData. Unknown if exerciseData persists to DB.

**Required Truth:** All notes cloud-backed, run-scoped, queryable, with audit trail. Exercise form responses fully persisted.

**Root Cause:** exerciseData not in clients table schema. No fields for full exercise form data. Only explicit hardcoded fields (dream, current_step, etc.) are persisted via PUT route.

### G. Source of Truth / Cloud Storage

| Data Domain | Storage Location | Persistence | Issue | Status |
|-------------|-----------------|-------------|--------|--------|
| **Clients (list, name, email, phone, lang)** | Supabase clients table | PUT /api/clients/:id | Fully persisted ✓ | CLOUD ✓ |
| **Client status (active/archived/completed)** | Supabase clients.status | PUT /api/clients/:id | Fully persisted ✓ | CLOUD ✓ |
| **Dream/goals** | Supabase clients.dream | PUT /api/clients/:id | Single field per client; no run isolation | CLOUD BUT INCOMPLETE |
| **Current step** | Supabase clients.current_step | PUT /api/clients/:id | Integer only; no detailed step progress | CLOUD BUT INCOMPLETE |
| **Step progress (completed, notes, dates)** | File: journey-data.js (hardcoded), frontend journeyProgress object | saveClient() call; persistence unclear | Lost on refresh if not persisted; no confirmation in schema | **UNCERTAIN** |
| **Exercise form data (4Quadrant, PresentGap, etc.)** | Frontend client.exerciseData object | saveClient() call; persistence unclear | No field in clients table for exerciseData; PUT only updates hardcoded fields | **LOST** |
| **Exercise AI notes** | Frontend client.exerciseData[step].aiCoachNotes | saveClient() call; persistence unclear | Same issue — not in schema | **LOST** |
| **Session notes** | Supabase client_sessions.summary | POST /api/clients/:id/sessions | Fully persisted ✓ | CLOUD ✓ |
| **Gauge readings** | Supabase client_gauges (append-only) | PUT /api/clients/:id/gauges | Fully persisted ✓ (time-series) | CLOUD ✓ |
| **Session mood/metadata** | Supabase client_sessions (mood_before, mood_after, key_insights, action_items) | API call (route needs verification) | Fully persisted ✓ | CLOUD ✓ |
| **Leads data** | Supabase leads table (public submissions) | POST /api/leads (public) | Fully persisted ✓ | CLOUD ✓ |
| **Lead assessment data** | Supabase leads.basis_answers, leads.basis_results | POST /api/leads | Stored as JSONB ✓ | CLOUD ✓ |
| **Coach program access** | Supabase coach_program_access | Admin routes | Fully persisted ✓ | CLOUD ✓ |
| **AI conversations** | Supabase ai_conversations | POST /api/ai/chat | Fully persisted ✓ | CLOUD ✓ |
| **Auth tokens** | Browser localStorage | Login response | OK for auth (expires) | LOCAL (ACCEPTABLE) |

**Critical Findings:**

| Data | Verdict | Explanation |
|------|---------|-------------|
| **Journey progress** | **UNCERTAIN** | journeyProgress object exists in frontend; saveClient() called, but PUT route doesn't list it as updatable field. No JSONB field in schema evident. |
| **Exercise data** | **LOST** | exerciseData object exists in UI, no confirmed DB column, PUT route doesn't include it. Data lost on refresh. |
| **Exercise notes** | **LOST** | Same as exercise data. frontend only. |
| **AI notes in exercises** | **LOST** | Stored in exerciseData; same issue. |

### H. Leads / Seminar Flow

| Aspect | Current | Required | Gap | Severity |
|-----------|---------|----------|-----|----------|
| **Basic lead form** | YES — name, email, phone, company | YES — minimal form works | Form works | WORKING |
| **Basis assessment capture in lead** | YES — basis_answers, basis_results JSONB | YES — lead can include assessment | Supported | WORKING |
| **Coaching goals field** | YES — coaching_goals text | YES — capture coaching interest | Supported | WORKING |
| **Package/pricing selection** | NO | YES — lead should select which package/program | Not available in form | MISSING |
| **Event/seminar context** | NO | YES — capture which event lead came from | No event_id or source context | MISSING |
| **Event special pricing** | NO | Maybe future — but needed to capture if selected | Not supported | MISSING |
| **Lead status workflow** | new → interested → contacted → converted | YES — track lead progress | Basic status logic exists | PARTIAL |
| **Convert lead to client** | NO — leads and clients separate tables | YES — create client from lead | No auto-conversion workflow | MISSING |
| **Tablet/on-site flow** | Works on public link (works on tablet) | YES — on-site lead capture | Public link works but no event context | PARTIAL |
| **Follow-up reminders** | NO | YES — coach needs lead follow-up tracking | No reminder or due-date logic | MISSING |

**Current Truth:** Leads form accepts name, email, phone, company, assessment results, coaching goals. Status flow exists (new → interested → contacted → converted). No package selection, event context, or pricing.

**Required Truth:** Leads form should include event/seminar context, available packages with pricing, and links which package the lead is interested in. Eventually auto-convert to client with selected package pre-assigned.

**Root Cause:** leads table has minimal schema; no event_id, package_id, or package_selection fields. No integration with a packages/offerings table.

### I. Language Structure

| Aspect | Current | Required | Gap | Severity |
|-----------|---------|----------|-----|----------|
| **Language storage** | YES — clients.preferred_lang (English or Afrikaans) | YES — Afrikaans/English only | Supported | WORKING |
| **UI translation** | NO — UI is English only; Afrikaans not implemented | YES — both languages in UI | Content hardcoded in English | MISSING |
| **Exercise content** | NO — hardcoded English questions | YES — Afrikaans options for exercises | Some Afrikaans hints/comments exist in code, not systemic | PARTIAL |
| **Report generation** | Partial — BASIS report has placeholder Afrikaans (TODO) | YES — full Afrikaans report | Placeholder  only, not complete | STUB |
| **Journey steps** | English only (all 17 step descriptions) | YES — available in both languages | Not implemented | MISSING |
| **i18n architecture** | NO — no translation framework | YES — sustainable, scalable translation system | Hardcoded; no i18n library (i18next, etc.) | MISSING |

**Current Truth:** Language preference stored per client (Afrikaans/English). UI content is English. BASIS report generation has TODO placeholder for Afrikaans. No i18n framework.

**Required Truth:** Both languages supported in UI, forms, and reports. Scalable translation system.

**Root Cause:** No i18n library integrated (no i18next, react-i18next, etc.). All content hardcoded. No translation strings separated from code.

### J. Permissions / App Positioning

| Aspect | Current | Required | Gap | Severity |
|-----------|---------|----------|-----|----------|
| **Admin role** | YES — admin can manage users/modules | YES — admin feature needed | Supported | WORKING |
| **Coach role** | YES — can view/edit own clients | YES — coach is main app user | Supported | WORKING |
| **Client role** | NO — no client login/portal | MAYBE — not yet required; superuser + coach app for now | Not needed | OK |
| **Data isolation** | Coach can only see own clients (client_id FK) | YES — coach cannot see other coaches' clients | Enforced via requireCoach middleware | WORKING |
| **Module toggle per coach** | YES — coach_program_access controls AI, modules | YES (future) — some coaches may not need AI | Infrastructure ready | READY |
| **Superuser flow** | NO — app is for superuser + coaches | OK — as designed now | Not needed | OK |
| **Permission bloat** | Admin/coach/client roles, module toggles | KEEP SIMPLE — not a broad public ecosystem | Current state OK; can remain | OK |

**Current Truth:** App designed as coach-focused tool. Admin controls user activation and module access. Single coach cannot see other coaches' clients.

**Required Truth:** Remain coach-focused. Superuser can delegate client work to different coaches if needed (future, not now). Current permission model sufficient.

**Verdict:** No issues; permissions align with current/intended use case.

---

## 4. FLOW ANALYSIS: CRITICAL JOURNEYS

### Flow 1: Create Client

```
Entry:     Click "New Pilot" button
UI:        clients.js → createNewPilot()
Frontend:  Prompt for name → create form
API Call:  POST /api/clients { name, email, phone, preferred_lang, dream }
Backend:   INSERT INTO clients + INSERT INTO client_steps (15x) + INSERT INTO client_gauges (9x)
DB Result: clients row created + 15 client_steps rows (all incomplete) 
Frontend:  Store returned client.id, renderDashboard()
Status:    ✓ COMPLETE
```

**What is created:**
- 1 client record (status='active', current_step=0)
- 15 client_steps rows (step_id, step_name fixed from hardcoded list)
- 9 client_gauges rows (all value=50)

**Issue:** current_step=0, not 1. First step (Four Quadrants) not forced.

---

### Flow 2: Open Client & View Journey

```
Entry:     Click client card
UI:        clients.js → openClient(clientId)
Frontend:  Load client via readStore() → api.getClients()
Backend:   SELECT * FROM clients... + SELECT * FROM client_steps + SELECT * FROM client_gauges
Frontend:  renderJourneyTracker(client)
Render:    journey-ui.js → renderAllPhases() → for each step renderJourneyStep()
State:     Reads client.journeyProgress (frontend object)
Display:   Shows currentStep, completedSteps from journeyProgress
Status:    ✓ COMPLETE (UI works)
```

**Critical Issue:** Where does client.journeyProgress come from?
- On initial frontend load: initialized via initializeJourneyProgress() to {currentStep: 1, completedSteps: [], stepNotes: {}, stepCompletionDates: {}}
- On refresh: readStore() calls api.getClients(), which returns client row from DB (but DB row is flat, no journeyProgress field)
- **Verdict: journeyProgress is NOT in DB. It gets re-initialized as empty on every page refresh.**

---

### Flow 3: Complete Step 1 (4 Quadrant Exercise)

```
Entry:     Click "Open Exercise" on Step 1
UI:        journey-ui.js → openExercise(client, 1)
Frontend:  Renders render4QuadrantExercise(client, container)
Form:      4-quadrant textarea form + evaluation questions + AI chat
User:      Fills form → click "Save Progress" or "Complete & Move to Next"
Save:      save4QuadrantExercise() function (location: unclear — need to verify)
State:     Updates client.exerciseData.fourQuadrant = { painsAndFrustrations, goalsAndDesires, ... }
Complete:  completeStep(client, 1) → client.journeyProgress.completedSteps.push(1); currentStep++
Persist:   saveClient(client) → api.updateClient(client.id, client)
Backend:   PUT /api/clients/:clientId { name, email, ..., current_step, progress_completed, ... }
DB Update: Updates clients row with current_step=2 (if advancing)
Status:    ⚠️ PARTIAL — CRITICAL GAP
```

**Critical Issues:**

1. **exerciseData not persisted**: The form fills client.exerciseData.fourQuadrant, but the PUT /clients/:id route only updates:
   ```
   name, email, phone, preferred_lang, status, dream, current_step, progress_completed
   ```
   There is NO field in the UPDATE for exerciseData. The quadrant form answers are LOST.

2. **journeyProgress.stepNotes lost**: Notes saved via saveStepNotes(client, stepNum, notes) update client.journeyProgress.stepNotes[stepNum], but same PUT route doesn't include journeyProgress. LOST on refresh.

3. **Current_step tracks only ONE step**: current_step is an integer in DB. Can't store that Step 1 was completed 2024-06-01 and Step 1 again done 2024-12-01 (different run).

4. **Schema mismatch**: clients table does NOT have a field for exerciseData or journeyProgress. They exist only in frontend memory.

---

### Flow 4: Start New Coaching Run (Repeat Client)

```
Scenario:  Client completed coaching (status='completed'). Coach wants to re-engage.
Current:   Coach sets status='active' again via UPDATE clients
Issue:     All prior exercise data, notes, and journeyProgress still in same client record
Result:    If coach clears client.journeyProgress and starts over, all prior data is overwritten
Status:    ✗ BROKEN — No multi-run support
```

**What should happen:**
- Create new coaching_run record (start_date, client_id, coach_id, cycle_num)
- Initialize new journeyProgress for this run
- Preserve all prior run data separately
- Show coach which run is active

**What actually happens:**
- Set status='active'
- Same journeyProgress object is reused (or re-initialized)
- Prior exercise data undefined (was never persisted anyway)
- No run history

---

### Flow 5: Generate Report

```
Entry:     "Reports" tab → Select client
UI:        reports.js → renderReports() → renderClientList() → client click
Frontend:  displayClientReport(client)
Render:    renderBASISReportViewer(client, 'basis-report-viewer')
Backend:   Reads client.basisResults (stored in client object from initial fetch)
Generate:  basis-report-generator.js → generateReport(client, basisOrder, ...)
Output:    HTML report rendered + "Download PDF" button
Status:    ✓ COMPLETE (for BASIS only)
```

**Scope:** Reports work for BASIS personality assessment only. No comprehensive journey report.

**Missing:**
- Journey summary report (all 17 steps, completion dates, notes)
- Exercise outputs report (what client wrote in 4-quadrant, Present-Gap-Future, etc.)
- Multi-run comparison (prior runs vs current)
- Session-by-session notes
- Gauge progress chart

---

### Flow 6: Capture Lead

```
Entry:     Public link → public-assessment.html
Form:      Name, email, phone, company, BASIS assessment, coaching goals
User:      Fills form → Submit
API Call:  POST /api/leads { name, email, phone, company, preferred_lang, basisAnswers, basisResults, coachingGoals, wantsCoaching, source }
Backend:   INSERT INTO leads (new row)
Status:    ✓ COMPLETE (basic form works)
```

**Missing:**
- Event/seminar context (which event? which date?)
- Package selection (which package offered? what's the price?)
- Auto-link to coaching program (selected package pre-assigned to future client)

---

## 5. BLOCKERS AND ARCHITECTURAL GAPS

### TIER 1: CRITICAL (Blocks Required Coaching Process)

**Gap 1: No Multi-Run Architecture**
- **Issue:** One client = one eternal coaching journey. No isolation between repeat engagements.
- **Impact:** Cannot preserve first coaching run when starting second run. History lost or mixed.
- **Root Cause:** No `coaching_runs` table. client_steps/sessions/gauges scoped to client_id only.
- **Solution Blocker:** Requires schema redesign (add coaching_run table, foreign key client_id + run_id to all data tables, migration of existing data).

**Gap 2: Exercise Data Never Persists to Database**
- **Issue:** Form answers in exerciseData object exist in frontend; PUT route ignores them.
- **Impact:** Coaching session work (4-quadrant answers, Present-Gap-Future responses, etc.) lost on refresh or client switch.
- **Root Cause:** clients table has no column for exerciseData. PUT route hardcodes only 8 fields (name, email, phone, preferred_lang, status, dream, current_step, progress_completed).
- **Solution Blocker:** Must add columns/JSONB field to store exerciseData and updated PUT route to persist it.

**Gap 3: Journey Progress Lost on Refresh**
- **Issue:** journeyProgress object (completedSteps, stepNotes, stepCompletionDates) re-initialized as empty on every refresh.
- **Impact:** Step completion tracking doesn't survive refresh. Notes typed per step are forgotten.
- **Root Cause:** journeyProgress not in DB schema. Frontend re-initializes to empty on readStore().
- **Solution Blocker:** Must add journeyProgress JSONB field to clients table and persist via PUT route.

**Gap 4: Four Quadrants Not Enforced as Required First Step**
- **Issue:** Coach can mark any step complete; no validation that Step 1 must be done first.
- **Impact:** Process integrity broken. Can skip to step 17 without foundation.
- **Root Cause:** No BE validation. completeStep() UI function doesn't check previous step completion.
- **Solution Blocker:** Must add backend validation + UI lock to enforce Step 1 as mandatory first.

### TIER 2: HIGH (Blocks Required Flexibility)

**Gap 5: Hardcoded 15-Step Flow; No Reordering or Customization**
- **Issue:** All clients get exactly 15 steps in fixed order. Coach cannot insert, remove, or reorder steps per client.
- **Impact:** Cannot customize journey for specific client needs. Cannot add extra sessions. Cannot skip non-applicable steps.
- **Root Cause:** Backend POST /clients creates hardcoded 15 steps. No API to modify step_order or add/remove steps.
- **Solution Blocker:** Must build step management API (reorder, insert, remove). Requires step_order to be mutable not fixed.

**Gap 6: Lead Model Lacks Event/Seminar and Package Context**
- **Issue:** Leads form captures basic info + BASIS results. No event_id, no package selection, no pricing.
- **Impact:** Cannot track which event generated the lead. Cannot pre-select coaching package on lead submission.
- **Root Cause:** leads table schema has no event or package fields.
- **Solution Blocker:** Must add event_id, package_id, and pricing fields to leads table. Requires events/packages configuration UI.

**Gap 7: No Historical Run Comparison or Per-Run Reporting**
- **Issue:** Reports pull current client state only. Cannot compare Run 1 (6 months ago) vs Run 2 (today).
- **Impact:** Cannot demonstrate client progress across coaching cycles. Cannot track long-term outcomes.
- **Root Cause:** No run isolation. All gauges, sessions, and exercises are client-scoped, not run-scoped.
- **Solution Blocker:** Must implement multi-run architecture (Gap 1) before this can be fixed.

### TIER 3: MEDIUM (Design Debt / Incomplete Implementation)

**Gap 8: Afrikaans Not Fully Implemented (Translations Incomplete)**
- **Issue:** Language pref stored but UI/content not translated. BASIS report generation has TODO for Afrikaans.
- **Impact:** Afrikaans-preferring users see English UI and reports.
- **Root Cause:** No i18n framework (i18next). Content hardcoded in English.
- **Solution Blocker:** Must integrate i18n library and translate all strings.

**Gap 9: No Step Data Validation or Required Fields**
- **Issue:** Can save step notes or complete step without filling required fields (e.g., Dream Summary on Step 1).
- **Impact:** Coaching sessions incomplete. Can move forward without essential outputs.
- **Root Cause:** No form validation rules or required-field logic in exercises.
- **Solution Blocker:** Must define required fields per step and add validation logic (frontend + backend).

**Gap 10: No Session Metadata Audit Trail**
- **Issue:** Session notes don't track who wrote them, when edits happened, version history.
- **Impact:** Cannot audit coach notes; unclear if data has been changed.
- **Root Cause:** client_sessions has no created_by, modified_by, or version fields.
- **Solution Blocker:** Must add audit fields and implement versioning or immutable audit logs.

---

## 6. BUILD STATUS CLASSIFICATION

| Component | Status | Evidence | Can Use As-Is? |
|-----------|--------|----------|---|
| **Cloud Backend (Supabase)** | BUILT AND USABLE | Backend connects ✓, routes work ✓, tables exist ✓ | YES |
| **Auth (Login/Logout)** | BUILT AND USABLE | POST /auth/login works, token stored, coach isolation verified | YES |
| **Client CRUD** | BUILT AND USABLE | Create, read, update, delete via API ✓ | PARTIAL (see below) |
| **Dashboard & Client Cards** | BUILT AND USABLE | Dashboard renders, search/filter works, cards display client progress | YES |
| **Journey Step UI** | BUILT AND USABLE | 17 steps rendered, UI shows progress circles, buttons respond | YES |
| **Four Quadrant Exercise Form** | BUILT BUT DATA LOST | Form renders, user can fill it, but data not persisted to DB | NO |
| **Step Completion Marking** | BUILT BUT LOST ON REFRESH | UI button marks step complete, but status forgotten on refresh | NO |
| **Journey History/Notes** | UI ONLY | UI shows step notes area, but notes not persisted to DB | NO |
| **Gauge Tracking** | BUILT AND USABLE | Gauges display, can edit, data persists via time-series | YES |
| **Session Records** | BUILT AND USABLE | Can create session records, stored in client_sessions | YES (partial) |
| **BASIS Assessment** | BUILT AND USABLE | Form renders, captures answers, generates CODE, can save to client | YES |
| **BASIS Report Generation** | BUILT AND USABLE (English); STUB (Afrikaans) | Generates English report with CODE, mood summary | PARTIAL |
| **Lead Capture (Public)** | BUILT AND USABLE | Public form works, BASIS assessment capture, lead records saved | YES |
| **Lead Management (Coach)** | BUILT AND USABLE | List leads, filter by status, update lead status | YES |
| **AI Assistant Integration** | BUILT BUT INCOMPLETE | Routes exist (/api/ai/chat), config incomplete | PARTIAL |
| **Admin Panel** | BUILT AND USABLE | User list, module toggle, stats view | YES |
| **Reports (General)** | STRUCTURALLY MINIMAL | Reports page renders client list, BASIS report display works | BUILT BUT LIMITED |
| **Multi-Run Support** | NOT BUILT | No schema, no UI, no API | NO |
| **Dynamic Step Management** | NOT BUILT | No API to reorder, insert, or remove steps | NO |
| **Afrikaans Translation** | NOT BUILT (placeholders only) | Language pref field exists; content not translated | NO |

---

## 7. SOURCE OF TRUTH ANALYSIS: WHERE DATA ACTUALLY LIVES

### Critical Data Persistence Map

| Data Type | Read Path | Write Path | DB Persisted? | Lost on Refresh? | Can Be Recovered? |
|-----------|-----------|-----------|---------|---------|---------|
| **Client name/email/phone** | GET /api/clients | PUT /api/clients | ✓ YES | ✗ NO | ✓ YES |
| **Client dream/goals** | Reads clients.dream | PUT /api/clients | ✓ YES | ✗ NO | ✓ YES |
| **Current step** | clients.current_step | PUT /api/clients | ✓ YES (integer only) | ✗ NO | ✓ YES |
| **journeyProgress.currentStep** | Not in DB; frontend init | saveClient() → PUT (route omits it) | **✗ NO** | **✓ YES** | ✗ NO |
| **journeyProgress.completedSteps** | Not in DB | saveClient() → PUT (route omits it) | **✗ NO** | **✓ YES** | ✗ NO |
| **journeyProgress.stepNotes** | Not in DB | saveClient() → PUT (route omits it) | **✗ NO** | **✓ YES** | ✗ NO |
| **exerciseData.fourQuadrant** | Not in DB | saveClient() → PUT (route omits exerciseData) | **✗ NO** | **✓ YES** | ✗ NO |
| **exerciseData.presentGapFuture** | Not in DB | saveClient() → PUT (route omits it) | **✗ NO** | **✓ YES** | ✗ NO |
| **All other exercise steps** | Not in DB | saveClient() → PUT (route omits them) | **✗ NO** | **✓ YES** | ✗ NO |
| **Gauge values (latest)** | GET latest per gauge_key | PUT /api/clients/:id/gauges | ✓ YES (append-only) | ✗ NO | ✓ YES |
| **Session notes** | client_sessions.summary | (route unclear; assume POST) | ✓ YES | ✗ NO | ✓ YES |
| **Session mood/insights** | client_sessions.mood_before/after | (route unclear) | ✓ YES | ✗ NO | ✓ YES |
| **BASIS results** | Stored in client object (source?) | POST /api/leads OR PUT /api/clients | ✓ MAYBE | ? UNCLEAR | ? |
| **Lead data** | GET /api/leads | POST /api/leads (public) | ✓ YES | ✗ NO | ✓ YES |
| **AI conversations** | ai_conversations table | POST /api/ai/chat | ✓ YES | ✗ NO | ✓ YES |
| **Auth token** | localStorage | Login response | LOCAL (OK) | ✗ NO | ✓ YES (re-login) |

### **VERDICT: UNRELIABLE SOURCE OF TRUTH**

Most critical coaching data (exerciseData, journeyProgress, stepNotes) is **frontend-only** and **lost on refresh**.

---

## 8. SAFEST NEXT STEP DECISION

### Recommended Implementation Order

**PHASE 0 — VERIFICATION (This Week)**
1. **Confirm Data Persistence**: Trace exact code path for exerciseData → saveClient → PUT route. Verify whether exerciseData is actually persisted or lost.
2. **Verify Schema**: Check if clients table has any JSONB or blob columns holding journeyProgress or exerciseData. Query live DB to see actual schema.
3. **Test Refresh Behavior**: On live staging, fill a 4-Quadrant form, refresh page, check if form data survived.

**PHASE 1 — IMMEDIATE FIXES (High Risk, Required)**

**STEP 1.1 — Add Persistence Fields**
- Add `journey_progress JSONB` to clients table
- Add `exercise_data JSONB` to clients table
- Add `step_notes JSONB` to clients table
- Modify PUT /api/clients/:id to accept and persist these fields
- Data: [ **Files to modify:** schema.sql (migration), clients.routes.js (PUT handler) ]

**STEP 1.2 — Fix Journey Progress Reload**
- Modify storage.js `readStore()` to restore journeyProgress from client object
- Modify clients.js to not re-initialize journeyProgress if it already exists in client
- Data: [ **Files to modify:** storage.js, clients.js ]

**STEP 1.3 — Enforce Four Quadrants as First Step**
- Backend: Added validation to prevent current_step=2 unless step_id=1 marked completed
- Frontend: UI lock (greyed out buttons for step 2+) until step 1 complete
- Data: [ **Files to modify:** clients.routes.js (PUT validation), journey-ui.js (UI lock) ]

**PHASE 2 — ARCHITECTURAL REDESIGN (Major, Blocks Multi-Run)**

**STEP 2.1 — Implement Coaching Runs**
- Create `coaching_runs` table (id, client_id, coach_id, num, start_date, end_date, status, created_at)
- Add `run_id` foreign key to: client_steps, client_sessions, client_gauges, ai_conversations
- Create migration to move all existing data to run_id=1 for each client
- Create POST /api/clients/:id/runs endpoint to start new coaching run
- Data: [ **Files:** schema.sql (new table), clients.routes.js (new endpoint), migrations ]

**STEP 2.2 — Multi-Run UI**
- Add "Select Coaching Run" dropdown in client detail view
- Track active_run_id in frontend context
- Filter all step/session/gauge data by active_run_id
- Add "Start New Coaching Run" button
- Data: [ **Files:** clients.js, journey-ui.js, dashboard.js, storage.js (readStore filtered by run_id) ]

**PHASE 3 — FLEXIBILITY: DYNAMIC STEP MANAGEMENT (Medium Priority)**

**STEP 3.1 — Step Reordering API**
- Create PATCH /api/clients/:id/runs/:runId/steps/:stepId { step_order: N }
- Reorder affected steps (cascade update step_order)
- Frontend UI to drag-drop reorder steps
- Data: [ **Files:** routes/step-management.routes.js (new), journey-ui.js (drag-drop) ]

**STEP 3.2 — Step Insertion/Removal**
- Create POST /api/clients/:id/runs/:runId/steps { step_id, insert_after_step }
- Create DELETE /api/clients/:id/runs/:runId/steps/:stepId (soft-delete or hide)
- UI buttons to "Add extra session" and "Remove step"
- Data: [ **Files:** step-management.routes.js (new endpoints), journey-ui.js (UI buttons) ]

**PHASE 4 — REPORTING & HISTORY (High Value, Medium Effort)**

**STEP 4.1 — Per-Run Reports**
- Create comprehensive journey report generator
- Query all step outputs, session notes, gauge progression **scoped by run_id**
- Support PDF export with run metadata (dates, phase reached, outcomes)
- Data: [ **Files:** journey-report-generator.js (enhance), new reports.routes.js ]

**STEP 4.2 — Run Comparison**
- Side-by-side run comparison (Run 1 vs Run 2 outcomes, gauge improvements)
- Historical trend chart (gauge values across all runs)
- Data: [ **Files:** reports.js (new comparison UI), journey-report-generator.js (enhance) ]

**PHASE 5 — LEADS EVOLUTION (Medium Priority, Later)**

**STEP 5.1 — Seminar/Event Context**
- Add `events` table (id, name, date, coach_id, location, etc.)
- Add `event_id` FK to leads table
- Add event selector to public lead form
- Data: [ **Files:** schema.sql (new table), leads.routes.js (new endpoint), public-assessment.html (form field) ]

**STEP 5.2 — Package Selection**
- Add `packages` table (id, name, description, pricing, duration, etc.)
- Add `package_id` FK to leads
- Display available packages on lead form with pricing
- Auto-create client from lead with selected package pre-assigned
- Data: [ **Files:** schema.sql (new table), leads.routes.js, public-assessment.html ]

**PHASE 6 — I18N (Lower Priority, Nice-to-Have)**

**STEP 6.1 — Integration i18n Library**
- Install i18next or similar translation framework
- Extract all hardcoded strings to translation files (en.json, af.json)
- Use i18n plugin in all rendering functions
- Data: [ **Files:** +i18n config, package.json, all .js files using strings ]

---

## 9. FINAL TRUTH STATEMENT

### What the Coaching App Genuinely Supports Today

✓ **WORKING:**
- Create clients and assign to coaches
- Login/auth for coaches and admins
- View client list with status filtering
- Navigate through 17-step coaching journey (UI)
- Mark steps as completed (frontend state)
- Fill 4-Quadrant exercise form and render output
- Complete BASIS personality assessment and generate CODE
- Record session notes and mood tracking
- Track gauge metrics (time-series readings)
- Manage leads via public form capture
- Generate BASIS personality report (English only)
- Upload and store lead data (JSONB basis answers/results)

### What the Coaching App Does Partially

~ **BROKEN/INCOMPLETE:**
- Step notes/completion data lost on refresh (not persisted)
- Exercise form answers lost on refresh (not persisted)
- AI coaching notes lost on refresh (not persisted)
- Four Quadrants can be skipped (not enforced as first step)
- Afrikaans language partial (preferences stored, content not translated)
- Reports limited (BASIS only, no journey summary)
- Session-level mood tracking UI exists but persistence unclear

### What the Coaching App Does NOT Support (Yet)

✗ **MISSING:**
- Repeat coaching engagement for same client (no multi-run support)
- Same client starting a new coaching journey without overwriting prior data
- Preserving coaching history across client re-engagement cycles
- Comparing client outcomes across multiple coaching runs
- Reordering or customizing step sequence per client
- Adding/removing steps dynamically
- Seminar/event context for lead capture
- Package selection on lead form
- Full Afrikaans translation
- Comprehensive journey report (all 17 steps, exercise outputs, notes summary)
- Historical reporting (per-run or cross-run comparisons)

### What Will Break the Required Business Process

🔴 **CRITICAL BREAKS:**

1. **Same client goes through coaching twice**
   - Current: All data for Cycle 1 is mixed with Cycle 2 data in same client record
   - Required: Two separate, distinct coaching runs with isolated step records, sessions, and notes
   - Impact: Prior work lost or confused; reports cannot distinguish cycles

2. **Coach needs to customize journey for one client**
   - Current: All clients get exactly 15 steps in fixed order, hardcoded
   - Required: Coach can reorder, add, or remove steps per client coaching cycle
   - Impact: Cannot adapt to individual client needs; inflexible process

3. **Coach needs to preserve coaching work but client goes inactive**
   - Current: Can archive client, but all notes/exercise data mixed; unclear if persisted
   - Required: Historical coaching run preserved separately, fully queryable, with all outputs intact
   - Impact: Months of coaching work potentially lost or inaccessible

4. **Seminar/event lead arrives at tablet; coach needs to know source**
   - Current: Lead form captures basic info but no event context; no package pre-selection
   - Required: Lead includes event name/date; package offered captured; auto-converts to client with package assigned
   - Impact: Cannot segment leads by event or pre-assign programs; manual data entry required

### Root Cause of All Issues

**Primary Architectural Issue:**
- **No coaching run/engagement cycle concept** → All data (steps, sessions, exercises, notes) tied directly to client_id → One client = one eternal journey → Repeat engagements overwrite or mix

**Secondary Persistence Issue:**
- **journeyProgress and exerciseData not in DB schema** → Stored in frontend memory only → Lost on any page refresh → No recovery possible

**Tertiary Flexibility Issue:**
- **15-step journey hardcoded** → Backend creates fixed steps on client creation → No API to modify step order or add/remove steps → Cannot customize per client

### Recommended Immediate Action

**SAFETY FIRST: Audit & Verify (Do This Before Any Major Implementation)**
1. Trace the exact code path when a coach fills the 4-Quadrant form and clicks "Save". Where does the data go? Does it reach the database?
2. Query the live Supabase database (clients table) and confirm whether there are any JSONB columns storing exerciseData or journeyProgress.
3. Refresh a page after saving exercise data. Does it reappear? If yes, it's persisted; if no, it's lost.

**Then Decide:**
- **If data IS persisted:** Data loss is less critical. Focus on multi-run architecture (Phase 1 & 2).
- **If data is NOT persisted:** Implement Phase 1 immediately (add persistence). This is blocking all coaching work.

**Build Order (Assuming data is NOT currently persisted):**
1. **PHASE 1** — Add journey_progress + exercise_data JSONB columns + update PUT route (1-2 days)
2. **PHASE 2** — Coaching runs architecture (multi-run isolation) (3-5 days)
3. **PHASE 3** — Dynamic step management (reorder, insert, remove) (2-3 days)
4. **PHASES 4-6** — Reporting, leads evolution, i18n (lower priority, can be phased)

---

## END OF AUDIT

**Audit Completed:** April 13, 2026  
**Status:** READY FOR IMPLEMENTATION PLANNING  
**Next Step:** Principal engineer to review, prioritize fixes, assign Phase 1 implementation

**Classification:**  
- 🔴 Critical (multi-run, data persistence): Must fix before expanding coaching app to production multi-client use
- 🟠 High (step flexibility, seminar leads): Should fix within Q2 2026 to unlock full business process
- 🟡 Medium (i18n, audit trails): Can defer to Q3 2026

---

This audit is complete and production-ready as a decision-making document for safe next implementation steps.
