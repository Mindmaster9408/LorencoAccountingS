# Leo Accounting × Grok Bot — MCP Integration Audit (Codebox 1)

> **Investigation only — nothing was changed.** No code, migrations, Supabase data, Render settings, deploys or commits.
> Date: 2026-11-18 · Basis: the repository at `main` (`032e0ed`), read-only database queries, the public `/api/health` endpoint, and xAI's public documentation.
> Legend: ✅ **confirmed** (seen in code / database) · ⚠️ **assumption / must be confirmed** (marked explicitly).

---

## 0. Decisions (Ruan, 2026-11-18 — DECIDED)

**An external bot is an employee user.** The client/practice brings the bot; the practice manager
decides its role and rights (even full rights) — that is the practice's decision, not Lorenco's.
Lorenco does not cap how many bots a practice runs. Only Sean (our built-in AI) is Lorenco's own
AI responsibility. Sean keeps learning from bot actions (same posting path). A fair-use rate limit
per bot and per company protects the shared server — it limits tempo, never rights.

Consequences for this report: D1/D2/D3 below are the **practice's** choice; sections C5 (dedicated
read-only role) and the "least privilege" rows in E become **recommendations to the practice**, not
Lorenco-imposed limits. Authentication becomes a **personal access token per user** (the bot user
creates one and pastes it into Grok); the MCP endpoint acts with exactly that user's rights.
Pricing notes: [docs/pricing/BOTS_EN_BILLIKE_GEBRUIK.md](../pricing/BOTS_EN_BILLIKE_GEBRUIK.md).

Original open questions (kept for the record):

| # | Decision | Why it matters |
|---|---|---|
| D1 | **Client financial data to an external AI.** Grok runs on xAI's servers; every tool result (bank lines, balances, client names) is sent to xAI. Earlier direction (2026-08-16/18, project memory) was that Sean must not use external LLMs and that client-support AI must not leak client financial data. | POPIA, client confidentiality, engagement letters. Decide: allowed at all? Only for consenting clients? Only for the test company first? |
| D2 | **Bot identity model** — Ruan's proposal: the practice creates a *user* for the bot with its own login. ✅ This fits Leo's existing model very well (section E). Confirm: one bot user per practice, restricted role, assigned only to selected clients. | Determines authentication, audit trail and least privilege. |
| D3 | **Write actions.** xAI documents that `require_approval` is **not supported** for remote MCP tools. Human approval therefore cannot rely on Grok — it must be enforced by Leo. Confirm the rule: the bot may *stage* and *suggest*, never *post*, *confirm* or *reconcile*. | Protects the general ledger. |

---

## A. Current architecture (what already exists)

| Area | Finding | Status |
|---|---|---|
| Frontend | Static HTML + vanilla JS pages (`frontend-accounting/*.html`), served by the backend | ✅ |
| Backend | Node ≥ 18, Express 4 (`backend/server.js`), one process serving every app (Leo, Paytime, Charlie, Stockton, …) | ✅ |
| API | REST under `/api/accounting/*`, mounted with `authenticateToken` + `requireModule('accounting')` (`server.js:384-390`); sub-routers in `modules/accounting/index.js:60-129` | ✅ |
| Authentication | JWT (12 h, `shared/routes/auth.js:256`), payload `{userId, companyId, role, isSuperAdmin}`. Every request re-checks the DB (user active, company active, active membership — `middleware/auth.js` `_checkActiveSession`, 60 s cache). Optional per-user TOTP 2FA (`shared/routes/twoFactor.js`) | ✅ |
| Authorization | Leo maps the Eco role to `admin / accountant / bookkeeper / viewer` (`modules/accounting/middleware/auth.js` `mapRole`) and checks a fixed `PERMISSIONS` map per route (`hasPermission`, unknown permission = hard 403) | ✅ |
| Tenant isolation | Company comes from the JWT (`req.companyId`); routes filter by `company_id`. Practice staff reach client companies through `POST /api/auth/select-company` via `eco_clients` trust links; restricted roles only reach clients listed in `user_client_access` | ✅ |
| Database | Supabase Postgres. Two access paths: Supabase JS client (service key, server-side only) and a direct `pg` pool for the accounting engine (`ACCOUNTING_DATABASE_URL`); production health shows `accountingDb: ok, provider: supabase` | ✅ |
| Hosting | Render, one Docker web service (`app.lorencoecosystem.com`), auto-deploys from `main`; HTTPS with a valid certificate via Render | ✅ |
| Audit | `AuditLogger.logUserAction` on bank staging/confirm/allocate (`modules/accounting/services/auditLogger.js`) + shared `audit_log` | ✅ |
| Rate limiting | **None** on the general API (only the Collector public portal has limiters, `server.js:494`) | ✅ (gap) |
| Existing "integrations API" | `routes/integrations.js` has an `X-Integration-Key` scheme, **but it is dead**: the `integrations` table does not exist, its SQL selects `companies.name` (column does not exist), and its `/external/*` routes sit behind the global JWT check. **Not reusable.** | ✅ (confirmed dead) |
| MCP | No MCP code or `@modelcontextprotocol/sdk` dependency anywhere in the repo | ✅ |

