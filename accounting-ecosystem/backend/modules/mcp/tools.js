'use strict';

/**
 * MCP tools — Ledger Leo, read-only (phase 1).
 * Every tool calls an EXISTING Leo endpoint as the token's user; Leo enforces the user's
 * role, companies and permissions. A tool never computes accounting itself.
 * Phase 2 (Ruan 2026-11-19): bank write tools — import a PDF statement, confirm/reject
 * staged lines, allocate, Sean suggestions / auto-allocate, allocation rules and bank
 * reconciliation. They call the SAME Leo routes as the screens (allow-listed in
 * lorencoApi.js), so Leo validates, posts, audits and Sean learns exactly as for a person.
 * Never built as tools: deleting records, SARS submissions, payments, period close/reopen,
 * final approval of financial statements, users/permissions, contacting clients.
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
        note: 'Read tools plus bank write tools; what you may do depends on this user\'s role in each company.' };
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
    description: 'Allocate one unallocated bank transaction. Leo checks it server-side first: an approved allocation rule that applies may NOT be overridden (refused); if Sean confidently recommends another account you must give disagreement_reason and it WAITS for a person; director/owner lines, transfers between own bank accounts and keys set to "approve everything" also WAIT for a person. Otherwise Leo posts the journal (VAT split by Leo, same path as the Banking screen) and Sean learns from it. Line amounts are positive and must add up to the transaction amount. Always give reason.',
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
      return { policy: ctx.policy || {}, always_needs_a_person: ['director / owner / shareholder lines', 'transfers between own bank accounts',
        'allocations that differ from a confident Sean recommendation'], never_available: ['deleting records', 'SARS submissions',
        'payments', 'closing or reopening periods', 'approving financial statements', 'changing users or permissions', 'contacting clients'] };
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
  }
];

/** Minimal JSON-schema check for our tool schemas. Returns an error string or null. */
function checkValue(p, v, k) {
  if (p.type === 'integer' && !(Number.isInteger(Number(v)) && String(v).trim() !== '' && typeof v !== 'boolean')) return `${k} must be a whole number`;
  if (p.type === 'number' && !(typeof v === 'number' ? isFinite(v) : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))))) return `${k} must be a number`;
  if (p.type === 'boolean' && typeof v !== 'boolean') return `${k} must be true or false`;
  if (p.type === 'string' && typeof v !== 'string') return `${k} must be text`;
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
