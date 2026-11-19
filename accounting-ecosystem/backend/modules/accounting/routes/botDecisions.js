'use strict';

/**
 * ============================================================================
 * Bot decisions — /api/accounting/bot-decisions   (migration 187, Codebox 4)
 * ============================================================================
 * The ONLY way a bot (personal access key through /mcp) allocates a bank line.
 * The rules live here, server-side (services/botDecisionService.js) — never only
 * in the bot's prompt.
 *
 *   Bot (req.user.via === 'api_token'):
 *     POST /allocate     decide → post now through the normal allocate path, or
 *                        hold for a person, or refuse; always recorded
 *     POST /exception    raise a bank line for a person to look at
 *   Bot and people:
 *     GET  /             decisions (filter by status) — the bot's review report
 *   People only (never a bot):
 *     POST /:id/approve  post the (possibly corrected) allocation as THIS person
 *     POST /:id/reject   close it without posting
 *
 * Approval posts through allocateBankTransaction with the approving person's own
 * request, so Leo's permission, VAT, validation, audit and Sean learning apply and
 * Sean learns the PERSON's decision.
 * ============================================================================
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const AuditLogger = require('../services/auditLogger');
const { normalizeBankDescription } = require('../services/bankDescriptionNormalizer');
const { matchBankRule } = require('../services/bankRuleMatcher');
const { evaluateAllocation, HOLD_LABELS } = require('../services/botDecisionService');
const SeanBankAllocation = require('../../../sean/bank-allocation-engine');
const bankLearning = require('../../../sean/bank-learning');
const ApiTokens = require('../../../shared/services/apiTokens');

const isBot = (req) => req.user && req.user.via === 'api_token';
const botOnly = (req, res, next) => isBot(req) ? next()
  : res.status(403).json({ success: false, error: 'This endpoint is for the bot connection. People allocate on the Banking screen.' });
const humanOnly = (req, res, next) => !isBot(req) ? next()
  : res.status(403).json({ success: false, error: 'Only a person can approve or reject a bot decision.' });

const cleanText = (v, max = 2000) => (v == null ? null : String(v).trim().slice(0, max) || null);

/** The key's policy — looked up fresh, bound to this user (a bot can never set it). */
async function botPolicy(req) {
  if (!req.user.apiTokenId) return ApiTokens.normalizePolicy({});
  const { data } = await supabase.from('user_api_tokens').select('policy, user_id, revoked_at')
    .eq('id', req.user.apiTokenId).maybeSingle();
  if (!data || data.revoked_at || Number(data.user_id) !== Number(req.user.id)) {
    const e = new Error('This bot key is no longer valid'); e.status = 401; throw e;
  }
  return ApiTokens.normalizePolicy(data.policy);
}

/** Approved rule that applies to this line — same query and matcher as GET /bank/rules/suggest. */
async function applicableRule(companyId, txn) {
  const { data: rules, error } = await supabase.from('bank_allocation_rules')
    .select('id, match_type, match_pattern, normalized_pattern, account_id, vat_setting_id, priority, accounts!account_id(id, code, name, is_active, is_postable)')
    .eq('company_id', companyId).eq('is_active', true)
    .order('priority', { ascending: true }).order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  const match = matchBankRule(rules || [], normalizeBankDescription(txn.description || ''));
  if (!match || !match.accounts || match.accounts.is_active === false || match.accounts.is_postable === false) return null;
  return { ruleId: match.id, accountId: match.account_id, accountCode: match.accounts.code, accountName: match.accounts.name,
    vatSettingId: match.vat_setting_id || null, matchPattern: match.match_pattern, matchType: match.match_type };
}

async function seanSuggestion(companyId, txnId) {
  try {
    const all = await SeanBankAllocation.suggestForTransactions(supabase, companyId, [txnId], {
      getApprovedGlobalPatterns: () => bankLearning.getPatterns({ status: 'approved' }),
      normalizeForGlobal: bankLearning.normalizeDescription
    });
    const s = all && (all[txnId] || all[String(txnId)]);
    return s ? { accountId: s.accountId, accountCode: s.accountCode || null, accountName: s.accountName || null,
      vatSettingId: s.vatSettingId || null, confidence: s.confidence, source: s.source, reason: s.reason || null } : null;
  } catch (e) {
    console.warn('[bot-decisions] Sean suggestion failed:', e.message);
    return null;
  }
}

