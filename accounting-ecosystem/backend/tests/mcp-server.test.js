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
    [{ company_id: 'abc', start_date: '2026-03-01', end_date: '2026-03-31' }, 'company_id must be a whole number'],
    [{ company_id: 51, start_date: '1 March', end_date: '2026-03-31' }, 'start_date must look like YYYY-MM-DD'],
    [{ company_id: 51, start_date: '2026-03-01', end_date: '2026-03-31', drop: 1 }, 'unknown argument: drop'],
    [{ company_id: 51, start_date: '2026-03-01', end_date: '2026-03-31' }, null]
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

  test('tools/list: read tools + bank write tools, each marked correctly', async () => {
    const r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = r.body.result.tools;
    const write = tools.filter(t => !t.annotations.readOnlyHint).map(t => t.name).sort();
    expect(write).toEqual(['allocate_bank_transaction', 'confirm_staged_transactions', 'create_account', 'create_allocation_rule',
      'create_bank_account', 'create_customer', 'create_customer_invoice', 'create_journal', 'create_supplier', 'create_supplier_invoice',
      'create_vat_code', 'flag_for_review', 'import_bank_statement_pdf', 'leo_request', 'post_customer_invoice', 'reconcile_bank_transactions',
      'reject_staged_transaction', 'sean_auto_allocate', 'stage_bank_transactions']);
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['ping', 'list_companies', 'get_trial_balance',
      'list_accounts', 'list_vat_settings', 'list_bank_transactions', 'get_sean_suggestions', 'list_bot_decisions', 'get_bot_policy']));
    expect(tools.every(t => t.inputSchema && t.inputSchema.type === 'object')).toBe(true);
    expect(tools.filter(t => !t.annotations.readOnlyHint).every(t => t.annotations.destructiveHint === false)).toBe(true);
  });

  test('tools/call runs AS the token user through the normal API, and is audited', async () => {
    const r = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_trial_balance',
      arguments: { company_id: 51, from_date: '2026-03-01', to_date: '2026-03-31' } } });   // phase-1 names still accepted
    expect(r.body.result.isError).toBeUndefined();
    expect(JSON.parse(r.body.result.content[0].text).accounts[0].code).toBe('1000');
    expect(calls).toEqual([['GET', '/api/accounting/reports/trial-balance?fromDate=2026-03-01&toDate=2026-03-31', 10, 51]]);
    await new Promise(r2 => setTimeout(r2, 20));
    expect(mockDb.audit_log[0]).toMatchObject({ user_id: 10, module: 'mcp', action_type: 'MCP_TOOL_CALL', entity_id: 'get_trial_balance', company_id: 51 });
    expect(mockDb.audit_log[0].metadata).toMatchObject({ ok: true, error_category: null, channel: 'mcp' });
    expect(mockDb.audit_log[0].metadata.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(mockDb.audit_log[0])).not.toMatch(/accounts|lnc_/);   // no payload, no token
  });

  test('failed calls are audited with a safe error category; start after end is refused', async () => {
    apiBehaviour = 'forbidden';
    await post({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'list_bank_accounts', arguments: { company_id: 99 } } });
    apiBehaviour = 'ok';
    const r = await post({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'get_trial_balance',
      arguments: { company_id: 51, start_date: '2026-04-01', end_date: '2026-03-01' } } });
    expect(r.body.result.isError).toBe(true);
    await new Promise(r2 => setTimeout(r2, 20));
    expect(mockDb.audit_log.map(a => a.metadata.error_category)).toEqual(['forbidden', 'invalid_arguments']);
    expect(calls.filter(c => c[0] === 'GET')).toHaveLength(1);   // the reversed range never reached Leo
  });

  test('the audit never stores a PDF or long lists — only ids, sizes and counts', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7 '), Buffer.alloc(4000, 32)]).toString('base64');
    await post({ jsonrpc: '2.0', id: 45, method: 'tools/call', params: { name: 'import_bank_statement_pdf',
      arguments: { company_id: 51, bank_account_id: 5, pdf_base64: pdf } } });
    await post({ jsonrpc: '2.0', id: 46, method: 'tools/call', params: { name: 'stage_bank_transactions',
      arguments: { company_id: 51, bank_account_id: 5, transactions: [{ date: '2026-10-01', description: 'SALARY ACME', amount: 100 }] } } });
    await new Promise(r2 => setTimeout(r2, 20));
    const [a1, a2] = mockDb.audit_log.map(a => a.metadata);
    expect(a1.args.pdf_base64).toMatch(/^.pdf [0-9]+ KB.$/);
    expect(a1.write).toBe(true);
    expect(a2.args.transactions).toBe('[1 items]');
    expect(JSON.stringify(mockDb.audit_log)).not.toMatch(/SALARY|JVBERi/);
  });

  test('prohibited capabilities do not exist as tools and fail closed', async () => {
    const list = (await post({ jsonrpc: '2.0', id: 43, method: 'tools/list' })).body.result.tools.map(t => t.name).join(' ');
    expect(list).not.toMatch(/sars|submit|pay|close|reopen|approve|delete|permission|role|email|send/i);
    for (const name of ['submit_sars_return', 'make_bank_payment', 'close_period', 'reopen_period', 'approve_financial_statements',
      'delete_journal', 'set_my_permissions', 'email_client']) {
      const r = await post({ jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name, arguments: { company_id: 51 } } });
      expect(r.body.error.code).toBe(-32602);
    }
    expect(calls).toEqual([]);
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

    test('everything in Ledger Leo is allowed; other apps and the hard-block list are refused before anything is sent', async () => {
      const c = createClient();
      for (const [m, p] of [['PUT', '/api/users/45'], ['POST', '/api/payroll/payruns'], ['GET', '/api/payroll/employees'],
        ['GET', '/api/pos/sales'], ['POST', '/api/accounting/bank/transactions/1/allocate/../../../journals'],
        ['PUT', '/api/accounting/bank/sean-settings'], ['POST', '/api/accounting/customer-invoices/12/send'],
        ['POST', '/api/accounting/vat-recon/periods/3/submit'], ['GET', '/api/accounting/paye/config'],
        ['POST', '/api/accounting/bot-decisions/5/approve'], ['DELETE', '/api/accounting/company/51'],
        ['POST', '/api/accounting/integrations'], ['TRACE', '/api/accounting/accounts']]) {
        await expect(c.request(ctx, 51, m, p, {})).rejects.toMatchObject({ status: 403 });
      }
      expect(seen).toEqual([]);
      const { isAllowedCall, blockReason } = require('../modules/mcp/lorencoApi');
      // normal accountant work: edit, delete, void, payments, journals, periods, year-end
      for (const [m, p] of [['POST', '/api/accounting/journals'], ['POST', '/api/accounting/journals/4/reverse'],
        ['DELETE', '/api/accounting/bank/transactions/1'], ['DELETE', '/api/accounting/bank/transactions/1/allocate'],
        ['POST', '/api/accounting/periods/3/lock'], ['POST', '/api/accounting/periods/3/unlock'], ['POST', '/api/accounting/year-end/close'],
        ['PUT', '/api/accounting/accounts/3'], ['DELETE', '/api/accounting/accounts/3'], ['POST', '/api/accounting/vat-settings'],
        ['POST', '/api/accounting/customer-invoices/12/void'], ['PUT', '/api/accounting/customer-invoices/12'],
        ['POST', '/api/accounting/customer-invoices/payments'], ['POST', '/api/accounting/suppliers/payments'],
        ['POST', '/api/accounting/credit-notes'], ['POST', '/api/accounting/quotes'], ['PUT', '/api/accounting/pos/customers/3'],
        ['POST', '/api/accounting/bot-decisions/allocate'], ['PATCH', '/api/accounting/bank/staging/9/reject']]) {
        expect([m, p, blockReason(m, p)]).toEqual([m, p, null]);
      }
      // still closed
      expect(isAllowedCall('POST', '/api/accounting/bank/transactions/12/allocate')).toBe(false);   // only via the decision rules
      expect(isAllowedCall('PUT', '/api/accounting/bank/transactions/transfer')).toBe(false);
      expect(isAllowedCall('POST', '/api/accounting/bank/staging/transfers/2/confirm')).toBe(false);
      expect(isAllowedCall('POST', '/api/accounting/quotes/3/send')).toBe(false);
      expect(isAllowedCall('POST', '/api/accounting/customer-statements/3/statement/send')).toBe(false);
      expect(isAllowedCall('POST', '/api/accounting/customer-invoices/recurring-plans/run')).toBe(false);
      expect(isAllowedCall('POST', '/api/accounting/customer-invoices/12/billing-choice')).toBe(false);
      expect(isAllowedCall('PUT', '/api/accounting/employees')).toBe(false);
      expect(isAllowedCall('POST', '/api/accounting/pos/gl-sync/generate-invoice')).toBe(false);
      expect(isAllowedCall('PUT', '/api/accounting/kv/x')).toBe(false);
      expect(isAllowedCall('PUT', '/api/accounting/ai/settings')).toBe(false);
      expect(isAllowedCall('POST', '/api/accounting/ai/actions/3/approve')).toBe(false);
      expect(isAllowedCall('GET', '/api/accounting/%2e%2e/users')).toBe(false);
      expect(isAllowedCall('GET', '/api/accounting/reports/trial-balance?fromDate=2026-03-01')).toBe(true);
    });

    test('an allowed write goes through select-company, then the POST with a JSON body', async () => {
      const c = createClient();
      await c.request(ctx, 51, 'POST', '/api/accounting/bank/staging/confirm', { stagingIds: [1] });
      expect(seen.map(s => s.join(' '))).toEqual(['GET /api/auth/companies', 'POST /api/auth/select-company',
        'POST /api/accounting/bank/staging/confirm']);
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

describe('Phase 2 — bank write tools (fake Leo API)', () => {
  const { TOOLS: T, validateArgs: V } = require('../modules/mcp/tools');
  const tool = (n) => T.find(t => t.name === n);
  const ctx = { user: { id: 45 }, tokenId: 1 };
  let calls, replies;
  const api = { async request(c, cid, method, path, body) {
    calls.push({ method, path: path.split('?')[0], query: path.split('?')[1] || '', body, cid });
    const key = method + ' ' + path.split('?')[0];
    const r = typeof replies[key] === 'function' ? replies[key](path, body) : replies[key];
    if (r instanceof Error) throw r;
    return r === undefined ? {} : r;
  } };
  beforeEach(() => { calls = []; replies = {}; });

  test('nested argument checks for lists of lines', () => {
    const s = tool('allocate_bank_transaction').inputSchema;
    expect(V(s, { company_id: 51, transaction_id: 1, reason: 'Fibre account', lines: [] })).toBe('lines needs at least 1 item(s)');
    expect(V(s, { company_id: 51, transaction_id: 1, reason: 'Fibre account', lines: [{ amount: 5 }] })).toBe('lines[0].account_id is required');
    expect(V(s, { company_id: 51, transaction_id: 1, reason: 'Fibre account', lines: [{ account_id: 3, amount: 'x' }] })).toBe('lines[0].amount must be a number');
    expect(V(s, { company_id: 51, transaction_id: 1, reason: 'Fibre account', lines: [{ account_id: 3, amount: 0 }] })).toBe('lines[0].amount must be at least 0.01');
    expect(V(s, { company_id: 51, transaction_id: 1, reason: 'Fibre account', lines: [{ account_id: 3, amount: 5, hack: 1 }] })).toBe('unknown argument: lines[0].hack');
    expect(V(s, { company_id: 51, transaction_id: 1, reason: 'Fibre account', lines: [{ account_id: 3, amount: 5, vat_inclusive: 'no' }] })).toBe('lines[0].vat_inclusive must be true or false');
    expect(V(s, { company_id: 51, transaction_id: 1, reason: 'Fibre account', lines: [{ account_id: 3, amount: 114.99, vat_setting_id: 2 }] })).toBeNull();
    expect(V(tool('create_allocation_rule').inputSchema, { company_id: 51, match_pattern: 'x', account_id: 1, match_type: 'regex' }))
      .toBe('match_type must be one of: contains, starts_with, exact');
  });

  test('allocate goes through the bot decision route with reason and evidence', async () => {
    await tool('allocate_bank_transaction').run(api, Object.assign({ correlationId: 'c-1' }, ctx), { company_id: 51, transaction_id: 77,
      lines: [{ account_id: 3, amount: 100.004, vat_setting_id: 2 }, { account_id: 4, amount: 15, vat_inclusive: false, description: 'fee' }],
      reason: 'Monthly fibre account', decision_source: 'sean' });
    expect(calls).toEqual([{ method: 'POST', path: '/api/accounting/bot-decisions/allocate', query: '', cid: 51, body: {
      bankTransactionId: 77,
      lines: [{ accountId: 3, amount: 100, vatSettingId: 2 }, { accountId: 4, amount: 15, vatInclusive: false, description: 'fee' }],
      reason: 'Monthly fibre account', decisionSource: 'sean', disagreementReason: undefined, evidence: undefined,
      description: undefined, correlationId: 'c-1' } }]);
    expect(V(tool('allocate_bank_transaction').inputSchema, { company_id: 51, transaction_id: 1, lines: [{ account_id: 3, amount: 5 }] }))
      .toBe('reason is required');
  });

  test('key policy: rules, reconcile-with-difference and Sean auto are off unless a person allowed them', async () => {
    const off = Object.assign({ policy: {} }, ctx);
    await expect(tool('create_allocation_rule').run(api, off, { company_id: 51, match_pattern: 'X', account_id: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(tool('sean_auto_allocate').run(api, off, { company_id: 51 })).rejects.toMatchObject({ status: 403 });
    await expect(tool('reconcile_bank_transactions').run(api, off, { company_id: 51, bank_account_id: 5, transaction_ids: [1],
      statement_date: '2026-10-31', statement_closing_balance: 1, allow_difference: true })).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
    const on = Object.assign({ policy: { allow_create_rules: true, allow_sean_auto: true } }, ctx);
    await tool('create_allocation_rule').run(api, on, { company_id: 51, match_pattern: 'X', account_id: 1 });
    await tool('sean_auto_allocate').run(api, on, { company_id: 51 });
    expect(calls.map(c => c.path)).toEqual(['/api/accounting/bank/rules', '/api/accounting/bank/sean-auto-allocate']);
  });

  test('PDF import: Leo parses, then stages as source pdf with the file hash', async () => {
    replies['POST /api/accounting/bank/import/pdf'] = { bank: 'ABSA', parserConfidence: 0.97, fileHash: 'h1',
      transactions: [{ date: '2026-10-01', description: 'FEE', amount: -10 }], batchDuplicateWarning: null };
    replies['POST /api/accounting/bank/import'] = { batchId: 'b1', staged: 1, skipped: 0, duplicatesSuspected: 0, transfersDetected: 0, message: 'ok' };
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)]).toString('base64');
    const out = await tool('import_bank_statement_pdf').run(api, ctx, { company_id: 51, bank_account_id: 5, pdf_base64: pdf, filename: 'oct.pdf' });
    expect(calls[0].body).toBeInstanceOf(FormData);
    expect(calls[0].body.get('bankAccountId')).toBe('5');
    expect(calls[1].body).toEqual({ bankAccountId: 5, transactions: [{ date: '2026-10-01', description: 'FEE', amount: -10 }], importSource: 'pdf', fileHash: 'h1' });
    expect(out).toMatchObject({ bank: 'ABSA', batch_id: 'b1', staged: 1 });
  });

  test('PDF import: not a PDF → refused; same file again → nothing staged', async () => {
    await expect(tool('import_bank_statement_pdf').run(api, ctx, { company_id: 51, bank_account_id: 5,
      pdf_base64: Buffer.from('hello world'.repeat(20)).toString('base64') })).rejects.toMatchObject({ status: 400 });
    replies['POST /api/accounting/bank/import/pdf'] = { fileHash: 'h1', transactions: [{ date: '2026-10-01', description: 'X', amount: 1 }],
      batchDuplicateWarning: { existingBatchId: 'old' } };
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32)]).toString('base64');
    const out = await tool('import_bank_statement_pdf').run(api, ctx, { company_id: 51, bank_account_id: 5, pdf_base64: pdf });
    expect(out.staged).toBe(0);
    expect(calls.map(c => c.path)).toEqual(['/api/accounting/bank/import/pdf']);
  });

  const reconSetup = () => {
    replies['GET /api/accounting/bank/accounts'] = { bankAccounts: [{ id: 5, opening_balance: '1000.00' }] };
    replies['GET /api/accounting/bank/transactions'] = (path) => path.includes('status=reconciled')
      ? { transactions: [{ id: 1, amount: '200' }] }
      : { transactions: [{ id: 10, amount: '-150.50' }, { id: 11, amount: '75.25' }] };
  };

  test('reconcile: cleared balance like the recon screen; a difference → nothing reconciled', async () => {
    reconSetup();
    const out = await tool('reconcile_bank_transactions').run(api, ctx, { company_id: 51, bank_account_id: 5,
      transaction_ids: [10, 11], statement_date: '2026-10-31', statement_closing_balance: 1100 });
    expect(out).toMatchObject({ book_opening_balance: 1200, selected_total: -75.25, cleared_balance: 1124.75, difference: -24.75, reconciled: false });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  test('reconcile: balances → posts Leo\'s reconcile with the same figures', async () => {
    reconSetup();
    const out = await tool('reconcile_bank_transactions').run(api, ctx, { company_id: 51, bank_account_id: 5,
      transaction_ids: [10, 11, 10], statement_date: '2026-10-31', statement_closing_balance: 1124.75 });
    expect(out.reconciled).toBe(true);
    expect(calls.find(c => c.method === 'POST')).toMatchObject({ path: '/api/accounting/bank/reconcile', body: {
      transactionIds: [10, 11], bankAccountId: 5, statementDate: '2026-10-31', statementClosingBalance: 1124.75, clearedBalance: 1124.75 } });
  });

  test('reconcile: ids that are not allocated lines on this account → refused', async () => {
    reconSetup();
    await expect(tool('reconcile_bank_transactions').run(api, ctx, { company_id: 51, bank_account_id: 5,
      transaction_ids: [10, 999], statement_date: '2026-10-31', statement_closing_balance: 0 })).rejects.toMatchObject({ status: 422 });
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  test('confirm, reject, rule, Sean suggestions map to the screen routes', async () => {
    replies['POST /api/accounting/bank/staging/confirm'] = { confirmed: [{ id: 501 }], skipped: [], seanAutoAllocate: false };
    const c = await tool('confirm_staged_transactions').run(api, ctx, { company_id: 51, staging_ids: [9] });
    expect(c).toMatchObject({ confirmed: 1, confirmed_transaction_ids: [501] });
    await tool('reject_staged_transaction').run(api, ctx, { company_id: 51, staging_id: 9 });
    await tool('create_allocation_rule').run(api, Object.assign({ policy: { allow_create_rules: true } }, ctx), { company_id: 51, match_pattern: 'ENGEN', account_id: 8 });
    await tool('get_sean_suggestions').run(api, ctx, { company_id: 51, transaction_ids: [501] });
    expect(calls.map(c2 => c2.method + ' ' + c2.path)).toEqual(['POST /api/accounting/bank/staging/confirm',
      'PATCH /api/accounting/bank/staging/9/reject', 'POST /api/accounting/bank/rules', 'POST /api/accounting/bank/sean-suggestions']);
    expect(calls[2].body).toMatchObject({ matchPattern: 'ENGEN', matchType: 'contains', accountId: 8, priority: 100 });
  });
});

describe('Setup tools — accounts, bank accounts, customers, suppliers (fake Leo API)', () => {
  const { TOOLS: T, validateArgs: V } = require('../modules/mcp/tools');
  const tool = (n) => T.find(t => t.name === n);
  const ctx = { user: { id: 46 }, tokenId: 9, policy: {} };
  let calls, replies;
  const api = { async request(c, cid, method, path, body) {
    calls.push({ method, path: path.split('?')[0], body });
    const r = replies[method + ' ' + path.split('?')[0]];
    if (r instanceof Error) throw r;
    return r === undefined ? {} : r;
  } };
  beforeEach(() => { calls = []; replies = {}; });

  test('every setup tool needs a reason; account type and last-4 digits are checked', () => {
    expect(V(tool('create_account').inputSchema, { company_id: 2, code: '6250', name: 'Courier', type: 'expense' })).toMatch(/reason/);
    expect(V(tool('create_account').inputSchema, { company_id: 2, code: '6250', name: 'Courier', type: 'cost', reason: 'x' })).toMatch(/type/);
    const b = { company_id: 2, name: 'FNB', bank_name: 'FNB', ledger_account_id: 5, opening_balance: 10, opening_balance_date: '2026-03-01', reason: 'statement' };
    expect(V(tool('create_bank_account').inputSchema, { ...b, account_last4: '62000000917' })).toMatch(/account_last4/);
    expect(V(tool('create_bank_account').inputSchema, { ...b, account_last4: '0917' })).toBeNull();
    expect(V(tool('create_supplier').inputSchema, { company_id: 2, name: 'X', reason: 'r', bank_account: '123' })).toMatch(/unknown argument/);
  });

  test('create_account posts to the chart of accounts', async () => {
    replies['POST /api/accounting/accounts'] = { id: 99, code: '6250', name: 'Courier', type: 'expense' };
    const out = await tool('create_account').run(api, ctx, { company_id: 2, code: '6250', name: ' Courier ', type: 'expense', reason: 'courier debit orders' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/accounting/accounts', body: { code: '6250', name: 'Courier', type: 'expense' } });
    expect(out).toMatchObject({ created: true, account: { id: 99 } });
  });

  test('create_bank_account stores only the last 4 digits, needs a bank/cash ledger and refuses duplicates', async () => {
    replies['GET /api/accounting/bank/accounts'] = { bankAccounts: [{ id: 1, name: 'ABSA Cheque', account_number_masked: '****1111' }] };
    replies['GET /api/accounting/accounts'] = { accounts: [{ id: 5, code: '1010', name: 'Bank', type: 'asset', sub_type: 'bank' },
      { id: 6, code: '6200', name: 'Telephone', type: 'expense' }] };
    replies['POST /api/accounting/bank/accounts'] = { id: 2, name: 'FNB Cheque', account_number_masked: '****0917', ledger_account_id: 5 };
    const a = { company_id: 2, name: 'FNB Cheque', bank_name: 'FNB', account_last4: '0917', ledger_account_id: 5,
      opening_balance: '1234.567', opening_balance_date: '2026-03-01', reason: 'statement Mar 2026' };
    await tool('create_bank_account').run(api, ctx, a);
    const post = calls.find(c => c.method === 'POST');
    expect(post.body).toMatchObject({ accountNumberMasked: '****0917', ledgerAccountId: 5, openingBalance: 1234.57, currency: 'ZAR' });
    calls = [];
    await expect(tool('create_bank_account').run(api, ctx, { ...a, account_last4: '1111', name: 'Other' })).rejects.toMatchObject({ status: 409 });
    await expect(tool('create_bank_account').run(api, ctx, { ...a, name: 'absa cheque ', account_last4: '2222' })).rejects.toMatchObject({ status: 409 });
    await expect(tool('create_bank_account').run(api, ctx, { ...a, ledger_account_id: 6 })).rejects.toMatchObject({ status: 400 });
    await expect(tool('create_bank_account').run(api, ctx, { ...a, ledger_account_id: 77 })).rejects.toMatchObject({ status: 400 });
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);
  });

  test('create_customer and create_supplier refuse a same-name duplicate (any capitals) and otherwise create', async () => {
    replies['GET /api/accounting/customer-invoices/customers'] = { customers: [{ id: 3, name: 'Acme Trading' }] };
    replies['POST /api/accounting/pos/customers'] = { customer: { id: 4, name: 'Beta Foods' } };
    await expect(tool('create_customer').run(api, ctx, { company_id: 2, name: 'ACME trading ', reason: 'r' })).rejects.toMatchObject({ status: 409 });
    const c = await tool('create_customer').run(api, ctx, { company_id: 2, name: 'Beta Foods', vat_number: '4123', reason: 'receipt on statement' });
    expect(c).toMatchObject({ created: true, customer: { id: 4 } });
    expect(calls.find(x => x.method === 'POST').body).toMatchObject({ name: 'Beta Foods', tax_reference: '4123', is_active: true });

    calls = [];
    replies['GET /api/accounting/suppliers'] = { suppliers: [{ id: 8, name: 'Vodacom', supplier_code: 'SUP001' }] };
    replies['POST /api/accounting/suppliers'] = { supplier: { id: 9, name: 'Engen Garage', supplier_code: 'SUP002' } };
    await expect(tool('create_supplier').run(api, ctx, { company_id: 2, name: 'vodacom', reason: 'r' })).rejects.toMatchObject({ status: 409 });
    const s = await tool('create_supplier').run(api, ctx, { company_id: 2, name: 'Engen Garage', reason: 'fuel on statement' });
    expect(s).toMatchObject({ created: true, supplier: { id: 9, code: 'SUP002' } });
    const body = calls.find(x => x.method === 'POST').body;
    expect(body).toMatchObject({ name: 'Engen Garage', type: 'company', paymentTerms: 30 });
    expect(Object.keys(body).some(k => /bank/i.test(k))).toBe(false);   // a bot never sets supplier bank details
  });
});

describe('Invoice tools (fake Leo API)', () => {
  const { TOOLS: T, validateArgs: V } = require('../modules/mcp/tools');
  const tool = (n) => T.find(t => t.name === n);
  const ctx = { user: { id: 46 }, tokenId: 9, policy: {} };
  let calls, replies;
  const api = { async request(c, cid, method, path, body) {
    calls.push({ method, path: path.split('?')[0], body });
    const r = replies[method + ' ' + path.split('?')[0]];
    if (typeof r === 'function') return r(body);
    if (r instanceof Error) throw r;
    return r === undefined ? {} : r;
  } };
  beforeEach(() => {
    calls = [];
    replies = {
      'GET /api/accounting/accounts': { accounts: [{ id: 1, code: '4000', name: 'Sales', type: 'income' },
        { id: 2, code: '6200', name: 'Telephone', type: 'expense' }, { id: 3, code: '1010', name: 'Bank', type: 'asset', sub_type: 'bank' },
        { id: 4, code: '5000', name: 'Header', type: 'expense', is_postable: false }] },
      'GET /api/accounting/vat-settings': { vatSettings: [{ id: 1, code: 'STD', rate: 15 }] }
    };
  });
  const line = (o = {}) => Object.assign({ description: 'Consulting', account_id: 1, quantity: 1, unit_price: 1000, vat_rate: 15 }, o);

  test('schemas: reason and VAT rate per line required; supplier invoice number required', () => {
    expect(V(tool('create_customer_invoice').inputSchema, { company_id: 51, customer_id: 1, invoice_date: '2026-11-01', lines: [line()] })).toMatch(/reason/);
    const { vat_rate: _vat, ...noVat } = line();
    expect(V(tool('create_customer_invoice').inputSchema, { company_id: 51, customer_id: 1, invoice_date: '2026-11-01', lines: [noVat], reason: 'r' })).toMatch(/vat_rate/);
    expect(V(tool('create_supplier_invoice').inputSchema, { company_id: 51, supplier_id: 1, invoice_date: '2026-11-01', lines: [line({ account_id: 2 })], reason: 'r' })).toMatch(/invoice_number/);
    expect(V(tool('create_customer_invoice').inputSchema, { company_id: 51, customer_name: 'X', customer_id: 1, invoice_date: '2026-11-01', lines: [line()], reason: 'r' })).toMatch(/unknown argument/);
  });

  test('customer invoice: draft by default, posted with post:true, never sent', async () => {
    replies['POST /api/accounting/customer-invoices'] = { invoice: { id: 7, invoice_number: 'INV-0007', total_amount: 1150, status: 'draft' } };
    const draft = await tool('create_customer_invoice').run(api, ctx, { company_id: 51, customer_id: 5, invoice_date: '2026-11-01', lines: [line()], reason: 'r' });
    expect(draft).toMatchObject({ created: true, posted: false, invoice: { id: 7 } });
    expect(calls.find(c => c.method === 'POST').body).toMatchObject({ customerId: 5, lines: [{ accountId: 1, lineType: 'account', vatRate: 15 }] });
    expect(calls.find(c => c.method === 'POST').body.customerName).toBeUndefined();
    calls = [];
    const posted = await tool('create_customer_invoice').run(api, ctx, { company_id: 51, customer_id: 5, invoice_date: '2026-11-01', lines: [line()], post: true, reason: 'r' });
    expect(posted).toMatchObject({ posted: true, invoice: { status: 'sent' } });
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/api/accounting/customer-invoices', '/api/accounting/customer-invoices/7/post']);
    expect(calls.some(c => /send/.test(c.path))).toBe(false);
  });

  test('a failed post keeps the draft id so the bot does not create it twice', async () => {
    replies['POST /api/accounting/customer-invoices'] = { invoice: { id: 8, invoice_number: 'INV-0008', status: 'draft' } };
    replies['POST /api/accounting/customer-invoices/8/post'] = new Error('Sales account missing');
    const out = await tool('create_customer_invoice').run(api, ctx, { company_id: 51, customer_id: 5, invoice_date: '2026-11-01', lines: [line()], post: true, reason: 'r' });
    expect(out).toMatchObject({ created: true, posted: false, post_error: 'Sales account missing' });
    expect(out.note_draft).toMatch(/draft id 8/);
  });

  test('lines are checked before anything is posted: own postable account, not bank, income for sales, known VAT rate', async () => {
    const run = (n, l, extra = {}) => tool(n).run(api, ctx, Object.assign({ company_id: 51, customer_id: 5, supplier_id: 5, invoice_number: 'A1',
      invoice_date: '2026-11-01', lines: [l], reason: 'r' }, extra));
    await expect(run('create_customer_invoice', line({ account_id: 99 }))).rejects.toMatchObject({ status: 400 });
    await expect(run('create_customer_invoice', line({ account_id: 3 }))).rejects.toThrow(/bank\/cash/);
    await expect(run('create_customer_invoice', line({ account_id: 2 }))).rejects.toThrow(/not an income account/);
    await expect(run('create_supplier_invoice', line({ account_id: 4 }))).rejects.toThrow(/header/);
    await expect(run('create_supplier_invoice', line({ account_id: 2, vat_rate: 14 }))).rejects.toThrow(/VAT rate 14%/);
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);
  });

  test('supplier invoice posts with the supplier\'s own number', async () => {
    replies['POST /api/accounting/suppliers/invoices'] = { invoice: { id: 11, invoice_number: 'VC-123', total_amount: 230, status: 'unpaid' } };
    const out = await tool('create_supplier_invoice').run(api, ctx, { company_id: 51, supplier_id: 5, invoice_number: ' VC-123 ',
      invoice_date: '2026-11-01', vat_inclusive: true, lines: [line({ account_id: 2, unit_price: 230 })], reason: 'Vodacom invoice VC-123' });
    expect(out).toMatchObject({ created: true, posted: true, invoice: { id: 11, invoice_number: 'VC-123' } });
    expect(calls.find(c => c.method === 'POST').body).toMatchObject({ supplierId: 5, invoiceNumber: 'VC-123', vatInclusive: true });
  });
});

describe('Full Ledger Leo access — VAT codes, journals, reports, leo_routes / leo_request (fake Leo API)', () => {
  const { TOOLS: T, validateArgs: V } = require('../modules/mcp/tools');
  const tool = (n) => T.find(t => t.name === n);
  let calls, replies;
  const ctxOf = (policy) => ({ user: { id: 45 }, tokenId: 1, correlationId: 'c-1', policy: policy || {} });
  const api = { async request(c, cid, method, path, body) {
    calls.push({ method, path, body, cid });
    const key = method + ' ' + path.split('?')[0];
    const r = typeof replies[key] === 'function' ? replies[key](path, body) : replies[key];
    if (r instanceof Error) throw r;
    return r === undefined ? {} : r;
  } };
  beforeEach(() => { calls = []; replies = {}; });

  test('create_vat_code posts the VAT setting', async () => {
    replies['POST /api/accounting/vat-settings'] = { vatSetting: { id: 9 } };
    const out = await tool('create_vat_code').run(api, ctxOf(), { company_id: 51, code: 'std', name: 'Standard 15%', rate: 15, reason: 'new client' });
    expect(out).toEqual({ vatSetting: { id: 9 } });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/accounting/vat-settings', cid: 51,
      body: { code: 'std', name: 'Standard 15%', rate: 15, is_capital: false } });
  });

  test('create_journal: refuses unbalanced or two-sided lines, creates + posts a balanced one', async () => {
    const t = tool('create_journal');
    const base = { company_id: 51, date: '2026-03-31', description: 'Depreciation', reason: 'month-end' };
    await expect(t.run(api, ctxOf(), Object.assign({}, base, { lines: [{ account_id: 1, debit: 100 }, { account_id: 2, credit: 90 }] })))
      .rejects.toMatchObject({ status: 400 });
    await expect(t.run(api, ctxOf(), Object.assign({}, base, { lines: [{ account_id: 1, debit: 100, credit: 100 }, { account_id: 2, credit: 0 }] })))
      .rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
    replies['POST /api/accounting/journals'] = { id: 77, status: 'draft' };
    replies['POST /api/accounting/journals/77/post'] = { id: 77, status: 'posted' };
    const out = await t.run(api, ctxOf(), Object.assign({}, base, { post: true, lines: [{ account_id: 1, debit: 100 }, { account_id: 2, credit: 100 }] }));
    expect(out).toMatchObject({ created: true, posted: true, journal: { id: 77, status: 'posted' } });
    expect(calls[0].body.lines).toEqual([{ accountId: 1, debit: 100, credit: 0, description: null }, { accountId: 2, debit: 0, credit: 100, description: null }]);
    expect(calls[0].body.idempotencyKey).toBe('mcp-c-1');
  });

  test('create_journal: a failed post returns the draft id instead of failing', async () => {
    replies['POST /api/accounting/journals'] = { id: 78 };
    replies['POST /api/accounting/journals/78/post'] = new Error('Period is locked');
    const out = await tool('create_journal').run(api, ctxOf(), { company_id: 51, date: '2026-03-31', description: 'x', reason: 'y', post: true,
      lines: [{ account_id: 1, debit: 5 }, { account_id: 2, credit: 5 }] });
    expect(out).toMatchObject({ created: true, posted: false, journal_id: 78, post_error: 'Period is locked' });
  });

  test('get_report maps each report to the Leo route', async () => {
    const t = tool('get_report');
    await t.run(api, ctxOf(), { company_id: 51, report: 'profit_loss', start_date: '2026-03-01', end_date: '2026-03-31' });
    await t.run(api, ctxOf(), { company_id: 51, report: 'balance_sheet', as_of_date: '2026-03-31' });
    await t.run(api, ctxOf(), { company_id: 51, report: 'customer_aging', as_of_date: '2026-03-31' });
    await t.run(api, ctxOf(), { company_id: 51, report: 'vat_report', period_key: '2026-03' });
    expect(calls.map(c => c.path)).toEqual(['/api/accounting/reports/profit-loss?fromDate=2026-03-01&toDate=2026-03-31',
      '/api/accounting/reports/balance-sheet?asOfDate=2026-03-31', '/api/accounting/customer-invoices/aging?asAt=2026-03-31',
      '/api/accounting/vat/report?periodKey=2026-03']);
    await expect(t.run(api, ctxOf(), { company_id: 51, report: 'profit_loss' })).rejects.toMatchObject({ status: 400 });
  });

  test('leo_routes lists Leo routes from the route files, without blocked ones', async () => {
    const r = await tool('leo_routes').run(api, ctxOf(), {});
    expect(r.count).toBeGreaterThan(150);
    const paths = r.routes.map(x => x.method + ' ' + x.path);
    expect(paths).toEqual(expect.arrayContaining(['POST /api/accounting/credit-notes', 'POST /api/accounting/journals/:id/reverse',
      'POST /api/accounting/suppliers/payments', 'DELETE /api/accounting/accounts/:id', 'POST /api/accounting/periods/:id/lock']));
    expect(paths.some(p => /\/send$|\/paye|\/employees|\/integrations|\/kv|pdf$/.test(p))).toBe(false);
    const vat = (await tool('leo_routes').run(api, ctxOf(), { filter: 'vat-settings', method: 'POST' })).routes;
    expect(vat.find(x => x.path === '/api/accounting/vat-settings').body).toEqual(expect.arrayContaining(['code', 'name', 'rate']));
  });

  test('leo_request: passes method, path, query and body; needs a reason to change data', async () => {
    const t = tool('leo_request');
    expect(V(t.inputSchema, { company_id: 51, method: 'GET', path: '/api/payroll/employees' })).toMatch(/path must look like/);
    expect(V(t.inputSchema, { company_id: 51, method: 'POST', path: '/api/accounting/quotes', body: [1] })).toBe('body must be an object');
    await expect(t.run(api, ctxOf(), { company_id: 51, method: 'POST', path: '/api/accounting/credit-notes', body: {} })).rejects.toMatchObject({ status: 400 });
    await t.run(api, ctxOf(), { company_id: 51, method: 'POST', path: '/api/accounting/credit-notes/', body: { customerId: 3 }, reason: 'returned goods' });
    await t.run(api, ctxOf(), { company_id: 51, method: 'GET', path: '/api/accounting/journals', query: { status: 'draft', limit: 5 } });
    await t.run(api, ctxOf(), { company_id: 51, method: 'DELETE', path: '/api/accounting/accounts/9', body: { x: 1 }, reason: 'duplicate' });
    expect(calls).toEqual([
      { method: 'POST', path: '/api/accounting/credit-notes', body: { customerId: 3 }, cid: 51 },
      { method: 'GET', path: '/api/accounting/journals?status=draft&limit=5', body: undefined, cid: 51 },
      { method: 'DELETE', path: '/api/accounting/accounts/9', body: undefined, cid: 51 }]);
  });

  test('leo_request: routes with their own checks go through their tool; rules and Sean auto keep the key policy', async () => {
    const t = tool('leo_request');
    const r = { reason: 'x', company_id: 51 };
    await expect(t.run(api, ctxOf(), Object.assign({ method: 'POST', path: '/api/accounting/bot-decisions/allocate' }, r))).rejects.toMatchObject({ status: 400 });
    await expect(t.run(api, ctxOf(), Object.assign({ method: 'POST', path: '/api/accounting/bank/reconcile' }, r))).rejects.toMatchObject({ status: 400 });
    await expect(t.run(api, ctxOf(), Object.assign({ method: 'DELETE', path: '/api/accounting/bank/rules/4' }, r))).rejects.toMatchObject({ status: 403 });
    await expect(t.run(api, ctxOf(), Object.assign({ method: 'POST', path: '/api/accounting/bank/sean-auto-allocate' }, r))).rejects.toMatchObject({ status: 403 });
    await expect(t.run(api, ctxOf(), Object.assign({ method: 'GET', path: '/api/accounting/reports/profit-loss/pdf' }, r))).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
    await t.run(api, ctxOf({ allow_create_rules: true }), Object.assign({ method: 'DELETE', path: '/api/accounting/bank/rules/4' }, r));
    expect(calls.map(c => c.method + ' ' + c.path)).toEqual(['DELETE /api/accounting/bank/rules/4']);
  });
});
