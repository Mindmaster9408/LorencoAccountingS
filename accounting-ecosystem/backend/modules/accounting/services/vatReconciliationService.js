const { supabase } = require('../../../config/database');
const { generatePeriods, derivePeriodForDate } = require('./vatPeriodUtils');

/**
 * VAT Reconciliation Service
 * Manages VAT periods, reconciliations, approvals, authorizations, and locking
 */

class VATReconciliationService {

    // ========================================================
    // HELPERS
    // ========================================================

    /**
     * Fetch a reconciliation row by ID and flatten the joined period columns
     * into the top-level object (matching the original SQL JOIN shape).
     */
    async _fetchReconWithPeriod(companyId, reconId) {
        const { data: recon, error: reconErr } = await supabase
            .from('vat_reconciliations')
            .select('*')
            .eq('company_id', companyId)
            .eq('id', reconId)
            .maybeSingle();

        if (reconErr) throw new Error(reconErr.message);
        if (!recon) return null;

        const { data: period, error: periodErr } = await supabase
            .from('vat_periods')
            .select('period_key, from_date, to_date, filing_frequency')
            .eq('id', recon.vat_period_id)
            .maybeSingle();

        if (periodErr) throw new Error(periodErr.message);

        return {
            ...recon,
            period_key:       period?.period_key       || null,
            from_date:        period?.from_date         || null,
            to_date:          period?.to_date           || null,
            filing_frequency: period?.filing_frequency  || null,
        };
    }

    // ========================================================
    // VAT PERIODS
    // ========================================================

    /**
     * Create or get a VAT period
     */
    async createOrGetPeriod(companyId, periodData) {
        const { periodKey, fromDate, toDate, filingFrequency } = periodData;

        // Check if period already exists
        const { data: existing, error: checkErr } = await supabase
            .from('vat_periods')
            .select('*')
            .eq('company_id', companyId)
            .eq('period_key', periodKey)
            .maybeSingle();

        if (checkErr) throw new Error(checkErr.message);
        if (existing) return existing;

        // Create new period
        const { data: created, error: insertErr } = await supabase
            .from('vat_periods')
            .insert({
                company_id:       companyId,
                period_key:       periodKey,
                from_date:        fromDate,
                to_date:          toDate,
                filing_frequency: filingFrequency,
                status:           'DRAFT',
            })
            .select()
            .single();

        if (insertErr) throw new Error(insertErr.message);
        return created;
    }

    /**
     * Get all VAT periods for a company
     */
    async getPeriods(companyId, filters = {}) {
        let query = supabase
            .from('vat_periods')
            .select('*')
            .eq('company_id', companyId);

        if (filters.status)   query = query.eq('status', filters.status);
        if (filters.fromDate) query = query.gte('from_date', filters.fromDate);
        if (filters.toDate)   query = query.lte('to_date', filters.toDate);

        query = query.order('from_date', { ascending: false });

        const { data, error } = await query;
        if (error) throw new Error(error.message);
        return data || [];
    }

