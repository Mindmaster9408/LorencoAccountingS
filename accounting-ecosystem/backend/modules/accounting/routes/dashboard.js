/**
 * ============================================================================
 * Dashboard Routes — Pilot Action Queue
 * ============================================================================
 * GET /api/accounting/dashboard/action-queue
 *
 * Returns a prioritised list of items requiring attention for the selected
 * company. All queries are independent: each is wrapped in a try/catch so a
 * single failing query degrades gracefully instead of crashing the response.
 * ============================================================================
 */

const express = require('express');
const router  = express.Router();
const { authenticate, hasPermission } = require('../middleware/auth');
const db = require('../config/database');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Executes a single read-only count query via the pg pool.
 * Never throws — returns { count, ok } on success or
 * { count: null, ok: false, message } on error.
 */
async function safeCount(sql, params) {
  try {
    const { rows } = await db.query(sql, params);
    return { count: parseInt(rows[0]?.n ?? 0, 10), ok: true };
  } catch (e) {
    return { count: null, ok: false, message: e.message };
  }
}

/**
 * Converts raw query results into ordered action-queue item objects.
 * Pure function — no I/O. Exported on the router object for unit testing.
 *
 * @param {object} results  - map of safeCount results (see destructure below)
 * @returns {Array}         - array of action item objects (only actionable items)
 */