**How Grok can talk to Leo without bypassing controls:** only through Leo's own authenticated HTTP API, **as a dedicated restricted user** (Ruan's proposal). Then every existing control applies unchanged: JWT session checks, company status, membership, the Leo permission map, per-client delegation, staging, the single posting path and the audit log. The MCP layer must never use the Supabase service key or the direct `pg` pool.

---

## B. Existing reusable functionality

### B1. Bank statement import ✅
| Step | Where | Notes |
|---|---|---|
| CSV | Parsed **in the browser** (`frontend-accounting/bank.html`); the server receives a `transactions[]` array | An MCP tool would have to parse CSV itself or reuse the browser's parser logic |
| PDF | `POST /api/accounting/bank/import/pdf` (`bank.js:810`) — parses, returns rows for review, **writes nothing** | Supported layouts: SB, ABSA, FNB, Nedbank, Capitec business (+ learned formats, migration 183) |
| Image | `POST /bank/import/image` (`bank.js:1005`) — OCR, review only | |
| OFX | `POST /bank/import/ofx` (`bank.js:1084`) | |
| Stage | `POST /bank/import` (`bank.js:688`, perm `bank.import`) → `BankStagingService.stageTransactions` | Verifies the bank account belongs to the company; **no direct `bank_transactions` insert** |
| Duplicates | File hash (`DuplicateDetectionService.detectBatchDuplicate`) + row-level flags during staging | Warns, does not block |
| Transfers | `BankStagingService.detectTransfers` after staging | |
| Review | `GET /bank/staging`, `GET /bank/staging/batches`, `PATCH /bank/staging/:id`, `…/reject`, `…/restore` | |
| Confirm | `POST /bank/staging/confirm` (perm `bank.import`) → `confirmStaged` → `bank_transactions`; audited; may trigger Sean auto-allocate (opt-in per client) | **Must stay human-only** |

**Can it be exposed via MCP?** Staging — yes, safely (no GL impact, reviewable, rejectable). Confirm — no (human step).

### B2. Allocation rules and engine ✅
| Item | Where |
|---|---|
| Rules (stored per company) | `GET/POST/PUT/DELETE /api/accounting/bank/rules` (`bankRules.js`), matcher `services/bankRuleMatcher.js`, normaliser `bankDescriptionNormalizer.js` |
| Rule suggestions (read-only) | `GET /bank/rules/suggest` (perm `bank.view`) |
| Sean suggestions (read-only) | `POST /bank/sean-suggestions` (perm `bank.view`) |
| Posting (the ONE path) | `allocateBankTransaction` behind `POST /bank/transactions/:id/allocate` (perm `bank.allocate`): journal, VAT split, post-validation, auto-reversal on failure, audit, Sean learning event (`bank.js:1579-1600`) |
| Undo | `DELETE /bank/transactions/:id/allocate` (perm `bank.allocate`) |
| Auto-allocate | `POST /bank/sean-auto-allocate` — only when "Sean allocates by himself" is on for that client; uses the same posting path |
| Unallocated lines | `GET /reports/unallocated-bank-transactions`, `GET /bank/transactions?status=…` |

VAT treatment: determined inside the posting path from the chosen account / rule (⚠️ exact VAT decision logic not traced line-by-line in this audit).
**Can Grok trigger allocation without duplicating logic?** Yes — by calling the suggestion endpoints (read) and, if ever allowed, the existing allocate endpoint. The MCP layer must never compute journals itself.

### B3. Bank reconciliation ✅
| Operation | Endpoint | Read / write |
|---|---|---|
| Recon report | `GET /reports/bank-reconciliation` | Read |
| Recon history | `GET /reports/bank-recon-history`, `/:sessionId` | Read |
| Month-end review (balance breaks, missing statements, duplicates, stale lines, mis-posts) | `GET /bank/sean-review?bankAccountId=` | Read — ideal "prepare work for human review" source |
| Control-account recon | `GET /reports/control-account-reconciliation` | Read |
| Reconcile | `POST /bank/reconcile` (perm `bank.reconcile`, creates `bank_recon_sessions`) | **Write — human only** |
| Unreconcile | `POST /bank/transactions/:id/unreconcile` | **Write — human only** |