    /**
     * Get single period by ID or period_key
     */
    async getPeriod(companyId, periodIdOrKey) {
        let query = supabase
            .from('vat_periods')
            .select('*')
            .eq('company_id', companyId);

        if (isNaN(periodIdOrKey)) {
            query = query.eq('period_key', periodIdOrKey);
        } else {
            query = query.eq('id', periodIdOrKey);
        }

        const { data, error } = await query.maybeSingle();
        if (error) throw new Error(error.message);
        return data;
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

        // Check for existing DRAFT reconciliation (most recent version)
        const { data: existingList, error: existingErr } = await supabase
            .from('vat_reconciliations')
            .select('*')
            .eq('company_id', companyId)
            .eq('vat_period_id', vatPeriodId)
            .eq('status', 'DRAFT')
            .order('version', { ascending: false })
            .limit(1);

        if (existingErr) throw new Error(existingErr.message);

        let reconId;

        if (existingList && existingList.length > 0) {
            // Update existing draft
            reconId = existingList[0].id;
            const { error: updateErr } = await supabase
                .from('vat_reconciliations')
                .update({
                    soa_amount:  soaAmount,
                    metadata:    metadata || {},
                    updated_at:  new Date().toISOString(),
                })
                .eq('id', reconId);

            if (updateErr) throw new Error(updateErr.message);
        } else {
            // Create new draft — get max version across ALL statuses first
            const { data: maxVerData, error: maxVerErr } = await supabase
                .from('vat_reconciliations')
                .select('version')
                .eq('company_id', companyId)
                .eq('vat_period_id', vatPeriodId)
                .order('version', { ascending: false })
                .limit(1);

            if (maxVerErr) throw new Error(maxVerErr.message);

            const newVersion = (maxVerData && maxVerData.length > 0) ? maxVerData[0].version + 1 : 1;

            const { data: newRecon, error: insertErr } = await supabase
                .from('vat_reconciliations')
                .insert({
                    company_id:          companyId,
                    vat_period_id:       vatPeriodId,
                    version:             newVersion,
                    status:              'DRAFT',
                    created_by_user_id:  userId,
                    soa_amount:          soaAmount,
                    metadata:            metadata || {},
                })
                .select('id')
                .single();

            if (insertErr) throw new Error(insertErr.message);
            reconId = newRecon.id;
        }

        // Delete existing lines and replace with new ones
        const { error: deleteErr } = await supabase
            .from('vat_reconciliation_lines')
            .delete()
            .eq('vat_reconciliation_id', reconId);

        if (deleteErr) throw new Error(deleteErr.message);

        if (lines && lines.length > 0) {
            const lineInserts = lines.map(line => ({
                vat_reconciliation_id: reconId,
                section_key:           line.sectionKey,
                row_key:               line.rowKey,
                label:                 line.label,
                line_order:            line.lineOrder || 0,
                vat_amount:            line.vatAmount,
                tb_amount:             line.tbAmount,
                statement_amount:      line.statementAmount,
                difference_amount:     line.differenceAmount,
                account_id:            line.accountId,
                metadata:              line.metadata || {},
            }));

            const { error: linesErr } = await supabase
                .from('vat_reconciliation_lines')
                .insert(lineInserts);

            if (linesErr) throw new Error(linesErr.message);
        }

        return this.getReconciliation(companyId, reconId);
    }

    /**
     * Get reconciliation with lines
     */
    async getReconciliation(companyId, reconId) {
        const recon = await this._fetchReconWithPeriod(companyId, reconId);
        if (!recon) return null;

        // Get lines
        const { data: lines, error: linesErr } = await supabase
            .from('vat_reconciliation_lines')
            .select('*')
            .eq('vat_reconciliation_id', reconId)
            .order('section_key')
            .order('line_order')
            .order('id');

        if (linesErr) throw new Error(linesErr.message);

        recon.lines = lines || [];
        return recon;
    }

