'use strict';

/**
 * Tests — personal access tokens (migration 186) + the MCP server (/mcp).
 * A bot authenticates with a user's token and every tool runs AS that user through the
 * normal API (here: a fake API recording the calls). Fair-use limits refuse tempo, never rights.
 */

const express = require('express');

const mockDb = {};
jest.mock('../config/database', () => ({ supabase: require('./golden/fake-supabase').createFakeSupabase(mockDb) }));

const ApiTokens = require('../shared/services/apiTokens');
const { createMcpRouter } = require('../modules/mcp');
const { createLimiter, Buckets } = require('../modules/mcp/rateLimit');
const { LorencoApiError } = require('../modules/mcp/lorencoApi');
const { validateArgs, trimLists, TOOLS } = require('../modules/mcp/tools');

const supabase = () => require('../config/database').supabase;

const reset = () => {
  Object.keys(mockDb).forEach(k => delete mockDb[k]);
  Object.assign(mockDb, {
    users: [
      { id: 10, username: 'leobot', email: 'bot@example.test', full_name: 'Leo Bot', is_super_admin: false, is_active: true },
      { id: 11, username: 'gone', email: 'gone@example.test', full_name: 'Gone', is_super_admin: false, is_active: false }
    ],
    user_api_tokens: [], audit_log: []
  });
};

describe('personal access tokens', () => {
  beforeEach(reset);

  test('created token is shown once; only its hash is stored; it resolves to the user', async () => {
    const { token, record } = await ApiTokens.createToken(supabase(), 10, { name: 'Grok bot' });
    expect(token).toMatch(/^lnc_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(mockDb.user_api_tokens)).not.toContain(token);
    expect(mockDb.user_api_tokens[0].token_hash).toBe(ApiTokens.hashToken(token));
    expect(record).toMatchObject({ name: 'Grok bot', active: true });
    const r = await ApiTokens.resolveToken(supabase(), token);
    expect(r.user.id).toBe(10);
  });

  test('revoked, expired, unknown, malformed and inactive-user tokens never resolve', async () => {
    const a = await ApiTokens.createToken(supabase(), 10, { name: 'a' });
    await ApiTokens.revokeToken(supabase(), 10, a.record.id);
    expect(await ApiTokens.resolveToken(supabase(), a.token)).toBeNull();

    const b = await ApiTokens.createToken(supabase(), 10, { name: 'b', expiresInDays: 1 });
    mockDb.user_api_tokens.find(t => t.id === b.record.id).expires_at = '2000-01-01T00:00:00Z';
    expect(await ApiTokens.resolveToken(supabase(), b.token)).toBeNull();

    expect(await ApiTokens.resolveToken(supabase(), 'lnc_' + 'x'.repeat(43))).toBeNull();
    expect(await ApiTokens.resolveToken(supabase(), 'Bearer nonsense')).toBeNull();

    const c = await ApiTokens.createToken(supabase(), 11, { name: 'c' });
    expect(await ApiTokens.resolveToken(supabase(), c.token)).toBeNull();
  });

  test('a user can only revoke their own keys', async () => {
    const a = await ApiTokens.createToken(supabase(), 10, { name: 'a' });
    expect(await ApiTokens.revokeToken(supabase(), 11, a.record.id)).toBe(false);
    expect(await ApiTokens.resolveToken(supabase(), a.token)).not.toBeNull();
  });

  test('name is required and expiry is validated', async () => {
    await expect(ApiTokens.createToken(supabase(), 10, { name: ' ' })).rejects.toMatchObject({ status: 400 });
    await expect(ApiTokens.createToken(supabase(), 10, { name: 'x', expiresInDays: 0 })).rejects.toMatchObject({ status: 400 });
  });
});

