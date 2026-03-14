const db = require('../config/database');

/**
 * VAT Reconciliation Service
 * Manages VAT periods, reconciliations, approvals, authorizations, and locking
 */

class VATReconciliationService {
    
    // ========================================================
    // VAT PERIODS
    // ========================================================
    
    /**
     * Create or get a VAT period
     */
    async createOrGetPeriod(companyId, periodData) {
        const { periodKey, fromDate, toDate, filingFrequency } = periodData;
        
        // Check if period already exists
        const existing = await db.query(
            `SELECT * FROM vat_periods 
             WHERE company_id = $1 AND period_key = $2`,
            [companyId, periodKey]
        );
        
        if (existing.rows.length > 0) {
            return existing.rows[0];
        }
        
        // Create new period
        const result = await db.query(
            `INSERT INTO vat_periods 
             (company_id, period_key, from_date, to_date, filing_frequency, status)
             VALUES ($1, $2, $3, $4, $5, 'DRAFT')
             RETURNING *`,
            [companyId, periodKey, fromDate, toDate, filingFrequency]
        );
        
        return result.rows[0];
    }
    
    /**
     * Get all VAT periods for a company
     */
    async getPeriods(companyId, filters = {}) {
        let query = 'SELECT * FROM vat_periods WHERE company_id = $1';
        const params = [companyId];
        let paramCount = 1;
        
        if (filters.status) {
            paramCount++;
            query += ` AND status = $${paramCount}`;
            params.push(filters.status);
        }
        
        if (filters.fromDate) {
            paramCount++;
            query += ` AND from_date >= $${paramCount}`;
            params.push(filters.fromDate);
        }
        
        if (filters.toDate) {
            paramCount++;
            query += ` AND to_date <= $${paramCount}`;
            params.push(filters.toDate);
        }
        
        query += ' ORDER BY from_date DESC';
        
        const result = await db.query(query, params);
        return result.rows;
    }
    
    /**
     * Get single period by ID or period_key
     */
    async getPeriod(companyId, periodIdOrKey) {
        let result;
        
        if (isNaN(periodIdOrKey)) {
            // It's a period_key
            result = await db.query(
                'SELECT * FROM vat_periods WHERE company_id = $1 AND period_key = $2',
                [companyId, periodIdOrKey]
            );
        } else {
            // It's an ID
            result = await db.query(
                'SELECT * FROM vat_periods WHERE company_id = $1 AND id = $2',
                [companyId, periodIdOrKey]
            );
        }
        
        return result.rows[0];
    }
    
    // ========================================================
    // VAT RECONCILIATIONS
    // ========================================================
    