### B4. Reports ✅
Trial balance `GET /reports/trial-balance`; GL, balance sheet, P&L (+ trend/matrix), cash flow — all `report.view`, available to the `viewer` role.

---

## C. Missing components

| # | Component | Notes |
|---|---|---|
| C1 | **MCP server** (Streamable HTTP) exposing tool definitions | New code + new dependency `@modelcontextprotocol/sdk` (or a minimal JSON-RPC implementation) |
| C2 | **MCP client authentication** — a secret Grok sends in `Authorization` | xAI supports a static `authorization` token or extra `headers` (see H). Store only a hash; revocable |
| C3 | **Bot session handling** — the MCP layer must act *as the bot user* | PoC: log in as the bot user (password in a Render secret) and refresh the 12 h JWT. Better: a revocable, scoped "agent token" for that user (new) |
| C4 | **Per-company context** — select the client company per tool call | Reuse `POST /api/auth/select-company`; cache one JWT per company |
| C5 | **Dedicated bot role** | `viewer`/`bookkeeper` exist in Leo's map but not in the Eco role hierarchy (`config/permissions.js`). Using `cashier` (→ bookkeeper) would also grant POS rights. A clean `ai_agent` role (read-only first) is needed |
| C6 | **Rate limiting + call audit** for MCP traffic | No general rate limiter exists today |
| C7 | **Idempotency** for write tools (staging) | Staging already dedups on file hash; add an `idempotency_key` per tool call |
| C8 | **Review-task queue** (`create_review_task`) | ⚠️ A dashboard action queue exists (`routes/dashboard.js`, docs `DASHBOARD_ACTION_QUEUE_IMPLEMENTATION_REPORT.md`) — not verified whether it can accept external tasks |
| C9 | **Kill switch** — feature flag + per-client consent flag | Instant off without a deploy |

---

## D. Recommended MCP architecture

**Recommendation: Option A-lite — a thin, isolated MCP module inside the existing backend that calls Leo's own HTTP API over loopback as the bot user.** Off by default behind a feature flag.

```
 Grok (xAI cloud)
   │  HTTPS · Streamable HTTP · Authorization: Bearer <MCP token>
   ▼
 app.lorencoecosystem.com/mcp            (Render, existing service, existing TLS)
 ┌──────────────────────────────────────────────────────────────┐
 │ modules/mcp  (NEW, feature-flagged, OFF by default)           │
 │  1. verify MCP token (hash) → which practice + bot user       │
 │  2. rate limit · log every call                               │
 │  3. tool → company check (bot must have access to it)         │
 │  4. call Leo REST on localhost with the BOT USER's JWT        │
 └──────────────────────────────┬───────────────────────────────┘
                                │  http://127.0.0.1:$PORT/api/accounting/...
                                ▼
 Existing Leo API — UNCHANGED: authenticateToken → session check →
 requireModule → enforceCompanyStatus → hasPermission → services → Supabase
```

