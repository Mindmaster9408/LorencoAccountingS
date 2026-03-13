const db = require('../config/database');

/**
 * Journal Service
 * Handles double-entry bookkeeping logic
 */
class JournalService {
  /**
   * Validate that a journal balances (debits = credits)
   */
  static validateBalance(lines) {
    const totalDebits = lines.reduce((sum, line) => sum + parseFloat(line.debit || 0), 0);
    const totalCredits = lines.reduce((sum, line) => sum + parseFloat(line.credit || 0), 0);

    const difference = Math.abs(totalDebits - totalCredits);
    
    // Allow for rounding errors (0.01)
    if (difference > 0.01) {
      return {
        valid: false,
        totalDebits,
        totalCredits,
        difference,
        message: `Journal out of balance: Debits (${totalDebits.toFixed(2)}) != Credits (${totalCredits.toFixed(2)})`
      };
    }

    return {
      valid: true,
      totalDebits,
      totalCredits,
      difference: 0
    };
  }

  /**
   * Validate journal lines
   */
  static validateLines(lines) {
    if (!lines || lines.length === 0) {
      return { valid: false, message: 'Journal must have at least one line' };
    }

    if (lines.length < 2) {
      return { valid: false, message: 'Journal must have at least two lines (double-entry)' };
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (!line.accountId) {
        return { valid: false, message: `Line ${i + 1}: Account is required` };
      }

      const debit = parseFloat(line.debit || 0);
      const credit = parseFloat(line.credit || 0);

      if (debit < 0 || credit < 0) {
        return { valid: false, message: `Line ${i + 1}: Debit and credit must be non-negative` };
      }

      if (debit > 0 && credit > 0) {
        return { valid: false, message: `Line ${i + 1}: Cannot have both debit and credit` };
      }

      if (debit === 0 && credit === 0) {
        return { valid: false, message: `Line ${i + 1}: Must have either debit or credit` };
      }
    }

    return { valid: true };
  }

  /**
   * Check if period is locked
   */
  static async isPeriodLocked(companyId, date) {
    const result = await db.query(
      `SELECT id, from_date, to_date 
       FROM accounting_periods 
       WHERE company_id = $1 
       AND $2 BETWEEN from_date AND to_date 
       AND is_locked = true`,
      [companyId, date]
    );

    return result.rows.length > 0;
  }

  /**
   * Create a draft journal
   */
  static async createDraftJournal(client, { companyId, date, reference, description, sourceType, createdByUserId, lines, metadata }) {
    // Validate lines
    const lineValidation = this.validateLines(lines);
    if (!lineValidation.valid) {
      throw new Error(lineValidation.message);
    }

    // Validate balance
    const balanceValidation = this.validateBalance(lines);
    if (!balanceValidation.valid) {
      throw new Error(balanceValidation.message);
    }

    // Check period lock
    const isLocked = await this.isPeriodLocked(companyId, date);
    if (isLocked) {
      throw new Error('Cannot create journal in a locked period');
    }

    // Create journal header
    const journalResult = await client.query(
      `INSERT INTO journals (company_id, date, reference, description, status, source_type, created_by_user_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [companyId, date, reference, description, 'draft', sourceType, createdByUserId, metadata ? JSON.stringify(metadata) : null]
    );

    const journal = journalResult.rows[0];

    // Create journal lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      await client.query(
        `INSERT INTO journal_lines (journal_id, account_id, line_number, description, debit, credit, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          journal.id,
          line.accountId,
          i + 1,
          line.description || null,
          line.debit || 0,
          line.credit || 0,
          line.metadata ? JSON.stringify(line.metadata) : null
        ]
      );
    }

