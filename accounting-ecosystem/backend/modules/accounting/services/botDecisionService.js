'use strict';

/**
 * ============================================================================
 * Bot decision rules — what a bot (GrokBot or any AI bookkeeper connected with a
 * personal access key) may post on its own, and what must wait for a person.
 * Codebox 4, 2026-11-19. Pure logic, no database — see routes/botDecisions.js.
 * ============================================================================
 * Decision hierarchy (highest first):
 *   1. An approved allocation rule that matches the bank line — the bot may NOT
 *      override it. Different account → refused (the bot can raise an exception
 *      if it thinks the rule is wrong).
 *   2. Sean's recommendation — when Sean is confident (prefill level) and the bot
 *      chooses a different account, the bot must say why, and the allocation
 *      WAITS for a person with both recommendations recorded. Never auto-posted.
 *   3. Supporting documents / history — the bot's evidence field.
 *   4. The bot's own reasoned choice (no rule, no confident Sean suggestion).
 *   5. A person, where required:
 *        - director / owner / shareholder lines — ALWAYS (not a policy option)
 *        - transfers between the company's own bank accounts
 *        - disagreeing with Sean
 *        - the key's policy "require_approval_all"
 * ============================================================================
 */

const SEAN_CONFIDENT = 70;   // = Sean's PREFILL_MIN_CONFIDENCE (the bank page prefills from here)

const DIRECTOR_ACCOUNT_RE = /\b(director|directors|shareholder|shareholders|member'?s?\s+(?:loan|contribution)|members?\s+loan|drawings|dividends?|owner'?s?|proprietor|partner'?s?\s+(?:loan|current|capital)|loan\s+account)\b/i;
const DIRECTOR_DESC_RE = /\b(director|directors|drawings|shareholder|dividends?|owner|proprietor)\b/i;

const r2 = (n) => Math.round(Number(n) * 100) / 100;

/** Bank / cash account: linked to a Leo bank account, or classified as bank/cash in the chart. */
const isBankOrCash = (a, bankLedgerIds) => !!a && ((bankLedgerIds && bankLedgerIds.has(Number(a.id)))
  || a.reporting_group === 'bank_cash' || ['bank', 'cash'].includes(String(a.sub_type || '').toLowerCase()));
/** Director / owner account: classified as drawings in the chart, or named like one. */
const isDirectorAccount = (a) => !!a && (a.reporting_group === 'drawings' || DIRECTOR_ACCOUNT_RE.test(a.name || ''));

/**
 * @param {object} p
 * @param {{id, amount, description, status}} p.txn                 the bank line
 * @param {Array<{accountId, amount}>} p.lines                       the bot's proposed allocation
 * @param {Map<number,{id,code,name,is_active,is_postable,sub_type,reporting_group}>} p.accountsById
 * @param {Set<number>} p.bankLedgerIds                              ledger accounts of the company's bank accounts
 * @param {{ruleId, accountId, accountCode}|null} p.rule             approved rule that matched, if any
 * @param {{accountId, confidence, source}|null} p.sean              Sean's suggestion, if any
 * @param {object} p.policy                                          normalized key policy
 * @param {string} p.reason
 * @param {string} [p.disagreementReason]
 * @returns {{outcome: 'post'|'hold'|'refuse', code?, message?, holdReasons: string[], decisionSource}}
 */
function evaluateAllocation(p) {
  const refuse = (code, message) => ({ outcome: 'refuse', code, message, holdReasons: [], decisionSource: null });
  const { txn, lines, accountsById, bankLedgerIds, rule, sean, policy = {} } = p;

  if (!p.reason || String(p.reason).trim().length < 5) {
    return refuse('REASON_REQUIRED', 'Give the reason for this allocation (at least a few words).');
  }
  if (!txn) return refuse('TRANSACTION_NOT_FOUND', 'Bank transaction not found in this company.');
  if (txn.status !== 'unmatched') return refuse('ALREADY_ALLOCATED', `This bank line is already ${txn.status}.`);
  if (!Array.isArray(lines) || !lines.length) return refuse('MISSING_LINES', 'At least one allocation line is required.');

  for (const l of lines) {
    const a = accountsById.get(Number(l.accountId));
    if (!a) return refuse('UNKNOWN_ACCOUNT', `Account ${l.accountId} does not exist in this company (see list_accounts).`);
    if (a.is_active === false || a.is_postable === false) {
      return refuse('ACCOUNT_NOT_POSTABLE', `Account ${a.code} ${a.name} is inactive or a header account.`);
    }
    if (!(Number(l.amount) > 0)) return refuse('BAD_AMOUNT', 'Line amounts must be positive.');
  }
  const total = r2(lines.reduce((s, l) => s + Number(l.amount), 0));
  if (Math.abs(total - r2(Math.abs(txn.amount))) >= 0.005) {
    return refuse('LINES_DO_NOT_ADD_UP', `Lines add up to ${total.toFixed(2)} but the bank line is ${Math.abs(txn.amount).toFixed(2)}.`);
  }

  const accountIds = [...new Set(lines.map(l => Number(l.accountId)))];
  const primary = Number(lines.slice().sort((a, b) => Number(b.amount) - Number(a.amount))[0].accountId);

  // 1. Approved rule — never overridden.
  if (rule && rule.accountId) {
    if (accountIds.some(id => id !== Number(rule.accountId))) {
      return refuse('RULE_OVERRIDE', `An approved allocation rule applies to this line (account ${rule.accountCode || rule.accountId}). ` +
        'A bot may not override it. If you think the rule is wrong, use flag_for_review.');
    }
  }

  const holdReasons = [];
  let decisionSource = rule ? 'rule' : (p.decisionSource || 'bot');

  // 2. Sean — confident and different → a person decides, with both recorded.
  if (!rule && sean && sean.accountId && Number(sean.confidence) >= SEAN_CONFIDENT) {
    if (Number(sean.accountId) === primary) {
      if (decisionSource === 'bot') decisionSource = 'sean';
    } else {
      if (!p.disagreementReason || String(p.disagreementReason).trim().length < 5) {
        return refuse('DISAGREEMENT_REASON_REQUIRED', `Sean recommends another account (${sean.accountId}, ${sean.confidence}% confident). ` +
          'Give disagreement_reason — the allocation will then wait for a person to choose.');
      }
      holdReasons.push('disagrees_with_sean');
    }
  }
  if (decisionSource === 'sean' && !(sean && Number(sean.accountId) === primary)) decisionSource = 'bot';

  // 5. People decide these — always.
  const touchesDirector = accountIds.some(id => isDirectorAccount(accountsById.get(id)))
    || DIRECTOR_DESC_RE.test(txn.description || '');
  if (touchesDirector) holdReasons.push('director_or_owner');
  if (accountIds.some(id => isBankOrCash(accountsById.get(id), bankLedgerIds))) holdReasons.push('internal_transfer');
  if (policy.require_approval_all === true) holdReasons.push('policy_requires_approval');

  return holdReasons.length
    ? { outcome: 'hold', holdReasons, decisionSource }
    : { outcome: 'post', holdReasons: [], decisionSource };
}

const HOLD_LABELS = {
  disagrees_with_sean: 'Bot disagrees with Sean',
  director_or_owner: 'Director / owner transaction',
  internal_transfer: 'Transfer between own bank accounts',
  policy_requires_approval: 'Key policy: every allocation needs approval',
  exception: 'Raised by the bot for review'
};

module.exports = { evaluateAllocation, isBankOrCash, isDirectorAccount, SEAN_CONFIDENT, DIRECTOR_ACCOUNT_RE, DIRECTOR_DESC_RE, HOLD_LABELS };