    /**
     * Create or update draft reconciliation
     */
    async saveDraftReconciliation(companyId, userId, reconData) {
        const { vatPeriodId, lines, soaAmount, metadata } = reconData;
        
        // Verify period exists and belongs to company
        const period = await this.getPeriod(companyId, vatPeriodId);
        if (!period) {
            throw new Error('VAT period not found');
        }
        
        // Check if period is locked
        if (period.status === 'LOCKED') {
            throw new Error('Cannot edit locked VAT period');
        }
        
        const client = await db.getClient();
        
        try {
            await client.query('BEGIN');
            
            // Check for existing draft reconciliation
            const existing = await client.query(
                `SELECT * FROM vat_reconciliations 
                 WHERE company_id = $1 AND vat_period_id = $2 AND status = 'DRAFT'
                 ORDER BY version DESC LIMIT 1`,
                [companyId, vatPeriodId]
            );
        
        let reconId;
        
        if (existing.rows.length > 0) {
            // Update existing draft
            reconId = existing.rows[0].id;
            await client.query(
                `UPDATE vat_reconciliations 
                 SET soa_amount = $1, metadata = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [soaAmount, JSON.stringify(metadata || {}), reconId]
            );
        } else {
            // Create new draft - get max version across ALL statuses
            const maxVersionResult = await client.query(
                `SELECT COALESCE(MAX(version), 0) as max_version FROM vat_reconciliations 
                 WHERE company_id = $1 AND vat_period_id = $2`,
                [companyId, vatPeriodId]
            );
            const newVersion = maxVersionResult.rows[0].max_version + 1;
            const result = await client.query(
                `INSERT INTO vat_reconciliations 
                 (company_id, vat_period_id, version, status, created_by_user_id, soa_amount, metadata)
                 VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6)
                 RETURNING *`,
                [companyId, vatPeriodId, newVersion, userId, soaAmount, JSON.stringify(metadata || {})]
            );
            reconId = result.rows[0].id;
        }
        
        // Delete existing lines and insert new ones
        await client.query(
            'DELETE FROM vat_reconciliation_lines WHERE vat_reconciliation_id = $1',
            [reconId]
        );
        
        if (lines && lines.length > 0) {
            for (const line of lines) {
                await client.query(
                    `INSERT INTO vat_reconciliation_lines 
                     (vat_reconciliation_id, section_key, row_key, label, line_order, 
                      vat_amount, tb_amount, statement_amount, difference_amount, 
                      account_id, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                    [
                        reconId, line.sectionKey, line.rowKey, line.label, line.lineOrder || 0,
                        line.vatAmount, line.tbAmount, line.statementAmount, line.differenceAmount,
                        line.accountId, JSON.stringify(line.metadata || {})
                    ]
                );
            }
        }
        
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        
        return this.getReconciliation(companyId, reconId);
    }
    
    /**
     * Get reconciliation with lines
     */
    async getReconciliation(companyId, reconId) {
        const reconResult = await db.query(
            `SELECT r.*, p.period_key, p.from_date, p.to_date, p.filing_frequency
             FROM vat_reconciliations r
             JOIN vat_periods p ON r.vat_period_id = p.id
             WHERE r.company_id = $1 AND r.id = $2`,
            [companyId, reconId]
        );
        
        if (reconResult.rows.length === 0) {
            return null;
        }
        
        const recon = reconResult.rows[0];
        
        // Get lines
        const linesResult = await db.query(
            `SELECT * FROM vat_reconciliation_lines 
             WHERE vat_reconciliation_id = $1 
             ORDER BY section_key, line_order, id`,
            [reconId]
        );
        
        recon.lines = linesResult.rows;
        
        return recon;
    }
    
    /**
     * Get reconciliation for a specific period
     */
    async getReconciliationByPeriod(companyId, periodIdOrKey, version = null) {
        const period = await this.getPeriod(companyId, periodIdOrKey);
        if (!period) {
            return null;
        }
        
        let query = `
            SELECT r.*, p.period_key, p.from_date, p.to_date, p.filing_frequency
            FROM vat_reconciliations r
            JOIN vat_periods p ON r.vat_period_id = p.id
            WHERE r.company_id = $1 AND r.vat_period_id = $2
        `;
        const params = [companyId, period.id];
        
        if (version !== null) {
            query += ' AND r.version = $3';
            params.push(version);
        } else {
            // Get latest approved or latest draft
            query += ` ORDER BY 
                CASE WHEN r.status = 'APPROVED' THEN 1 
                     WHEN r.status = 'LOCKED' THEN 2 
                     ELSE 3 END, 
                r.version DESC 
                LIMIT 1`;
        }
        
        const reconResult = await db.query(query, params);
        
        if (reconResult.rows.length === 0) {
            return null;
        }
        
        const recon = reconResult.rows[0];
        
        // Get lines
        const linesResult = await db.query(
            `SELECT * FROM vat_reconciliation_lines 
             WHERE vat_reconciliation_id = $1 
             ORDER BY section_key, line_order, id`,
            [recon.id]
        );
        
        recon.lines = linesResult.rows;
        
        return recon;
    }
    
    // ========================================================
    // AUTHORIZATION
    // ========================================================
    