    /**
     * Get reconciliation for a specific period
     */
    async getReconciliationByPeriod(companyId, periodIdOrKey, version = null) {
        const period = await this.getPeriod(companyId, periodIdOrKey);
        if (!period) return null;

        let query = supabase
            .from('vat_reconciliations')
            .select('*')
            .eq('company_id', companyId)
            .eq('vat_period_id', period.id);

        if (version !== null) {
            query = query.eq('version', version).limit(1);
        }

        const { data: recons, error: reconErr } = await query;
        if (reconErr) throw new Error(reconErr.message);
        if (!recons || recons.length === 0) return null;

        let recon;
        if (version !== null) {
            recon = recons[0];
        } else {
            // Sort in JS: APPROVED first, then LOCKED, then others, then by version DESC
            // (mirrors original SQL: CASE WHEN status='APPROVED' THEN 1 WHEN 'LOCKED' THEN 2 ELSE 3, version DESC)
            const priority = { APPROVED: 1, LOCKED: 2 };
            const sorted = recons.slice().sort((a, b) => {
                const pa = priority[a.status] || 3;
                const pb = priority[b.status] || 3;
                if (pa !== pb) return pa - pb;
                return b.version - a.version;
            });
            recon = sorted[0];
        }

        // Fetch period columns and flatten
        const { data: periodRow, error: periodErr } = await supabase
            .from('vat_periods')
            .select('period_key, from_date, to_date, filing_frequency')
            .eq('id', period.id)
            .maybeSingle();

        if (periodErr) throw new Error(periodErr.message);

        const flatRecon = {
            ...recon,
            period_key:       periodRow?.period_key       || null,
            from_date:        periodRow?.from_date         || null,
            to_date:          periodRow?.to_date           || null,
            filing_frequency: periodRow?.filing_frequency  || null,
        };

        // Get lines
        const { data: lines, error: linesErr } = await supabase
            .from('vat_reconciliation_lines')
            .select('*')
            .eq('vat_reconciliation_id', recon.id)
            .order('section_key')
            .order('line_order')
            .order('id');

        if (linesErr) throw new Error(linesErr.message);

        flatRecon.lines = lines || [];
        return flatRecon;
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

        const { error } = await supabase
            .from('vat_reconciliations')
            .update({
                diff_authorized:              true,
                diff_authorized_by_user_id:   userId,
                diff_authorized_by_initials:  userInitials,
                diff_authorized_at:           new Date().toISOString(),
            })
            .eq('id', reconId);

        if (error) throw new Error(error.message);

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

        const { error } = await supabase
            .from('vat_reconciliations')
            .update({
                soa_authorized:              true,
                soa_authorized_by_user_id:   userId,
                soa_authorized_by_initials:  userInitials,
                soa_authorized_at:           new Date().toISOString(),
            })
            .eq('id', reconId);

        if (error) throw new Error(error.message);

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

        const { error: reconUpdateErr } = await supabase
            .from('vat_reconciliations')
            .update({
                status:              'APPROVED',
                approved_by_user_id: userId,
                approved_at:         new Date().toISOString(),
            })
            .eq('id', reconId);

        if (reconUpdateErr) throw new Error(reconUpdateErr.message);

        // Update period status if still in DRAFT
        const { error: periodUpdateErr } = await supabase
            .from('vat_periods')
            .update({ status: 'APPROVED' })
            .eq('id', recon.vat_period_id)
            .eq('status', 'DRAFT');

        if (periodUpdateErr) throw new Error(periodUpdateErr.message);

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

        // Create submission record
        const { data: submission, error: subErr } = await supabase
            .from('vat_submissions')
            .insert({
                company_id:              companyId,
                vat_period_id:           period.id,
                vat_reconciliation_id:   recon.id,
                submission_date:         new Date().toISOString(),
                submitted_by_user_id:    userId,
                submission_reference:    submissionReference,
                output_vat:              outputVat,
                input_vat:               inputVat,
                net_vat:                 netVat,
                payment_date:            paymentDate,
                payment_reference:       paymentReference,
            })
            .select()
            .single();

        if (subErr) throw new Error(subErr.message);

        // Lock reconciliation
        const { error: lockReconErr } = await supabase
            .from('vat_reconciliations')
            .update({
                status:                  'LOCKED',
                locked_by_user_id:       userId,
                locked_at:               new Date().toISOString(),
                submitted_by_user_id:    userId,
                submitted_at:            new Date().toISOString(),
            })
            .eq('id', recon.id);

        if (lockReconErr) throw new Error(lockReconErr.message);

        // Lock period
        const { error: lockPeriodErr } = await supabase
            .from('vat_periods')
            .update({
                status:                  'LOCKED',
                locked_by_user_id:       userId,
                locked_at:               new Date().toISOString(),
                submitted_by_user_id:    userId,
                submitted_at:            new Date().toISOString(),
                submission_reference:    submissionReference,
                payment_date:            paymentDate,
            })
            .eq('id', period.id);

        if (lockPeriodErr) throw new Error(lockPeriodErr.message);

        // Lock VAT report if one exists for this period
        await supabase
            .from('vat_reports')
            .update({
                status:              'LOCKED',
                locked_by_user_id:   userId,
                locked_at:           new Date().toISOString(),
            })
            .eq('vat_period_id', period.id);
        // No error check — it's fine if no vat_reports row exists for this period

        return submission;
    }

