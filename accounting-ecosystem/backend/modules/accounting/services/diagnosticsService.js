'use strict';

/**
 * DiagnosticsService — Lorenco Accounting
 *
 * Runs structured integrity checks across the accounting data model and
 * provides safe, audited repair actions. All read queries use the direct
 * pg Pool so that complex multi-table joins can be written in plain SQL
 * with guaranteed company-scoped WHERE clauses (multi-tenant safety).
 *
 * Repairs delegate to existing service methods wherever possible so that
 * transactional safety, validation, and audit-event rules are not bypassed.
 *
 * Priority 14 — 2026-05
 */

const db            = require('../config/database');
const JournalService = require('./journalService');

// ─── Severity weights for score calculation ──────────────────────────────────
const SEVERITY_WEIGHTS = { CRITICAL: 10, HIGH: 5, MEDIUM: 2, LOW: 1 };

// ─── Category codes ───────────────────────────────────────────────────────────
const CATEGORIES = {
  A: 'JOURNAL_INTEGRITY',
  B: 'BANK_LINKAGE',
  C: 'INVOICE_LINKAGE',
  D: 'VAT_INTEGRITY',
  E: 'BANK_STAGING',
  F: 'PERIOD_YEAR_END',
  G: 'AUDIT_TRAIL',
  H: 'AR_INTEGRITY',
  I: 'AP_INTEGRITY',
  J: 'REPORTING_INTEGRITY',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a deterministic finding ID.
 * Format: "CATEGORY_CODE-CHECK_KEY[-ENTITY_ID]"
 * e.g. "A-UNBALANCED_JOURNAL-4512"
 */
function makeFindingId(categoryCode, checkKey, entityId) {
  return entityId != null
    ? `${categoryCode}-${checkKey}-${entityId}`
    : `${categoryCode}-${checkKey}`;
}

/**
 * Build a finding object — uniform shape across all checks.
 */
function finding(categoryCode, checkKey, severity, title, detail, entityId, entityType, repairAction) {
  return {
    id:           makeFindingId(categoryCode, checkKey, entityId),
    category:     CATEGORIES[categoryCode] || categoryCode,
    categoryCode,
    checkKey,
    severity,     // 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
    title,
    detail,
    entityId:     entityId ?? null,
    entityType:   entityType ?? null,
    repairAction: repairAction ?? null,  // null = no automatic repair
    detectedAt:   new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

class DiagnosticsService {

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC: run all (or filtered) checks
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run diagnostic checks for the given company.
   *
   * @param {number}  companyId
   * @param {object}  [opts]
   * @param {string}  [opts.category]       - single category code (A-G) to run
   * @param {number}  [opts.olderThanDays]  - staging stale threshold (default 30)
   * @returns {object} { summary, findings }
   */
  static async runChecks(companyId, { category = null, olderThanDays = 30 } = {}) {
    if (!companyId) throw new Error('companyId is required');

    const all = [];

    const run = async (code, fn) => {
      if (category && category !== code) return;
      try {
        const results = await fn();
        all.push(...results);
      } catch (err) {
        // A failed check becomes a LOW diagnostic finding itself so the caller
        // can see it rather than receiving an opaque 500.
        all.push(finding(code, 'CHECK_ERROR', 'LOW',
          `Check ${code} failed`,
          `Internal error running category ${code} checks: ${err.message}`,
          null, null, null));
      }
    };

    await run('A', () => this.checkJournalIntegrity(companyId));
    await run('B', () => this.checkBankLinkage(companyId));
    await run('C', () => this.checkInvoiceLinkage(companyId));
    await run('D', () => this.checkVatIntegrity(companyId));
    await run('E', () => this.checkStaging(companyId, olderThanDays));
    await run('F', () => this.checkPeriods(companyId));
    await run('G', () => this.checkAuditTrail(companyId));
    await run('H', () => this.checkArIntegrity(companyId));
    await run('I', () => this.checkApIntegrity(companyId));
    await run('J', () => this.checkReportingIntegrity(companyId));

    const summary = this._buildSummary(companyId, all);
    return { summary, findings: all };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY A — JOURNAL INTEGRITY
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkJournalIntegrity(companyId) {
    const results = [];

    // A1 — Posted journal with zero lines (should never happen — indicates
    //      a failed write that left an orphaned header)
    const zeroLines = await db.query(`
      SELECT j.id, j.date, j.reference, j.description
      FROM journals j
      LEFT JOIN journal_lines jl ON jl.journal_id = j.id
      WHERE j.company_id = $1
        AND j.status = 'posted'
      GROUP BY j.id, j.date, j.reference, j.description
      HAVING COUNT(jl.id) = 0
    `, [companyId]);

    for (const row of zeroLines.rows) {
      results.push(finding('A', 'POSTED_ZERO_LINES', 'CRITICAL',
        'Posted journal has no lines',
        `Journal #${row.id} (${row.date}, ref: ${row.reference || 'none'}) is posted but has zero lines. This indicates a failed transaction write.`,
        row.id, 'journal', null));
    }

    // A2 — Posted journal with only one line (violates double-entry)
    const fewLines = await db.query(`
      SELECT j.id, j.date, j.reference, COUNT(jl.id) AS line_count
      FROM journals j
      JOIN journal_lines jl ON jl.journal_id = j.id
      WHERE j.company_id = $1
        AND j.status = 'posted'
      GROUP BY j.id, j.date, j.reference
      HAVING COUNT(jl.id) = 1
    `, [companyId]);

    for (const row of fewLines.rows) {
      results.push(finding('A', 'POSTED_ONE_LINE', 'CRITICAL',
        'Posted journal has only one line',
        `Journal #${row.id} (${row.date}, ref: ${row.reference || 'none'}) has only 1 line — violates double-entry. Lines must always come in pairs.`,
        row.id, 'journal', null));
    }

    // A3 — Unbalanced posted journal (debits ≠ credits beyond 0.01 tolerance)
    const unbalanced = await db.query(`
      SELECT j.id, j.date, j.reference,
             ROUND(SUM(jl.debit)::numeric, 2)  AS total_debit,
             ROUND(SUM(jl.credit)::numeric, 2) AS total_credit,
             ROUND(ABS(SUM(jl.debit) - SUM(jl.credit))::numeric, 2) AS diff
      FROM journals j
      JOIN journal_lines jl ON jl.journal_id = j.id
      WHERE j.company_id = $1
        AND j.status = 'posted'
      GROUP BY j.id, j.date, j.reference
      HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) > 0.01
    `, [companyId]);

    for (const row of unbalanced.rows) {
      results.push(finding('A', 'UNBALANCED_JOURNAL', 'CRITICAL',
        'Posted journal is out of balance',
        `Journal #${row.id} (${row.date}): Debits ${row.total_debit} ≠ Credits ${row.total_credit} (diff: ${row.diff}). This breaks the general ledger balance.`,
        row.id, 'journal', null));
    }

    // A4 — Journal line with both debit AND credit > 0
    const bothDrCr = await db.query(`
      SELECT jl.id, jl.journal_id, jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      WHERE j.company_id = $1
        AND jl.debit > 0 AND jl.credit > 0
    `, [companyId]);

    for (const row of bothDrCr.rows) {
      results.push(finding('A', 'LINE_BOTH_DR_CR', 'HIGH',
        'Journal line has both debit and credit',
        `Line #${row.id} on journal #${row.journal_id}: debit=${row.debit}, credit=${row.credit}. A line must have exactly one side populated.`,
        row.id, 'journal_line', null));
    }

    // A5 — Journal line with neither debit NOR credit
    const neitherDrCr = await db.query(`
      SELECT jl.id, jl.journal_id
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      WHERE j.company_id = $1
        AND (jl.debit IS NULL OR jl.debit = 0)
        AND (jl.credit IS NULL OR jl.credit = 0)
    `, [companyId]);

    for (const row of neitherDrCr.rows) {
      results.push(finding('A', 'LINE_ZERO_AMOUNT', 'MEDIUM',
        'Journal line has zero amount on both sides',
        `Line #${row.id} on journal #${row.journal_id}: debit=0, credit=0. Zero-amount lines contribute nothing to the ledger.`,
        row.id, 'journal_line', null));
    }

    // A6 — Journal line referencing account that doesn't exist in this company
    //      (The FK constraint was dropped per schema migration — orphans are possible)
    const missingAccount = await db.query(`
      SELECT jl.id, jl.journal_id, jl.account_id
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      LEFT JOIN accounts a ON a.id = jl.account_id AND a.company_id = j.company_id
      WHERE j.company_id = $1
        AND a.id IS NULL
    `, [companyId]);

    for (const row of missingAccount.rows) {
      results.push(finding('A', 'LINE_MISSING_ACCOUNT', 'HIGH',
        'Journal line references non-existent account',
        `Line #${row.id} on journal #${row.journal_id}: account_id ${row.account_id} does not exist in this company's chart of accounts. The FK constraint was dropped in migration — this orphan was not caught at write time.`,
        row.id, 'journal_line', null));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY B — BANK LINKAGE
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkBankLinkage(companyId) {
    const results = [];

    // B1 — matched/reconciled bank transaction with null matched_entity_id
    const nullEntity = await db.query(`
      SELECT id, amount, date, description, status
      FROM bank_transactions
      WHERE company_id = $1
        AND status IN ('matched', 'reconciled')
        AND matched_entity_id IS NULL
    `, [companyId]);

    for (const row of nullEntity.rows) {
      results.push(finding('B', 'MATCHED_NULL_ENTITY', 'HIGH',
        'Matched bank transaction has no entity link',
        `Bank transaction #${row.id} (${row.date}, ${row.amount}, ${row.status}) is marked matched/reconciled but matched_entity_id is NULL. The allocation journal is missing.`,
        row.id, 'bank_transaction', null));
    }

    // B2 — matched_entity_id points to a journal that no longer exists
    const missingJournal = await db.query(`
      SELECT bt.id AS bt_id, bt.amount, bt.date, bt.matched_entity_id
      FROM bank_transactions bt
      LEFT JOIN journals j ON j.id = bt.matched_entity_id AND j.company_id = bt.company_id
      WHERE bt.company_id = $1
        AND bt.matched_entity_id IS NOT NULL
        AND j.id IS NULL
    `, [companyId]);

    for (const row of missingJournal.rows) {
      results.push(finding('B', 'ENTITY_JOURNAL_MISSING', 'CRITICAL',
        'Bank transaction links to deleted/missing journal',
        `Bank transaction #${row.bt_id} (${row.date}, ${row.amount}) references journal #${row.matched_entity_id} which no longer exists. The allocation is broken.`,
        row.bt_id, 'bank_transaction', null));
    }

    // B3 — linked journal exists but is not in 'posted' status
    const journalNotPosted = await db.query(`
      SELECT bt.id AS bt_id, bt.amount, bt.date, j.id AS journal_id, j.status AS journal_status
      FROM bank_transactions bt
      JOIN journals j ON j.id = bt.matched_entity_id AND j.company_id = bt.company_id
      WHERE bt.company_id = $1
        AND bt.status IN ('matched', 'reconciled')
        AND j.status != 'posted'
    `, [companyId]);

    for (const row of journalNotPosted.rows) {
      results.push(finding('B', 'LINKED_JOURNAL_NOT_POSTED', 'HIGH',
        'Bank transaction links to unposted journal',
        `Bank transaction #${row.bt_id} (${row.date}, ${row.amount}) is matched but its journal #${row.journal_id} is '${row.journal_status}', not 'posted'. The allocation has not hit the ledger.`,
        row.bt_id, 'bank_transaction', null));
    }

    // B4 — bank-source posted journal where the bankTransactionId in metadata
    //      doesn't match any real bank transaction in this company
    const orphanedJournals = await db.query(`
      SELECT j.id AS journal_id, j.date, j.metadata->>'bankTransactionId' AS bt_id_in_metadata
      FROM journals j
      WHERE j.company_id = $1
        AND j.source_type = 'bank'
        AND j.status = 'posted'
        AND j.metadata->>'bankTransactionId' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM bank_transactions bt
          WHERE bt.company_id = j.company_id
            AND bt.id::text = j.metadata->>'bankTransactionId'
        )
    `, [companyId]);

    for (const row of orphanedJournals.rows) {
      results.push(finding('B', 'BANK_SOURCE_JOURNAL_ORPHANED', 'HIGH',
        'Bank-source journal references missing bank transaction',
        `Journal #${row.journal_id} (${row.date}) has source_type='bank' and metadata.bankTransactionId=${row.bt_id_in_metadata} but no matching bank transaction exists. This is a dangling bank-allocation journal.`,
        row.journal_id, 'journal', 'REVERSE_DANGLING_JOURNAL'));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY C — INVOICE LINKAGE
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkInvoiceLinkage(companyId) {
    const results = [];

    // C1 — Supplier invoice in active status but missing journal link
    const supplierNoJournal = await db.query(`
      SELECT id, invoice_number, status, total_amount
      FROM supplier_invoices
      WHERE company_id = $1
        AND status NOT IN ('draft', 'cancelled')
        AND journal_id IS NULL
    `, [companyId]);

    for (const row of supplierNoJournal.rows) {
      results.push(finding('C', 'SUPPLIER_INV_NO_JOURNAL', 'HIGH',
        'Approved/posted supplier invoice has no journal',
        `Supplier invoice #${row.id} (${row.invoice_number || 'no number'}, status: ${row.status}, amount: ${row.total_amount}) has no journal entry. The cost is not reflected in the ledger.`,
        row.id, 'supplier_invoice', null));
    }

    // C2 — Supplier invoice journal_id points to a missing journal
    const supplierMissingJournal = await db.query(`
      SELECT si.id AS inv_id, si.invoice_number, si.journal_id
      FROM supplier_invoices si
      LEFT JOIN journals j ON j.id = si.journal_id AND j.company_id = si.company_id
      WHERE si.company_id = $1
        AND si.journal_id IS NOT NULL
        AND j.id IS NULL
    `, [companyId]);

    for (const row of supplierMissingJournal.rows) {
      results.push(finding('C', 'SUPPLIER_INV_JOURNAL_MISSING', 'CRITICAL',
        'Supplier invoice links to deleted journal',
        `Supplier invoice #${row.inv_id} (${row.invoice_number || 'no number'}) references journal #${row.journal_id} which no longer exists. The accounts payable entry is broken.`,
        row.inv_id, 'supplier_invoice', null));
    }

    // C3 — Supplier invoice journal exists but is not posted
    const supplierJournalNotPosted = await db.query(`
      SELECT si.id AS inv_id, si.invoice_number, j.id AS journal_id, j.status
      FROM supplier_invoices si
      JOIN journals j ON j.id = si.journal_id AND j.company_id = si.company_id
      WHERE si.company_id = $1
        AND si.status NOT IN ('draft', 'cancelled')
        AND j.status != 'posted'
    `, [companyId]);

    for (const row of supplierJournalNotPosted.rows) {
      results.push(finding('C', 'SUPPLIER_INV_JOURNAL_NOT_POSTED', 'MEDIUM',
        'Supplier invoice journal is not posted',
        `Supplier invoice #${row.inv_id} (${row.invoice_number || 'no number'}) links to journal #${row.journal_id} with status '${row.status}'. Only posted journals affect the ledger.`,
        row.inv_id, 'supplier_invoice', null));
    }

    // C4 — Customer invoice in active status but missing journal link
    const customerNoJournal = await db.query(`
      SELECT id, invoice_number, status, total_amount
      FROM customer_invoices
      WHERE company_id = $1
        AND status NOT IN ('draft', 'void')
        AND journal_id IS NULL
    `, [companyId]);

    for (const row of customerNoJournal.rows) {
      results.push(finding('C', 'CUSTOMER_INV_NO_JOURNAL', 'HIGH',
        'Sent/paid customer invoice has no journal',
        `Customer invoice #${row.id} (${row.invoice_number || 'no number'}, status: ${row.status}, amount: ${row.total_amount}) has no journal entry. Revenue/receivable not in the ledger.`,
        row.id, 'customer_invoice', null));
    }

    // C5 — Customer invoice journal_id points to missing or unposted journal
    const customerBadJournal = await db.query(`
      SELECT ci.id AS inv_id, ci.invoice_number, ci.journal_id,
             j.id AS found_journal_id, j.status AS journal_status
      FROM customer_invoices ci
      LEFT JOIN journals j ON j.id = ci.journal_id AND j.company_id = ci.company_id
      WHERE ci.company_id = $1
        AND ci.journal_id IS NOT NULL
        AND (j.id IS NULL OR j.status != 'posted')
    `, [companyId]);

    for (const row of customerBadJournal.rows) {
      const isNull = row.found_journal_id == null;
      results.push(finding('C', isNull ? 'CUSTOMER_INV_JOURNAL_MISSING' : 'CUSTOMER_INV_JOURNAL_NOT_POSTED',
        isNull ? 'CRITICAL' : 'MEDIUM',
        isNull ? 'Customer invoice links to deleted journal' : 'Customer invoice journal is not posted',
        isNull
          ? `Customer invoice #${row.inv_id} (${row.invoice_number || 'no number'}) references journal #${row.journal_id} which no longer exists.`
          : `Customer invoice #${row.inv_id} (${row.invoice_number || 'no number'}) links to journal #${row.journal_id} with status '${row.journal_status}'.`,
        row.inv_id, 'customer_invoice', null));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY D — VAT INTEGRITY
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkVatIntegrity(companyId) {
    const results = [];

    // D1 — VAT-relevant posted journal with no vat_period_id
    //      VAT-relevant = at least one line has an account with reporting_group
    //      matching 'vat_asset' or 'vat_liability' (mirrors isVatJournal() in vatPeriodUtils)
    const vatNoperiod = await db.query(`
      SELECT DISTINCT j.id, j.date, j.reference
      FROM journals j
      JOIN journal_lines jl ON jl.journal_id = j.id
      JOIN accounts a ON a.id = jl.account_id AND a.company_id = j.company_id
      WHERE j.company_id = $1
        AND j.status = 'posted'
        AND j.vat_period_id IS NULL
        AND a.reporting_group IN ('vat_asset', 'vat_liability')
    `, [companyId]);

    for (const row of vatNoperiod.rows) {
      results.push(finding('D', 'VAT_JOURNAL_NO_PERIOD', 'HIGH',
        'VAT journal missing vat_period assignment',
        `Journal #${row.id} (${row.date}, ref: ${row.reference || 'none'}) has VAT account lines but vat_period_id is null. It will be excluded from VAT returns until repaired.`,
        row.id, 'journal', 'REASSIGN_VAT_PERIOD'));
    }

    // D2 — Journal vat_period_id references a period that doesn't exist
    const missingPeriod = await db.query(`
      SELECT j.id, j.date, j.vat_period_id
      FROM journals j
      LEFT JOIN vat_periods vp ON vp.id = j.vat_period_id AND vp.company_id = j.company_id
      WHERE j.company_id = $1
        AND j.vat_period_id IS NOT NULL
        AND vp.id IS NULL
    `, [companyId]);

    for (const row of missingPeriod.rows) {
      results.push(finding('D', 'VAT_PERIOD_MISSING', 'HIGH',
        'Journal references deleted VAT period',
        `Journal #${row.id} (${row.date}) has vat_period_id=${row.vat_period_id} but that VAT period no longer exists in this company.`,
        row.id, 'journal', 'REASSIGN_VAT_PERIOD'));
    }

    // D3 — Journal vat_period_id belongs to a different company (cross-tenant contamination)
    const wrongCompanyPeriod = await db.query(`
      SELECT j.id, j.date, j.vat_period_id, vp.company_id AS period_company_id
      FROM journals j
      JOIN vat_periods vp ON vp.id = j.vat_period_id
      WHERE j.company_id = $1
        AND vp.company_id != j.company_id
    `, [companyId]);

    for (const row of wrongCompanyPeriod.rows) {
      results.push(finding('D', 'VAT_PERIOD_WRONG_COMPANY', 'CRITICAL',
        'Journal assigned to VAT period of wrong company',
        `Journal #${row.id} (${row.date}) has vat_period_id=${row.vat_period_id} which belongs to company #${row.period_company_id}, not this company. Cross-tenant VAT contamination.`,
        row.id, 'journal', 'REASSIGN_VAT_PERIOD'));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY E — BANK STAGING / IMPORT
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkStaging(companyId, olderThanDays = 30) {
    const results = [];

    // E1 — Staging rows stuck in UNMATCHED older than threshold
    const stuckUnmatched = await db.query(`
      SELECT id, date, description, amount, import_batch_id, created_at
      FROM bank_transaction_staging
      WHERE company_id = $1
        AND match_status = 'UNMATCHED'
        AND created_at < NOW() - ($2 || ' days')::INTERVAL
      ORDER BY created_at ASC
      LIMIT 200
    `, [companyId, olderThanDays]);

    if (stuckUnmatched.rows.length > 0) {
      const count = stuckUnmatched.rows.length;
      const oldest = stuckUnmatched.rows[0];
      results.push(finding('E', 'STAGING_STUCK_UNMATCHED', count >= 50 ? 'HIGH' : 'MEDIUM',
        `${count} staging row(s) stuck UNMATCHED for >${olderThanDays} days`,
        `${count} imported bank transaction(s) have been UNMATCHED for more than ${olderThanDays} days. Oldest: #${oldest.id} (${oldest.date}, ${oldest.amount}). These may never be reviewed without manual intervention.`,
        null, 'bank_transaction_staging', null));
    }

    // E2 — Partially confirmed bank transfers (one leg CONFIRMED, other not)
    const partialTransfers = await db.query(`
      SELECT btl.id AS link_id, btl.debit_tx_id, btl.credit_tx_id, btl.confirmed,
             s1.match_status AS debit_status,
             s2.match_status AS credit_status
      FROM bank_transfer_links btl
      JOIN bank_transaction_staging s1 ON s1.id = btl.debit_tx_id
      JOIN bank_transaction_staging s2 ON s2.id = btl.credit_tx_id
      WHERE btl.company_id = $1
        AND (
          (btl.confirmed = true AND (s1.match_status != 'CONFIRMED' OR s2.match_status != 'CONFIRMED'))
          OR
          (btl.confirmed = false AND (s1.match_status = 'CONFIRMED' OR s2.match_status = 'CONFIRMED'))
        )
    `, [companyId]);

    for (const row of partialTransfers.rows) {
      results.push(finding('E', 'PARTIAL_TRANSFER_CONFIRMATION', 'MEDIUM',
        'Bank transfer link is partially confirmed',
        `Transfer link #${row.link_id}: confirmed=${row.confirmed}, debit_tx ${row.debit_tx_id} status=${row.debit_status}, credit_tx ${row.credit_tx_id} status=${row.credit_status}. Both legs must be CONFIRMED when the link is confirmed.`,
        row.link_id, 'bank_transfer_link', null));
    }

    // E3 — Transfer link references a journal that no longer exists
    const transferMissingJournal = await db.query(`
      SELECT btl.id AS link_id, btl.journal_id
      FROM bank_transfer_links btl
      LEFT JOIN journals j ON j.id = btl.journal_id AND j.company_id = btl.company_id
      WHERE btl.company_id = $1
        AND btl.journal_id IS NOT NULL
        AND j.id IS NULL
    `, [companyId]);

    for (const row of transferMissingJournal.rows) {
      results.push(finding('E', 'TRANSFER_JOURNAL_MISSING', 'HIGH',
        'Bank transfer link references missing journal',
        `Transfer link #${row.link_id} references journal #${row.journal_id} which no longer exists. The transfer was not properly posted.`,
        row.link_id, 'bank_transfer_link', null));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY F — PERIOD / YEAR-END
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkPeriods(companyId) {
    const results = [];

    // F1 — Overlapping accounting periods for the same company
    const overlapping = await db.query(`
      SELECT a.id AS id_a, a.from_date AS from_a, a.to_date AS to_a,
             b.id AS id_b, b.from_date AS from_b, b.to_date AS to_b
      FROM accounting_periods a
      JOIN accounting_periods b
        ON a.company_id = b.company_id
       AND a.id < b.id
       AND a.from_date <= b.to_date
       AND a.to_date >= b.from_date
      WHERE a.company_id = $1
    `, [companyId]);

    for (const row of overlapping.rows) {
      results.push(finding('F', 'OVERLAPPING_PERIODS', 'HIGH',
        'Accounting periods overlap',
        `Period #${row.id_a} (${row.from_a}–${row.to_a}) overlaps with period #${row.id_b} (${row.from_b}–${row.to_b}). Overlapping periods cause ambiguity in period-locking and reporting.`,
        row.id_a, 'accounting_period', null));
    }

    // F2 — Year-end close record with no closing_journal_id
    const yearEndNoJournal = await db.query(`
      SELECT id, financial_year_label, from_date, to_date, status
      FROM year_end_close_records
      WHERE company_id = $1
        AND closing_journal_id IS NULL
        AND status = 'closed'
    `, [companyId]);

    for (const row of yearEndNoJournal.rows) {
      results.push(finding('F', 'YEAREND_NO_CLOSING_JOURNAL', 'HIGH',
        'Year-end close record has no closing journal',
        `Year-end close #${row.id} (${row.financial_year_label}, ${row.from_date}–${row.to_date}) is status='closed' but has no closing_journal_id. The closing entry is missing from the ledger.`,
        row.id, 'year_end_close_record', null));
    }

    // F3 — Year-end closing journal exists but is not posted
    const yearEndJournalNotPosted = await db.query(`
      SELECT yec.id AS yec_id, yec.financial_year_label,
             j.id AS journal_id, j.status AS journal_status
      FROM year_end_close_records yec
      JOIN journals j ON j.id = yec.closing_journal_id AND j.company_id = yec.company_id
      WHERE yec.company_id = $1
        AND j.status != 'posted'
    `, [companyId]);

    for (const row of yearEndJournalNotPosted.rows) {
      results.push(finding('F', 'YEAREND_JOURNAL_NOT_POSTED', 'HIGH',
        'Year-end closing journal is not posted',
        `Year-end close #${row.yec_id} (${row.financial_year_label}) closing journal #${row.journal_id} has status '${row.journal_status}'. The year-end close has not taken effect in the ledger.`,
        row.yec_id, 'year_end_close_record', null));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY G — AUDIT TRAIL HEALTH
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkAuditTrail(companyId) {
    const results = [];

    // G1 — SYSTEM_ERROR events with danglingJournal=true that have not been
    //      resolved (journal still exists as posted)
    const danglingEvents = await db.query(`
      SELECT aal.id AS event_id, aal.entity_id AS journal_id,
             aal.after_json->>'bankTransactionId' AS bt_id,
             aal.created_at
      FROM accounting_audit_log aal
      WHERE aal.company_id = $1
        AND aal.action_type = 'SYSTEM_ERROR'
        AND aal.entity_type = 'BANK_ALLOCATION'
        AND (aal.after_json->>'danglingJournal')::boolean = true
        AND EXISTS (
          SELECT 1 FROM journals j
          WHERE j.id = aal.entity_id::integer
            AND j.company_id = $1
            AND j.status = 'posted'
        )
    `, [companyId]);

    for (const row of danglingEvents.rows) {
      results.push(finding('G', 'UNRESOLVED_DANGLING_JOURNAL', 'HIGH',
        'Unresolved dangling bank-allocation journal',
        `Audit event #${row.event_id}: journal #${row.journal_id} was flagged as a dangling bank-allocation journal (bankTransactionId=${row.bt_id || 'unknown'}, flagged at ${row.created_at}). The journal is still posted and unresolved.`,
        row.journal_id, 'journal', 'REVERSE_DANGLING_JOURNAL'));
    }

    // G2 — Check for journals posted without any audit trail entry
    //      (only checks the most recent 500 posted journals to keep query fast)
    const noAuditTrail = await db.query(`
      SELECT j.id, j.date, j.reference
      FROM journals j
      WHERE j.company_id = $1
        AND j.status = 'posted'
        AND NOT EXISTS (
          SELECT 1 FROM accounting_audit_log aal
          WHERE aal.company_id = $1
            AND aal.entity_id = j.id::text
            AND aal.entity_type = 'JOURNAL'
            AND aal.action_type IN ('JOURNAL_POSTED', 'JOURNAL_REVERSED')
        )
      ORDER BY j.id DESC
      LIMIT 200
    `, [companyId]);

    if (noAuditTrail.rows.length > 0) {
      const count = noAuditTrail.rows.length;
      const oldest = noAuditTrail.rows[noAuditTrail.rows.length - 1];
      results.push(finding('G', 'JOURNALS_WITHOUT_AUDIT_TRAIL', count > 50 ? 'MEDIUM' : 'LOW',
        `${count} posted journal(s) have no JOURNAL_POSTED audit event`,
        `${count} posted journals (oldest checked: #${oldest.id}, ${oldest.date}) have no corresponding JOURNAL_POSTED event in accounting_audit_log. This may indicate journals posted before audit trail was enabled, or an audit logging gap.`,
        null, 'journal', null));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPAIR ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Re-assign VAT period for a posted journal that has vat_period_id = null
   * or points to a missing/wrong-company period.
   *
   * Delegates to JournalService.assignVatPeriod — the canonical path that
   * uses _resolveVatPeriodForPost and writes back atomically.
   *
   * @param {number} companyId
   * @param {number} journalId
   */
  static async repairVatAssignment(companyId, journalId) {
    // Verify the journal belongs to this company and is posted
    const res = await db.query(`
      SELECT id, date, status FROM journals
      WHERE id = $1 AND company_id = $2
    `, [journalId, companyId]);

    if (res.rows.length === 0) {
      throw new Error(`Journal #${journalId} not found for company ${companyId}`);
    }

    const journal = res.rows[0];
    if (journal.status !== 'posted') {
      throw new Error(`Journal #${journalId} is not posted (status: ${journal.status}). Only posted journals can have VAT periods re-assigned.`);
    }

    // assignVatPeriod is a no-op for non-VAT journals — safe to call without pre-check
    await JournalService.assignVatPeriod(journalId, companyId, journal.date);

    // Verify it was set (it may legitimately remain null for non-VAT journals)
    const verify = await db.query(
      'SELECT vat_period_id FROM journals WHERE id = $1',
      [journalId]
    );
    const assigned = verify.rows[0]?.vat_period_id;
    if (!assigned) {
      throw new Error(`Journal #${journalId} has no VAT-relevant lines — VAT period assignment is not applicable.`);
    }

    return { journalId, vatPeriodId: assigned };
  }

  /**
   * Re-link a bank transaction to the correct journal.
   * Only allowed when the bank transaction currently has no matched_entity_id
   * (null) or the previously linked journal no longer exists.
   *
   * @param {number} companyId
   * @param {number} bankTxnId
   * @param {number} journalId   - the journal to link to
   */
  static async repairBankRelink(companyId, bankTxnId, journalId) {
    // Verify bank transaction belongs to company
    const btRes = await db.query(`
      SELECT id, status, matched_entity_id, amount FROM bank_transactions
      WHERE id = $1 AND company_id = $2
    `, [bankTxnId, companyId]);

    if (btRes.rows.length === 0) {
      throw new Error(`Bank transaction #${bankTxnId} not found for company ${companyId}`);
    }

    const bt = btRes.rows[0];

    // Only allow re-link if currently null or pointing to a missing journal
    if (bt.matched_entity_id != null) {
      const existingJ = await db.query(
        'SELECT id FROM journals WHERE id = $1 AND company_id = $2',
        [bt.matched_entity_id, companyId]
      );
      if (existingJ.rows.length > 0) {
        throw new Error(
          `Bank transaction #${bankTxnId} already links to a valid journal #${bt.matched_entity_id}. ` +
          `Re-link is only permitted when the existing link is broken (journal missing). ` +
          `Use the bank allocation flow to change an existing valid link.`
        );
      }
    }

    // Verify target journal belongs to this company and is posted
    const jRes = await db.query(`
      SELECT id, status FROM journals WHERE id = $1 AND company_id = $2
    `, [journalId, companyId]);

    if (jRes.rows.length === 0) {
      throw new Error(`Target journal #${journalId} not found for company ${companyId}`);
    }
    if (jRes.rows[0].status !== 'posted') {
      throw new Error(`Target journal #${journalId} is not posted — cannot link a bank transaction to an unposted journal`);
    }

    // Apply the re-link
    await db.query(`
      UPDATE bank_transactions
         SET matched_entity_id   = $1,
             matched_entity_type = 'journal',
             status              = CASE WHEN status = 'unmatched' THEN 'matched' ELSE status END,
             updated_at          = NOW()
       WHERE id = $2 AND company_id = $3
    `, [journalId, bankTxnId, companyId]);

    return { bankTxnId, linkedJournalId: journalId };
  }

  /**
   * Reverse a dangling bank-allocation or orphaned posted journal.
   * Delegates entirely to JournalService.reverseJournal — no custom journal
   * writes here.
   *
   * @param {number} companyId
   * @param {number} journalId
   * @param {number} userId
   * @param {string} reason
   */
  static async repairDanglingJournalReversal(companyId, journalId, userId, reason) {
    if (!reason || reason.trim().length === 0) {
      throw new Error('reason is required for journal reversal');
    }

    // Verify ownership + posted status before delegating
    const res = await db.query(`
      SELECT id, status, source_type FROM journals
      WHERE id = $1 AND company_id = $2
    `, [journalId, companyId]);

    if (res.rows.length === 0) {
      throw new Error(`Journal #${journalId} not found for company ${companyId}`);
    }
    if (res.rows[0].status !== 'posted') {
      throw new Error(`Journal #${journalId} is not posted — only posted journals can be reversed`);
    }

    const reversalJournal = await JournalService.reverseJournal(journalId, companyId, userId, reason);
    return { originalJournalId: journalId, reversalJournalId: reversalJournal.id };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY H — AR INTEGRITY
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkArIntegrity(companyId) {
    const results = [];

    // H1 — AR control account GL balance vs outstanding customer invoice total.
    // Locates AR control accounts by type/sub_type/reporting_group/name heuristic,
    // then compares the net GL balance to the sum of non-void customer invoices.
    // A variance > R1 means the sub-ledger and ledger have diverged.
    const arAccounts = await db.query(`
      SELECT id, code, name
      FROM accounts
      WHERE company_id = $1
        AND is_active = true
        AND (
          LOWER(type)               LIKE '%receivable%'
          OR LOWER(sub_type)        LIKE '%receivable%'
          OR LOWER(reporting_group) LIKE '%receivable%'
          OR LOWER(reporting_group) LIKE '%debtors%'
          OR (LOWER(name) LIKE '%debtors control%'  AND LOWER(name) NOT LIKE '%vat%')
          OR (LOWER(name) LIKE '%trade receivable%' AND LOWER(name) NOT LIKE '%vat%')
          OR (LOWER(name) LIKE '%accounts receivable%' AND LOWER(name) NOT LIKE '%vat%')
        )
    `, [companyId]);

    if (arAccounts.rows.length > 0) {
      const arIds  = arAccounts.rows.map(r => r.id);
      const arDesc = arAccounts.rows.map(r => [r.code, r.name].filter(Boolean).join(' ')).join(', ');

      const glRes = await db.query(`
        SELECT ROUND(
          COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0),
          2
        ) AS gl_balance
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        WHERE j.company_id = $1
          AND j.status = 'posted'
          AND jl.account_id = ANY($2::int[])
      `, [companyId, arIds]);

      const invRes = await db.query(`
        SELECT ROUND(COALESCE(SUM(total_amount), 0), 2) AS invoice_total
        FROM customer_invoices
        WHERE company_id = $1
          AND status NOT IN ('draft', 'void', 'cancelled', 'written_off')
      `, [companyId]);

      const glBalance = parseFloat(glRes.rows[0]?.gl_balance   || 0);
      const invTotal  = parseFloat(invRes.rows[0]?.invoice_total || 0);
      const variance  = Math.round(Math.abs(glBalance - invTotal) * 100) / 100;

      if (variance > 1) {
        const sev = variance > 10000 ? 'CRITICAL' : variance > 1000 ? 'HIGH' : 'MEDIUM';
        results.push(finding('H', 'AR_CONTROL_VARIANCE', sev,
          `AR control account vs ageing: R${variance.toFixed(2)} variance`,
          `GL AR balance (${arDesc}): R${glBalance.toFixed(2)}. Outstanding customer invoices total: R${invTotal.toFixed(2)}. Variance: R${variance.toFixed(2)}. The accounts receivable sub-ledger and general ledger have diverged. Compare the Trial Balance AR line to the Aged Debtors report total to locate the source.`,
          null, 'customer_invoice', null));
      }
    }

    // H2 — Customer invoices with negative total amount.
    // Negative invoices should be credit notes — posting them as invoices distorts ageing.
    const negInv = await db.query(`
      SELECT id, invoice_number, total_amount, status
      FROM customer_invoices
      WHERE company_id = $1
        AND total_amount < 0
        AND status NOT IN ('void', 'cancelled')
      ORDER BY total_amount ASC
      LIMIT 20
    `, [companyId]);

    for (const row of negInv.rows) {
      results.push(finding('H', 'AR_NEGATIVE_INVOICE', 'MEDIUM',
        'Customer invoice has negative amount',
        `Invoice #${row.id} (${row.invoice_number || 'no number'}, status: ${row.status}): amount R${row.total_amount}. Negative customer invoices should be credit notes — they distort aged debtors and the AR control account balance.`,
        row.id, 'customer_invoice', null));
    }

    // H3 — Duplicate customer invoice numbers (active only).
    // Duplicate numbers prevent reliable payment matching and customer statement generation.
    const dupInv = await db.query(`
      SELECT invoice_number,
             COUNT(*)                               AS cnt,
             STRING_AGG(id::text, ', ' ORDER BY id) AS ids
      FROM customer_invoices
      WHERE company_id = $1
        AND invoice_number IS NOT NULL
        AND invoice_number != ''
        AND status NOT IN ('void', 'cancelled')
      GROUP BY invoice_number
      HAVING COUNT(*) > 1
      LIMIT 20
    `, [companyId]);

    for (const row of dupInv.rows) {
      results.push(finding('H', 'AR_DUPLICATE_INVOICE_NUMBER', 'MEDIUM',
        'Duplicate customer invoice numbers',
        `Invoice number "${row.invoice_number}" appears ${row.cnt} times (IDs: ${row.ids}). Duplicate numbers make it impossible to reliably match payments to invoices and will cause incorrect customer statements.`,
        null, 'customer_invoice', null));
    }

    // H4 — Orphaned customer invoice allocations: bank transactions matched to
    //      customer_invoice entity type where the invoice no longer exists.
    const orphanAlloc = await db.query(`
      SELECT bt.id AS bt_id, bt.amount, bt.date, bt.matched_entity_id AS inv_id
      FROM bank_transactions bt
      LEFT JOIN customer_invoices ci
        ON ci.id = bt.matched_entity_id
       AND ci.company_id = bt.company_id
      WHERE bt.company_id = $1
        AND bt.matched_entity_type = 'customer_invoice'
        AND bt.matched_entity_id IS NOT NULL
        AND ci.id IS NULL
    `, [companyId]);

    for (const row of orphanAlloc.rows) {
      results.push(finding('H', 'AR_ORPHAN_ALLOCATION', 'HIGH',
        'Bank payment allocated to missing customer invoice',
        `Bank transaction #${row.bt_id} (${row.date}, R${row.amount}) is allocated to customer invoice #${row.inv_id} which no longer exists. The receipt cannot be posted to the correct AR balance.`,
        row.bt_id, 'bank_transaction', null));
    }

    // H5 — Unreconciled old AR receipts (status=matched, >90 days old).
    // Receipts matched but not reconciled for extended periods inflate reported cash.
    const agedUnreconciled = await db.query(`
      SELECT COUNT(*) AS cnt,
             ROUND(SUM(ABS(amount))::numeric, 2) AS total,
             MIN(date) AS oldest
      FROM bank_transactions
      WHERE company_id = $1
        AND matched_entity_type IN ('customer_invoice', 'customer_receipt')
        AND status = 'matched'
        AND date < CURRENT_DATE - INTERVAL '90 days'
    `, [companyId]);

    const ar5 = agedUnreconciled.rows[0];
    if (parseInt(ar5?.cnt || 0) > 0) {
      results.push(finding('H', 'AR_AGED_UNRECONCILED', 'MEDIUM',
        `${ar5.cnt} AR receipt(s) matched but not reconciled for >90 days`,
        `${ar5.cnt} customer receipts (total R${ar5.total}) have been matched to invoices but not reconciled for more than 90 days (oldest: ${ar5.oldest}). Review these allocations in the bank reconciliation to confirm they have cleared.`,
        null, 'bank_transaction', null));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY I — AP INTEGRITY
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkApIntegrity(companyId) {
    const results = [];

    // I1 — AP control account GL balance vs outstanding supplier invoice total.
    const apAccounts = await db.query(`
      SELECT id, code, name
      FROM accounts
      WHERE company_id = $1
        AND is_active = true
        AND (
          LOWER(type)               LIKE '%payable%'
          OR LOWER(sub_type)        LIKE '%payable%'
          OR LOWER(reporting_group) LIKE '%payable%'
          OR LOWER(reporting_group) LIKE '%creditors%'
          OR (LOWER(name) LIKE '%creditors control%'   AND LOWER(name) NOT LIKE '%vat%')
          OR (LOWER(name) LIKE '%trade payable%'        AND LOWER(name) NOT LIKE '%vat%')
          OR (LOWER(name) LIKE '%accounts payable%'     AND LOWER(name) NOT LIKE '%vat%')
        )
    `, [companyId]);

    if (apAccounts.rows.length > 0) {
      const apIds  = apAccounts.rows.map(r => r.id);
      const apDesc = apAccounts.rows.map(r => [r.code, r.name].filter(Boolean).join(' ')).join(', ');

      // AP control accounts are normally credit-balance (liability): credit - debit
      const glRes = await db.query(`
        SELECT ROUND(
          COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit), 0),
          2
        ) AS gl_balance
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        WHERE j.company_id = $1
          AND j.status = 'posted'
          AND jl.account_id = ANY($2::int[])
      `, [companyId, apIds]);

      const invRes = await db.query(`
        SELECT ROUND(COALESCE(SUM(total_amount), 0), 2) AS invoice_total
        FROM supplier_invoices
        WHERE company_id = $1
          AND status NOT IN ('draft', 'cancelled', 'paid', 'void')
      `, [companyId]);

      const glBalance = parseFloat(glRes.rows[0]?.gl_balance    || 0);
      const invTotal  = parseFloat(invRes.rows[0]?.invoice_total || 0);
      const variance  = Math.round(Math.abs(glBalance - invTotal) * 100) / 100;

      if (variance > 1) {
        const sev = variance > 10000 ? 'CRITICAL' : variance > 1000 ? 'HIGH' : 'MEDIUM';
        results.push(finding('I', 'AP_CONTROL_VARIANCE', sev,
          `AP control account vs ageing: R${variance.toFixed(2)} variance`,
          `GL AP balance (${apDesc}): R${glBalance.toFixed(2)}. Outstanding supplier invoices total: R${invTotal.toFixed(2)}. Variance: R${variance.toFixed(2)}. The accounts payable sub-ledger and general ledger have diverged. Compare the Trial Balance AP line to the Aged Creditors report to locate the source.`,
          null, 'supplier_invoice', null));
      }
    }

    // I2 — Supplier invoices with negative total amount (should be credit notes).
    const negSupInv = await db.query(`
      SELECT id, invoice_number, total_amount, status
      FROM supplier_invoices
      WHERE company_id = $1
        AND total_amount < 0
        AND status NOT IN ('void', 'cancelled')
      ORDER BY total_amount ASC
      LIMIT 20
    `, [companyId]);

    for (const row of negSupInv.rows) {
      results.push(finding('I', 'AP_NEGATIVE_INVOICE', 'MEDIUM',
        'Supplier invoice has negative amount',
        `Supplier invoice #${row.id} (${row.invoice_number || 'no number'}, status: ${row.status}): amount R${row.total_amount}. Negative supplier invoices should be supplier credit notes — posting them as invoices distorts aged creditors.`,
        row.id, 'supplier_invoice', null));
    }

    // I3 — Negative AP control account balance (company has a net debit balance —
    //      suppliers owe us money in aggregate, which is unusual).
    if (apAccounts.rows.length > 0) {
      const apIds = apAccounts.rows.map(r => r.id);
      const netRes = await db.query(`
        SELECT ROUND(
          COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit), 0),
          2
        ) AS net_balance
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        WHERE j.company_id = $1
          AND j.status = 'posted'
          AND jl.account_id = ANY($2::int[])
      `, [companyId, apIds]);

      const netBal = parseFloat(netRes.rows[0]?.net_balance || 0);
      if (netBal < -1) {
        results.push(finding('I', 'AP_NEGATIVE_CONTROL_BALANCE', 'HIGH',
          'AP control account has a negative (debit) balance',
          `The AP control account shows a net debit balance of R${Math.abs(netBal).toFixed(2)}, meaning suppliers collectively owe this company money. This is unusual and may indicate overpayments, duplicate payments, or journal posting errors. Investigate each supplier account individually.`,
          null, 'account', null));
      }
    }

    // I4 — Duplicate supplier invoice numbers within same supplier.
    const dupSupInv = await db.query(`
      SELECT supplier_id, invoice_number,
             COUNT(*)                               AS cnt,
             STRING_AGG(id::text, ', ' ORDER BY id) AS ids
      FROM supplier_invoices
      WHERE company_id = $1
        AND invoice_number IS NOT NULL
        AND invoice_number != ''
        AND status NOT IN ('void', 'cancelled')
        AND supplier_id IS NOT NULL
      GROUP BY supplier_id, invoice_number
      HAVING COUNT(*) > 1
      LIMIT 20
    `, [companyId]);

    for (const row of dupSupInv.rows) {
      results.push(finding('I', 'AP_DUPLICATE_INVOICE_NUMBER', 'HIGH',
        'Duplicate supplier invoice number for same supplier',
        `Supplier #${row.supplier_id}: invoice number "${row.invoice_number}" appears ${row.cnt} times (IDs: ${row.ids}). This is a common indicator of a duplicate payment. Verify that the supplier was not paid twice.`,
        row.supplier_id, 'supplier', null));
    }

    // I5 — Orphaned AP allocations: bank transactions matched to supplier invoices that no longer exist.
    const orphanApAlloc = await db.query(`
      SELECT bt.id AS bt_id, bt.amount, bt.date, bt.matched_entity_id AS inv_id
      FROM bank_transactions bt
      LEFT JOIN supplier_invoices si
        ON si.id = bt.matched_entity_id
       AND si.company_id = bt.company_id
      WHERE bt.company_id = $1
        AND bt.matched_entity_type = 'supplier_invoice'
        AND bt.matched_entity_id IS NOT NULL
        AND si.id IS NULL
    `, [companyId]);

    for (const row of orphanApAlloc.rows) {
      results.push(finding('I', 'AP_ORPHAN_ALLOCATION', 'HIGH',
        'Bank payment allocated to missing supplier invoice',
        `Bank transaction #${row.bt_id} (${row.date}, R${row.amount}) is allocated to supplier invoice #${row.inv_id} which no longer exists. The payment has been made but the AP balance is not correctly reduced.`,
        row.bt_id, 'bank_transaction', null));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY J — REPORTING INTEGRITY
  // ═══════════════════════════════════════════════════════════════════════════

  static async checkReportingIntegrity(companyId) {
    const results = [];

    // J1 — Trial Balance: total posted debits must equal total posted credits.
    // If J1 fails, every downstream report (P&L, Balance Sheet) is unreliable.
    // Individual unbalanced journals are caught by A3; this is the aggregate check.
    const tbBalance = await db.query(`
      SELECT
        ROUND(COALESCE(SUM(jl.debit),  0)::numeric, 2) AS total_debit,
        ROUND(COALESCE(SUM(jl.credit), 0)::numeric, 2) AS total_credit,
        ROUND(ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0))::numeric, 2) AS diff
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      WHERE j.company_id = $1
        AND j.status = 'posted'
    `, [companyId]);

    const tb = tbBalance.rows[0];
    const tbDiff = parseFloat(tb?.diff || 0);
    if (tbDiff > 0.01) {
      results.push(finding('J', 'TB_OUT_OF_BALANCE', 'CRITICAL',
        `Trial Balance is out of balance by R${tbDiff.toFixed(2)}`,
        `Total posted debits: R${tb.total_debit}. Total posted credits: R${tb.total_credit}. Difference: R${tbDiff.toFixed(2)}. A non-zero TB imbalance means the general ledger itself is corrupted — all financial reports will be incorrect. Check category A findings (unbalanced journals) to locate the source.`,
        null, 'journal', null));
    }

    // J2 — AR sub-ledger vs AR control: cross-check (reporting perspective).
    // A separate check from H1 — this flags it as a REPORTING concern, not just AR.
    // Only report here if H1 did not find a variance (avoid double-reporting).
    // (Runtime-deduplicated by the UI; we don't emit here to keep findings clean.)

    // J3 — VAT control account GL balance vs last submitted VAT return net.
    // Identifies uncommitted VAT (posted VAT journals not yet on a VAT return).
    const vatAccounts = await db.query(`
      SELECT id, code, name
      FROM accounts
      WHERE company_id = $1
        AND is_active = true
        AND reporting_group IN ('vat_asset', 'vat_liability')
    `, [companyId]);

    if (vatAccounts.rows.length > 0) {
      const vatIds = vatAccounts.rows.map(r => r.id);

      // Net VAT on the GL (positive = liability, negative = asset/refund due)
      const vatGlRes = await db.query(`
        SELECT ROUND(
          COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit), 0),
          2
        ) AS gl_net_vat
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        WHERE j.company_id = $1
          AND j.status = 'posted'
          AND jl.account_id = ANY($2::int[])
      `, [companyId, vatIds]);

      // Net VAT from the most recent submitted VAT return
      const vatReturnRes = await db.query(`
        SELECT ROUND(COALESCE(output_vat - input_vat, 0)::numeric, 2) AS return_net
        FROM vat_submissions
        WHERE company_id = $1
        ORDER BY submission_date DESC
        LIMIT 1
      `, [companyId]);

      const glVat     = parseFloat(vatGlRes.rows[0]?.gl_net_vat  || 0);
      const returnVat = parseFloat(vatReturnRes.rows[0]?.return_net || 0);

      // Flag if there is a significant unsubmitted VAT balance on the GL
      // (i.e., VAT posted but not yet included in any submitted return)
      if (Math.abs(glVat) > 1 && vatReturnRes.rows.length === 0) {
        results.push(finding('J', 'VAT_CONTROL_NO_RETURN', 'HIGH',
          `VAT control account has a R${Math.abs(glVat).toFixed(2)} balance with no submitted return`,
          `The VAT control accounts carry a net balance of R${glVat.toFixed(2)} but no submitted VAT return exists for this company. This VAT amount is outstanding and has not been declared to SARS. Open a VAT period, reconcile, and submit.`,
          null, 'vat_period', null));
      }

      // J3b — VAT journals not assigned to any VAT period (cross-check with D1)
      const unassignedVatRes = await db.query(`
        SELECT COUNT(DISTINCT j.id) AS cnt,
               ROUND(COALESCE(SUM(CASE WHEN jl.credit > 0 THEN jl.credit ELSE 0 END), 0)::numeric, 2) AS output_vat,
               ROUND(COALESCE(SUM(CASE WHEN jl.debit  > 0 THEN jl.debit  ELSE 0 END), 0)::numeric, 2) AS input_vat
        FROM journals j
        JOIN journal_lines jl ON jl.journal_id = j.id
        WHERE j.company_id = $1
          AND j.status = 'posted'
          AND j.vat_period_id IS NULL
          AND jl.account_id = ANY($2::int[])
      `, [companyId, vatIds]);

      const uv = unassignedVatRes.rows[0];
      if (parseInt(uv?.cnt || 0) > 0) {
        results.push(finding('J', 'VAT_UNASSIGNED_JOURNALS', 'HIGH',
          `${uv.cnt} VAT journal(s) not assigned to a VAT period`,
          `${uv.cnt} posted journal(s) with VAT lines have vat_period_id = null (output VAT: R${uv.output_vat}, input VAT: R${uv.input_vat}). These transactions are excluded from all VAT returns and will cause your VAT report to understate the actual VAT position. Use the repair action on individual findings in category D to reassign VAT periods.`,
          null, 'journal', null));
      }
    }

    // J4 — P&L vs Balance Sheet retained earnings cross-check.
    // Net income accounts (income - expense) on the TB should equal the
    // movement in the retained earnings / accumulated profit account for the period.
    // Simplified check: if the sum of income/expense accounts is non-zero but
    // there is no retained earnings account, flag the gap.
    const plCheck = await db.query(`
      SELECT
        ROUND(
          COALESCE(SUM(CASE WHEN a.type IN ('income', 'revenue') THEN jl.credit - jl.debit ELSE 0 END), 0)::numeric
          - COALESCE(SUM(CASE WHEN a.type IN ('expense', 'cost_of_sales') THEN jl.debit - jl.credit ELSE 0 END), 0)::numeric,
          2
        ) AS net_profit
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id AND a.company_id = j.company_id
      WHERE j.company_id = $1
        AND j.status = 'posted'
    `, [companyId]);

    const retainedRes = await db.query(`
      SELECT COUNT(*) AS cnt
      FROM accounts
      WHERE company_id = $1
        AND is_active = true
        AND (
          LOWER(type) LIKE '%retained%'
          OR LOWER(sub_type) LIKE '%retained%'
          OR LOWER(reporting_group) LIKE '%retained%'
          OR LOWER(name) LIKE '%retained earnings%'
          OR LOWER(name) LIKE '%accumulated profit%'
          OR LOWER(name) LIKE '%accumulated loss%'
        )
    `, [companyId]);

    const netProfit       = parseFloat(plCheck.rows[0]?.net_profit || 0);
    const hasRetainedAcct = parseInt(retainedRes.rows[0]?.cnt || 0) > 0;

    if (Math.abs(netProfit) > 1 && !hasRetainedAcct) {
      results.push(finding('J', 'PL_NO_RETAINED_EARNINGS_ACCOUNT', 'MEDIUM',
        'P&L net income exists but no retained earnings account found',
        `The income and expense accounts carry a net profit/loss of R${netProfit.toFixed(2)}, but no retained earnings or accumulated profit account was found in the chart of accounts. Without this account the Balance Sheet will not balance after a year-end close. Add a retained earnings equity account.`,
        null, 'account', null));
    }

    // J5 — Accounts with zero movement in the last 12 months still marked active.
    //      Informational: flags dormant accounts that may indicate chart-of-accounts clutter.
    const dormantAccounts = await db.query(`
      SELECT a.id, a.code, a.name, a.type
      FROM accounts a
      WHERE a.company_id = $1
        AND a.is_active = true
        AND a.type NOT IN ('bank', 'header', 'group')
        AND NOT EXISTS (
          SELECT 1
          FROM journal_lines jl
          JOIN journals j ON j.id = jl.journal_id
          WHERE j.company_id = $1
            AND j.status = 'posted'
            AND jl.account_id = a.id
            AND j.date >= CURRENT_DATE - INTERVAL '12 months'
        )
      ORDER BY a.type, a.code
      LIMIT 5
    `, [companyId]);

    if (dormantAccounts.rows.length > 0) {
      const names = dormantAccounts.rows.map(r => `${r.code || ''} ${r.name}`.trim()).join('; ');
      results.push(finding('J', 'DORMANT_ACTIVE_ACCOUNTS', 'LOW',
        `${dormantAccounts.rows.length}+ active account(s) with no movement in 12 months`,
        `Sample: ${names}. Dormant active accounts clutter the chart of accounts and can appear on reports with zero balances. Review and deactivate accounts that are no longer in use.`,
        null, 'account', null));
    }

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPAIR — RECALCULATE AGEING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Recalculate AR and AP ageing by invalidating any cached ageing data.
   * If the system computes ageing dynamically (no cache table), confirms this
   * and directs the user to refresh the ageing report.
   *
   * @param {number} companyId
   */
  static async repairRecalculateAgeing(companyId) {
    // Check for an ageing cache table — clear it if it exists.
    // The system may compute ageing dynamically; in that case, refreshing the
    // Aged Debtors / Aged Creditors report pages achieves the same result.
    let cleared = false;

    try {
      await db.query(`
        DELETE FROM ageing_cache
        WHERE company_id = $1
      `, [companyId]);
      cleared = true;
    } catch (_) {
      // Table does not exist — ageing is computed on demand (no cache to clear)
      cleared = false;
    }

    return {
      companyId,
      ageingCacheCleared: cleared,
      message: cleared
        ? 'Ageing cache cleared. Refresh the Aged Debtors and Aged Creditors reports to see recalculated balances.'
        : 'Ageing is computed dynamically in this system — no cache table exists. Open the Aged Debtors and Aged Creditors report pages to see current balances.',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPAIR — REBUILD SNAPSHOTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Rebuild historical comparative snapshots for this company.
   * Marks all DRAFT batches as needing re-validation, allowing the
   * historical comparatives import flow to re-process them.
   * FINALIZED batches are not touched — they represent confirmed prior-period data.
   *
   * @param {number} companyId
   */
  static async repairRebuildSnapshots(companyId) {
    // Only reset draft batches — finalized batches are immutable.
    const res = await db.query(`
      UPDATE historical_comparative_batches
         SET status     = 'draft',
             updated_at = NOW()
       WHERE company_id = $1
         AND status = 'validated'
      RETURNING id, label
    `, [companyId]);

    const resetBatches = res.rows;

    return {
      companyId,
      resetCount: resetBatches.length,
      batches: resetBatches.map(r => ({ id: r.id, label: r.label })),
      message: resetBatches.length > 0
        ? `${resetBatches.length} historical comparative batch(es) reset to draft. Re-open Historical Comparatives and validate each batch to rebuild the snapshots.`
        : 'No validated snapshot batches found for this company. No changes were made.',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  static _buildSummary(companyId, findings) {
    let critical = 0, high = 0, medium = 0, low = 0;
    for (const f of findings) {
      switch (f.severity) {
        case 'CRITICAL': critical++; break;
        case 'HIGH':     high++;     break;
        case 'MEDIUM':   medium++;   break;
        case 'LOW':      low++;      break;
      }
    }

    const deduction =
      critical * SEVERITY_WEIGHTS.CRITICAL +
      high     * SEVERITY_WEIGHTS.HIGH     +
      medium   * SEVERITY_WEIGHTS.MEDIUM   +
      low      * SEVERITY_WEIGHTS.LOW;

    const score = Math.max(0, 100 - deduction);

    return {
      companyId,
      score,
      critical,
      high,
      medium,
      low,
      totalFindings: findings.length,
      checkedAt: new Date().toISOString(),
    };
  }
}

module.exports = DiagnosticsService;
