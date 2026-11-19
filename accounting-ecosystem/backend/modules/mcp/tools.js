'use strict';

/**
 * MCP tools — Ledger Leo, read-only (phase 1).
 * Every tool calls an EXISTING Leo endpoint as the token's user; Leo enforces the user's
 * role, companies and permissions. A tool never computes accounting itself.
 * Write tools (staging an import, allocation) come in a later phase.
 */

const MAX_ROWS_DEFAULT = 100;
const MAX_ROWS_CAP = 500;
const MAX_TEXT_CHARS = 120000;

const companyIdProp = { type: 'integer', description: 'Company id from list_companies' };
const isoDate = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
const today = () => new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);   // SA time

/** Keep big lists readable for the model: first N rows + an explicit note. */
function trimLists(value, max) {
  const notes = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      const out = v.slice(0, max).map((x, i) => walk(x, path + '[' + i + ']'));
      if (v.length > max) notes.push(`${path || 'result'}: showing ${max} of ${v.length} rows`);
      return out;
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], path ? path + '.' + k : k);
      return o;
    }
    return v;
  };
  const data = walk(value, '');
  return { data, notes };
}

const qs = (o) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v));
  return p.length ? '?' + p.join('&') : '';
};
const rowsLimit = (a) => Math.min(Math.max(parseInt(a.limit, 10) || MAX_ROWS_DEFAULT, 1), MAX_ROWS_CAP);

const PROFILE_FIELDS = ['id', 'name', 'company_name', 'trading_name', 'tradingName', 'registration_number',
  'registrationNumber', 'vat_number', 'vatNumber', 'vat_registered', 'financial_year_end', 'financialYearEnd',
  'currency', 'currency_symbol', 'tax_label', 'tax_authority', 'jurisdiction', 'country', 'city', 'province'];