    /**
     * Authorize difference (Income/Expense reconciliation)
     */
    async authorizeDifference(companyId, reconId, userId, userInitials) {
        const recon = await this.getReconciliation(companyId, reconId);
        if (!recon) {
            throw new Error('Reconciliation not found');
        }
        
        if (recon.status === 'LOCKED') {
            throw new Error('Cannot authorize locked reconciliation');
        }
        
        await db.query(
            `UPDATE vat_reconciliations 
             SET diff_authorized = true,
                 diff_authorized_by_user_id = $1,
                 diff_authorized_by_initials = $2,
                 diff_authorized_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [userId, userInitials, reconId]
        );
        
        return this.getReconciliation(companyId, reconId);
    }
    
    /**
     * Authorize Statement of Account difference
     */
    async authorizeSOADifference(companyId, reconId, userId, userInitials) {
        const recon = await this.getReconciliation(companyId, reconId);
        if (!recon) {
            throw new Error('Reconciliation not found');
        }
        
        if (recon.status === 'LOCKED') {
            throw new Error('Cannot authorize locked reconciliation');
        }
        
        await db.query(
            `UPDATE vat_reconciliations 
             SET soa_authorized = true,
                 soa_authorized_by_user_id = $1,
                 soa_authorized_by_initials = $2,
                 soa_authorized_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [userId, userInitials, reconId]
        );
        
        return this.getReconciliation(companyId, reconId);
    }
    
    // ========================================================
    // APPROVAL
    // ========================================================
    
