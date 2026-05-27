const express = require('express');
const { supabase } = require('../../../config/database');
const db = require('../config/database'); // direct pg Pool — used for atomic draft-delete transaction
const { authenticate, hasPermission } = require('../middleware/auth');
const JournalService = require('../services/journalService');
const AuditLogger = require('../services/auditLogger');

const router = express.Router();

/**
 * GET /api/journals
 * List journals for the company
 */
router.get('/', authenticate, hasPermission('journal.view'), async (req, res) => {
  try {
    const { status, sourceType, scope, fromDate, toDate, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from('journals')
      .select('*, created_user:users!created_by_user_id(email), posted_user:users!posted_by_user_id(email)')
      .eq('company_id', req.user.companyId)
      .order('date', { ascending: false })
      .order('id', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status) query = query.eq('status', status);

    // scope filter: 'manual' = accountant-created only; 'system' = non-manual only; 'all'/absent = all journals
    // When scope is set it takes precedence over the individual sourceType param.
    if (scope === 'manual') {
      query = query.or('source_type.is.null,source_type.eq.manual');
    } else if (scope === 'system') {
      query = query.not('source_type', 'is', null).neq('source_type', 'manual');
    } else if (sourceType) {
      // No scope set — allow individual sourceType filter (backward compat)
      query = query.eq('source_type', sourceType);
    }

    if (fromDate) query = query.gte('date', fromDate);
    if (toDate)   query = query.lte('date', toDate);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const journals = (data || []).map(j => ({
      ...j,
      created_by_email: j.created_user?.email || null,
      posted_by_email:  j.posted_user?.email  || null,
    }));

    res.json({ journals, count: journals.length });

  } catch (error) {
    console.error('Error fetching journals:', error);
    res.status(500).json({ error: 'Failed to fetch journals' });
  }
});

/**
 * GET /api/journals/:id
 * Get a specific journal with lines
 */
router.get('/:id', authenticate, hasPermission('journal.view'), async (req, res) => {
  try {
    const journal = await JournalService.getJournalWithLines(req.params.id, req.user.companyId);

    if (!journal) {
      return res.status(404).json({ error: 'Journal not found' });
    }

    res.json(journal);

  } catch (error) {
    console.error('Error fetching journal:', error);
    res.status(500).json({ error: 'Failed to fetch journal' });
  }
});

/**
 * POST /api/journals
 * Create a new draft journal.
 *
 * Optional body field `idempotencyKey` (string): if supplied and a journal with that
 * key was already created for this company within the last 24 hours, the existing
 * journal is returned (HTTP 200, { ...journal, duplicate: true }) instead of
 * creating a new one. This prevents double-click and network-retry duplicates.
 */
router.post('/', authenticate, hasPermission('journal.create'), async (req, res) => {
  try {
    const { date, reference, description, sourceType = 'manual', lines, metadata, idempotencyKey } = req.body;

    if (!date || !description || !lines) {
      return res.status(400).json({ error: 'Date, description, and lines are required' });
    }

    // ── Idempotency guard ─────────────────────────────────────────────────────
    // If the caller supplies an idempotency key, look for an existing journal
    // created with that key in the last 24 h and return it instead of duplicating.
    if (idempotencyKey && typeof idempotencyKey === 'string' && idempotencyKey.trim()) {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: existing } = await supabase
        .from('journals')
        .select('id')
        .eq('company_id', req.user.companyId)
        .filter('metadata->>idempotency_key', 'eq', idempotencyKey.trim())
        .gte('created_at', cutoff)
        .maybeSingle();
      if (existing) {
        const fullJournal = await JournalService.getJournalWithLines(existing.id, req.user.companyId);
        return res.status(200).json({ ...fullJournal, duplicate: true });
      }
    }

    // Merge idempotency key into journal metadata so future lookups can find it.
    const resolvedMetadata = idempotencyKey && idempotencyKey.trim()
      ? { ...(metadata || {}), idempotency_key: idempotencyKey.trim() }
      : (metadata || undefined);

    const journal = await JournalService.createDraftJournal({
      companyId: req.user.companyId,
      date,
      reference,
      description,
      sourceType,
      createdByUserId: req.user.id,
      lines,
      metadata: resolvedMetadata
    });

    await AuditLogger.logUserAction(
      req,
      'CREATE',
      'JOURNAL',
      journal.id,
      null,
      { date: journal.date, reference: journal.reference, description: journal.description, lineCount: lines.length },
      'Journal draft created'
    );

    const fullJournal = await JournalService.getJournalWithLines(journal.id, req.user.companyId);
    res.status(201).json(fullJournal);

  } catch (error) {
    console.error('Error creating journal:', error);
    res.status(400).json({ error: error.message || 'Failed to create journal' });
  }
});

/**
 * PUT /api/journals/:id
 * Edit a draft journal (header + lines replaced atomically)
 */