    return journal;
  }

  /**
   * Update a draft journal's header and lines.
   * Only draft journals may be edited.
   */
  static async updateDraftJournal(client, journalId, companyId, { date, reference, description, lines, updatedByUserId }) {
    // Fetch and guard
    const journalResult = await client.query(
      'SELECT * FROM journals WHERE id = $1 AND company_id = $2',
      [journalId, companyId]
    );

    if (journalResult.rows.length === 0) {
      throw new Error('Journal not found');
    }

    const journal = journalResult.rows[0];

    if (journal.status !== 'draft') {
      throw new Error(`Cannot edit a journal with status: ${journal.status}. Only draft journals may be edited.`);
    }

    // Validate lines
    const lineValidation = this.validateLines(lines);
    if (!lineValidation.valid) {
      throw new Error(lineValidation.message);
    }

    const balanceValidation = this.validateBalance(lines);
    if (!balanceValidation.valid) {
      throw new Error(balanceValidation.message);
    }

    // Check period lock for the new date
    const isLocked = await this.isPeriodLocked(companyId, date);
    if (isLocked) {
      throw new Error('Cannot move journal into a locked period');
    }

    // Update header
    await client.query(
      `UPDATE journals
       SET date = $1, reference = $2, description = $3, updated_at = NOW()
       WHERE id = $4`,
      [date, reference || null, description, journalId]
    );

    // Replace lines: delete all existing, re-insert
    await client.query('DELETE FROM journal_lines WHERE journal_id = $1', [journalId]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      await client.query(
        `INSERT INTO journal_lines (journal_id, account_id, line_number, description, debit, credit, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          journalId,
          line.accountId,
          i + 1,
          line.description || null,
          line.debit || 0,
          line.credit || 0,
          line.metadata ? JSON.stringify(line.metadata) : null
        ]
      );
    }

    return { ...journal, date, reference: reference || null, description };
  }

  /**
   * Post a journal (make it permanent in the ledger)
   */
  static async postJournal(client, journalId, companyId, postedByUserId) {
    // Get journal
    const journalResult = await client.query(
      'SELECT * FROM journals WHERE id = $1 AND company_id = $2',
      [journalId, companyId]
    );

    if (journalResult.rows.length === 0) {
      throw new Error('Journal not found');
    }

    const journal = journalResult.rows[0];

    if (journal.status !== 'draft') {
      throw new Error(`Cannot post journal with status: ${journal.status}`);
    }

    // Check period lock
    const isLocked = await this.isPeriodLocked(companyId, journal.date);
    if (isLocked) {
      throw new Error('Cannot post journal in a locked period');
    }

    // Get journal lines
    const linesResult = await client.query(
      'SELECT * FROM journal_lines WHERE journal_id = $1 ORDER BY line_number',
      [journalId]
    );

    const lines = linesResult.rows;

    // Validate balance
    const balanceValidation = this.validateBalance(lines);
    if (!balanceValidation.valid) {
      throw new Error(balanceValidation.message);
    }

    // Update journal status
    await client.query(
      `UPDATE journals 
       SET status = 'posted', posted_at = CURRENT_TIMESTAMP, posted_by_user_id = $1
       WHERE id = $2`,
      [postedByUserId, journalId]
    );

    return journal;
  }

  /**
   * Reverse a posted journal
   */
  static async reverseJournal(client, originalJournalId, companyId, reversedByUserId, reason) {
    // Get original journal
    const journalResult = await client.query(
      'SELECT * FROM journals WHERE id = $1 AND company_id = $2',
      [originalJournalId, companyId]
    );

    if (journalResult.rows.length === 0) {
      throw new Error('Journal not found');
    }

    const originalJournal = journalResult.rows[0];

    if (originalJournal.status !== 'posted') {
      throw new Error('Can only reverse posted journals');
    }

    if (originalJournal.reversed_by_journal_id) {
      throw new Error('Journal has already been reversed');
    }

    // Check period lock for reversal date (today)
    const today = new Date().toISOString().split('T')[0];
    const isLocked = await this.isPeriodLocked(companyId, today);
    if (isLocked) {
      throw new Error('Cannot create reversal journal in a locked period');
    }

    // Get original journal lines
    const linesResult = await client.query(
      'SELECT * FROM journal_lines WHERE journal_id = $1 ORDER BY line_number',
      [originalJournalId]
    );

    const originalLines = linesResult.rows;

    // Create reversal journal
    const reversalResult = await client.query(
      `INSERT INTO journals (company_id, date, reference, description, status, source_type, created_by_user_id, posted_by_user_id, posted_at, reversal_of_journal_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, CURRENT_TIMESTAMP, $8, $9)
       RETURNING *`,
      [
        companyId,
        today,
        `REV-${originalJournal.reference || originalJournal.id}`,
        `Reversal of: ${originalJournal.description}. Reason: ${reason}`,
        'posted',
        originalJournal.source_type,
        reversedByUserId,
        originalJournalId,
        JSON.stringify({ reversalReason: reason })
      ]
    );

    const reversalJournal = reversalResult.rows[0];

    // Create reversed lines (swap debits and credits)
    for (let i = 0; i < originalLines.length; i++) {
      const originalLine = originalLines[i];
      await client.query(
        `INSERT INTO journal_lines (journal_id, account_id, line_number, description, debit, credit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          reversalJournal.id,
          originalLine.account_id,
          i + 1,
          `Reversal: ${originalLine.description || ''}`,
          originalLine.credit, // Swap
          originalLine.debit   // Swap
        ]
      );
    }

    // Mark original journal as reversed
    await client.query(
      'UPDATE journals SET status = $1, reversed_by_journal_id = $2 WHERE id = $3',
      ['reversed', reversalJournal.id, originalJournalId]
    );

    return reversalJournal;
  }

  /**
   * Get journal with lines
   */
  static async getJournalWithLines(journalId, companyId) {
    const journalResult = await db.query(
      'SELECT * FROM journals WHERE id = $1 AND company_id = $2',
      [journalId, companyId]
    );

    if (journalResult.rows.length === 0) {
      return null;
    }

    const journal = journalResult.rows[0];

    const linesResult = await db.query(
      `SELECT jl.*, a.code as account_code, a.name as account_name, a.type as account_type
       FROM journal_lines jl
       JOIN accounts a ON jl.account_id = a.id
       WHERE jl.journal_id = $1
       ORDER BY jl.line_number`,
      [journalId]
    );

    journal.lines = linesResult.rows;

    return journal;
  }
}

module.exports = JournalService;