    /**
     * Get submission history
     */
    async getSubmissions(companyId, filters = {}) {
        let query = supabase
            .from('vat_submissions')
            .select('*')
            .eq('company_id', companyId);

        if (filters.periodId) query = query.eq('vat_period_id', filters.periodId);
        if (filters.status)   query = query.eq('status', filters.status);

        query = query.order('submission_date', { ascending: false });

        const { data: submissions, error } = await query;
        if (error) throw new Error(error.message);
        if (!submissions || submissions.length === 0) return [];

        // Fetch period details for all involved periods in one query
        const periodIds = [...new Set(submissions.map(s => s.vat_period_id))];
        const { data: periods, error: periodsErr } = await supabase
            .from('vat_periods')
            .select('id, period_key, from_date, to_date')
            .in('id', periodIds);

        if (periodsErr) throw new Error(periodsErr.message);

        const periodMap = {};
        for (const p of periods || []) periodMap[p.id] = p;

        // Fetch vat_report IDs for the involved periods in one query
        const { data: vatReports, error: reportsErr } = await supabase
            .from('vat_reports')
            .select('id, vat_period_id')
            .in('vat_period_id', periodIds);

        if (reportsErr) throw new Error(reportsErr.message);

        const vatReportByPeriod = {};
        for (const r of vatReports || []) vatReportByPeriod[r.vat_period_id] = r.id;

        // Flatten and merge period + vat_report data into each submission row
        return submissions.map(s => {
            const p = periodMap[s.vat_period_id] || {};
            return {
                ...s,
                period_key:        p.period_key   || null,
                from_date:         p.from_date     || null,
                to_date:           p.to_date       || null,
                reconciliation_id: s.vat_reconciliation_id || null,
                vat_report_id:     vatReportByPeriod[s.vat_period_id] || null,
            };
        });
    }

    // ========================================================
    // TRIAL BALANCE INTEGRATION
    // ========================================================

    /**
     * Get Trial Balance data for a specific period
     */
    async getTrialBalanceForPeriod(companyId, fromDate, toDate) {
        // Fetch active accounts for the company
        const { data: accounts, error: acctErr } = await supabase
            .from('accounts')
            .select('id, code, name, type')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('code');

        if (acctErr) throw new Error(acctErr.message);
        if (!accounts || accounts.length === 0) return [];

        // Fetch posted journal IDs for the company within the date range
        const { data: journals, error: journalsErr } = await supabase
            .from('journals')
            .select('id')
            .eq('company_id', companyId)
            .eq('status', 'posted')
            .gte('date', fromDate)
            .lte('date', toDate);

        if (journalsErr) throw new Error(journalsErr.message);

        // Aggregate journal line amounts per account in JavaScript
        const lineMap = {};

        if (journals && journals.length > 0) {
            const journalIds = journals.map(j => j.id);

            const { data: lines, error: linesErr } = await supabase
                .from('journal_lines')
                .select('account_id, debit, credit')
                .in('journal_id', journalIds);

            if (linesErr) throw new Error(linesErr.message);

            for (const line of lines || []) {
                if (!lineMap[line.account_id]) lineMap[line.account_id] = 0;
                lineMap[line.account_id] += (parseFloat(line.debit) || 0) - (parseFloat(line.credit) || 0);
            }
        }

        // Return accounts with non-zero balances (equivalent to HAVING != 0)
        return accounts
            .filter(a => Math.abs(lineMap[a.id] || 0) >= 0.001)
            .map(a => ({
                account_id:   a.id,
                account_code: a.code,
                account_name: a.name,
                account_type: a.type,
                amount:       lineMap[a.id] || 0,
            }));
    }

    // ========================================================
    // PERIOD GENERATION (Prompt 2)
    // ========================================================