router.put('/:id', authenticate, hasPermission('journal.create'), async (req, res) => {
  try {
    const { date, reference, description, lines } = req.body;

    if (!date || !description || !lines) {
      return res.status(400).json({ error: 'Date, description, and lines are required' });
    }

    const beforeJournal = await JournalService.getJournalWithLines(req.params.id, req.user.companyId);
    if (!beforeJournal) {
      return res.status(404).json({ error: 'Journal not found' });
    }

    await JournalService.updateDraftJournal(req.params.id, req.user.companyId, {
      date, reference, description, lines, updatedByUserId: req.user.id
    });

    await AuditLogger.logUserAction(
      req,
      'UPDATE',
      'JOURNAL',
      req.params.id,
      { date: beforeJournal.date, reference: beforeJournal.reference, description: beforeJournal.description, lineCount: beforeJournal.lines.length },
      { date, reference, description, lineCount: lines.length },
      'Draft journal updated'
    );

    const updatedJournal = await JournalService.getJournalWithLines(req.params.id, req.user.companyId);
    res.json(updatedJournal);

  } catch (error) {
    console.error('Error updating journal:', error);
    res.status(400).json({ error: error.message || 'Failed to update journal' });
  }
});

/**
 * POST /api/journals/:id/post
 * Post a draft journal
 */
router.post('/:id/post', authenticate, hasPermission('journal.post'), async (req, res) => {
  try {
    const journal = await JournalService.postJournal(
      req.params.id,
      req.user.companyId,
      req.user.id
    );

    await AuditLogger.logUserAction(
      req,
      'POST',
      'JOURNAL',
      journal.id,
      { status: 'draft' },
      { status: 'posted' },
      'Journal posted'
    );

    const updatedJournal = await JournalService.getJournalWithLines(journal.id, req.user.companyId);
    res.json(updatedJournal);

  } catch (error) {
    console.error('Error posting journal:', error);
    if (error.message && error.message.toLowerCase().includes('locked period')) {
      await AuditLogger.logUserAction(
        req,
        'JOURNAL_BLOCKED_LOCKED_PERIOD',
        'JOURNAL',
        req.params.id,
        null,
        { blockedAction: 'POST', reason: error.message },
        `Journal post blocked: ${error.message}`
      );
    }
    res.status(400).json({ error: error.message || 'Failed to post journal' });
  }
});

/**
 * POST /api/journals/:id/reverse
 * Reverse a posted journal
 */
router.post('/:id/reverse', authenticate, hasPermission('journal.reverse'), async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Reason is required for reversal' });
    }

    const reversalJournal = await JournalService.reverseJournal(
      req.params.id,
      req.user.companyId,
      req.user.id,
      reason
    );

    await AuditLogger.logUserAction(
      req,
      'REVERSE',
      'JOURNAL',
      req.params.id,
      { status: 'posted' },
      { status: 'reversed', reversedBy: reversalJournal.id },
      `Journal reversed: ${reason}`
    );

    const fullReversalJournal = await JournalService.getJournalWithLines(
      reversalJournal.id,
      req.user.companyId
    );

    res.json({ message: 'Journal reversed successfully', reversalJournal: fullReversalJournal });

  } catch (error) {
    console.error('Error reversing journal:', error);
    if (error.message && error.message.toLowerCase().includes('locked period')) {
      await AuditLogger.logUserAction(
        req,
        'JOURNAL_BLOCKED_LOCKED_PERIOD',
        'JOURNAL',
        req.params.id,
        null,
        { blockedAction: 'REVERSE', reason: error.message },
        `Journal reverse blocked: ${error.message}`
      );
    }
    res.status(400).json({ error: error.message || 'Failed to reverse journal' });
  }
});

/**
 * DELETE /api/journals/:id
 * Delete a draft journal
 */
router.delete('/:id', authenticate, hasPermission('journal.delete'), async (req, res) => {
  const journalId = parseInt(req.params.id, 10);
  const companyId = req.user.companyId;

  if (isNaN(journalId)) {
    return res.status(400).json({ error: 'Invalid journal ID' });
  }

  let journalSnapshot = null;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Fetch and lock the row — confirms ownership and prevents concurrent delete races
    const { rows } = await client.query(
      `SELECT id, status, date, reference, description
         FROM journals
        WHERE id = $1 AND company_id = $2
          FOR UPDATE`,
      [journalId, companyId]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Draft journal not found.' });
    }

    const journal = rows[0];
    if (journal.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Only draft journals can be deleted. Posted journals must be reversed.',
      });
    }

    journalSnapshot = journal;

    await client.query('DELETE FROM journal_lines WHERE journal_id = $1', [journalId]);

    const deleteResult = await client.query(
      `DELETE FROM journals WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
      [journalId, companyId]
    );

    if (deleteResult.rowCount !== 1) {
      throw new Error('Draft journal delete failed. No changes were saved.');
    }

    await client.query('COMMIT');

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error deleting journal:', error);
    return res.status(500).json({ error: error.message || 'Draft journal delete failed. No changes were saved.' });
  } finally {
    client.release();
  }

  // Audit log outside transaction — same pattern as rest of codebase
  await AuditLogger.logUserAction(
    req,
    'DELETE',
    'JOURNAL',
    journalSnapshot.id,
    { date: journalSnapshot.date, reference: journalSnapshot.reference, description: journalSnapshot.description },
    null,
    'Draft journal deleted'
  ).catch(auditErr => { console.error('Audit log failed for journal delete:', auditErr.message); });

  res.json({ message: 'Journal deleted successfully' });
});

module.exports = router;
