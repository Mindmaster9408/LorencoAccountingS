'use strict';

/**
 * Diagnostics Routes — /api/accounting/diagnostics
 *
 * GET  /          — run all diagnostic checks (diagnostics.view)
 * POST /repair    — apply a safe repair action (diagnostics.repair)
 *
 * Priority 14 — 2026-05
 */

const express            = require('express');
const { authenticate, hasPermission } = require('../middleware/auth');
const DiagnosticsService = require('../services/diagnosticsService');
const AuditLogger        = require('../services/auditLogger');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET / — run diagnostics
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', authenticate, hasPermission('diagnostics.view'), async (req, res) => {
  const companyId = req.user.companyId;

  try {
    const category      = req.query.category     || null;
    const olderThanDays = parseInt(req.query.olderThanDays, 10) || 30;

    // Validate category if provided
    const VALID_CATEGORIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Invalid category '${category}'. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }

    if (olderThanDays < 1 || olderThanDays > 3650) {
      return res.status(400).json({ error: 'olderThanDays must be between 1 and 3650' });
    }

    const result = await DiagnosticsService.runChecks(companyId, { category, olderThanDays });

    // Audit the run
    await AuditLogger.logUserAction(
      req,
      'DIAGNOSTICS_RUN',
      'COMPANY',
      String(companyId),
      null,
      {
        score:         result.summary.score,
        critical:      result.summary.critical,
        high:          result.summary.high,
        medium:        result.summary.medium,
        low:           result.summary.low,
        totalFindings: result.summary.totalFindings,
        category:      category || 'ALL',
      },
      null
    );

    return res.json(result);

  } catch (err) {
    console.error('[diagnostics] runChecks error:', err);
    return res.status(500).json({ error: 'Diagnostics run failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /repair — apply a safe repair action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expected request body:
 * {
 *   findingId:    string   — the finding ID from a previous diagnostics run
 *   repairAction: string   — one of: REASSIGN_VAT_PERIOD | RELINK_BANK_TX | REVERSE_DANGLING_JOURNAL | ACKNOWLEDGE
 *   confirm:      true     — must be explicitly true (prevents accidental calls)
 *   reason:       string   — mandatory non-empty reason (audit trail)
 *   // For RELINK_BANK_TX:
 *   bankTxnId:    number
 *   journalId:    number
 *   // For REASSIGN_VAT_PERIOD:
 *   journalId:    number
 *   // For REVERSE_DANGLING_JOURNAL:
 *   journalId:    number
 * }
 */
router.post('/repair', authenticate, hasPermission('diagnostics.repair'), async (req, res) => {
  const companyId = req.user.companyId;
  const userId    = req.user.id;

  const { findingId, repairAction, confirm, reason, journalId, bankTxnId } = req.body;

  // ── Guard: mandatory fields ────────────────────────────────────────────────
  if (!findingId || typeof findingId !== 'string') {
    return res.status(400).json({ error: 'findingId is required (string)' });
  }
  if (!repairAction || typeof repairAction !== 'string') {
    return res.status(400).json({ error: 'repairAction is required (string)' });
  }
  if (confirm !== true) {
    return res.status(400).json({ error: 'confirm must be true — repair actions require explicit confirmation' });
  }
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return res.status(400).json({ error: 'reason is required (non-empty string) — all repairs are audited' });
  }

  const VALID_ACTIONS = ['REASSIGN_VAT_PERIOD', 'RELINK_BANK_TX', 'REVERSE_DANGLING_JOURNAL', 'ACKNOWLEDGE'];
  if (!VALID_ACTIONS.includes(repairAction)) {
    return res.status(400).json({ error: `Unknown repairAction '${repairAction}'. Must be one of: ${VALID_ACTIONS.join(', ')}` });
  }

  // ── Log: repair started ────────────────────────────────────────────────────
  await AuditLogger.logUserAction(
    req,
    'DIAGNOSTIC_REPAIR_STARTED',
    'COMPANY',
    String(companyId),
    null,
    { findingId, repairAction, reason: reason.trim() },
    reason.trim()
  );

  // ── Dispatch repair action ─────────────────────────────────────────────────
  try {
    let repairResult;

    switch (repairAction) {

      case 'REASSIGN_VAT_PERIOD': {
        if (!journalId || isNaN(parseInt(journalId, 10))) {
          return res.status(400).json({ error: 'journalId (number) is required for REASSIGN_VAT_PERIOD' });
        }
        repairResult = await DiagnosticsService.repairVatAssignment(
          companyId, parseInt(journalId, 10)
        );

        await AuditLogger.logUserAction(
          req,
          'DIAGNOSTIC_REPAIR_VAT_ASSIGNMENT',
          'JOURNAL',
          String(journalId),
          null,
          { findingId, vatPeriodId: repairResult.vatPeriodId },
          reason.trim()
        );
        break;
      }

      case 'RELINK_BANK_TX': {
        if (!bankTxnId || isNaN(parseInt(bankTxnId, 10))) {
          return res.status(400).json({ error: 'bankTxnId (number) is required for RELINK_BANK_TX' });
        }
        if (!journalId || isNaN(parseInt(journalId, 10))) {
          return res.status(400).json({ error: 'journalId (number) is required for RELINK_BANK_TX' });
        }
        repairResult = await DiagnosticsService.repairBankRelink(
          companyId, parseInt(bankTxnId, 10), parseInt(journalId, 10)
        );

        await AuditLogger.logUserAction(
          req,
          'DIAGNOSTIC_REPAIR_BANK_RELINK',
          'BANK_TRANSACTION',
          String(bankTxnId),
          null,
          { findingId, bankTxnId: repairResult.bankTxnId, linkedJournalId: repairResult.linkedJournalId },
          reason.trim()
        );
        break;
      }

      case 'REVERSE_DANGLING_JOURNAL': {
        if (!journalId || isNaN(parseInt(journalId, 10))) {
          return res.status(400).json({ error: 'journalId (number) is required for REVERSE_DANGLING_JOURNAL' });
        }
        repairResult = await DiagnosticsService.repairDanglingJournalReversal(
          companyId, parseInt(journalId, 10), userId, reason.trim()
        );

        await AuditLogger.logUserAction(
          req,
          'DIAGNOSTIC_REPAIR_DANGLING_BANK_JOURNAL_REVERSED',
          'JOURNAL',
          String(journalId),
          null,
          {
            findingId,
            originalJournalId:  repairResult.originalJournalId,
            reversalJournalId:  repairResult.reversalJournalId,
          },
          reason.trim()
        );
        break;
      }

      case 'ACKNOWLEDGE': {
        // Soft acknowledgement — no data change, just an audit trail marker.
        // Callers can record a reason without altering data.
        repairResult = { acknowledged: true, findingId };
        break;
      }

      default:
        // Should never reach here due to the VALID_ACTIONS check above
        return res.status(400).json({ error: `Unhandled repairAction: ${repairAction}` });
    }

    // ── Log: repair completed ─────────────────────────────────────────────────
    await AuditLogger.logUserAction(
      req,
      'DIAGNOSTIC_REPAIR_COMPLETED',
      'COMPANY',
      String(companyId),
      null,
      { findingId, repairAction, result: repairResult },
      reason.trim()
    );

    return res.json({
      success: true,
      findingId,
      repairAction,
      result: repairResult,
    });

  } catch (err) {
    // ── Log: repair failed ───────────────────────────────────────────────────
    await AuditLogger.logUserAction(
      req,
      'DIAGNOSTIC_REPAIR_FAILED',
      'COMPANY',
      String(companyId),
      null,
      { findingId, repairAction, error: err.message },
      reason ? reason.trim() : null
    ).catch(() => {}); // Do not mask the original error

    console.error(`[diagnostics] repair failed for findingId=${findingId} action=${repairAction}:`, err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
