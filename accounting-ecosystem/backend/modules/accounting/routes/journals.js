const express = require('express');
const db = require('../config/database');
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
    
    let query = `
      SELECT j.*, 
             u_created.email as created_by_email,
             u_posted.email as posted_by_email
      FROM journals j
      LEFT JOIN users u_created ON j.created_by_user_id = u_created.id
      LEFT JOIN users u_posted ON j.posted_by_user_id = u_posted.id
      WHERE j.company_id = $1
    `;
    const params = [req.user.companyId];
    let paramCount = 2;

    if (status) {
      query += ` AND j.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (sourceType) {
      query += ` AND j.source_type = $${paramCount}`;
      params.push(sourceType);
      paramCount++;
    }

    if (fromDate) {
      query += ` AND j.date >= $${paramCount}`;
      params.push(fromDate);
      paramCount++;
    }

    if (toDate) {
      query += ` AND j.date <= $${paramCount}`;
      params.push(toDate);
      paramCount++;
    }

    query += ` ORDER BY j.date DESC, j.id DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    res.json({
      journals: result.rows,
      count: result.rows.length
    });

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
  const client = await db.getClient();
  
  try {
    const { date, reference, description, sourceType = 'manual', lines, metadata } = req.body;

    // Validation
    if (!date || !description || !lines) {
      return res.status(400).json({ error: 'Date, description, and lines are required' });
    }

    await client.query('BEGIN');

    const journal = await JournalService.createDraftJournal(client, {
      companyId: req.user.companyId,
      date,
      reference,
      description,
      sourceType,
      createdByUserId: req.user.id,
      lines,
      metadata
    });

    // Audit log
    await AuditLogger.logUserAction(
      req,
      'CREATE',
      'JOURNAL',
      journal.id,
      null,
      { 
        date: journal.date, 
        reference: journal.reference, 
        description: journal.description,
        lineCount: lines.length 
      },
      'Journal draft created'
    );

    await client.query('COMMIT');

    // Fetch full journal with lines
    const fullJournal = await JournalService.getJournalWithLines(journal.id, req.user.companyId);

    res.status(201).json(fullJournal);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating journal:', error);
    res.status(400).json({ error: error.message || 'Failed to create journal' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/journals/:id
 * Edit a draft journal (header + lines replaced atomically)
 */
router.put('/:id', authenticate, hasPermission('journal.create'), async (req, res) => {
  const client = await db.getClient();

  try {
    const { date, reference, description, lines } = req.body;

    if (!date || !description || !lines) {
      return res.status(400).json({ error: 'Date, description, and lines are required' });
    }

    // Capture before-state for audit
    const beforeJournal = await JournalService.getJournalWithLines(req.params.id, req.user.companyId);
    if (!beforeJournal) {
      return res.status(404).json({ error: 'Journal not found' });
    }

    await client.query('BEGIN');

    await JournalService.updateDraftJournal(client, req.params.id, req.user.companyId, {
      date,
      reference,
      description,
      lines,
      updatedByUserId: req.user.id
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

    await client.query('COMMIT');

    const updatedJournal = await JournalService.getJournalWithLines(req.params.id, req.user.companyId);
    res.json(updatedJournal);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating journal:', error);
    res.status(400).json({ error: error.message || 'Failed to update journal' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/journals/:id/post
 * Post a draft journal
 */
router.post('/:id/post', authenticate, hasPermission('journal.post'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    const journal = await JournalService.postJournal(
      client,
      req.params.id,
      req.user.companyId,
      req.user.id
    );

    // Audit log
    await AuditLogger.logUserAction(
      req,
      'POST',
      'JOURNAL',
      journal.id,
      { status: 'draft' },
      { status: 'posted' },
      'Journal posted'
    );

    await client.query('COMMIT');

    // Fetch updated journal
    const updatedJournal = await JournalService.getJournalWithLines(journal.id, req.user.companyId);

    res.json(updatedJournal);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error posting journal:', error);
    res.status(400).json({ error: error.message || 'Failed to post journal' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/journals/:id/reverse
 * Reverse a posted journal
 */
router.post('/:id/reverse', authenticate, hasPermission('journal.reverse'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Reason is required for reversal' });
    }

    await client.query('BEGIN');

    const reversalJournal = await JournalService.reverseJournal(
      client,
      req.params.id,
      req.user.companyId,
      req.user.id,
      reason
    );

    // Audit log
    await AuditLogger.logUserAction(
      req,
      'REVERSE',
      'JOURNAL',
      req.params.id,
      { status: 'posted' },
      { status: 'reversed', reversedBy: reversalJournal.id },
      `Journal reversed: ${reason}`
    );

    await client.query('COMMIT');

    // Fetch reversal journal with lines
    const fullReversalJournal = await JournalService.getJournalWithLines(
      reversalJournal.id,
      req.user.companyId
    );

    res.json({
      message: 'Journal reversed successfully',
      reversalJournal: fullReversalJournal
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error reversing journal:', error);
    res.status(400).json({ error: error.message || 'Failed to reverse journal' });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/journals/:id
 * Delete a draft journal
 */
router.delete('/:id', authenticate, hasPermission('journal.delete'), async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');

    // Get journal
    const journalResult = await client.query(
      'SELECT * FROM journals WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.companyId]
    );

    if (journalResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Journal not found' });
    }

    const journal = journalResult.rows[0];

    if (journal.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Can only delete draft journals' });
    }

    // Delete journal lines first
    await client.query('DELETE FROM journal_lines WHERE journal_id = $1', [req.params.id]);

    // Delete journal
    await client.query('DELETE FROM journals WHERE id = $1', [req.params.id]);

    // Audit log
    await AuditLogger.logUserAction(
      req,
      'DELETE',
      'JOURNAL',
      journal.id,
      { 
        date: journal.date, 
        reference: journal.reference, 
        description: journal.description 
      },
      null,
      'Draft journal deleted'
    );

    await client.query('COMMIT');

    res.json({ message: 'Journal deleted successfully' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting journal:', error);
    res.status(500).json({ error: 'Failed to delete journal' });
  } finally {
    client.release();
  }
});

module.exports = router;