describe('fair-use limiter', () => {
  test('bucket refills over time and refuses when empty', () => {
    const b = new Buckets(60, 2);           // 1 per second, burst 2
    const t = 1e6;
    expect(b.take('k', 1, t).ok).toBe(true);
    expect(b.take('k', 1, t).ok).toBe(true);
    const r = b.take('k', 1, t);
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBe(1);
    expect(b.take('k', 1, t + 1000).ok).toBe(true);
  });

  test('a refusal in one bucket spends nothing in the others; company limit covers all its bots', () => {
    const lim = createLimiter({ MCP_RATE_USER_PER_MIN: '600', MCP_RATE_COMPANY_PER_MIN: '2' });
    const t = 5e6;
    expect(lim.check({ userId: 1, companyId: 7 }, t).ok).toBe(true);
    expect(lim.check({ userId: 2, companyId: 7 }, t).ok).toBe(true);
    const r = lim.check({ userId: 3, companyId: 7 }, t);
    expect(r).toMatchObject({ ok: false, scope: 'per company' });
    expect(lim.check({ userId: 3, companyId: 8 }, t).ok).toBe(true);   // other company unaffected
  });
});

describe('tool argument checks', () => {
  const schema = TOOLS.find(t => t.name === 'get_trial_balance').inputSchema;
  test.each([
    [{}, 'company_id is required'],
    [{ company_id: 'abc', from_date: '2026-03-01', to_date: '2026-03-31' }, 'company_id must be a whole number'],
    [{ company_id: 51, from_date: '1 March', to_date: '2026-03-31' }, 'from_date must look like YYYY-MM-DD'],
    [{ company_id: 51, from_date: '2026-03-01', to_date: '2026-03-31', drop: 1 }, 'unknown argument: drop'],
    [{ company_id: 51, from_date: '2026-03-01', to_date: '2026-03-31' }, null]
  ])('%j', (args, expected) => expect(validateArgs(schema, args)).toBe(expected));

  test('long lists are cut with an explicit note', () => {
    const { data, notes } = trimLists({ rows: Array.from({ length: 7 }, (_, i) => i) }, 3);
    expect(data.rows).toEqual([0, 1, 2]);
    expect(notes[0]).toMatch(/showing 3 of 7/);
  });
});