function buildActionQueueItems({
  bankUnmatched, bankMatchedUnrecon, bankReconOpen,
  arOverdue, arDraft, apOverdue, apDraft,
  historicalDraft, openingDraft,
  auditErrors, historicalBlocked, vatOpen,
}) {
  const items = [];

  function degraded(id, label) {
    return {
      id,
      severity: 'warning',
      title:       `Unable to check: ${label}`,
      description: 'Query failed — check server logs.',
      count:       null,
      link:        null,
    };
  }

  function p(n, singular, plural) {
    return n === 1 ? singular : plural;
  }

  // ─── Bank ──────────────────────────────────────────────────────────────────
  if (!bankUnmatched.ok) {
    items.push(degraded('bank-unmatched', 'unmatched bank transactions'));
  } else if (bankUnmatched.count > 0) {
    const n = bankUnmatched.count;
    items.push({
      id:          'bank-unmatched',
      severity:    'high',
      title:       `${n} unmatched bank ${p(n, 'transaction', 'transactions')}`,
      description: 'Transactions need to be allocated before reconciliation.',
      count:       n,
      link:        '/accounting/bank.html',
    });
  }

  if (!bankMatchedUnrecon.ok) {
    items.push(degraded('bank-matched-unrecon', 'matched-unreconciled transactions'));
  } else if (bankMatchedUnrecon.count > 0) {
    const n = bankMatchedUnrecon.count;
    items.push({
      id:          'bank-matched-unrecon',
      severity:    'warning',
      title:       `${n} matched ${p(n, 'transaction', 'transactions')} not yet reconciled`,
      description: 'Matched but pending final reconciliation sign-off.',
      count:       n,
      link:        '/accounting/bank-reconciliation.html',
    });
  }

  if (!bankReconOpen.ok) {
    items.push(degraded('bank-recon-open', 'open reconciliation sessions'));
  } else if (bankReconOpen.count > 0) {
    const n = bankReconOpen.count;
    items.push({
      id:          'bank-recon-open',
      severity:    'high',
      title:       `${n} open bank reconciliation ${p(n, 'session', 'sessions')} with a difference`,
      description: 'Books and statement do not balance.',
      count:       n,
      link:        '/accounting/bank-reconciliation.html',
    });
  }

  // ─── AR ────────────────────────────────────────────────────────────────────
  if (!arOverdue.ok) {
    items.push(degraded('ar-overdue', 'overdue AR invoices'));
  } else if (arOverdue.count > 0) {
    const n = arOverdue.count;
    items.push({
      id:          'ar-overdue',
      severity:    'high',
      title:       `${n} overdue AR ${p(n, 'invoice', 'invoices')}`,
      description: 'Customer invoices past their due date.',
      count:       n,
      link:        '/accounting/aged-debtors.html',
    });
  }

  if (!arDraft.ok) {
    items.push(degraded('ar-draft', 'draft AR invoices'));
  } else if (arDraft.count > 0) {
    const n = arDraft.count;
    items.push({
      id:          'ar-draft',
      severity:    'warning',
      title:       `${n} draft AR ${p(n, 'invoice', 'invoices')} not posted`,
      description: 'Draft invoices not yet posted to the general ledger.',
      count:       n,
      link:        '/accounting/aged-debtors.html',
    });
  }

  // ─── AP ────────────────────────────────────────────────────────────────────
  if (!apOverdue.ok) {
    items.push(degraded('ap-overdue', 'overdue AP invoices'));
  } else if (apOverdue.count > 0) {
    const n = apOverdue.count;
    items.push({
      id:          'ap-overdue',
      severity:    'high',
      title:       `${n} overdue AP ${p(n, 'invoice', 'invoices')}`,
      description: 'Supplier invoices past their due date.',
      count:       n,
      link:        '/accounting/aged-creditors.html',
    });
  }

  if (!apDraft.ok) {
    items.push(degraded('ap-draft', 'draft AP invoices'));
  } else if (apDraft.count > 0) {
    const n = apDraft.count;
    items.push({
      id:          'ap-draft',
      severity:    'warning',
      title:       `${n} draft AP ${p(n, 'invoice', 'invoices')} not posted`,
      description: 'Draft supplier invoices not yet posted to the GL.',
      count:       n,
      link:        '/accounting/aged-creditors.html',
    });
  }

  // ─── Historical Comparatives & Opening Balances ────────────────────────────
  if (!historicalDraft.ok) {
    items.push(degraded('historical-draft', 'unfinalized historical batches'));
  } else if (historicalDraft.count > 0) {
    const n = historicalDraft.count;
    items.push({
      id:          'historical-draft',
      severity:    'info',
      title:       `${n} unfinalized historical comparative ${p(n, 'batch', 'batches')}`,
      description: 'Draft or validated batches not yet finalized.',
      count:       n,
      link:        '/accounting/historical-comparatives.html',
    });
  }

  if (!openingDraft.ok) {
    items.push(degraded('opening-draft', 'unfinalized opening balance batches'));
  } else if (openingDraft.count > 0) {
    const n = openingDraft.count;
    items.push({
      id:          'opening-draft',
      severity:    'info',
      title:       `${n} unfinalized opening balance ${p(n, 'batch', 'batches')}`,
      description: 'Opening balance batches not yet finalized.',
      count:       n,
      link:        '/accounting/opening-balances.html',
    });
  }

  // ─── Audit & Integrity ─────────────────────────────────────────────────────
  if (!auditErrors.ok) {
    items.push(degraded('audit-errors', 'recent audit errors'));
  } else if (auditErrors.count > 0) {
    const n = auditErrors.count;
    items.push({
      id:          'audit-errors',
      severity:    'critical',
      title:       `${n} system ${p(n, 'error', 'errors')} in the audit log (last 7 days)`,
      description: 'System errors recorded in the audit trail. Investigate immediately.',
      count:       n,
      link:        '/accounting/audit-trail.html',
    });
  }

  if (!historicalBlocked.ok) {
    items.push(degraded('historical-blocked', 'blocked finalize attempts'));
  } else if (historicalBlocked.count > 0) {
    const n = historicalBlocked.count;
    items.push({
      id:          'historical-blocked',
      severity:    'warning',
      title:       `${n} blocked finalize ${p(n, 'attempt', 'attempts')} in historical comparatives (last 7 days)`,
      description: 'Finalization blocked due to unsaved changes. Save and retry.',
      count:       n,
      link:        '/accounting/historical-comparatives.html',
    });
  }

  // ─── VAT (graceful fallback — table may not exist in all deployments) ───────
  if (!vatOpen.ok) {
    items.push(degraded('vat-open', 'open VAT returns'));
  } else if (vatOpen.count > 0) {
    const n = vatOpen.count;
    items.push({
      id:          'vat-open',
      severity:    'warning',
      title:       `${n} open VAT ${p(n, 'return', 'returns')}`,
      description: 'VAT returns not yet filed.',
      count:       n,
      link:        '/accounting/vat-return.html',
    });
  }

  return items;
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.get(
  '/action-queue',
  authenticate,
  hasPermission('dashboard.view'),
  async (req, res) => {
    const companyId = req.user.companyId;
    if (!companyId) {
      return res.status(400).json({ error: 'Company context required' });
    }

    const cid = [companyId];

    const [
      bankUnmatched,
      bankMatchedUnrecon,
      bankReconOpen,
      arOverdue,
      arDraft,
      apOverdue,
      apDraft,
      historicalDraft,
      openingDraft,
      auditErrors,
      historicalBlocked,
      vatOpen,
    ] = await Promise.all([
      safeCount(
        `SELECT COUNT(*)::int AS n FROM bank_transactions
           WHERE company_id=$1 AND status='unmatched'`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM bank_transactions
           WHERE company_id=$1 AND status='matched'`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM bank_recon_sessions
           WHERE company_id=$1 AND difference<>0`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM customer_invoices
           WHERE company_id=$1
             AND status NOT IN ('paid','void','cancelled')
             AND due_date < NOW()`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM customer_invoices
           WHERE company_id=$1 AND status='draft'`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM supplier_invoices
           WHERE company_id=$1
             AND status NOT IN ('paid','void','cancelled')
             AND due_date < NOW()`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM supplier_invoices
           WHERE company_id=$1 AND status='draft'`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM historical_comparative_batches
           WHERE company_id=$1 AND status IN ('draft','validated')`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM opening_balance_batches
           WHERE company_id=$1 AND status IN ('draft','validated')`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM accounting_audit_log
           WHERE company_id=$1
             AND action_type='SYSTEM_ERROR'
             AND created_at >= NOW() - INTERVAL '7 days'`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM historical_comparative_audit_log
           WHERE company_id=$1
             AND action='FINALIZED_EDIT_BLOCKED'
             AND performed_at >= NOW() - INTERVAL '7 days'`,
        cid),
      safeCount(
        `SELECT COUNT(*)::int AS n FROM vat_returns
           WHERE company_id=$1 AND status NOT IN ('filed','cancelled')`,
        cid),
    ]);

    const items = buildActionQueueItems({
      bankUnmatched, bankMatchedUnrecon, bankReconOpen,
      arOverdue, arDraft, apOverdue, apDraft,
      historicalDraft, openingDraft,
      auditErrors, historicalBlocked, vatOpen,
    });

    const summary = {
      criticalCount:   items.filter(i => i.severity === 'critical').length,
      highCount:       items.filter(i => i.severity === 'high').length,
      warningCount:    items.filter(i => i.severity === 'warning').length,
      infoCount:       items.filter(i => i.severity === 'info').length,
      totalActionable: items.filter(i => ['critical', 'high', 'warning'].includes(i.severity)).length,
    };

    res.json({
      companyId,
      generatedAt: new Date().toISOString(),
      items,
      summary,
    });
  }
);

// Exported for unit testing
router.safeCount            = safeCount;
router.buildActionQueueItems = buildActionQueueItems;

module.exports = router;
