const express = require('express');
const { supabase } = require('../../../config/database');
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
    const { status, sourceType, fromDate, toDate, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from('journals')
      .select('*, created_user:users!created_by_user_id(email), posted_user:users!posted_by_user_id(email)')
      .eq('company_id', req.user.companyId)
      .order('date', { ascending: false })
      .order('id', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status)     query = query.eq('status', status);
    if (sourceType) query = query.eq('source_type', sourceType);
    if (fromDate)   query = query.gte('date', fromDate);
    if (toDate)     query = query.lte('date', toDate);

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
 * Create a new draft journal
 */
router.post('/', authenticate, hasPermission('journal.create'), async (req, res) => {
  try {
    const { date, reference, description, sourceType = 'manual', lines, metadata } = req.body;

    if (!date || !description || !lines) {
      return res.status(400).json({ error: 'Date, description, and lines are required' });
    }

    const journal = await JournalService.createDraftJournal({
      companyId: req.user.companyId,
      date,
      reference,
      description,
      sourceType,
      createdByUserId: req.user.id,
      lines,
      metadata
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
    res.status(400).json({ error: error.message || 'Failed to reverse journal' });
  }
});

/**
 * DELETE /api/journals/:id
 * Delete a draft journal
 */
router.delete('/:id', authenticate, hasPermission('journal.delete'), async (req, res) => {
  try {
    const { data: journal, error: fetchErr } = await supabase
      .from('journals')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.user.companyId)
      .single();

    if (fetchErr || !journal) {
      return res.status(404).json({ error: 'Journal not found' });
    }

    if (journal.status !== 'draft') {
      return res.status(403).json({ error: 'Can only delete draft journals' });
    }

    // Delete journal lines first
    const { error: linesErr } = await supabase
      .from('journal_lines')
      .delete()
      .eq('journal_id', req.params.id);

    if (linesErr) throw new Error(linesErr.message);

    // Delete journal
    const { error: journalErr } = await supabase
      .from('journals')
      .delete()
      .eq('id', req.params.id);

    if (journalErr) throw new Error(journalErr.message);

    await AuditLogger.logUserAction(
      req,
      'DELETE',
      'JOURNAL',
      journal.id,
      { date: journal.date, reference: journal.reference, description: journal.description },
      null,
      'Draft journal deleted'
    );

    res.json({ message: 'Journal deleted successfully' });

  } catch (error) {
    console.error('Error deleting journal:', error);
    res.status(500).json({ error: 'Failed to delete journal' });
  }
});

module.exports = router;