| Criterion | A-lite (inside backend, loopback) | B (separate Render service) |
|---|---|---|
| Changes to Leo | One mount line + one new module | None |
| Reuses business logic | Yes — via the real API, no service-level shortcuts | Yes — same API |
| Tenant isolation | Enforced by Leo itself (bot user's JWT) | Same |
| Security | Secrets never leave the server; no service key in the module | Bot credentials stored in a second service |
| HTTPS / Render | Existing domain + certificate | New service + URL |
| Independent maintenance | Separate folder, feature flag; but deploys with the app | Fully independent |
| Hosting cost | None extra | Extra service (free tier sleeps → Grok timeouts) |

A-lite wins on fewest changes and cost. **Move to B** if MCP traffic ever affects the main app (CPU, memory) or needs its own release cycle — the loopback design makes that move trivial (only the base URL changes).

⚠️ Do **not** expose the existing frontend routes or page URLs to the agent; only the REST endpoints listed in section 7 below.

---

## E. Security assessment

### Ruan's proposal — the bot as an employee user ✅ recommended
Leo already supports everything this needs:
- A practice manager can create a user with a role and app restriction (`POST /api/users`, `shared/routes/users.js:226`; `apps_access` + `user_app_access` → module check level 3).
- A **restricted** practice user reaches **only** the client companies listed for him in `user_client_access` and works there with his own restricted role (`shared/routes/auth.js` select-company, delegated-access path). Accountant-level roles reach all clients — so the bot must **not** be an accountant.
- Every action is attributed to that user in the audit trail ("done by: Leo Bot").
- Disable = deactivate the user (session check blocks within 60 s).

### Required controls
| Requirement | How |
|---|---|
| Authentication | MCP token (hashed, revocable) **and** the bot user's own session; never the Supabase service key |
| Per-company authorization | Bot user only in `user_client_access` for consenting clients; checked by Leo on every call |
| Tenant isolation | Company switch only through `select-company`; MCP layer rejects any company id not in the bot's list before calling Leo |
| Least privilege | Phase 1 role = read-only (Leo `viewer`). Later at most `bookkeeper` (import + allocate, never post journals / reconcile / year-end) |
| Read-only tools | Separate tool set; write tools absent from the server until approved |
| Audit | Existing `AuditLogger` + a new MCP call log (tool, args hash, company, result size, duration) |
| Rate limiting | Per token + per company (C6) |
| Replay / duplicates | Idempotency key per write call; staging file-hash dedup already exists |
| Human approval | **Enforced by Leo**: the bot can only stage/suggest; confirming, posting, reconciling stay human-only by role. (Grok has no approval step — D3) |
| Bot must never be super admin | Super admins bypass every check and can switch to any company with `X-Company-Id`. Also keep the bot's email out of `ADMIN_EMAILS` (`modules/accounting/middleware/auth.js`) |
| 2FA | A bot cannot type codes. Either 2FA off for the bot user (compensated by the MCP token + IP/rate limits) or store its TOTP secret in Render (which makes it a second password). Long-term: agent token (C3) instead of password login |
| Prompt injection | Bank descriptions are attacker-controllable text. The server must enforce permissions regardless of what the bot is told (section 6 requirement) — guaranteed by the role, not by instructions |

### Main risks
1. **Data leaving to xAI** (D1) — highest business risk.
2. **Over-privileged bot user** (accountant/admin/super admin) — would expose every client and posting.
3. **No rate limiting** today — a looping agent could load the shared server (affects Paytime, Charlie).
4. **1000-row cap** in Supabase reads — large tool results silently truncated (see Paytime audit H2); tools must paginate and say so.

---

## F. Implementation roadmap (small, independently testable codeboxes)

| Codebox | Scope | Test in | Complexity |
|---|---|---|---|
| CB2 | Bot role `ai_agent` (read-only) mapped to Leo `viewer`; create bot user in "Infinite Legacy — TEST" practice context; verify it sees only assigned clients | Company 51 | Low |
| CB3 | MCP module skeleton: feature flag, `/mcp` Streamable HTTP endpoint, token check, `ping` + `list_companies` | Local + co 51 | Medium |
| CB4 | Read-only tools: `list_bank_accounts`, `get_company_profile`, `get_trial_balance` (loopback as bot user) | Co 51 | Low |
| CB5 | Read-only tools: `get_bank_import_status`, `get_allocation_rules`, `get_unallocated_transactions`, `get_reconciliation_status` (incl. `sean-review`) with pagination | Co 51 | Medium |
| CB6 | Rate limiting, MCP call log, kill switch, per-client consent flag | Co 51 | Medium |
| CB7 | Live Grok connection test (section H checklist) | Co 51 only | Low |
| CB8 | (Later, after D3) `import_bank_statement` → **staging only**, idempotency key; human confirms in Leo | Co 51 | High |
| CB9 | (Later) `run_allocation_rules` → **suggestions only**; posting stays in Leo UI | Co 51 | Medium |
| CB10 | (Later) `create_review_task` (needs C8 decision) | Co 51 | Medium |

### Proposed tools — reuse map
| Tool | Reuses | Parameters | Permission | Complexity |
|---|---|---|---|---|
| `list_companies` | `GET /api/auth/companies` (bot's own list) | — | any | Low |
| `list_bank_accounts` | `GET /api/accounting/bank/accounts` | company_id | `bank.view` | Low |
| `get_company_profile` | `GET /api/accounting/company/:id` (`company.js:134`; ⚠️ trim fields — no bank/tax details) | company_id | authenticated user of that company | Low |
| `get_bank_import_status` | `GET /bank/staging/batches`, `GET /bank/staging` (both `bank.view`, confirmed) | company_id, batch_id? | `bank.view` | Low |
| `get_allocation_rules` | `GET /bank/rules` | company_id | `bank.view` | Low |
| `get_unallocated_transactions` | `GET /reports/unallocated-bank-transactions` | company_id, bank_account_id?, limit/offset | `report.view` | Low |
| `get_reconciliation_status` | `GET /reports/bank-reconciliation`, `/bank-recon-history`, `GET /bank/sean-review` | company_id, bank_account_id | `report.view` / `bank.view` | Medium |
| `get_trial_balance` | `GET /reports/trial-balance` | company_id, date range | `report.view` | Low |
| `import_bank_statement` (future) | `/bank/import/pdf|ofx` (parse) → `POST /bank/import` (stage) | company_id, bank_account_id, file, idempotency_key | `bank.import` → needs bookkeeper-level bot | High |
| `run_allocation_rules` (future) | `GET /bank/rules/suggest`, `POST /bank/sean-suggestions` | company_id, transaction ids | `bank.view` | Medium |
| `prepare_bank_reconciliation` (future) | `GET /bank/sean-review` + recon report (read only) | company_id, bank_account_id, statement date | `bank.view` | Medium |
| `create_review_task` (future) | ⚠️ dashboard action queue or new table | company_id, title, links | new | Medium |

---

## G. Estimated complexity
Read-only proof of concept (CB2–CB7): **Medium overall** — mostly Low pieces; the MCP transport and bot session handling are the only Medium parts. Write tools (CB8–CB10): **Medium–High**, gated by D1/D3.

---

## H. Deployment requirements and Grok compatibility

**Runs on the existing Render service** (A-lite): same Docker image, same domain and TLS, one new path `/mcp`, new env secrets (MCP token hash, bot credentials) — set by Ruan in Render, never in the repo. No new service needed for the PoC.

**Grok remote MCP — from xAI's documentation** ([Remote MCP Tools](https://docs.x.ai/developers/tools/remote-mcp)):
- Transport: **Streamable HTTP or SSE** only (no stdio). `server_url` + `server_label` required.
- Auth: optional `authorization` (sent as the `Authorization` header) and optional extra `headers`. OAuth is not mentioned on that page; the Grok **CLI** docs mention automatic OAuth or a static header ([MCP servers](https://docs.x.ai/build/features/mcp-servers.md)).
- `allowed_tools` can restrict which tools Grok sees — use it as an extra layer, never as the security boundary.
- `require_approval` is **not supported** → approval must live in Leo (D3).
- Calls appear to run from xAI's servers (inference from "server-side tool calls"; not stated explicitly) → the endpoint must be publicly reachable; IP allow-listing is only possible if xAI publishes egress ranges.

**⚠️ Must be confirmed in a live test (CB7):**
1. Which product "Grok Bot" is: the xAI API (Responses API / SDK) or the consumer Grok app's connector feature — their auth options may differ.
2. Streamable HTTP session handling against Render (keep-alive, timeouts behind Render's proxy).
3. That the `Authorization` header arrives intact and that tool results above a certain size are accepted.
4. Timeout per tool call (Render cold-start does not apply — the main service is always on).
5. Exact tool-name prefixing (`server_label`) and error-message display.

A generic REST API does **not** qualify as an MCP server — the JSON-RPC MCP protocol (initialize, tools/list, tools/call) must be implemented (C1).

---

## I. First proof of concept (smallest safe step)

1. Ruan decides **D1** (at least: allowed for the TEST company).
2. Create user "Leo Bot" in the TEST company context with a **read-only** role and access to **company 51 only**.
3. Add `/mcp` behind a feature flag (off in production until tested) with **two tools**: `list_companies` and `get_trial_balance` — both read-only, both called as the bot user over loopback.
4. Connect Grok with a test MCP token; ask: "Which companies can you see?" and "Show the trial balance of Infinite Legacy — TEST".
5. Verify: only company 51 appears; a request for any other company is refused by Leo (403); every call is in the audit log as "Leo Bot".

No real client data, no write path, nothing touching existing users or flows.

---

## Production safety
The PoC touches none of: existing users, bank imports, allocations, reconciliations, reports, period locks, opening balances, year-end, authentication, Supabase data. It adds one feature-flagged path that calls the same API the browser uses, as a user with fewer rights than any staff member. All testing in **Infinite Legacy — TEST (company 51)** per CLAUDE.md Part H; Sean governance (Part B) still applies to anything the bot causes Sean to learn.

Sources: [xAI Remote MCP Tools](https://docs.x.ai/developers/tools/remote-mcp) · [xAI Grok CLI MCP servers](https://docs.x.ai/build/features/mcp-servers.md) · [xAI remote MCP guide](https://docs.x.ai/docs/guides/tools/remote-mcp-tools)