const TOOLS = [
  {
    name: 'ping',
    description: 'Check that the Lorenco connection works. Returns the connection status, the server version and who you are connected as.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(api, ctx) {
      return { status: 'ok', server: 'Lorenco Ledger Leo', version: ctx.serverVersion || null, mcp_enabled: true,
        connected_as: ctx.user.full_name || ctx.user.username || null, read_only: true };
    }
  },
  {
    name: 'list_companies',
    description: 'List the companies this user may open in Lorenco, with the user\'s role in each. Use the id as company_id in the other tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(api, ctx) {
      const list = await api.listCompanies(ctx);
      return { companies: list.map(c => ({
        id: c.id, name: c.trading_name || c.company_name || c.name, legal_name: c.company_name || null,
        role: c.role || null, apps: c.modules_enabled || []
      })) };
    }
  },
  {
    name: 'get_company_profile',
    description: 'Basic company details in Ledger Leo (name, registration and VAT numbers, financial year end, currency).',
    inputSchema: { type: 'object', properties: { company_id: companyIdProp }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      const d = await api.request(ctx, a.company_id, 'GET', '/api/accounting/company/' + parseInt(a.company_id, 10));
      const out = {};
      PROFILE_FIELDS.forEach(k => { if (d && d[k] !== undefined && d[k] !== null && d[k] !== '') out[k] = d[k]; });
      return out;
    }
  },
  {
    name: 'list_bank_accounts',
    description: 'Bank accounts of the company in Ledger Leo (id, bank, account name, linked ledger account, balance fields).',
    inputSchema: { type: 'object', properties: { company_id: companyIdProp }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      return api.request(ctx, a.company_id, 'GET', '/api/accounting/bank/accounts');
    }
  },
  {
    name: 'get_bank_import_status',
    description: 'Bank statement imports waiting in staging (not yet confirmed into the books). Without batch_id: the list of import batches with counts. With batch_id: the staged lines of that batch.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      batch_id: { type: 'string', description: 'Import batch id from the batch list' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CAP }
    }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      if (a.batch_id) {
        return api.request(ctx, a.company_id, 'GET', '/api/accounting/bank/staging' + qs({ batchId: a.batch_id, limit: rowsLimit(a) }));
      }
      return api.request(ctx, a.company_id, 'GET', '/api/accounting/bank/staging/batches');
    }
  },
  {
    name: 'get_allocation_rules',
    description: 'The company\'s bank allocation rules (which description goes to which account, VAT treatment).',
    inputSchema: { type: 'object', properties: { company_id: companyIdProp }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      return api.request(ctx, a.company_id, 'GET', '/api/accounting/bank/rules');
    }
  },
  {
    name: 'get_unallocated_transactions',
    description: 'Bank transactions that are not yet allocated to an account.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      bank_account_id: { type: 'integer' },
      date_from: isoDate, date_to: isoDate,
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CAP, description: 'Rows to return (default 100)' }
    }, required: ['company_id'], additionalProperties: false },
    limitRows: true,
    async run(api, ctx, a) {
      return api.request(ctx, a.company_id, 'GET', '/api/accounting/reports/unallocated-bank-transactions' +
        qs({ bankAccountId: a.bank_account_id, dateFrom: a.date_from, dateTo: a.date_to }));
    }
  },
  {
    name: 'get_reconciliation_status',
    description: 'Bank reconciliation of one bank account: statement vs ledger balance on a date, the reconciliation history, and Sean\'s month-end review (balance breaks, missing statements, likely duplicates, stale unallocated lines). Read-only.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      bank_account_id: { type: 'integer' },
      date: Object.assign({}, isoDate, { description: 'Reconciliation date YYYY-MM-DD (default today)' })
    }, required: ['company_id', 'bank_account_id'], additionalProperties: false },
    heavy: true,
    async run(api, ctx, a) {
      const id = parseInt(a.bank_account_id, 10);
      const [recon, history, review] = await Promise.all([
        api.request(ctx, a.company_id, 'GET', '/api/accounting/reports/bank-reconciliation' + qs({ bankAccountId: id, date: a.date || today() })),
        api.request(ctx, a.company_id, 'GET', '/api/accounting/reports/bank-recon-history' + qs({ bankAccountId: id })).catch(e => ({ error: e.message })),
        api.request(ctx, a.company_id, 'GET', '/api/accounting/bank/sean-review' + qs({ bankAccountId: id })).catch(e => ({ error: e.message }))
      ]);
      return { reconciliation: recon, history, month_end_review: review };
    }
  },
  {
    name: 'get_trial_balance',
    description: 'Trial balance of the company for a date range (debits, credits and balance per account).',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp, from_date: isoDate, to_date: isoDate
    }, required: ['company_id', 'from_date', 'to_date'], additionalProperties: false },
    async run(api, ctx, a) {
      return api.request(ctx, a.company_id, 'GET', '/api/accounting/reports/trial-balance' + qs({ fromDate: a.from_date, toDate: a.to_date }));
    }
  }
];

/** Minimal JSON-schema check for our flat input schemas. Returns an error string or null. */
function validateArgs(schema, args) {
  const a = args || {};
  if (typeof a !== 'object' || Array.isArray(a)) return 'arguments must be an object';
  for (const k of schema.required || []) {
    if (a[k] === undefined || a[k] === null || a[k] === '') return `${k} is required`;
  }
  for (const [k, v] of Object.entries(a)) {
    const p = (schema.properties || {})[k];
    if (!p) { if (schema.additionalProperties === false) return `unknown argument: ${k}`; continue; }
    if (p.type === 'integer' && !(Number.isInteger(Number(v)) && String(v).trim() !== '')) return `${k} must be a whole number`;
    if (p.type === 'string' && typeof v !== 'string') return `${k} must be text`;
    if (p.pattern && !new RegExp(p.pattern).test(String(v))) return `${k} must look like ${p.description || p.pattern}`;
    if (p.minimum != null && Number(v) < p.minimum) return `${k} must be at least ${p.minimum}`;
    if (p.maximum != null && Number(v) > p.maximum) return `${k} must be at most ${p.maximum}`;
  }
  return null;
}

/** Turn a tool result into MCP content (text JSON + structuredContent). */
function toContent(result, maxRows) {
  const { data, notes } = trimLists(result, maxRows);
  let text = JSON.stringify(data, null, 1);
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    notes.push('result was cut at ' + MAX_TEXT_CHARS + ' characters — ask for a smaller range');
  }
  const content = [{ type: 'text', text }];
  if (notes.length) content.push({ type: 'text', text: 'Note: ' + notes.join('; ') });
  return { content, structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data } };
}

module.exports = { TOOLS, validateArgs, toContent, trimLists, rowsLimit, MAX_ROWS_DEFAULT };