function toLines(raw) {
  return (Array.isArray(raw) ? raw : []).map(l => {
    const line = { accountId: parseInt(l.accountId ?? l.account_id, 10), amount: Math.round(Number(l.amount) * 100) / 100 };
    const vs = l.vatSettingId ?? l.vat_setting_id;
    if (vs != null && vs !== '') line.vatSettingId = parseInt(vs, 10);
    if ((l.vatInclusive ?? l.vat_inclusive) === false) line.vatInclusive = false;
    if (l.description) line.description = String(l.description).slice(0, 300);
    return line;
  });
}

async function recordDecision(row) {
  const { data, error } = await supabase.from('bot_decisions').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') { const e = new Error('This bank line is already waiting for a person (see the Bot Review page).'); e.status = 409; throw e; }
    throw new Error('Could not record the decision: ' + error.message);
  }
  return data;
}

// ─── POST /allocate (bot) ─────────────────────────────────────────────────────
router.post('/allocate', authenticate, botOnly, hasPermission('bank.allocate'), async (req, res) => {
  const companyId = req.user.companyId;
  try {
    const b = req.body || {};
    const txnId = parseInt(b.bankTransactionId, 10);
    if (!(txnId > 0)) return res.status(400).json({ success: false, error: 'bankTransactionId is required' });
    const policy = await botPolicy(req);
    const lines = toLines(b.lines);

    const [{ data: txn }, { data: accounts }, { data: banks }] = await Promise.all([
      supabase.from('bank_transactions').select('id, amount, description, status, date, bank_account_id')
        .eq('id', txnId).eq('company_id', companyId).maybeSingle(),
      supabase.from('accounts').select('id, code, name, is_active, is_postable, sub_type, reporting_group').eq('company_id', companyId),
      supabase.from('bank_accounts').select('ledger_account_id').eq('company_id', companyId)
    ]);
    const [rule, sean] = txn && txn.status === 'unmatched'
      ? await Promise.all([applicableRule(companyId, txn), seanSuggestion(companyId, txnId)]) : [null, null];

    const verdict = evaluateAllocation({
      txn, lines, rule, sean, policy,
      accountsById: new Map((accounts || []).map(a => [Number(a.id), a])),
      bankLedgerIds: new Set((banks || []).map(x => Number(x.ledger_account_id)).filter(Boolean)),
      reason: b.reason, disagreementReason: b.disagreementReason,
      decisionSource: ['rule', 'sean', 'evidence', 'bot'].includes(b.decisionSource) ? b.decisionSource : null
    });

    const base = {
      company_id: companyId, bot_user_id: req.user.id, api_token_id: req.user.apiTokenId || null,
      correlation_id: cleanText(b.correlationId, 64), action: 'allocate', entity_type: 'bank_transaction', entity_id: txnId,
      proposed: { lines, description: cleanText(b.description, 300) },
      rule_suggestion: rule, sean_suggestion: sean,
      reason: cleanText(b.reason) || '(no reason given)', disagreement_reason: cleanText(b.disagreementReason),
      evidence: cleanText(b.evidence), decision_source: verdict.decisionSource
    };

    if (verdict.outcome === 'refuse') {
      // Refusals are not queued; Leo's audit records them so nothing a bot tried is invisible.
      AuditLogger.logUserAction(req, 'BOT_ALLOCATION_REFUSED', 'BANK_TRANSACTION', txnId, null,
        { code: verdict.code, lines, rule, sean }, verdict.message).catch(() => {});
      const status = verdict.code === 'TRANSACTION_NOT_FOUND' ? 404 : verdict.code === 'ALREADY_ALLOCATED' ? 409 : 422;
      return res.status(status).json({ success: false, outcome: 'refused', errorCode: verdict.code, error: verdict.message,
        rule_suggestion: rule, sean_suggestion: sean });
    }

    if (verdict.outcome === 'hold') {
      const d = await recordDecision(Object.assign(base, { status: 'pending_approval', hold_reasons: verdict.holdReasons }));
      AuditLogger.logUserAction(req, 'BOT_ALLOCATION_HELD', 'BANK_TRANSACTION', txnId, null,
        { decisionId: d.id, holdReasons: verdict.holdReasons }, 'Bot allocation waiting for approval').catch(() => {});
      return res.status(202).json({ success: true, outcome: 'pending_approval', decision_id: d.id,
        hold_reasons: verdict.holdReasons.map(h => HOLD_LABELS[h] || h), rule_suggestion: rule, sean_suggestion: sean,
        message: 'Not posted — waiting for a person on the Bot Review page.' });
    }

    // Post through the ONE posting path (journal, VAT, validation, audit, Sean learning).
    const { allocateBankTransaction } = require('./bank');
    const result = await allocateBankTransaction(req, txnId, {
      lines, description: base.proposed.description || undefined, allocationType: 'account',
      appliedRuleId: rule ? rule.ruleId : undefined
    });
    const posted = result.status >= 200 && result.status < 300;
    const journalId = posted && result.body && result.body.journal ? result.body.journal.id : null;
    const d = await recordDecision(Object.assign(base, posted
      ? { status: 'posted', journal_id: journalId }
      : { status: 'failed', error: cleanText(result.body && result.body.error, 500) }));
    return res.status(posted ? 201 : result.status).json(posted
      ? { success: true, outcome: 'posted', decision_id: d.id, journal_id: journalId, decision_source: verdict.decisionSource,
          rule_suggestion: rule, sean_suggestion: sean }
      : Object.assign({ outcome: 'failed', decision_id: d.id }, result.body));
  } catch (err) {
    console.error('[bot-decisions/allocate]', err.message);
    return res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'Could not process the bot allocation' });
  }
});

