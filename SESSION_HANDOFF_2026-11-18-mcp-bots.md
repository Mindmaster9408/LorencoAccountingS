# Session handoff — 2026-11-18 — Bots as users: personal access keys + MCP server (Ledger Leo, read-only)

Covers Codebox 3 ("MCP Server Foundation — Safe Read-Only Integration"), adapted to Ruan's decision.

**Decision (Ruan):** an external AI bot (Grok or any other) brought in by a client/practice is
**an employee user**. The practice manager decides its role and rights; Lorenco does not limit a
practice's choice of rights or the number of bots. Only Sean is Lorenco's own AI. Fair-use limits
protect the shared server. Background: `accounting-ecosystem/docs/accounting/GROK_MCP_INTEGRATION_AUDIT_2026-11-18.md`;
pricing notes `accounting-ecosystem/docs/pricing/BOTS_EN_BILLIKE_GEBRUIK.md`.

**Status:** not committed (on the pending commit list). Migration 186 **run**. `/mcp` answers **503 (off)**
until `MCP_ENABLED=true` is set on Render.

## How Codebox 3 was applied
| Codebox item | Done as |
|---|---|
| Verify current implementation | Done: no dedicated AI role exists — **by Ruan's decision** the bot is a normal user whose role the practice picks. Company isolation = Leo's existing `select-company` + per-request session check. Safe location = separate `modules/mcp`. |
| Official SDK | Server is a minimal, dependency-free MCP implementation (stateless Streamable HTTP, JSON-RPC 2.0), **verified with the official SDK client** (`@modelcontextprotocol/sdk` 1.17.0): 21/21. Chosen to avoid a new runtime dependency; switch to the SDK server later if sessions/SSE are needed. |
| `/mcp`, HTTPS via Render, `MCP_ENABLED` off by default | Yes — always mounted, refuses with 503 when off. |
| No direct DB access from tools, no service key for the agent, no admin credentials | Tools call the normal Lorenco API over loopback **as the key's user**; **platform admin accounts (super admins + ADMIN_EMAILS) cannot create or use keys**. |
| Dedicated bot identity, hashed token, revocable | Personal access key per user (`lnc_…`, SHA-256 hash only, revoke = instant 401). The practice creates a dedicated user for its bot. |
| Company enforcement every request | Leo's own checks + MCP pre-check: the company must be in the user's own company list. |
| Tools: ping, list_companies, get_trial_balance | Yes — plus 6 more **read-only** tools already built and tested (bank accounts, import status, allocation rules, unallocated transactions, reconciliation status, company profile). Trial balance params are `from_date` / `to_date`. |
| Rate limit, audit, timeouts, validation, safe errors, isolation, kill switch | 60/min per bot (burst 120), 600/min per company, 10/min heavy tools; every tool call in `audit_log` (module `mcp`, args only — no results, no tokens); 25 s timeout per Lorenco call; strict argument checks; 5xx details never shown to the bot; kill switch below. |
| Prohibited capabilities | Not built, and the MCP layer is **read-only**: it refuses any non-GET call even if a tool asked. Never to be built as tools: SARS submissions, bank payments, period close/reopen, final approval of financial statements, deleting records, changing own permissions, direct client communication. |

## Files
| File | Purpose |
|---|---|
| `backend/config/migrations/186_user_api_tokens.sql` (RUN) | `user_api_tokens` — hashes only, revocable, optional expiry |
| `backend/shared/services/apiTokens.js` | create (shown once), list, revoke, resolve; `isPlatformAdmin` block; max 20 active per user |
| `backend/shared/routes/apiTokens.js` | `GET/POST /api/api-tokens`, `DELETE /api/api-tokens/:id` (own keys, audited; admins refused) |
| `backend/modules/mcp/index.js` | `POST /mcp`: off switch → key check → JSON-RPC (initialize, ping, tools/list, tools/call); notifications 202; GET 405 |
| `backend/modules/mcp/lorencoApi.js` | loopback as the user; company allow-list pre-check; GET-only; 25 s timeout |
| `backend/modules/mcp/tools.js` | 9 read-only tools |
| `backend/modules/mcp/rateLimit.js` | fair-use buckets |
| `backend/server.js` | mounts `/api/api-tokens` and `/mcp` |
| `frontend-ecosystem/dashboard.html` | Profile → "Bot / AI access keys" (create, copy once, list, revoke, MCP address) |
| `backend/modules/accounting/routes/reports.js` | bug fix found while testing: bank-recon-history selected `users.name` → 500 in production; now `name:full_name` |
| `backend/tests/mcp-server.test.js` | 28 tests |

