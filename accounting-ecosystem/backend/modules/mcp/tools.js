'use strict';

/**
 * MCP tools — Ledger Leo, read-only (phase 1).
 * Every tool calls an EXISTING Leo endpoint as the token's user; Leo enforces the user's
 * role, companies and permissions. A tool never computes accounting itself.
 * Phase 2 (Ruan 2026-11-19): bank write tools — import a PDF statement, confirm/reject
 * staged lines, allocate, Sean suggestions / auto-allocate, allocation rules and bank
 * reconciliation. They call the SAME Leo routes as the screens (allow-listed in
 * lorencoApi.js), so Leo validates, posts, audits and Sean learns exactly as for a person.
 * 2026-11-20 (Ruan): the bot is a normal Ledger Leo user — create_vat_code, create_journal,
 * get_report, and leo_routes + leo_request for every other Leo route (edit, delete, void,
 * payments, periods, year-end …). Still closed (hard-blocked in lorencoApi.js): other apps,
 * contacting clients, SARS submissions, system/keys/company admin, users/permissions,
 * AI/Sean settings, approving its own Bot Review items.
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

const money = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function apiError(status, message) {
  const { LorencoApiError } = require('./lorencoApi');
  return new LorencoApiError(status, message);
}

/** Key policy (set by a person in Profile; the bot can never change it). */
function requirePolicy(ctx, key, what) {
  if (!(ctx.policy && ctx.policy[key] === true)) {
    throw apiError(403, what + ' is switched off for this bot key. A person can allow it in Lorenco: Profile → Bot / AI access keys.');
  }
}