// ─── POST /exception (bot) ────────────────────────────────────────────────────
router.post('/exception', authenticate, botOnly, hasPermission('bank.view'), async (req, res) => {
  const companyId = req.user.companyId;
  try {
    const b = req.body || {};
    const txnId = parseInt(b.bankTransactionId, 10);
    if (!(txnId > 0)) return res.status(400).json({ success: false, error: 'bankTransactionId is required' });
    if (!cleanText(b.reason) || cleanText(b.reason).length < 5) return res.status(400).json({ success: false, error: 'reason is required' });
    const { data: txn } = await supabase.from('bank_transactions').select('id, description, status')
      .eq('id', txnId).eq('company_id', companyId).maybeSingle();
    if (!txn) return res.status(404).json({ success: false, error: 'Bank transaction not found in this company' });
    const [rule, sean] = txn.status === 'unmatched' ? await Promise.all([applicableRule(companyId, txn), seanSuggestion(companyId, txnId)]) : [null, null];
    const lines = toLines(b.lines);
    const d = await recordDecision({
      company_id: companyId, bot_user_id: req.user.id, api_token_id: req.user.apiTokenId || null,
      correlation_id: cleanText(b.correlationId, 64), action: 'exception', entity_type: 'bank_transaction', entity_id: txnId,
      status: 'exception', proposed: lines.length ? { lines } : null, rule_suggestion: rule, sean_suggestion: sean,
      reason: cleanText(b.reason), evidence: cleanText(b.evidence), hold_reasons: ['exception'], decision_source: null
    });
    AuditLogger.logUserAction(req, 'BOT_EXCEPTION_RAISED', 'BANK_TRANSACTION', txnId, null, { decisionId: d.id }, cleanText(b.reason, 500)).catch(() => {});
    return res.status(201).json({ success: true, outcome: 'exception', decision_id: d.id });
  } catch (err) {
    console.error('[bot-decisions/exception]', err.message);
    return res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'Could not record the exception' });
  }
});

// ─── GET / (bot + people) ─────────────────────────────────────────────────────
router.get('/', authenticate, hasPermission('bank.view'), async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    let q = supabase.from('bot_decisions').select('*').eq('company_id', companyId)
      .order('created_at', { ascending: false }).limit(limit);
    if (req.query.status) q = q.in('status', String(req.query.status).split(',').map(s => s.trim()).filter(Boolean));
    if (req.query.since) q = q.gte('created_at', req.query.since);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = data || [];

    // Bank line + account names for the reviewer (one query each, company-scoped)
    const txnIds = [...new Set(rows.map(r => r.entity_id))];
    const acctIds = new Set();
    rows.forEach(r => {
      ((r.proposed && r.proposed.lines) || []).forEach(l => acctIds.add(Number(l.accountId)));
      if (r.sean_suggestion && r.sean_suggestion.accountId) acctIds.add(Number(r.sean_suggestion.accountId));
      if (r.rule_suggestion && r.rule_suggestion.accountId) acctIds.add(Number(r.rule_suggestion.accountId));
    });
    const [{ data: txns }, { data: accts }, { data: users }] = await Promise.all([
      txnIds.length ? supabase.from('bank_transactions').select('id, date, description, amount, status, bank_account_id')
        .eq('company_id', companyId).in('id', txnIds) : { data: [] },
      acctIds.size ? supabase.from('accounts').select('id, code, name').eq('company_id', companyId).in('id', [...acctIds]) : { data: [] },
      supabase.from('users').select('id, full_name').in('id', [...new Set(rows.flatMap(r => [r.bot_user_id, r.reviewed_by]).filter(Boolean))])
    ]);
    const tMap = new Map((txns || []).map(t => [Number(t.id), t]));
    const aMap = new Map((accts || []).map(a => [Number(a.id), a]));
    const uMap = new Map((users || []).map(u => [Number(u.id), u.full_name]));
    const decisions = rows.map(r => Object.assign({}, r, {
      bank_line: tMap.get(Number(r.entity_id)) || null,
      bot_name: uMap.get(Number(r.bot_user_id)) || null,
      reviewed_by_name: r.reviewed_by ? uMap.get(Number(r.reviewed_by)) || null : null,
      hold_labels: (r.hold_reasons || []).map(h => HOLD_LABELS[h] || h),
      accounts: Object.fromEntries([...aMap].map(([k, v]) => [k, v.code + ' ' + v.name]))
    }));
    const counts = {};
    rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
    res.json({ success: true, decisions, counts });
  } catch (err) {
    console.error('[bot-decisions/list]', err.message);
    res.status(500).json({ success: false, error: 'Could not load bot decisions' });
  }
});