    /**
     * Approve reconciliation
     */
    async approveReconciliation(companyId, reconId, userId) {
        const recon = await this.getReconciliation(companyId, reconId);
        if (!recon) {
            throw new Error('Reconciliation not found');
        }
        
        if (recon.status === 'LOCKED') {
            throw new Error('Cannot approve locked reconciliation');
        }
        
        if (recon.status === 'APPROVED') {
            throw new Error('Reconciliation already approved');
        }
        
        await db.query(
            `UPDATE vat_reconciliations 
             SET status = 'APPROVED',
                 approved_by_user_id = $1,
                 approved_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [userId, reconId]
        );
        
        // Update period status if not already approved
        await db.query(
            `UPDATE vat_periods 
             SET status = 'APPROVED'
             WHERE id = $1 AND status = 'DRAFT'`,
            [recon.vat_period_id]
        );
        
        return this.getReconciliation(companyId, reconId);
    }
    
    // ========================================================
    // SUBMISSION AND LOCKING
    // ========================================================
    
    /**
     * Submit to SARS and lock
     */
    async submitToSARS(companyId, periodId, userId, submissionData) {
        const period = await this.getPeriod(companyId, periodId);
        if (!period) {
            throw new Error('VAT period not found');
        }
        
        if (period.status === 'LOCKED') {
            throw new Error('Period already locked');
        }
        
        // Get approved reconciliation
        const recon = await this.getReconciliationByPeriod(companyId, periodId);
        if (!recon || recon.status !== 'APPROVED') {
            throw new Error('No approved reconciliation found for this period');
        }
        
        const { outputVat, inputVat, netVat, submissionReference, paymentDate, paymentReference } = submissionData;
        
        // Begin transaction
        const client = await db.getClient();
        
        try {
            await client.query('BEGIN');
            // Create submission record
            const submissionResult = await client.query(
                `INSERT INTO vat_submissions 
                 (company_id, vat_period_id, vat_reconciliation_id, 
                  submission_date, submitted_by_user_id, submission_reference,
                  output_vat, input_vat, net_vat, payment_date, payment_reference)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING *`,
                [companyId, period.id, recon.id, userId, submissionReference,
                 outputVat, inputVat, netVat, paymentDate, paymentReference]
            );
            
            // Lock reconciliation
            await client.query(
                `UPDATE vat_reconciliations 
                 SET status = 'LOCKED',
                     locked_by_user_id = $1,
                     locked_at = CURRENT_TIMESTAMP,
                     submitted_by_user_id = $1,
                     submitted_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [userId, recon.id]
            );
            
            // Lock period
            await client.query(
                `UPDATE vat_periods 
                 SET status = 'LOCKED',
                     locked_by_user_id = $1,
                     locked_at = CURRENT_TIMESTAMP,
                     submitted_by_user_id = $1,
                     submitted_at = CURRENT_TIMESTAMP,
                     submission_reference = $2,
                     payment_date = $3
                 WHERE id = $4`,
                [userId, submissionReference, paymentDate, period.id]
            );
            
            // Lock VAT report if exists
            await client.query(
                `UPDATE vat_reports 
                 SET status = 'LOCKED',
                     locked_by_user_id = $1,
                     locked_at = CURRENT_TIMESTAMP
                 WHERE vat_period_id = $2`,
                [userId, period.id]
            );
            
            await client.query('COMMIT');
            
            return submissionResult.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    
    /**
     * Get submission history
     */
    async getSubmissions(companyId, filters = {}) {
        let query = `
            SELECT s.*,
                   p.period_key, p.from_date, p.to_date,
                   r.id as reconciliation_id,
                   rep.id as vat_report_id
            FROM vat_submissions s
            JOIN vat_periods p ON s.vat_period_id = p.id
            LEFT JOIN vat_reconciliations r ON s.vat_reconciliation_id = r.id
            LEFT JOIN vat_reports rep ON rep.vat_period_id = s.vat_period_id
            WHERE s.company_id = $1
        `;
        const params = [companyId];
        let paramCount = 1;
        
        if (filters.periodId) {
            paramCount++;
            query += ` AND s.vat_period_id = $${paramCount}`;
            params.push(filters.periodId);
        }
        
        if (filters.status) {
            paramCount++;
            query += ` AND s.status = $${paramCount}`;
            params.push(filters.status);
        }
        
        query += ' ORDER BY s.submission_date DESC';
        
        const result = await db.query(query, params);
        return result.rows;
    }
    
    // ========================================================
    // TRIAL BALANCE INTEGRATION
    // ========================================================
    
    /**
     * Get Trial Balance data for a specific period
     */
    async getTrialBalanceForPeriod(companyId, fromDate, toDate) {
        const query = `
            SELECT 
                a.id as account_id,
                a.code as account_code,
                a.name as account_name,
                a.type as account_type,
                COALESCE(SUM(jl.debit - jl.credit), 0) as amount
            FROM accounts a
            LEFT JOIN journal_lines jl ON jl.account_id = a.id
            LEFT JOIN journals j ON jl.journal_id = j.id
                AND j.company_id = $1
                AND j.status = 'posted'
                AND j.date >= $2
                AND j.date <= $3
            WHERE a.company_id = $1
                AND a.is_active = true
            GROUP BY a.id, a.code, a.name, a.type
            HAVING COALESCE(SUM(jl.debit - jl.credit), 0) != 0
            ORDER BY a.code
        `;
        
        const result = await db.query(query, [companyId, fromDate, toDate]);
        return result.rows;
    }
    
    /**
     * Generate user initials from user data
     */
    generateUserInitials(firstName, lastName) {
        if (!firstName || !lastName) {
            return '??';
        }
        
        const firstInitial = firstName.charAt(0).toLowerCase();
        
        // Handle "van" and other prefixes
        const lastNameParts = lastName.split(' ');
        let lastInitial;
        
        if (lastNameParts.length > 1 && lastNameParts[0].toLowerCase() === 'van') {
            // Format: "r vL" for "Ruan van Loughrenberg"
            lastInitial = 'v' + lastNameParts[1].charAt(0).toUpperCase();
        } else {
            lastInitial = lastName.charAt(0).toUpperCase();
        }
        
        return `${firstInitial} ${lastInitial}`;
    }
}

module.exports = new VATReconciliationService();