/** All bank lines of one status on one account (pages of 1000, like the recon screen). */
async function allBankLines(api, ctx, companyId, bankAccountId, status) {
  const out = [];
  for (let offset = 0; offset < 50000; offset += 1000) {
    const d = await api.request(ctx, companyId, 'GET', '/api/accounting/bank/transactions' +
      qs({ bankAccountId, status, limit: 1000, offset }));
    const rows = (d && d.transactions) || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/**
 * Invoice lines: every account must be an active, postable account of THIS company and not a
 * bank/cash account; every VAT rate must be one of the company's VAT rates (or 0). Leo's supplier
 * invoice route does not check line accounts itself, so the bot path checks them here.
 */
async function checkInvoiceLines(api, ctx, a, kind) {
  const accts = ((await api.request(ctx, a.company_id, 'GET', '/api/accounting/accounts')) || {}).accounts || [];
  const byId = new Map(accts.map(x => [Number(x.id), x]));
  for (const l of a.lines) {
    const acc = byId.get(Number(l.account_id));
    if (!acc) throw apiError(400, `Account ${l.account_id} is not an account of this company (list_accounts).`);
    if (acc.is_active === false || acc.is_postable === false) throw apiError(400, `Account ${acc.code} ${acc.name} is inactive or a header account.`);
    if (acc.reporting_group === 'bank_cash' || ['bank', 'cash'].includes(String(acc.sub_type || '').toLowerCase())) {
      throw apiError(400, `Account ${acc.code} ${acc.name} is a bank/cash account — it cannot be used on an invoice line.`);
    }
    if (kind === 'income' && acc.type !== 'income') throw apiError(400, `Account ${acc.code} ${acc.name} is not an income account.`);
    if (!(Number(l.quantity) > 0)) throw apiError(400, 'Line quantity must be more than 0.');
  }
  const vats = ((await api.request(ctx, a.company_id, 'GET', '/api/accounting/vat-settings')) || {}).vatSettings || [];
  const rates = new Set([0, ...vats.filter(v => v.is_active !== false).map(v => Number(v.rate))]);
  for (const l of a.lines) {
    if (!rates.has(Number(l.vat_rate))) {
      throw apiError(400, `VAT rate ${l.vat_rate}% is not one of this company's VAT rates (${[...rates].join('%, ')}%). See list_vat_settings.`);
    }
  }
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
        connected_as: ctx.user.full_name || ctx.user.username || null, read_only: false,
        note: 'Full Ledger Leo access as this user: dedicated tools for the common work, and leo_routes + leo_request for EVERYTHING else (edit, delete, void, journals, payments, credit notes, quotes, periods, year-end …). Firmflow (practice management) through firmflow_routes + firmflow_request. What you may do depends on this user\'s role in each company.' };
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
    name: 'list_accounts',
    description: 'Chart of accounts of the company (id, code, name, type). Use the id as account_id when allocating. Only postable accounts can be allocated to.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      include_inactive: { type: 'boolean', description: 'Also list inactive accounts (default false)' }
    }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      const d = await api.request(ctx, a.company_id, 'GET', '/api/accounting/accounts' + qs({ includeInactive: a.include_inactive ? 'true' : undefined }));
      return { accounts: ((d && d.accounts) || []).map(x => ({ id: x.id, code: x.code, name: x.name, type: x.type,
        sub_type: x.sub_type || null, is_postable: x.is_postable !== false, is_active: x.is_active !== false })) };
    }
  },
  {
    name: 'list_vat_settings',
    description: 'VAT codes of the company (id, code, name, rate). Use the id as vat_setting_id on an allocation line when the line carries VAT.',
    inputSchema: { type: 'object', properties: { company_id: companyIdProp }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      const d = await api.request(ctx, a.company_id, 'GET', '/api/accounting/vat-settings');
      return { vat_settings: ((d && d.vatSettings) || []).map(v => ({ id: v.id, code: v.code, name: v.name, rate: v.rate,
        is_capital: !!v.is_capital, is_active: v.is_active !== false, effective_from: v.effective_from || null })) };
    }
  },
  {
    name: 'list_bank_transactions',
    description: 'Bank transactions in the books for one bank account. status: unmatched (not yet allocated), matched (allocated, not reconciled) or reconciled.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      bank_account_id: { type: 'integer' },
      status: { type: 'string', enum: ['unmatched', 'matched', 'reconciled'] },
      date_from: isoDate, date_to: isoDate,
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CAP, description: 'Rows to return (default 100)' },
      offset: { type: 'integer', minimum: 0 }
    }, required: ['company_id', 'bank_account_id'], additionalProperties: false },
    limitRows: true,
    async run(api, ctx, a) {
      return api.request(ctx, a.company_id, 'GET', '/api/accounting/bank/transactions' + qs({
        bankAccountId: a.bank_account_id, status: a.status, fromDate: a.date_from, toDate: a.date_to,
        limit: rowsLimit(a), offset: a.offset }));
    }
  },
  {
    name: 'import_bank_statement_pdf',
    description: 'Import a PDF bank statement into Ledger Leo. Leo\'s own statement reader parses the PDF and the lines are STAGED for review (not yet in the books) — exactly like the Import button on the Banking screen. Next step: confirm_staged_transactions. If the same file was imported before, nothing is staged unless allow_duplicate_file is true.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      bank_account_id: { type: 'integer', description: 'Bank account from list_bank_accounts' },
      pdf_base64: { type: 'string', description: 'The PDF file, base64-encoded' },
      filename: { type: 'string', description: 'Original file name, e.g. statement-2026-10.pdf' },
      allow_duplicate_file: { type: 'boolean', description: 'Stage even if this exact file was imported before (default false)' }
    }, required: ['company_id', 'bank_account_id', 'pdf_base64'], additionalProperties: false },
    heavy: true, write: true,
    async run(api, ctx, a) {
      const buf = Buffer.from(String(a.pdf_base64).replace(/^data:[^,]*,/, ''), 'base64');
      if (buf.length < 100 || buf.slice(0, 5).toString('latin1') !== '%PDF-') {
        throw apiError(400, 'pdf_base64 is not a PDF file');
      }
      if (buf.length > 15 * 1024 * 1024) throw apiError(400, 'PDF is larger than 15 MB');
      const form = new FormData();
      form.append('bankAccountId', String(parseInt(a.bank_account_id, 10)));
      form.append('file', new Blob([buf], { type: 'application/pdf' }), (a.filename || 'statement.pdf').replace(/[^\w.\- ]/g, '_'));
      const parsed = await api.request(ctx, a.company_id, 'POST', '/api/accounting/bank/import/pdf', form);
      const txns = (parsed && parsed.transactions) || [];
      const summary = {
        bank: parsed.bank || null, parser_confidence: parsed.parserConfidence ?? null,
        statement_period: parsed.statementPeriod || null, account_number: parsed.accountNumber || null,
        account_match: parsed.accountMatch || null, transactions_read: txns.length,
        warnings: parsed.warnings || [], duplicate_file: parsed.batchDuplicateWarning || null
      };
      if (!txns.length) return Object.assign(summary, { staged: 0, message: 'Leo could not read any transactions from this PDF — nothing was staged.' });
      if (parsed.batchDuplicateWarning && !a.allow_duplicate_file) {
        return Object.assign(summary, { staged: 0, message: 'This exact file was imported before — nothing was staged. Use allow_duplicate_file only if that is intended.' });
      }
      const staged = await api.request(ctx, a.company_id, 'POST', '/api/accounting/bank/import', {
        bankAccountId: parseInt(a.bank_account_id, 10), transactions: txns, importSource: 'pdf', fileHash: parsed.fileHash || null });
      return Object.assign(summary, { batch_id: staged.batchId, staged: staged.staged, skipped: staged.skipped,
        possible_duplicates: staged.duplicatesSuspected, transfers_detected: staged.transfersDetected,
        message: staged.message, next_step: 'Review with get_bank_import_status (batch_id), then confirm_staged_transactions.' });
    }
  },
  {
    name: 'stage_bank_transactions',
    description: 'Stage bank lines you already have as data (for example from a CSV export) for review — they are NOT yet in the books. Prefer import_bank_statement_pdf when you have the bank\'s PDF: those lines are read by Leo itself and Sean learns from their allocations. amount: positive = money in, negative = money out.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      bank_account_id: { type: 'integer' },
      transactions: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'object', properties: {
        date: isoDate, description: { type: 'string' }, amount: { type: 'number' },
        reference: { type: 'string' }, balance: { type: 'number' }
      }, required: ['date', 'description', 'amount'], additionalProperties: false } }
    }, required: ['company_id', 'bank_account_id', 'transactions'], additionalProperties: false },
    heavy: true, write: true,
    async run(api, ctx, a) {
      const r = await api.request(ctx, a.company_id, 'POST', '/api/accounting/bank/import', {
        bankAccountId: parseInt(a.bank_account_id, 10), importSource: 'csv',
        transactions: a.transactions.map(t => ({ date: t.date, description: t.description, amount: Number(t.amount),
          reference: t.reference || null, balance: t.balance != null ? Number(t.balance) : null })) });
      return { batch_id: r.batchId, staged: r.staged, skipped: r.skipped, possible_duplicates: r.duplicatesSuspected,
        transfers_detected: r.transfersDetected, message: r.message };
    }
  },
  {
    name: 'confirm_staged_transactions',
    description: 'Confirm staged bank lines into the books (they become unallocated bank transactions; no journal is posted yet). Use the staging ids from get_bank_import_status with a batch_id. Lines flagged as possible duplicates should be checked first.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      staging_ids: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'integer' } }
    }, required: ['company_id', 'staging_ids'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      const r = await api.request(ctx, a.company_id, 'POST', '/api/accounting/bank/staging/confirm', { stagingIds: a.staging_ids.map(Number) });
      return { confirmed: (r.confirmed || []).length, skipped: r.skipped || [], sean_auto_allocate_started: !!r.seanAutoAllocate,
        confirmed_transaction_ids: (r.confirmed || []).map(t => t.id) };
    }
  },
  {
    name: 'reject_staged_transaction',
    description: 'Reject one staged bank line (for example a duplicate) so it is not confirmed. It can be restored on the Banking screen.',
    inputSchema: { type: 'object', properties: { company_id: companyIdProp, staging_id: { type: 'integer' } },
      required: ['company_id', 'staging_id'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      return api.request(ctx, a.company_id, 'PATCH', '/api/accounting/bank/staging/' + parseInt(a.staging_id, 10) + '/reject', {});
    }
  },
  {
    name: 'get_sean_suggestions',
    description: 'Sean\'s allocation suggestions for unallocated bank transactions (account, VAT code, confidence, reason). Read-only — use allocate_bank_transaction to post.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      transaction_ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'integer' } }
    }, required: ['company_id', 'transaction_ids'], additionalProperties: false },
    async run(api, ctx, a) {
      const r = await api.request(ctx, a.company_id, 'POST', '/api/accounting/bank/sean-suggestions', { ids: a.transaction_ids.map(Number) });
      return { suggestions: r.suggestions || {}, prefill_min_confidence: r.prefillMinConfidence ?? null };
    }
  },
  {
    name: 'allocate_bank_transaction',
    description: 'Allocate one unallocated bank transaction — posted straight away, exactly like a person on the Banking screen (journal, VAT split by Leo, Sean learns from it). Leo refuses two things: overriding an approved allocation rule (use flag_for_review if you think the rule is wrong), and a transfer between the company’s own bank accounts (use Leo’s transfer function via leo_routes "transfer", so both bank lines are matched once). Line amounts are positive and must add up to the transaction amount. Always give reason; give disagreement_reason when you choose differently from a confident Sean.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      transaction_id: { type: 'integer' },
      lines: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: {
        account_id: { type: 'integer' }, amount: { type: 'number', minimum: 0.01 },
        vat_setting_id: { type: 'integer' }, vat_inclusive: { type: 'boolean' }, description: { type: 'string' }
      }, required: ['account_id', 'amount'], additionalProperties: false } },
      reason: { type: 'string', description: 'Why this account (required)' },
      decision_source: { type: 'string', enum: ['rule', 'sean', 'evidence', 'bot'], description: 'What the decision is based on' },
      disagreement_reason: { type: 'string', description: 'Required when you choose a different account than Sean recommends' },
      evidence: { type: 'string', description: 'Supporting documents or history you relied on' },
      description: { type: 'string', description: 'Journal description (default: the bank line\'s description)' }
    }, required: ['company_id', 'transaction_id', 'lines', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      return api.request(ctx, a.company_id, 'POST', '/api/accounting/bot-decisions/allocate', {
        bankTransactionId: parseInt(a.transaction_id, 10),
        lines: a.lines.map(l => Object.assign({ accountId: Number(l.account_id), amount: money(l.amount) },
          l.vat_setting_id != null ? { vatSettingId: Number(l.vat_setting_id) } : {},
          l.vat_inclusive === false ? { vatInclusive: false } : {},
          l.description ? { description: l.description } : {})),
        reason: a.reason, decisionSource: a.decision_source, disagreementReason: a.disagreement_reason,
        evidence: a.evidence, description: a.description, correlationId: ctx.correlationId || null
      });
    }
  },
  {
    name: 'flag_for_review',
    description: 'Hand a bank line to a person instead of allocating it: unknown expense, a possible duplicate, a director/owner payment, anything you are not sure of, or when you think an approved rule is wrong. It appears on the Bot Review page with your reason and optional suggested lines.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      transaction_id: { type: 'integer' },
      reason: { type: 'string' },
      evidence: { type: 'string' },
      suggested_lines: { type: 'array', maxItems: 50, items: { type: 'object', properties: {
        account_id: { type: 'integer' }, amount: { type: 'number', minimum: 0.01 }, vat_setting_id: { type: 'integer' }
      }, required: ['account_id', 'amount'], additionalProperties: false } }
    }, required: ['company_id', 'transaction_id', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      return api.request(ctx, a.company_id, 'POST', '/api/accounting/bot-decisions/exception', {
        bankTransactionId: parseInt(a.transaction_id, 10), reason: a.reason, evidence: a.evidence,
        lines: (a.suggested_lines || []).map(l => Object.assign({ accountId: Number(l.account_id), amount: money(l.amount) },
          l.vat_setting_id != null ? { vatSettingId: Number(l.vat_setting_id) } : {})),
        correlationId: ctx.correlationId || null
      });
    }
  },
  {
    name: 'list_bot_decisions',
    description: 'Your decisions in this company — posted, waiting for approval, exceptions, approved, rejected, failed — with the reason, the rule and Sean suggestion that applied and the bank line. Use it for your review report.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      status: { type: 'string', description: 'Comma-separated: posted, pending_approval, exception, approved, rejected, failed' },
      since: Object.assign({}, isoDate, { description: 'Only decisions from this date (YYYY-MM-DD)' }),
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CAP }
    }, required: ['company_id'], additionalProperties: false },
    limitRows: true,
    async run(api, ctx, a) {
      const d = await api.request(ctx, a.company_id, 'GET', '/api/accounting/bot-decisions' + qs({ status: a.status, since: a.since, limit: rowsLimit(a) }));
      return { counts: d.counts || {}, decisions: (d.decisions || []).map(x => ({
        id: x.id, status: x.status, action: x.action, bank_line: x.bank_line, decision_source: x.decision_source,
        proposed: x.proposed, rule: x.rule_suggestion, sean: x.sean_suggestion, reason: x.reason,
        disagreement_reason: x.disagreement_reason, waiting_because: x.hold_labels, journal_id: x.journal_id,
        reviewed_by: x.reviewed_by_name, review_note: x.review_note, created_at: x.created_at })) };
    }
  },
  {
    name: 'get_bot_policy',
    description: 'What this bot key may do on its own (set by a person in Lorenco; you cannot change it).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(api, ctx) {
      return { policy: ctx.policy || {}, allocations: 'posted straight away like an employee — follow approved rules, Sean and your instructions; transfers between own bank accounts through the transfer function',
        never_available: ['other apps (Paytime, Checkout Charlie, Stockton …)',
        'e-mailing / sending anything to clients', 'SARS submissions', 'system settings, integrations and keys', 'changing users or permissions',
        'changing AI / Sean settings', 'approving your own Bot Review items',
        'Firmflow sign-off (approve / reject / QA lock / partner override / recording reviews)', 'marking SARS submissions as submitted',
        'Firmflow practice settings, staff and users'],
        everything_else: 'Any other Ledger Leo task is available — dedicated tools, or leo_routes + leo_request. Any other Firmflow task: firmflow_routes + firmflow_request.' };
    }
  },
  {
    name: 'sean_auto_allocate',
    description: 'Let Sean allocate the unallocated lines he is sure of (only works when "Sean allocates by himself" is switched on for this company). Every posting is audited and can be undone on the Banking screen.',
    inputSchema: { type: 'object', properties: { company_id: companyIdProp, bank_account_id: { type: 'integer' } },
      required: ['company_id'], additionalProperties: false },
    heavy: true, write: true,
    async run(api, ctx, a) {
      requirePolicy(ctx, 'allow_sean_auto', 'Letting Sean allocate by himself');
      return api.request(ctx, a.company_id, 'POST', '/api/accounting/bank/sean-auto-allocate',
        a.bank_account_id ? { bankAccountId: parseInt(a.bank_account_id, 10) } : {});
    }
  },
  {
    name: 'create_allocation_rule',
    description: 'Only if this key allows it (get_bot_policy). Create a bank allocation rule: bank lines whose description matches the pattern are suggested to the account (and VAT code).',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      match_pattern: { type: 'string', description: 'Text to match in the bank description' },
      match_type: { type: 'string', enum: ['contains', 'starts_with', 'exact'] },
      account_id: { type: 'integer' }, vat_setting_id: { type: 'integer' },
      priority: { type: 'integer', minimum: 1, maximum: 1000 }
    }, required: ['company_id', 'match_pattern', 'account_id'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      requirePolicy(ctx, 'allow_create_rules', 'Creating allocation rules');
      return api.request(ctx, a.company_id, 'POST', '/api/accounting/bank/rules', {
        matchPattern: a.match_pattern, matchType: a.match_type || 'contains', accountId: Number(a.account_id),
        vatSettingId: a.vat_setting_id != null ? Number(a.vat_setting_id) : undefined, priority: a.priority || 100 });
    }
  },
  {
    name: 'reconcile_bank_transactions',
    description: 'Reconcile allocated (matched) bank transactions against a bank statement closing balance, exactly like Finish on the Bank Reconciliation screen. Cleared balance = account opening balance + all reconciled lines + the selected lines. If it does not equal the statement closing balance, nothing is reconciled unless allow_difference is true. Returns the figures either way.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      bank_account_id: { type: 'integer' },
      transaction_ids: { type: 'array', minItems: 1, maxItems: 5000, items: { type: 'integer' } },
      statement_date: isoDate,
      statement_closing_balance: { type: 'number' },
      allow_difference: { type: 'boolean', description: 'Reconcile even if cleared balance ≠ statement balance (default false)' }
    }, required: ['company_id', 'bank_account_id', 'transaction_ids', 'statement_date', 'statement_closing_balance'], additionalProperties: false },
    heavy: true, write: true,
    async run(api, ctx, a) {
      if (a.allow_difference === true) requirePolicy(ctx, 'allow_reconcile_difference', 'Reconciling with a difference');
      const accId = parseInt(a.bank_account_id, 10);
      const accounts = (await api.request(ctx, a.company_id, 'GET', '/api/accounting/bank/accounts')).bankAccounts || [];
      const account = accounts.find(x => Number(x.id) === accId);
      if (!account) throw apiError(404, 'Bank account ' + accId + ' not found in this company');
      const [reconciled, matched] = await Promise.all([
        allBankLines(api, ctx, a.company_id, accId, 'reconciled'),
        allBankLines(api, ctx, a.company_id, accId, 'matched')
      ]);
      const matchedById = new Map(matched.map(t => [Number(t.id), t]));
      const wanted = [...new Set(a.transaction_ids.map(Number))];
      const notMatched = wanted.filter(id => !matchedById.has(id));
      if (notMatched.length) {
        throw apiError(422, 'These ids are not allocated (matched) lines on this bank account, so they cannot be reconciled: ' + notMatched.slice(0, 50).join(', '));
      }
      const bookOpening = num(account.opening_balance) + reconciled.reduce((s, t) => s + num(t.amount), 0);
      const selected = wanted.reduce((s, id) => s + num(matchedById.get(id).amount), 0);
      const cleared = money(bookOpening + selected);
      const closing = money(a.statement_closing_balance);
      const difference = money(closing - cleared);
      const figures = { book_opening_balance: money(bookOpening), selected_total: money(selected), cleared_balance: cleared,
        statement_closing_balance: closing, difference, lines: wanted.length };
      if (Math.abs(difference) >= 0.005 && !a.allow_difference) {
        return Object.assign(figures, { reconciled: false,
          message: 'Cleared balance does not equal the statement closing balance — nothing was reconciled. Find the difference first (or pass allow_difference: true).' });
      }
      const r = await api.request(ctx, a.company_id, 'POST', '/api/accounting/bank/reconcile', {
        transactionIds: wanted, bankAccountId: accId, statementDate: a.statement_date,
        statementClosingBalance: closing, clearedBalance: cleared });
      return Object.assign(figures, { reconciled: true, result: r });
    }
  },
  // ── Setup: chart of accounts, bank accounts, customers, suppliers (create only — 2026-11-19) ──
  {
    name: 'list_customers',
    description: 'Customers of the company (id, name, email, phone). Check here before create_customer.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      search: { type: 'string', description: 'Only names containing this text' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CAP }
    }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      const d = await api.request(ctx, a.company_id, 'GET', '/api/accounting/customer-invoices/customers');
      const s = String(a.search || '').trim().toLowerCase();
      const rows = ((d && d.customers) || []).filter(c => !s || String(c.name || '').toLowerCase().includes(s))
        .map(c => ({ id: c.id, name: c.name, email: c.email || null, phone: c.phone || null }));
      return { customers: rows.slice(0, rowsLimit(a)), total: rows.length };
    }
  },
  {
    name: 'list_suppliers',
    description: 'Suppliers of the company (id, code, name, VAT number, balance owing). Check here before create_supplier.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      search: { type: 'string', description: 'Only suppliers whose name, code or email contains this text' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CAP }
    }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      const d = await api.request(ctx, a.company_id, 'GET', '/api/accounting/suppliers' + qs({ search: a.search }));
      const rows = ((d && d.suppliers) || []).map(x => ({ id: x.id, code: x.supplier_code || null, name: x.name,
        vat_number: x.vat_number || null, email: x.email || null, is_active: x.is_active !== false,
        balance_owing: x.balance_owing != null ? x.balance_owing : null }));
      return { suppliers: rows.slice(0, rowsLimit(a)), total: rows.length };
    }
  },
  {
    name: 'create_account',
    description: 'Add an account to the chart of accounts (like Add Account on the Chart of Accounts screen). Check list_accounts first: the code must be new. Bank / cash ledger accounts use sub_type "bank" or "cash". Accounts cannot be edited or deleted by a bot.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      code: { type: 'string', pattern: '^[A-Za-z0-9./-]{1,20}$', description: 'account code, e.g. 6250 (letters, digits, . / -)' },
      name: { type: 'string', description: 'Account name' },
      type: { type: 'string', enum: ['asset', 'liability', 'equity', 'income', 'expense'] },
      sub_type: { type: 'string', description: 'Optional sub type, e.g. bank, cash, current_asset, cost_of_sales' },
      reporting_group: { type: 'string', description: 'Optional reporting group, e.g. bank_cash, drawings' },
      parent_id: { type: 'integer', description: 'Optional parent account id (list_accounts)' },
      description: { type: 'string' },
      vat_code: { type: 'string', description: 'Optional default VAT code (list_vat_settings)' },
      reason: { type: 'string', description: 'Why this account is needed (kept in the bot audit trail)' }
    }, required: ['company_id', 'code', 'name', 'type', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      if (!String(a.name).trim()) throw apiError(400, 'name is required');
      const d = await api.request(ctx, a.company_id, 'POST', '/api/accounting/accounts', {
        code: a.code.trim(), name: a.name.trim(), type: a.type, subType: a.sub_type || undefined,
        reportingGroup: a.reporting_group || undefined, parentId: a.parent_id != null ? Number(a.parent_id) : undefined,
        description: a.description || undefined, vatCode: a.vat_code || undefined });
      return { created: true, account: d && { id: d.id, code: d.code, name: d.name, type: d.type, sub_type: d.sub_type || null } };
    }
  },
  {
    name: 'create_bank_account',
    description: 'Add a bank account in Ledger Leo (like Add Bank Account on the Banking screen), linked to a bank/cash ledger account from the chart (create_account first if needed). Only the LAST 4 digits of the account number are stored. The opening balance must be the statement balance on opening_balance_date — it drives every later reconciliation, so take it from the statement, never guess.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      name: { type: 'string', description: 'Display name, e.g. "FNB Business Cheque"' },
      bank_name: { type: 'string', description: 'e.g. FNB, ABSA, Standard Bank, Nedbank, Capitec' },
      account_last4: { type: 'string', pattern: '^\\d{4}$', description: 'the last 4 digits of the account number' },
      ledger_account_id: { type: 'integer', description: 'bank/cash ledger account id (list_accounts)' },
      opening_balance: { type: 'number', description: 'statement balance on opening_balance_date (overdrawn = negative)' },
      opening_balance_date: isoDate,
      currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO currency, default ZAR' },
      reason: { type: 'string', description: 'Where the details come from, e.g. "statement Oct 2026 p1"' }
    }, required: ['company_id', 'name', 'bank_name', 'account_last4', 'ledger_account_id', 'opening_balance', 'opening_balance_date', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      const masked = '****' + a.account_last4;
      const existing = ((await api.request(ctx, a.company_id, 'GET', '/api/accounting/bank/accounts')) || {}).bankAccounts || [];
      const dup = existing.find(b => b.is_active !== false && (String(b.account_number_masked || '').slice(-4) === a.account_last4
        || String(b.name || '').trim().toLowerCase() === String(a.name).trim().toLowerCase()));
      if (dup) throw apiError(409, `A bank account like this already exists: id ${dup.id} "${dup.name}" ${dup.account_number_masked || ''}. Use it instead of creating another.`);
      const accts = ((await api.request(ctx, a.company_id, 'GET', '/api/accounting/accounts')) || {}).accounts || [];
      const ledger = accts.find(x => Number(x.id) === Number(a.ledger_account_id));
      if (!ledger) throw apiError(400, 'ledger_account_id is not an account of this company (list_accounts).');
      if (!(ledger.type === 'asset' && (['bank', 'cash'].includes(String(ledger.sub_type || '').toLowerCase()) || ledger.reporting_group === 'bank_cash'))) {
        throw apiError(400, `Account ${ledger.code} ${ledger.name} is not a bank/cash asset account. Create one with create_account (type asset, sub_type bank).`);
      }
      const d = await api.request(ctx, a.company_id, 'POST', '/api/accounting/bank/accounts', {
        name: a.name.trim(), bankName: a.bank_name.trim(), accountNumberMasked: masked, currency: a.currency || 'ZAR',
        ledgerAccountId: Number(a.ledger_account_id), openingBalance: money(a.opening_balance), openingBalanceDate: a.opening_balance_date });
      return { created: true, bank_account: d && { id: d.id, name: d.name, bank_name: d.bank_name, account_number_masked: d.account_number_masked,
        ledger_account_id: d.ledger_account_id, opening_balance: d.opening_balance, opening_balance_date: d.opening_balance_date },
        subaccount_created: (d && d.subaccount_created) || null };
    }
  },
  {
    name: 'create_customer',
    description: 'Add a customer (like Add Customer on the Customers screen). Refused when a customer with the same name already exists — use that one.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      name: { type: 'string' },
      customer_number: { type: 'string' }, contact_person: { type: 'string' },
      email: { type: 'string' }, phone: { type: 'string' },
      vat_number: { type: 'string', description: 'customer VAT / tax reference' },
      registration_number: { type: 'string', description: 'company registration or ID number' },
      address: { type: 'string' }, city: { type: 'string' }, province: { type: 'string' }, postal_code: { type: 'string' },
      credit_limit: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
      reason: { type: 'string', description: 'Why / where from, e.g. "receipt from this customer on the Oct statement"' }
    }, required: ['company_id', 'name', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      const name = String(a.name).trim();
      if (!name) throw apiError(400, 'name is required');
      const list = ((await api.request(ctx, a.company_id, 'GET', '/api/accounting/customer-invoices/customers')) || {}).customers || [];
      const dup = list.find(c => String(c.name || '').trim().toLowerCase() === name.toLowerCase());
      if (dup) throw apiError(409, `Customer "${dup.name}" already exists (id ${dup.id}). Use it instead of creating another.`);
      const d = await api.request(ctx, a.company_id, 'POST', '/api/accounting/pos/customers', {
        name, customer_number: a.customer_number || null, contact_person: a.contact_person || null,
        email: a.email || null, phone: a.phone || null, tax_reference: a.vat_number || null, id_number: a.registration_number || null,
        address_line_1: a.address || null, city: a.city || null, province: a.province || null, postal_code: a.postal_code || null,
        credit_limit: a.credit_limit != null ? Number(a.credit_limit) : 0, notes: a.notes || null, is_active: true });
      const c = d && d.customer;
      return { created: true, customer: c && { id: c.id, name: c.name, customer_number: c.customer_number || null } };
    }
  },
  {
    name: 'create_supplier',
    description: 'Add a supplier (like Add Supplier on the Suppliers screen). Refused when a supplier with the same name already exists. Supplier BANK details cannot be set by a bot — a person adds those in Lorenco (payment-fraud protection).',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      name: { type: 'string' },
      code: { type: 'string', description: 'Optional supplier code; generated (SUP001…) when left out' },
      type: { type: 'string', enum: ['company', 'individual'] },
      contact_name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
      vat_number: { type: 'string' }, registration_number: { type: 'string' },
      address: { type: 'string' }, city: { type: 'string' }, postal_code: { type: 'string' },
      payment_terms: { type: 'integer', minimum: 0, maximum: 365, description: 'days, default 30' },
      notes: { type: 'string' },
      reason: { type: 'string', description: 'Why / where from, e.g. "debit order on the Oct statement"' }
    }, required: ['company_id', 'name', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      const name = String(a.name).trim();
      if (!name) throw apiError(400, 'name is required');
      const list = ((await api.request(ctx, a.company_id, 'GET', '/api/accounting/suppliers' + qs({ search: name }))) || {}).suppliers || [];
      const dup = list.find(s => String(s.name || '').trim().toLowerCase() === name.toLowerCase());
      if (dup) throw apiError(409, `Supplier "${dup.name}" already exists (id ${dup.id}, ${dup.supplier_code || ''}). Use it instead of creating another.`);
      const d = await api.request(ctx, a.company_id, 'POST', '/api/accounting/suppliers', {
        name, code: a.code || undefined, type: a.type || 'company', contactName: a.contact_name || null,
        email: a.email || null, phone: a.phone || null, vatNumber: a.vat_number || null, registrationNumber: a.registration_number || null,
        address: a.address || null, city: a.city || null, postalCode: a.postal_code || null,
        paymentTerms: a.payment_terms != null ? Number(a.payment_terms) : 30, notes: a.notes || null });
      const s = d && d.supplier;
      return { created: true, supplier: s && { id: s.id, code: s.supplier_code, name: s.name } };
    }
  },
  // ── Invoices: customer (create + post, NEVER send) and supplier (create = posted) — 2026-11-20 ──
  {
    name: 'list_customer_invoices',
    description: 'Customer (sales) invoices. status: draft (not yet posted), sent (posted to the books — "sent" is Leo\'s word for posted, it does not mean e-mailed), paid, part_paid (partly paid), void.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      status: { type: 'string', enum: ['draft', 'sent', 'paid', 'part_paid', 'overdue', 'void', 'cancelled'] },
      customer_id: { type: 'integer' }, from_date: isoDate, to_date: isoDate,
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CAP }
    }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      const d = await api.request(ctx, a.company_id, 'GET', '/api/accounting/customer-invoices' + qs({ status: a.status,
        customerId: a.customer_id, fromDate: a.from_date, toDate: a.to_date, limit: rowsLimit(a) }));
      return { invoices: ((d && d.invoices) || []).map(i => ({ id: i.id, invoice_number: i.invoice_number, date: i.date,
        due_date: i.due_date || null, customer_id: i.customer_id, customer_name: i.customer_name || null, status: i.status,
        total: i.total_amount, vat: i.vat_amount, balance_due: i.balance_due })) };
    }
  },
  {
    name: 'create_customer_invoice',
    description: 'Create a customer (sales) invoice as a DRAFT; with post: true it is also posted to the books. A bot can NEVER e-mail an invoice to a customer — a person sends it from Ledger Leo. The customer must already exist (list_customers / create_customer). Leo refuses a duplicate invoice number.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      customer_id: { type: 'integer', description: 'from list_customers' },
      invoice_number: { type: 'string', description: 'Optional; Leo numbers it (INV-0001…) when left out' },
      invoice_date: isoDate, due_date: isoDate,
      vat_inclusive: { type: 'boolean', description: 'true when unit prices include VAT (default false)' },
      lines: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: {
        description: { type: 'string' },
        account_id: { type: 'integer', description: 'income account id (list_accounts)' },
        quantity: { type: 'number', minimum: 0 },
        unit_price: { type: 'number', minimum: 0 },
        vat_rate: { type: 'number', minimum: 0, maximum: 100, description: 'VAT % — a rate from list_vat_settings, or 0' }
      }, required: ['description', 'account_id', 'quantity', 'unit_price', 'vat_rate'], additionalProperties: false } },
      notes: { type: 'string' },
      post: { type: 'boolean', description: 'true = post to the books straight away (default false: stays a draft for a person)' },
      reason: { type: 'string', description: 'Where this invoice comes from (kept in the bot audit trail)' }
    }, required: ['company_id', 'customer_id', 'invoice_date', 'lines', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      await checkInvoiceLines(api, ctx, a, 'income');
      const d = await api.request(ctx, a.company_id, 'POST', '/api/accounting/customer-invoices', {
        customerId: Number(a.customer_id), invoiceNumber: a.invoice_number || undefined, invoiceDate: a.invoice_date,
        dueDate: a.due_date || undefined, vatInclusive: a.vat_inclusive === true, notes: a.notes || undefined,
        lines: a.lines.map(l => ({ description: l.description, accountId: Number(l.account_id), lineType: 'account',
          quantity: Number(l.quantity), unitPrice: Number(l.unit_price), vatRate: Number(l.vat_rate) })) });
      const inv = d && d.invoice;
      const out = { created: true, invoice: inv && { id: inv.id, invoice_number: inv.invoice_number, total: inv.total_amount, status: inv.status }, posted: false };
      if (a.post === true && inv) {
        try {
          await api.request(ctx, a.company_id, 'POST', `/api/accounting/customer-invoices/${parseInt(inv.id, 10)}/post`, {});
          out.posted = true; out.invoice.status = 'sent';
        } catch (e) {
          // the draft exists — say so, so the bot does not create it a second time
          out.post_error = (e && e.message) || 'posting failed';
          out.note_draft = `The invoice was created as draft id ${inv.id} but NOT posted. Fix the cause, then use post_customer_invoice — do not create it again.`;
        }
      }
      out.note = 'Not e-mailed. A person sends it to the customer from Ledger Leo.';
      return out;
    }
  },
  {
    name: 'post_customer_invoice',
    description: 'Post an existing DRAFT customer invoice to the books (like Post on the invoice screen). Does NOT e-mail it — a person sends it.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp, invoice_id: { type: 'integer' },
      reason: { type: 'string' }
    }, required: ['company_id', 'invoice_id', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      const d = await api.request(ctx, a.company_id, 'POST', `/api/accounting/customer-invoices/${parseInt(a.invoice_id, 10)}/post`, {});
      return { posted: true, invoice_id: Number(a.invoice_id), result: d || null, note: 'Not e-mailed. A person sends it to the customer from Ledger Leo.' };
    }
  },
  {
    name: 'list_supplier_invoices',
    description: 'Supplier (purchase) invoices already in the books, with supplier, totals and amount paid. Check here before create_supplier_invoice.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      supplier_id: { type: 'integer' }, status: { type: 'string' }, from_date: isoDate, to_date: isoDate,
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CAP }
    }, required: ['company_id'], additionalProperties: false },
    async run(api, ctx, a) {
      const d = await api.request(ctx, a.company_id, 'GET', '/api/accounting/suppliers/invoices' + qs({ supplierId: a.supplier_id,
        status: a.status, fromDate: a.from_date, toDate: a.to_date }));
      const rows = ((d && d.invoices) || []).map(i => ({ id: i.id, invoice_number: i.invoice_number, reference: i.reference || null,
        date: i.date, due_date: i.due_date || null, supplier_id: i.supplier_id, supplier_name: i.supplier_name || null,
        status: i.status, total: i.total_amount, vat: i.vat_amount, amount_paid: i.amount_paid }));
      return { invoices: rows.slice(0, rowsLimit(a)), total: rows.length };
    }
  },
  {
    name: 'create_supplier_invoice',
    description: 'Capture a supplier (purchase) invoice. In Ledger Leo a supplier invoice is POSTED TO THE BOOKS immediately (there is no draft stage), so only do this from a real invoice document. invoice_number is the supplier\'s own number — required, so the same invoice can never be captured twice. The supplier must already exist (list_suppliers / create_supplier).',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      supplier_id: { type: 'integer', description: 'from list_suppliers' },
      invoice_number: { type: 'string', description: 'the number printed on the supplier\'s invoice' },
      reference: { type: 'string' },
      invoice_date: isoDate, due_date: isoDate,
      vat_inclusive: { type: 'boolean', description: 'true when the amounts include VAT (default false)' },
      lines: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: {
        description: { type: 'string' },
        account_id: { type: 'integer', description: 'expense / asset / cost-of-sales account id (list_accounts)' },
        quantity: { type: 'number', minimum: 0 },
        unit_price: { type: 'number', minimum: 0 },
        vat_rate: { type: 'number', minimum: 0, maximum: 100, description: 'VAT % — a rate from list_vat_settings, or 0' }
      }, required: ['description', 'account_id', 'quantity', 'unit_price', 'vat_rate'], additionalProperties: false } },
      notes: { type: 'string' },
      reason: { type: 'string', description: 'Which document this comes from, e.g. "Vodacom invoice 12345 dated 2026-10-01"' }
    }, required: ['company_id', 'supplier_id', 'invoice_number', 'invoice_date', 'lines', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      if (!String(a.invoice_number).trim()) throw apiError(400, 'invoice_number is required');
      await checkInvoiceLines(api, ctx, a, 'purchase');
      const d = await api.request(ctx, a.company_id, 'POST', '/api/accounting/suppliers/invoices', {
        supplierId: Number(a.supplier_id), invoiceNumber: String(a.invoice_number).trim(), reference: a.reference || undefined,
        invoiceDate: a.invoice_date, dueDate: a.due_date || undefined, vatInclusive: a.vat_inclusive === true, notes: a.notes || undefined,
        lines: a.lines.map(l => ({ description: l.description, accountId: Number(l.account_id),
          quantity: Number(l.quantity), unitPrice: Number(l.unit_price), vatRate: Number(l.vat_rate) })) });
      const inv = (d && (d.invoice || d)) || {};
      return { created: true, posted: true, invoice: { id: inv.id, invoice_number: inv.invoice_number, total: inv.total_amount, status: inv.status } };
    }
  },
  {
    name: 'get_trial_balance',
    description: 'Trial balance of the company for a date range (debits, credits and balance per account), exactly as Ledger Leo calculates it.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp, start_date: isoDate, end_date: isoDate
    }, required: ['company_id', 'start_date', 'end_date'], additionalProperties: false },
    // Older clients may still send from_date / to_date (phase-1 names).
    aliases: { from_date: 'start_date', to_date: 'end_date' },
    async run(api, ctx, a) {
      if (a.start_date > a.end_date) {
        const { LorencoApiError } = require('./lorencoApi');
        throw new LorencoApiError(400, 'start_date must be on or before end_date');
      }
      // Leo's trial-balance contract: ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
      return api.request(ctx, a.company_id, 'GET', '/api/accounting/reports/trial-balance' + qs({ fromDate: a.start_date, toDate: a.end_date }));
    }
  },

  // ── Full Ledger Leo access (Ruan 2026-11-20: the bot is a normal user / accountant) ──────────
  {
    name: 'create_vat_code',
    description: 'Add a VAT code to the company (e.g. standard 15%, zero-rated 0%, exempt, capital goods). Check list_vat_settings first — Leo refuses the same code with the same effective date.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      code: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,30}$', description: 'Short code, e.g. std, zero, exempt, cap' },
      name: { type: 'string', description: 'e.g. "Standard rate 15%"' },
      rate: { type: 'number', minimum: 0, maximum: 100, description: 'Percentage, e.g. 15' },
      is_capital: { type: 'boolean', description: 'Capital goods VAT code' },
      effective_from: isoDate, effective_to: isoDate,
      reason: { type: 'string' }
    }, required: ['company_id', 'code', 'name', 'rate', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      return api.request(ctx, a.company_id, 'POST', '/api/accounting/vat-settings', {
        code: a.code, name: a.name, rate: Number(a.rate), is_capital: !!a.is_capital,
        effective_from: a.effective_from, effective_to: a.effective_to });
    }
  },
  {
    name: 'create_journal',
    description: 'Write a journal (manual journal entry). Debits must equal credits; every line has an account and EITHER a debit OR a credit. With post: true it is posted to the books straight away, otherwise it stays a draft (post it later with leo_request POST /api/accounting/journals/{id}/post). Leo refuses inactive / header accounts and locked periods.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      date: isoDate,
      description: { type: 'string' },
      reference: { type: 'string' },
      lines: { type: 'array', minItems: 2, maxItems: 200, items: { type: 'object', properties: {
        account_id: { type: 'integer' }, debit: { type: 'number', minimum: 0 }, credit: { type: 'number', minimum: 0 },
        description: { type: 'string' }
      }, required: ['account_id'], additionalProperties: false } },
      post: { type: 'boolean', description: 'Post immediately (default false = draft)' },
      reason: { type: 'string' }
    }, required: ['company_id', 'date', 'description', 'lines', 'reason'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      let dr = 0, cr = 0;
      const lines = a.lines.map((l, i) => {
        const d = money(l.debit || 0), c = money(l.credit || 0);
        if ((d > 0) === (c > 0)) throw apiError(400, `Line ${i + 1}: give either a debit or a credit (not both, not neither).`);
        dr += d; cr += c;
        return { accountId: Number(l.account_id), debit: d, credit: c, description: l.description || null };
      });
      if (money(dr) !== money(cr)) throw apiError(400, `Journal does not balance: debits ${money(dr)} vs credits ${money(cr)}.`);
      const j = await api.request(ctx, a.company_id, 'POST', '/api/accounting/journals', {
        date: a.date, description: a.description, reference: a.reference || null, sourceType: 'manual', lines,
        metadata: { via: 'mcp', reason: a.reason }, idempotencyKey: 'mcp-' + (ctx.correlationId || Date.now()) });
      if (!a.post) return { created: true, posted: false, journal: j };
      try {
        const p = await api.request(ctx, a.company_id, 'POST', `/api/accounting/journals/${j.id}/post`, {});
        return { created: true, posted: true, journal: p };
      } catch (e) {
        return { created: true, posted: false, journal_id: j.id, post_error: e.message,
          note_draft: `Journal ${j.id} was saved as a draft but not posted — fix the problem and post THAT draft; do not create it again.` };
      }
    }
  },
  {
    name: 'get_report',
    description: 'Ledger Leo financial reports, exactly as the Reports screens calculate them: profit_loss, balance_sheet, cash_flow, general_ledger (one account, or all), trial_balance, vat_report (one VAT period), customer_aging, supplier_aging, control_accounts (debtors/creditors control vs sub-ledger), unallocated_bank.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      report: { type: 'string', enum: ['profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger', 'trial_balance', 'vat_report',
        'customer_aging', 'supplier_aging', 'control_accounts', 'unallocated_bank'] },
      start_date: isoDate, end_date: isoDate,
      as_of_date: Object.assign({}, isoDate, { description: 'YYYY-MM-DD — balance sheet / aging date (default: end_date or today)' }),
      account_id: { type: 'integer', description: 'general_ledger: one account (leave out for the full ledger)' },
      period_key: { type: 'string', description: 'vat_report: the VAT period key (see leo_request GET /api/accounting/vat-recon/periods)' }
    }, required: ['company_id', 'report'], additionalProperties: false },
    async run(api, ctx, a) {
      const from = a.start_date, to = a.end_date, asOf = a.as_of_date || a.end_date || today();
      const need = (...k) => { for (const x of k) if (!a[x]) throw apiError(400, `${a.report} needs ${k.join(' and ')}`); };
      const base = '/api/accounting';
      let path;
      switch (a.report) {
        case 'profit_loss': need('start_date', 'end_date'); path = base + '/reports/profit-loss' + qs({ fromDate: from, toDate: to }); break;
        case 'balance_sheet': path = base + '/reports/balance-sheet' + qs({ asOfDate: asOf, fromDate: from }); break;
        case 'cash_flow': need('start_date', 'end_date'); path = base + '/reports/cash-flow' + qs({ fromDate: from, toDate: to }); break;
        case 'general_ledger': need('start_date', 'end_date');
          path = base + (a.account_id ? '/reports/general-ledger' : '/reports/general-ledger/full') + qs({ accountId: a.account_id, fromDate: from, toDate: to }); break;
        case 'trial_balance': need('start_date', 'end_date'); path = base + '/reports/trial-balance' + qs({ fromDate: from, toDate: to }); break;
        case 'vat_report': need('period_key'); path = base + '/vat/report' + qs({ periodKey: a.period_key }); break;
        case 'customer_aging': path = base + '/customer-invoices/aging' + qs({ asAt: asOf }); break;
        case 'supplier_aging': path = base + '/suppliers/aging' + qs({ asAt: asOf }); break;
        case 'control_accounts': path = base + '/reports/control-account-reconciliation' + qs({ asAt: asOf }); break;
        case 'unallocated_bank': path = base + '/reports/unallocated-bank-transactions'; break;
      }
      return api.request(ctx, a.company_id, 'GET', path);
    }
  },
  {
    name: 'leo_routes',
    description: 'The list of EVERYTHING you can do in Ledger Leo through leo_request: every route (method + path) with the body / query fields it reads. Search it with "filter" (e.g. "credit-notes", "journals", "payments", "periods", "quotes", "suppliers"). Use it whenever there is no dedicated tool for a task — never tell the user something cannot be done before checking here.',
    inputSchema: { type: 'object', properties: {
      filter: { type: 'string', description: 'Words to match in the path, e.g. "credit-notes" or "void"' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }
    }, additionalProperties: false },
    async run(api, ctx, a) {
      const words = String(a.filter || '').toLowerCase().split(/\s+/).filter(Boolean);
      const rows = routeCatalogue('accounting').filter(r => (!a.method || r.method === a.method) &&
        words.every(w => r.path.toLowerCase().includes(w)));
      return { count: rows.length, routes: rows,
        how: 'Call leo_request with method, path (replace :id etc. with real ids), query and body. Field names are as Leo reads them; when unsure, GET an existing record first and copy its shape. Leo\'s error message tells you what is missing.' };
    }
  },
  {
    name: 'leo_request',
    description: 'Do ANY task in Ledger Leo as this user, like a person on the screens: edit or delete records, void or credit invoices, record customer receipts and supplier payments, quotes, credit notes, purchase orders, journals (edit / post / reverse), periods (lock / unlock), year-end, opening balances, VAT periods and reconciliations, segments, items, bank (unallocate, unreconcile, flip sign, add lines), and every read. Find the route with leo_routes. Leo checks this user\'s permissions and validates everything. Not available: other apps (Paytime, Checkout Charlie …), e-mailing / sending to clients, SARS submissions, system settings and keys, approving your own Bot Review items.',
    inputSchema: { type: 'object', properties: {
      company_id: companyIdProp,
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', pattern: '^/api/accounting/[A-Za-z0-9._~\\-/]+$', description: 'e.g. /api/accounting/credit-notes or /api/accounting/journals/123/reverse' },
      query: { type: 'object', description: 'Query-string values, e.g. {"fromDate":"2026-03-01"}' },
      body: { type: 'object', description: 'JSON body for POST / PUT / PATCH' },
      reason: { type: 'string', description: 'Why (required for anything that changes data)' }
    }, required: ['company_id', 'method', 'path'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      const m = a.method, p = a.path.replace(/\/+$/, '');
      if (m !== 'GET' && !(a.reason && String(a.reason).trim())) throw apiError(400, 'reason is required for anything that changes data');
      if (m === 'GET' && /\/(pdf|file|download)$/.test(p)) throw apiError(400, 'PDF / file downloads are not available through the bot — use the same route without /pdf for the data.');
      // Tasks that have their own tool with extra checks go through that tool.
      if (m === 'POST' && /^\/api\/accounting\/bot-decisions\/(allocate|exception)$/.test(p)) throw apiError(400, 'Use allocate_bank_transaction / flag_for_review for this.');
      if (m === 'POST' && p === '/api/accounting/bank/reconcile') throw apiError(400, 'Use reconcile_bank_transactions (it checks the statement balance first).');
      if (m !== 'GET' && /^\/api\/accounting\/bank\/rules(\/|$)/.test(p)) requirePolicy(ctx, 'allow_create_rules', 'Creating or changing allocation rules');
      if (m === 'POST' && p === '/api/accounting/bank/sean-auto-allocate') requirePolicy(ctx, 'allow_sean_auto', 'Letting Sean allocate by himself');
      const q = {};
      for (const [k, v] of Object.entries(a.query || {})) {
        if (v !== null && typeof v === 'object') throw apiError(400, `query.${k} must be a plain value`);
        q[k] = v;
      }
      return api.request(ctx, a.company_id, m, p + qs(q), m === 'GET' || m === 'DELETE' ? undefined : (a.body || {}));
    }
  },

  // ── Firmflow — practice management (Ruan 2026-11-20) ────────────────────────────────────────
  {
    name: 'firmflow_routes',
    description: 'The list of EVERYTHING you can do in Firmflow (practice management) through firmflow_request: clients and contacts, tasks, time entries / WIP, deadlines and the compliance calendar, engagements, billing, document requests, communications log, reminders, workflows, individual / company / provisional tax work, tax payments, SARS statement recon, disputes, secretarial (registers, meetings, resolutions, beneficial ownership), onboarding, knowledge base, SOPs, risk register, planning board, capacity and reports. Search with "filter" (e.g. "tasks", "time-entries", "deadlines", "individual-tax", "secretarial"). Check here before ever saying a Firmflow task cannot be done.',
    inputSchema: { type: 'object', properties: {
      filter: { type: 'string', description: 'Words to match in the path, e.g. "tasks" or "time-entries"' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }
    }, additionalProperties: false },
    async run(api, ctx, a) {
      const words = String(a.filter || '').toLowerCase().split(/\s+/).filter(Boolean);
      const rows = routeCatalogue('practice').filter(r => (!a.method || r.method === a.method) &&
        words.every(w => r.path.toLowerCase().includes(w)));
      return { count: rows.length, routes: rows,
        how: 'Call firmflow_request with the PRACTICE company_id (the accounting firm, from list_companies — not the client\'s own company), method, path (replace :id etc. with real ids), query and body. When unsure of the fields, GET an existing record first and copy its shape.' };
    }
  },
  {
    name: 'firmflow_request',
    description: 'Do ANY task in Firmflow (practice management) as this user, like a staff member on the screens: add / edit clients and contacts, create and update tasks, log time, manage deadlines, engagements, document requests, the communications log, tax and secretarial work, and submit work for review — plus every read. Find the route with firmflow_routes. company_id is the accounting PRACTICE (firm) company. Firmflow checks this user\'s role. Not available: sign-off (approve / reject / QA lock / partner override / recording reviews — a person signs off; you submit for review), marking SARS submissions as submitted, practice settings, staff and users.',
    inputSchema: { type: 'object', properties: {
      company_id: Object.assign({}, companyIdProp, { description: 'The accounting practice (firm) company id from list_companies' }),
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', pattern: '^/api/practice/[A-Za-z0-9._~\\-/]+$', description: 'e.g. /api/practice/tasks or /api/practice/time-entries' },
      query: { type: 'object', description: 'Query-string values, e.g. {"status":"open"}' },
      body: { type: 'object', description: 'JSON body for POST / PUT / PATCH' },
      reason: { type: 'string', description: 'Why (required for anything that changes data)' }
    }, required: ['company_id', 'method', 'path'], additionalProperties: false },
    write: true,
    async run(api, ctx, a) {
      const m = a.method, p = a.path.replace(/\/+$/, '');
      if (m !== 'GET' && !(a.reason && String(a.reason).trim())) throw apiError(400, 'reason is required for anything that changes data');
      if (m === 'GET' && /\/(pdf|file|download|export)$/.test(p)) throw apiError(400, 'PDF / file downloads are not available through the bot — use the data route instead.');
      const q = {};
      for (const [k, v] of Object.entries(a.query || {})) {
        if (v !== null && typeof v === 'object') throw apiError(400, `query.${k} must be a plain value`);
        q[k] = v;
      }
      return api.request(ctx, a.company_id, m, p + qs(q), m === 'GET' || m === 'DELETE' ? undefined : (a.body || {}));
    }
  }
];

