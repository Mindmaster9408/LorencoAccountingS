/**
 * ============================================================================
 * Bank Allocation Rules Routes
 * ============================================================================
 * Mounted at /api/accounting/bank/rules (via accounting/index.js)
 *
 * Rules are suggest-only in Phase 1. No rule auto-posts to the GL.
 * The existing POST /api/accounting/bank/transactions/:id/allocate endpoint
 * remains the only posting path.
 *
 * Intelligence priority (enforced here, documented in future roadmap):
 *   1. Company bank rules  ← this file
 *   2. Sean AI             ← future, separate addon
 *   3. Manual selection
 *
 * Multi-tenant: all queries scoped by req.companyId (set by auth middleware).
 * ============================================================================
 */

const express = require('express');
const router  = express.Router();
const { supabase }   = require('../../../config/database');
const AuditLogger    = require('../services/auditLogger');
const { authenticate, hasPermission } = require('../middleware/auth');
const { normalizeBankDescription } = require('../services/bankDescriptionNormalizer');

function userId(req) {
  return req.user && req.user.userId ? req.user.userId : (req.user && req.user.id ? req.user.id : null);
}

// ─── GET / — List rules for current company ───────────────────────────────────
router.get('/', authenticate, hasPermission('bank.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;

  try {
    const { data, error } = await supabase
      .from('bank_allocation_rules')
      .select(`
        id, match_type, match_pattern, normalized_pattern, allocation_type,
        account_id, vat_setting_id, priority, is_active, source,
        created_by_user_id, created_at, updated_at, last_applied_at, apply_count,
        accounts!account_id(code, name),
        vat_settings!vat_setting_id(code, name, rate)
      `)
      .eq('company_id', companyId)
      .order('priority', { ascending: true })
      .order('updated_at', { ascending: false });

    if (error) throw new Error(error.message);

    const rules = (data || []).map(r => ({
      id:               r.id,
      matchType:        r.match_type,
      matchPattern:     r.match_pattern,
      normalizedPattern: r.normalized_pattern,
      allocationType:   r.allocation_type,
      accountId:        r.account_id,
      accountCode:      r.accounts?.code || null,
      accountName:      r.accounts?.name || null,
      vatSettingId:     r.vat_setting_id,
      vatSettingCode:   r.vat_settings?.code || null,
      vatSettingName:   r.vat_settings?.name || null,
      vatRate:          r.vat_settings?.rate || null,
      priority:         r.priority,
      isActive:         r.is_active,
      source:           r.source,
      createdAt:        r.created_at,
      updatedAt:        r.updated_at,
      lastAppliedAt:    r.last_applied_at,
      applyCount:       r.apply_count,
    }));

    res.json({ rules, count: rules.length });
  } catch (err) {
    console.error('GET /bank/rules error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST / — Create a rule ───────────────────────────────────────────────────
router.post('/', authenticate, hasPermission('bank.manage'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const { matchType = 'contains', matchPattern, accountId, vatSettingId, priority = 100 } = req.body;

  if (!matchPattern || !matchPattern.trim()) {
    return res.status(400).json({ error: 'match_pattern is required' });
  }
  if (!accountId) {
    return res.status(400).json({ error: 'account_id is required' });
  }

  const normalizedPattern = normalizeBankDescription(matchPattern);
  if (!normalizedPattern) {
    return res.status(422).json({ error: 'The match pattern produces an empty normalised value. Use a more descriptive pattern.' });
  }

  try {
    // Validate account belongs to this company, is active, and is postable
    const { data: acct, error: acctErr } = await supabase
      .from('accounts')
      .select('id, code, name, is_active, is_postable')
      .eq('id', parseInt(accountId))
      .eq('company_id', companyId)
      .maybeSingle();

    if (acctErr) throw new Error(acctErr.message);
    if (!acct) {
      return res.status(422).json({ error: 'The selected account does not exist or does not belong to this company.' });
    }
    if (acct.is_active === false) {
      return res.status(422).json({ error: `Account ${acct.code} (${acct.name}) is inactive. Select an active account.` });
    }
    if (acct.is_postable === false) {
      return res.status(422).json({
        error: `Account ${acct.code} (${acct.name}) is a parent/header account and cannot be used for bank rules. Select a sub-account instead.`
      });
    }

    // Validate VAT setting if supplied
    if (vatSettingId) {
      const { data: vs } = await supabase
        .from('vat_settings')
        .select('id, name')
        .eq('id', parseInt(vatSettingId))
        .eq('company_id', companyId)
        .maybeSingle();

      if (!vs) {
        return res.status(422).json({ error: 'The selected VAT setting does not exist or does not belong to this company.' });
      }
    }

    const { data: rule, error: ruleErr } = await supabase
      .from('bank_allocation_rules')
      .insert({
        company_id:         companyId,
        match_type:         matchType,
        match_pattern:      matchPattern.trim(),
        normalized_pattern: normalizedPattern,
        allocation_type:    'account',
        account_id:         parseInt(accountId),
        vat_setting_id:     vatSettingId ? parseInt(vatSettingId) : null,
        priority:           parseInt(priority) || 100,
        is_active:          true,
        source:             'user',
        created_by_user_id: userId(req),
      })
      .select()
      .single();

    if (ruleErr) throw new Error(ruleErr.message);

    await AuditLogger.log({
      companyId,
      actorType:  'USER',
      actorId:    userId(req),
      actionType: 'BANK_RULE_CREATED',
      entityType: 'BANK_ALLOCATION_RULE',
      entityId:   rule.id,
      beforeJson: null,
      afterJson:  {
        matchType, matchPattern: matchPattern.trim(), normalizedPattern,
        accountId: acct.id, accountCode: acct.code, accountName: acct.name,
        vatSettingId: vatSettingId || null, priority: rule.priority,
      },
      reason: 'Bank allocation rule created',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(201).json({ rule });
  } catch (err) {
    console.error('POST /bank/rules error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /:id — Update a rule ─────────────────────────────────────────────────
router.put('/:id', authenticate, hasPermission('bank.manage'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const ruleId    = parseInt(req.params.id);
  const { matchType, matchPattern, accountId, vatSettingId, priority, isActive } = req.body;

  try {
    const { data: existing, error: fetchErr } = await supabase
      .from('bank_allocation_rules')
      .select('*')
      .eq('id', ruleId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    const updatePayload = {};

    if (matchPattern !== undefined) {
      if (!matchPattern.trim()) {
        return res.status(400).json({ error: 'match_pattern cannot be blank' });
      }
      updatePayload.match_pattern      = matchPattern.trim();
      updatePayload.normalized_pattern = normalizeBankDescription(matchPattern);
      if (!updatePayload.normalized_pattern) {
        return res.status(422).json({ error: 'The match pattern produces an empty normalised value.' });
      }
    }
    if (matchType !== undefined)  updatePayload.match_type = matchType;
    if (priority  !== undefined)  updatePayload.priority   = parseInt(priority) || 100;
    if (isActive  !== undefined)  updatePayload.is_active  = Boolean(isActive);

    if (accountId !== undefined) {
      const { data: acct } = await supabase
        .from('accounts')
        .select('id, code, name, is_active, is_postable')
        .eq('id', parseInt(accountId))
        .eq('company_id', companyId)
        .maybeSingle();

      if (!acct) return res.status(422).json({ error: 'Account not found for this company.' });
      if (acct.is_active === false) return res.status(422).json({ error: `Account ${acct.code} is inactive.` });
      if (acct.is_postable === false) {
        return res.status(422).json({ error: `Account ${acct.code} (${acct.name}) is a parent/header account. Select a sub-account.` });
      }
      updatePayload.account_id = parseInt(accountId);
    }

    if (vatSettingId !== undefined) {
      if (vatSettingId === null || vatSettingId === '') {
        updatePayload.vat_setting_id = null;
      } else {
        const { data: vs } = await supabase
          .from('vat_settings')
          .select('id')
          .eq('id', parseInt(vatSettingId))
          .eq('company_id', companyId)
          .maybeSingle();
        if (!vs) return res.status(422).json({ error: 'VAT setting not found for this company.' });
        updatePayload.vat_setting_id = parseInt(vatSettingId);
      }
    }

    const { data: updated, error: updErr } = await supabase
      .from('bank_allocation_rules')
      .update(updatePayload)
      .eq('id', ruleId)
      .eq('company_id', companyId)
      .select()
      .single();

    if (updErr) throw new Error(updErr.message);

    await AuditLogger.log({
      companyId,
      actorType:  'USER',
      actorId:    userId(req),
      actionType: 'BANK_RULE_UPDATED',
      entityType: 'BANK_ALLOCATION_RULE',
      entityId:   ruleId,
      beforeJson: { ...existing },
      afterJson:  updatePayload,
      reason: 'Bank allocation rule updated',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ rule: updated });
  } catch (err) {
    console.error('PUT /bank/rules/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /:id — Soft deactivate (no hard delete) ──────────────────────────
router.delete('/:id', authenticate, hasPermission('bank.manage'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId = req.companyId;
  const ruleId    = parseInt(req.params.id);

  try {
    const { data: existing } = await supabase
      .from('bank_allocation_rules')
      .select('id, match_pattern, is_active')
      .eq('id', ruleId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    if (!existing.is_active) return res.status(409).json({ error: 'Rule is already inactive' });

    await supabase
      .from('bank_allocation_rules')
      .update({ is_active: false })
      .eq('id', ruleId)
      .eq('company_id', companyId);

    await AuditLogger.log({
      companyId,
      actorType:  'USER',
      actorId:    userId(req),
      actionType: 'BANK_RULE_DEACTIVATED',
      entityType: 'BANK_ALLOCATION_RULE',
      entityId:   ruleId,
      beforeJson: { is_active: true },
      afterJson:  { is_active: false },
      reason: `Bank allocation rule deactivated: "${existing.match_pattern}"`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ message: 'Rule deactivated', ruleId });
  } catch (err) {
    console.error('DELETE /bank/rules/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /suggest — Match an unmatched bank transaction against active rules ──
//
// Returns the highest-priority matching rule or null.
// Matching pipeline (in order):
//   1. exact   — normalized(description) === rule.normalized_pattern
//   2. contains — normalized(description) includes rule.normalized_pattern
//   3. starts_with — normalized(description) starts with rule.normalized_pattern
// Lower priority number wins. Tie-break: newest updated_at.
//
// Only status='unmatched' transactions may receive a suggestion.
// Fires BANK_RULE_SUGGESTED audit log when a match is found.
// Updates last_applied_at and apply_count on the matched rule.

router.get('/suggest', authenticate, hasPermission('bank.view'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not available' });
  const companyId    = req.companyId;
  const { bankTransactionId } = req.query;

  if (!bankTransactionId) {
    return res.status(400).json({ error: 'bankTransactionId query parameter is required' });
  }

  try {
    // Fetch the transaction — scoped to company, must be unmatched
    const { data: txn, error: txnErr } = await supabase
      .from('bank_transactions')
      .select('id, description, status, bank_account_id')
      .eq('id', parseInt(bankTransactionId))
      .eq('company_id', companyId)
      .maybeSingle();

    if (txnErr) throw new Error(txnErr.message);
    if (!txn) return res.status(404).json({ error: 'Bank transaction not found' });
    if (txn.status !== 'unmatched') {
      return res.json({ suggestion: null, reason: 'Transaction is not unmatched' });
    }

    // Fetch all active rules for this company, ordered by priority then newest
    const { data: rules, error: rulesErr } = await supabase
      .from('bank_allocation_rules')
      .select(`
        id, match_type, match_pattern, normalized_pattern,
        account_id, vat_setting_id, priority,
        accounts!account_id(id, code, name, is_active, is_postable),
        vat_settings!vat_setting_id(id, code, name, rate)
      `)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('priority', { ascending: true })
      .order('updated_at', { ascending: false });

    if (rulesErr) throw new Error(rulesErr.message);
    if (!rules || rules.length === 0) return res.json({ suggestion: null });

    const normalizedDesc = normalizeBankDescription(txn.description || '');

    // Run matching pipeline
    let match = null;

    // Pass 1: exact
    for (const rule of rules) {
      if (rule.match_type === 'exact' && normalizedDesc === rule.normalized_pattern) {
        match = rule;
        break;
      }
    }
    // Pass 2: contains
    if (!match) {
      for (const rule of rules) {
        if (rule.match_type === 'contains' && normalizedDesc.includes(rule.normalized_pattern)) {
          match = rule;
          break;
        }
      }
    }
    // Pass 3: starts_with
    if (!match) {
      for (const rule of rules) {
        if (rule.match_type === 'starts_with' && normalizedDesc.startsWith(rule.normalized_pattern)) {
          match = rule;
          break;
        }
      }
    }

    if (!match) return res.json({ suggestion: null });

    // Guard: account must still be active and postable
    const acct = match.accounts;
    if (!acct || acct.is_active === false || acct.is_postable === false) {
      return res.json({ suggestion: null, reason: 'Matched rule account is inactive or non-postable' });
    }

    // Update rule stats (non-blocking — don't fail the response if this errors)
    supabase
      .from('bank_allocation_rules')
      .update({ last_applied_at: new Date().toISOString(), apply_count: (match.apply_count || 0) + 1 })
      .eq('id', match.id)
      .eq('company_id', companyId)
      .then(() => {})
      .catch(e => console.warn('[bankRules] Failed to update apply stats:', e.message));

    // Audit log suggestion (non-blocking)
    AuditLogger.log({
      companyId,
      actorType:  'SYSTEM',
      actorId:    userId(req),
      actionType: 'BANK_RULE_SUGGESTED',
      entityType: 'BANK_TRANSACTION',
      entityId:   txn.id,
      beforeJson: null,
      afterJson: {
        ruleId:      match.id,
        matchType:   match.match_type,
        matchPattern: match.match_pattern,
        accountId:   acct.id,
        accountCode: acct.code,
      },
      reason: `Bank rule "${match.match_pattern}" matched transaction ${txn.id}`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(() => {});

    const vs = match.vat_settings;
    res.json({
      suggestion: {
        source:         'bank_rule',
        ruleId:         match.id,
        matchPattern:   match.match_pattern,
        matchType:      match.match_type,
        accountId:      acct.id,
        accountCode:    acct.code,
        accountName:    acct.name,
        vatSettingId:   vs ? vs.id   : null,
        vatSettingCode: vs ? vs.code : null,
        vatSettingName: vs ? vs.name : null,
        confidence:     100,
        reason:         `Matched company bank rule: "${match.match_pattern}"`,
      }
    });
  } catch (err) {
    console.error('GET /bank/rules/suggest error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