    /**
     * Auto-generate VAT period records for a company using its configured
     * filing frequency and cycle type.
     *
     * Idempotent — skips periods that already exist (same period_key).
     *
     * @param {number} companyId
     * @param {string} fromDateStr  YYYY-MM-DD — start of range
     * @param {string} toDateStr    YYYY-MM-DD — end of range (defaults to today)
     * @returns {Array} created period records
     */
    async generatePeriodsRange(companyId, fromDateStr, toDateStr) {
        // Fetch company VAT settings
        const { data: company, error: coErr } = await supabase
            .from('companies')
            .select('vat_period, vat_cycle_type, is_vat_registered, vat_registered_date')
            .eq('id', companyId)
            .single();

        if (coErr || !company) throw new Error('Company not found');
        if (!company.is_vat_registered) throw new Error('Company is not VAT registered');

        const filingFrequency = company.vat_period       || 'bi-monthly';
        const vatCycleType    = company.vat_cycle_type    || 'even';
        const effectiveFrom   = fromDateStr || company.vat_registered_date || '2020-01-01';
        const effectiveTo     = toDateStr   || new Date().toISOString().split('T')[0];

        const periodDefs = generatePeriods(effectiveFrom, effectiveTo, filingFrequency, vatCycleType);

        const created = [];
        for (const p of periodDefs) {
            // Check if already exists
            const { data: existing } = await supabase
                .from('vat_periods')
                .select('id')
                .eq('company_id', companyId)
                .eq('period_key', p.periodKey)
                .maybeSingle();

            if (existing) continue;

            const { data: inserted, error: insErr } = await supabase
                .from('vat_periods')
                .insert({
                    company_id:       companyId,
                    period_key:       p.periodKey,
                    from_date:        p.fromDate,
                    to_date:          p.toDate,
                    filing_frequency: filingFrequency,
                    vat_cycle_type:   vatCycleType,
                    status:           'open',
                    out_of_period_count:        0,
                    out_of_period_total_input:  0,
                    out_of_period_total_output: 0,
                })
                .select()
                .single();

            if (insErr) throw new Error(insErr.message);
            created.push(inserted);
        }

        return created;
    }

    // ========================================================
    // PERIOD LOCKING (Prompt 2)
    // ========================================================

    /**
     * Lock a VAT period.
     *
     * Hard rules:
     * - Period must exist and belong to company
     * - Period must not already be locked
     * - Only admin or accountant role may lock (caller must verify role before calling)
     *
     * This is separate from submitToSARS (which also locks) so users can lock
     * without the SARS submission step when needed.
     */
    async lockPeriod(companyId, periodId, userId) {
        const period = await this.getPeriod(companyId, periodId);
        if (!period) throw new Error('VAT period not found');
        if ((period.status || '').toUpperCase() === 'LOCKED') throw new Error('Period is already locked');

        const { error } = await supabase
            .from('vat_periods')
            .update({
                status:             'LOCKED',
                locked_by_user_id:  userId,
                locked_at:          new Date().toISOString(),
                updated_at:         new Date().toISOString(),
            })
            .eq('id', period.id)
            .eq('company_id', companyId);

        if (error) throw new Error(error.message);

        // Also lock the associated VAT report + reconciliation if they exist
        await supabase.from('vat_reports').update({
            status:            'LOCKED',
            locked_by_user_id: userId,
            locked_at:         new Date().toISOString(),
        }).eq('company_id', companyId).eq('vat_period_id', period.id);

        await supabase.from('vat_reconciliations').update({
            status:            'LOCKED',
            locked_by_user_id: userId,
            locked_at:         new Date().toISOString(),
        }).eq('company_id', companyId).eq('vat_period_id', period.id).neq('status', 'LOCKED');

        return { ...period, status: 'LOCKED' };
    }

    // ========================================================
    // CURRENT OPEN PERIOD (Prompt 2)
    // ========================================================