/**
 * Every route of an app, read from the route files themselves (so it never goes stale): the mounts
 * in modules/<app>/index.js — router.use('/x', require('./routes/f')) or router.use('/x', xRouter)
 * with const xRouter = require('./f') — plus routes defined in index.js itself, with the
 * req.body / req.query fields each handler reads. Routes the bot may not use are left out.
 */
const APPS = { accounting: '/api/accounting', practice: '/api/practice' };
const _catalogues = {};
function routeCatalogue(app) {
  if (_catalogues[app]) return _catalogues[app];
  const fs = require('fs');
  const path = require('path');
  const { blockReason } = require('./lorencoApi');
  const base = APPS[app];
  const dir = path.join(__dirname, '..', app);
  const read = (file) => { try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch (_) { return null; } };
  const fields = (seg, src) => {
    const out = new Set();
    const re = new RegExp('const\\s*\\{([^}]+)\\}\\s*=\\s*req\\.' + src, 'g');
    let m;
    while ((m = re.exec(seg))) {
      for (const part of m[1].split(',')) {
        const name = part.split(/[:=]/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
      }
    }
    const re2 = new RegExp('req\\.' + src + '\\.([A-Za-z_$][\\w$]*)', 'g');
    while ((m = re2.exec(seg))) out.add(m[1]);
    return [...out];
  };
  const rows = [];
  const seen = new Set();
  const addRoutes = (src, prefix) => {
    const routeRe = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    const hits = [];
    let r;
    while ((r = routeRe.exec(src))) hits.push({ method: r[1].toUpperCase(), sub: r[2], at: r.index });
    hits.forEach((h, i) => {
      const seg = src.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : src.length);
      const sub = h.sub.replace(/\([^)]*\)/g, '');
      const full = (prefix + (sub === '/' ? '' : sub)).replace(/\/+$/, '') || prefix;
      if (/\/(pdf|file|download|export)$/.test(full)) return;
      if (blockReason(h.method, full.replace(/:[A-Za-z]+/g, '1'))) return;
      const key = h.method + ' ' + full;
      if (seen.has(key)) return;
      seen.add(key);
      const row = { method: h.method, path: full };
      const b = h.method === 'GET' || h.method === 'DELETE' ? [] : fields(seg, 'body');
      const q = fields(seg, 'query');
      if (b.length) row.body = b;
      if (q.length) row.query = q;
      rows.push(row);
    });
  };
  const index = read('index.js') || '';
  const vars = {};
  const varRe = /const\s+(\w+)\s*=\s*require\('\.\/([^']+?)(?:\.js)?'\)/g;
  let v;
  while ((v = varRe.exec(index))) vars[v[1]] = v[2];
  const mountRe = /router\.use\(\s*'([^']+)'\s*,\s*(?:require\('\.\/([^']+?)(?:\.js)?'\)|(\w+))\s*\)/g;
  let mm;
  while ((mm = mountRe.exec(index))) {
    const file = mm[2] || vars[mm[3]];
    if (!file) continue;
    const src = read(file + '.js');
    if (src) addRoutes(src, base + (mm[1] === '/' ? '' : mm[1]));
  }
  addRoutes(index, base);            // routes defined in index.js itself (e.g. Firmflow clients, tasks, time)
  _catalogues[app] = rows;
  return rows;
}