## Test results (Codebox 3 list)
| # | Test | Result |
|---|---|---|
| 1 | Valid key → connects | ✅ E2E (official client) |
| 2 | Invalid/missing key → 401 | ✅ unit + E2E (revoked key) |
| 3 | MCP disabled → refused | ✅ unit + live (503 with `MCP_ENABLED` unset); kill switch unit-tested |
| 4 | `ping` | ✅ status / version / enabled, no secrets |
| 5 | `list_companies` only assigned companies | ✅ bot saw only company 51 |
| 6 | `get_trial_balance` returns Leo's report | ✅ (company 51, 2026/27) |
| 7 | Unauthorized company refused | ✅ company 7 refused (pre-check + Leo) |
| 8 | No write access | ✅ only read tools listed; non-GET refused before sending (unit) |
| 9 | Existing Leo unaffected | ✅ full suite 1472 pass, golden 56/56, lint 0 errors |
| 10 | Calls audited | ✅ `audit_log` module `mcp` rows per tool call |

## Render environment variables
| Variable | Value | Needed |
|---|---|---|
| `MCP_ENABLED` | `true` to switch on (anything else = off) | yes, when going live |
| `PUBLIC_APP_URL` | `https://app.lorencoecosystem.com` (shown in the Profile keys section) | optional (that is the default) |
| `MCP_RATE_USER_PER_MIN` / `MCP_RATE_USER_BURST` / `MCP_RATE_COMPANY_PER_MIN` / `MCP_RATE_HEAVY_PER_MIN` | defaults 60 / 120 / 600 / 10 | optional |
| `MCP_REQUEST_TIMEOUT_MS` | default 25000 | optional |
| `ADMIN_EMAILS` | existing; accounts listed here cannot get bot keys | already set/defaulted |

Kill switch without a redeploy: in Supabase, `feature_flags` row `flag_key = 'mcp_kill_switch'`, `is_active = true`
→ `/mcp` off for everyone within 30 seconds (set back to `false` to allow again).

## Connecting Grok
1. Push, then on Render set `MCP_ENABLED=true` (service redeploys).
2. In company 51 there is a test user **"Leo Bot (test)"** (`leobot.test51@example.com`, role viewer, company 51 only).
   Reset its password in Users, sign in as it, open **Profile → Bot / AI access keys**, create a key, copy it.
3. In Grok (xAI remote MCP): server URL `https://app.lorencoecosystem.com/mcp`, server label `lorenco`,
   authorization = the key (sent as `Authorization: Bearer <key>`).
4. Ask: "Ping Lorenco", "Which companies can you see?", "Show the trial balance of Infinite Legacy — TEST for 2026-03-01 to 2027-02-28".

## Open risks / next
- Live Grok test still to do (which Grok product; header passthrough; result size) — audit section H.
- Fair-use buckets are in process memory (fine for one Render instance; use a shared store if scaled out).
- Phase 2: write tools (stage an import, allocation suggestions/allocate) + tag Sean learning events with the
  bot channel (the `X-Lorenco-Channel: mcp` header is already sent). Prohibited list above stays prohibited.
- Managers creating a key FOR a bot user (today: sign in as the bot user and create it there).
- Local `.env`: `ACCOUNTING_DATABASE_URL` points at retired Zeabur — locally set it to the Supabase URL.