async function openDecision(req, res) {
  const id = parseInt(req.params.id, 10);
  const { data: d } = await supabase.from('bot_decisions').select('*')
    .eq('id', id).eq('company_id', req.user.companyId).maybeSingle();
  if (!d) { res.status(404).json({ success: false, error: 'Decision not found' }); return null; }
  if (!['pending_approval', 'exception'].includes(d.status)) {
    res.status(409).json({ success: false, error: `This decision is already ${d.status}` }); return null;
  }
  return d;
}

// ─── POST /:id/approve (people) ───────────────────────────────────────────────
router.post('/:id/approve', authenticate, humanOnly, hasPermission('bank.allocate'), async (req, res) => {
  try {
    const d = await openDecision(req, res);
    if (!d) return;
    const b = req.body || {};
    const lines = Array.isArray(b.lines) && b.lines.length ? toLines(b.lines) : toLines(d.proposed && d.proposed.lines);
    if (!lines.length) return res.status(400).json({ success: false, error: 'Choose the account(s) to post to.' });
    const { allocateBankTransaction } = require('./bank');
    const result = await allocateBankTransaction(req, d.entity_id, {
      lines, description: (d.proposed && d.proposed.description) || undefined, allocationType: 'account',
      appliedRuleId: d.rule_suggestion && d.rule_suggestion.ruleId && lines.every(l => l.accountId === Number(d.rule_suggestion.accountId))
        ? d.rule_suggestion.ruleId : undefined
    });
    if (result.status < 200 || result.status >= 300) return res.status(result.status).json(result.body);
    const journalId = result.body && result.body.journal ? result.body.journal.id : null;
    const changed = JSON.stringify(lines) !== JSON.stringify(toLines(d.proposed && d.proposed.lines));
    await supabase.from('bot_decisions').update({
      status: 'approved', journal_id: journalId, reviewed_by: req.user.id, reviewed_at: new Date().toISOString(),
      review_note: cleanText(b.note, 1000), updated_at: new Date().toISOString(),
      proposed: changed ? Object.assign({}, d.proposed, { approved_lines: lines }) : d.proposed
    }).eq('id', d.id).eq('company_id', req.user.companyId);
    AuditLogger.logUserAction(req, 'BOT_DECISION_APPROVED', 'BANK_TRANSACTION', d.entity_id, null,
      { decisionId: d.id, journalId, changed }, cleanText(b.note, 500)).catch(() => {});
    res.json({ success: true, journal_id: journalId, changed });
  } catch (err) {
    console.error('[bot-decisions/approve]', err.message);
    res.status(500).json({ success: false, error: 'Could not approve' });
  }
});

// ─── POST /:id/reject (people) ────────────────────────────────────────────────
router.post('/:id/reject', authenticate, humanOnly, hasPermission('bank.allocate'), async (req, res) => {
  try {
    const d = await openDecision(req, res);
    if (!d) return;
    await supabase.from('bot_decisions').update({
      status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(),
      review_note: cleanText((req.body || {}).note, 1000), updated_at: new Date().toISOString()
    }).eq('id', d.id).eq('company_id', req.user.companyId);
    AuditLogger.logUserAction(req, 'BOT_DECISION_REJECTED', 'BANK_TRANSACTION', d.entity_id, null, { decisionId: d.id },
      cleanText((req.body || {}).note, 500)).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error('[bot-decisions/reject]', err.message);
    res.status(500).json({ success: false, error: 'Could not reject' });
  }
});

module.exports = router;
module.exports._internal = { applicableRule, seanSuggestion, toLines };