/** Minimal JSON-schema check for our tool schemas. Returns an error string or null. */
function checkValue(p, v, k) {
  if (p.type === 'integer' && !(Number.isInteger(Number(v)) && String(v).trim() !== '' && typeof v !== 'boolean')) return `${k} must be a whole number`;
  if (p.type === 'number' && !(typeof v === 'number' ? isFinite(v) : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))))) return `${k} must be a number`;
  if (p.type === 'boolean' && typeof v !== 'boolean') return `${k} must be true or false`;
  if (p.type === 'string' && typeof v !== 'string') return `${k} must be text`;
  if (p.type === 'object' && !p.properties && (typeof v !== 'object' || Array.isArray(v))) return `${k} must be an object`;
  if (p.enum && !p.enum.includes(v)) return `${k} must be one of: ${p.enum.join(', ')}`;
  if (p.pattern && !new RegExp(p.pattern).test(String(v))) return `${k} must look like ${p.description || p.pattern}`;
  if (p.minimum != null && Number(v) < p.minimum) return `${k} must be at least ${p.minimum}`;
  if (p.maximum != null && Number(v) > p.maximum) return `${k} must be at most ${p.maximum}`;
  if (p.type === 'array') {
    if (!Array.isArray(v)) return `${k} must be a list`;
    if (p.minItems != null && v.length < p.minItems) return `${k} needs at least ${p.minItems} item(s)`;
    if (p.maxItems != null && v.length > p.maxItems) return `${k} may have at most ${p.maxItems} items`;
    for (let i = 0; i < v.length; i++) {
      const bad = p.items && (p.items.type === 'object' ? validateArgs(p.items, v[i], `${k}[${i}].`) : checkValue(p.items, v[i], `${k}[${i}]`));
      if (bad) return bad;
    }
  }
  return null;
}
function validateArgs(schema, args, prefix = '') {
  const a = args || {};
  if (typeof a !== 'object' || Array.isArray(a)) return `${prefix || 'arguments'} must be an object`.replace('. must', ' must');
  for (const k of schema.required || []) {
    if (a[k] === undefined || a[k] === null || a[k] === '') return `${prefix}${k} is required`;
  }
  for (const [k, v] of Object.entries(a)) {
    const p = (schema.properties || {})[k];
    if (!p) { if (schema.additionalProperties === false) return `unknown argument: ${prefix}${k}`; continue; }
    if (v === undefined || v === null) continue;
    const bad = checkValue(p, v, prefix + k);
    if (bad) return bad;
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