describe('MCP server over HTTP', () => {
  let server, base, token, calls, apiBehaviour;
  const fakeApi = {
    async listCompanies(ctx) { calls.push(['companies', ctx.user.id]); return [{ id: 51, company_name: 'Infinite Legacy — TEST', role: 'viewer', modules_enabled: ['accounting'] }]; },
    async request(ctx, companyId, method, path) {
      calls.push([method, path, ctx.user.id, companyId]);
      if (apiBehaviour === 'forbidden') throw new LorencoApiError(403, 'Insufficient permissions');
      return { accounts: [{ code: '1000', debit: 10, credit: 0 }] };
    }
  };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/mcp', createMcpRouter({ isEnabled: () => true, killSwitchOn: async () => false, api: fakeApi, limiter: createLimiter({ MCP_RATE_USER_PER_MIN: '600', MCP_RATE_USER_BURST: '600' }) }));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port + '/mcp';
  });
  afterAll(() => new Promise(r => server.close(r)));
  beforeEach(async () => {
    reset();
    calls = []; apiBehaviour = 'ok';
    token = (await ApiTokens.createToken(supabase(), 10, { name: 'Grok' })).token;
  });

  const post = async (body, tok = token, extraHeaders = {}) => {
    const r = await fetch(base, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream' }, tok ? { Authorization: 'Bearer ' + tok } : {}, extraHeaders), body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  };

  test('no key / wrong key → 401 with a hint, nothing called', async () => {
    const a = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null);
    const b = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'lnc_' + 'y'.repeat(43));
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect(calls).toEqual([]);
  });

  test('initialize negotiates the protocol version and announces tools', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(r.status).toBe(200);
    expect(r.body.result.protocolVersion).toBe('2025-03-26');
    expect(r.body.result.capabilities.tools).toBeDefined();
    const u = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(u.body.result.protocolVersion).toBe('2025-06-18');
  });

  test('notifications get 202 and no body', async () => {
    const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(r.body).toBeNull();
  });

  test('tools/list: all read-only Leo tools with input schemas', async () => {
    const r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const names = r.body.result.tools.map(t => t.name);
    expect(names).toEqual(['ping', 'list_companies', 'get_company_profile', 'list_bank_accounts', 'get_bank_import_status',
      'get_allocation_rules', 'get_unallocated_transactions', 'get_reconciliation_status', 'get_trial_balance']);
    expect(r.body.result.tools.every(t => t.inputSchema && t.inputSchema.type === 'object' && t.annotations.readOnlyHint)).toBe(true);
  });

  test('tools/call runs AS the token user through the normal API, and is audited', async () => {
    const r = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_trial_balance',
      arguments: { company_id: 51, from_date: '2026-03-01', to_date: '2026-03-31' } } });
    expect(r.body.result.isError).toBeUndefined();
    expect(JSON.parse(r.body.result.content[0].text).accounts[0].code).toBe('1000');
    expect(calls).toEqual([['GET', '/api/accounting/reports/trial-balance?fromDate=2026-03-01&toDate=2026-03-31', 10, 51]]);
    await new Promise(r2 => setTimeout(r2, 20));
    expect(mockDb.audit_log[0]).toMatchObject({ user_id: 10, module: 'mcp', action_type: 'MCP_TOOL_CALL', entity_id: 'get_trial_balance', company_id: 51 });
  });

  test('Leo refuses → tool error the bot can read (rights come from the user, not the bot)', async () => {
    apiBehaviour = 'forbidden';
    const r = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_bank_accounts', arguments: { company_id: 99 } } });
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/Not allowed for this user/);
  });

  test('bad arguments and unknown tools/methods', async () => {
    const a = await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_trial_balance', arguments: { company_id: 51 } } });
    expect(a.body.result.isError).toBe(true);
    const b = await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } });
    expect(b.body.error.code).toBe(-32602);
    const c = await post({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
    expect(c.body.error.code).toBe(-32601);
    expect(calls).toEqual([]);
  });

  test('structuredContent only for protocol 2025-06-18', async () => {
    const call = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_companies', arguments: {} } };
    const old = await post(call, token, { 'mcp-protocol-version': '2025-03-26' });
    const neu = await post(call, token, { 'mcp-protocol-version': '2025-06-18' });
    expect(old.body.result.structuredContent).toBeUndefined();
    expect(neu.body.result.structuredContent.companies[0].id).toBe(51);
  });

  test('GET is not supported (stateless server)', async () => {
    const r = await fetch(base, { headers: { Authorization: 'Bearer ' + token } });
    expect(r.status).toBe(405);
  });
});