    /**
     * Find the current open VAT period for a company (the most recent open one).
     * If none exists, derive and create one based on today's date.
     */
    async getCurrentOpenPeriod(companyId) {
        const { data: company } = await supabase
            .from('companies')
            .select('vat_period, vat_cycle_type, is_vat_registered')
            .eq('id', companyId)
            .single();

        if (!company || !company.is_vat_registered) return null;

        const filingFrequency = company.vat_period    || 'bi-monthly';
        const vatCycleType    = company.vat_cycle_type || 'even';

        // Find most recent open period
        const { data: openPeriods } = await supabase
            .from('vat_periods')
            .select('*')
            .eq('company_id', companyId)
            .ilike('status', 'open')        // case-insensitive: 'open' or 'OPEN'
            .order('from_date', { ascending: false })
            .limit(1);

        if (openPeriods && openPeriods.length > 0) return openPeriods[0];

        // No open period — auto-create one for today
        const today  = new Date().toISOString().split('T')[0];
        const period = derivePeriodForDate(today, filingFrequency, vatCycleType);

        const { data: existing } = await supabase
            .from('vat_periods')
            .select('*')
            .eq('company_id', companyId)
            .eq('period_key', period.periodKey)
            .maybeSingle();

        if (existing) return existing;

        const { data: created, error } = await supabase
            .from('vat_periods')
            .insert({
                company_id:       companyId,
                period_key:       period.periodKey,
                from_date:        period.fromDate,
                to_date:          period.toDate,
                filing_frequency: filingFrequency,
                vat_cycle_type:   vatCycleType,
                status:           'open',
                out_of_period_count:        0,
                out_of_period_total_input:  0,
                out_of_period_total_output: 0,
            })
            .select()
            .single();

        if (error) throw new Error(error.message);
        return created;
    }

    // ========================================================
    // OUT-OF-PERIOD ITEMS (Prompt 2)
    // ========================================================

    /**
     * Return all out-of-period journals assigned to a given VAT period.
     * These are journals that were captured late and belong historically to
     * an earlier locked period, but are included in this period's VAT.
     */
    async getOutOfPeriodItems(companyId, periodId) {
        const period = await this.getPeriod(companyId, periodId);
        if (!period) throw new Error('VAT period not found');

        const { data: journals, error } = await supabase
            .from('journals')
            .select('id, date, reference, description, source_type, out_of_period_original_date, metadata')
            .eq('company_id', companyId)
            .eq('vat_period_id', periodId)
            .eq('is_out_of_period', true)
            .eq('status', 'posted')
            .order('out_of_period_original_date', { ascending: true });

        if (error) throw new Error(error.message);
        if (!journals || journals.length === 0) return { items: [], summary: null };

        // Fetch lines for VAT amount calculation
        const journalIds = journals.map(j => j.id);
        const { data: lines } = await supabase
            .from('journal_lines')
            .select('journal_id, account_id, debit, credit, accounts!account_id(code, reporting_group)')
            .in('journal_id', journalIds);

        // Group lines by journal for per-journal VAT amount display
        const linesByJournal = {};
        for (const l of lines || []) {
            if (!linesByJournal[l.journal_id]) linesByJournal[l.journal_id] = [];
            linesByJournal[l.journal_id].push({
                ...l,
                account_code:            l.accounts?.code,
                account_reporting_group: l.accounts?.reporting_group,
            });
        }

        let totalInputVat  = 0;
        let totalOutputVat = 0;

        const items = journals.map(j => {
            const jLines = linesByJournal[j.id] || [];
            let inputVat = 0, outputVat = 0;
            for (const l of jLines) {
                if (l.account_reporting_group === 'vat_asset'    || l.account_code === '1400')
                    inputVat  += (parseFloat(l.debit) || 0) - (parseFloat(l.credit) || 0);
                if (l.account_reporting_group === 'vat_liability' || l.account_code === '2300')
                    outputVat += (parseFloat(l.credit) || 0) - (parseFloat(l.debit) || 0);
            }
            totalInputVat  += inputVat;
            totalOutputVat += outputVat;
            return {
                journal_id:              j.id,
                captured_date:           j.date,
                original_period_date:    j.out_of_period_original_date,
                reference:               j.reference,
                description:             j.description,
                source_type:             j.source_type,
                input_vat:               Math.round(inputVat  * 100) / 100,
                output_vat:              Math.round(outputVat * 100) / 100,
            };
        });

        return {
            items,
            summary: {
                count:              items.length,
                total_input_vat:    Math.round(totalInputVat  * 100) / 100,
                total_output_vat:   Math.round(totalOutputVat * 100) / 100,
                total_net_vat:      Math.round((totalOutputVat - totalInputVat) * 100) / 100,
            },
        };
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