describe('MCP fair-use over HTTP', () => {
  let server, base, token;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/mcp', createMcpRouter({
      isEnabled: () => true, killSwitchOn: async () => false,
      api: { async listCompanies() { return []; }, async request() { return {}; } },
      limiter: createLimiter({ MCP_RATE_USER_PER_MIN: '1', MCP_RATE_USER_BURST: '1' })
    }));
    await new Promise(r => { server = app.listen(0, r); });
    base = 'http://127.0.0.1:' + server.address().port + '/mcp';
  });
  afterAll(() => new Promise(r => server.close(r)));

  test('over the limit → tool error with a wait time (never a crash)', async () => {
    reset();
    token = (await ApiTokens.createToken(supabase(), 10, { name: 'Grok' })).token;
    const call = () => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_companies', arguments: {} } }) });
    const first = await (await call()).json();
    const secondRes = await call();
    const second = await secondRes.json();
    expect(first.result.isError).toBeUndefined();
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0].text).toMatch(/Fair-use limit reached \(per bot\)/);
    expect(Number(secondRes.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('Codebox 3 controls', () => {
  test('MCP switched off (env) or kill switch on → 503 before authentication', async () => {
    const mk = (isEnabled, kill) => {
      const app = express(); app.use(express.json());
      app.use('/mcp', createMcpRouter({ isEnabled, killSwitchOn: async () => kill, api: {} }));
      return app;
    };
    for (const [enabled, kill] of [[false, false], [true, true]]) {
      const server = await new Promise(r => { const s = mk(() => enabled, kill).listen(0, () => r(s)); });
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/mcp', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      const body = await res.json();
      await new Promise(r => server.close(r));
      expect(res.status).toBe(503);
      expect(body.error.message).toMatch(/switched off/);
    }
  });

  test('kill switch reads the feature flag and caches it', async () => {
    reset();
    mockDb.feature_flags = [{ id: 1, flag_key: 'mcp_kill_switch', is_active: true }];
    const { createKillSwitch } = require('../modules/mcp');
    expect(await createKillSwitch(supabase())()).toBe(true);
    mockDb.feature_flags[0].is_active = false;
    expect(await createKillSwitch(supabase())()).toBe(false);
  });

  test('platform admin accounts never get a working key', async () => {
    reset();
    mockDb.users.push({ id: 12, username: 'sa', email: 'sa@example.test', full_name: 'SA', is_super_admin: true, is_active: true });
    mockDb.users.push({ id: 13, username: 'ga', email: 'antonjvr@lorenco.co.za', full_name: 'GA', is_super_admin: false, is_active: true });
    expect(ApiTokens.isPlatformAdmin({ is_super_admin: true })).toBe(true);
    expect(ApiTokens.isPlatformAdmin({ email: 'ANTONJVR@lorenco.co.za' })).toBe(true);
    expect(ApiTokens.isPlatformAdmin({ email: 'owner@practice.test', is_super_admin: false })).toBe(false);
    const sa = await ApiTokens.createToken(supabase(), 12, { name: 'x' });
    const ga = await ApiTokens.createToken(supabase(), 13, { name: 'x' });
    expect(await ApiTokens.resolveToken(supabase(), sa.token)).toBeNull();
    expect(await ApiTokens.resolveToken(supabase(), ga.token)).toBeNull();
  });

  describe('lorencoApi guards (no network: fetch is stubbed)', () => {
    const { createClient } = require('../modules/mcp/lorencoApi');
    const realFetch = global.fetch;
    let seen;
    beforeEach(() => {
      process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
      seen = [];
      global.fetch = async (url, opts) => {
        seen.push([opts.method, url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')]);
        const body = url.endsWith('/api/auth/companies') ? { companies: [{ id: 51 }] }
          : url.endsWith('/api/auth/select-company') ? { token: 'company-jwt' } : { ok: 1 };
        return { status: 200, ok: true, json: async () => body };
      };
    });
    afterAll(() => { global.fetch = realFetch; });
    const ctx = { user: { id: 10, email: 'bot@example.test' }, tokenId: 1 };

    test('read-only: any non-GET is refused before anything is sent', async () => {
      const c = createClient();
      await expect(c.request(ctx, 51, 'POST', '/api/accounting/journals', {})).rejects.toMatchObject({ status: 403 });
      await expect(c.request(ctx, 51, 'DELETE', '/api/accounting/bank/transactions/1')).rejects.toMatchObject({ status: 403 });
      expect(seen).toEqual([]);
    });

    test('a company outside the user\'s own list is refused before select-company is tried', async () => {
      const c = createClient();
      await expect(c.request(ctx, 7, 'GET', '/api/accounting/reports/trial-balance')).rejects.toMatchObject({ status: 403 });
      expect(seen.map(s => s[1])).toEqual(['/api/auth/companies']);
    });

    test('an allowed company goes through select-company, then the GET', async () => {
      const c = createClient();
      await c.request(ctx, 51, 'GET', '/api/accounting/reports/trial-balance?fromDate=2026-03-01&toDate=2026-03-31');
      expect(seen.map(s => s.join(' '))).toEqual([
        'GET /api/auth/companies', 'POST /api/auth/select-company',
        'GET /api/accounting/reports/trial-balance?fromDate=2026-03-01&toDate=2026-03-31']);
    });
  });
});
