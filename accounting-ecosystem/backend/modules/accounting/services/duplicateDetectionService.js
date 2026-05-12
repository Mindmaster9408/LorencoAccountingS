'use strict';

/**
 * ============================================================================
 * DuplicateDetectionService
 * ============================================================================
 * Pure utility class — no database writes, no side effects.
 * All methods are static.
 *
 * Responsibilities:
 *   - Compute file hashes (SHA-256) for whole-batch duplicate detection
 *   - Normalize transaction descriptions for fuzzy matching
 *   - Detect potential duplicate batches (same file re-imported)
 *   - Detect potential duplicate transactions (amount+date fuzzy match)
 *
 * Used by:
 *   - bankStagingService.stageTransactions() — per-row duplicate flagging
 *   - bank.js POST /import/pdf — file hash computation
 *   - bank.js POST /import      — batch-level hash check before staging
 *
 * This service NEVER auto-merges, auto-deletes, or auto-blocks transactions.
 * Its output is informational — downstream code and the user decide what to do.
 *
 * Multi-tenant: all DB queries are scoped by companyId.
 * ============================================================================
 */

const crypto = require('crypto');

// Amount tolerance (ZAR) for fuzzy transaction matching.
const FUZZY_AMOUNT_TOLERANCE = 0.01;

// Date window (days) for fuzzy transaction matching.
const FUZZY_DATE_WINDOW_DAYS = 1;


class DuplicateDetectionService {

  // ──────────────────────────────────────────────────────────────────────────
  // computeFileHash
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Compute the SHA-256 hash of a file buffer.
   * Used to detect if the exact same file has been imported before.
   *
   * @param {Buffer} buffer
   * @returns {string}  hex-encoded SHA-256 digest
   */
  static computeFileHash(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new Error('buffer must be a Buffer');
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }


  // ──────────────────────────────────────────────────────────────────────────
  // normalizeDescription
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Normalise a raw bank transaction description for fuzzy duplicate matching.
   *
   * Steps applied (in order):
   *   1. Lowercase
   *   2. Strip common bank reference patterns (ref:123, trn/456, order#ABC)
   *   3. Strip pure digit sequences longer than 6 characters (bank refs, dates embedded in text)
   *   4. Strip punctuation and special characters
   *   5. Collapse whitespace
   *   6. Trim
   *
   * @param {string} raw  — original description from bank statement
   * @returns {string}    — normalised string (may be empty string)
   */
  static normalizeDescription(raw) {
    if (!raw || typeof raw !== 'string') return '';

    let s = raw.toLowerCase();

    // Strip bank reference patterns: e.g. "ref 123456789", "trn/987654", "order:ABC123"
    // word boundary + keyword + optional separator + alphanumeric token
    s = s.replace(/\b(ref|reference|trn|trns|trfr|ord|order|chq|cheque|transaction|txn|pay|payment)[:/\s#-]*[\w-]+/gi, '');

    // Strip pure digit sequences longer than 6 chars (account numbers, txn refs)
    s = s.replace(/\b\d{7,}\b/g, '');

    // Strip all punctuation and special characters (keep letters, digits, spaces)
    s = s.replace(/[^a-z0-9\s]/g, ' ');

    // Collapse whitespace
    s = s.replace(/\s+/g, ' ').trim();

    return s;
  }


  // ──────────────────────────────────────────────────────────────────────────
  // detectBatchDuplicate
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Check whether a file with the given hash has already been staged for this
   * company+account combination.  Returns the first matching batch found.
   *
   * Caller must decide what to do with the result — this method never blocks
   * the import or modifies any data.
   *
   * @param {object} supabase         — Supabase client
   * @param {number} companyId
   * @param {string} fileHash         — SHA-256 hex from computeFileHash()
   * @param {number|null} bankAccountId
   * @returns {Promise<{
   *   isDuplicate: boolean,
   *   existingBatchId?: string,
   *   confidence: number,
   *   reason?: string
   * }>}
   */
  static async detectBatchDuplicate(supabase, companyId, fileHash, bankAccountId) {
    if (!fileHash) return { isDuplicate: false, confidence: 0 };
    if (!companyId) return { isDuplicate: false, confidence: 0 };

    let query = supabase
      .from('bank_transaction_staging')
      .select('import_batch_id, import_source')
      .eq('company_id', companyId)
      .eq('source_file_hash', fileHash)
      .not('match_status', 'eq', 'REJECTED')
      .limit(1);

    if (bankAccountId) {
      query = query.eq('bank_account_id', bankAccountId);
    }

    const { data: rows, error } = await query;

    // Treat DB errors as non-duplicate (don't block import on detection failure)
    if (error) {
      console.warn('[DuplicateDetectionService.detectBatchDuplicate] DB error:', error.message);
      return { isDuplicate: false, confidence: 0 };
    }

    if (rows && rows.length > 0) {
      return {
        isDuplicate:      true,
        existingBatchId:  rows[0].import_batch_id,
        confidence:       1.0,
        reason:           'Exact file hash match — this file appears to have been imported before'
      };
    }

    return { isDuplicate: false, confidence: 0 };
  }


  // ──────────────────────────────────────────────────────────────────────────
  // detectTransactionDuplicates
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * For each incoming transaction, check whether a possible duplicate already
   * exists in bank_transaction_staging (non-REJECTED) or bank_transactions.
   *
   * Matching criteria (tiered):
   *   HIGH (1.0)  — exact external_id match in staging or live
   *   MED  (0.85) — exact amount + same date + similar normalised description
   *   LOW  (0.70) — exact amount + date within ±1 day
   *
   * External-id duplicates are NOT returned here — they are already handled
   * as hard skips in stageTransactions.  Only fuzzy matches (no externalId,
   * or externalId not matching) are returned.
   *
   * @param {object}  supabase
   * @param {number}  companyId
   * @param {number}  bankAccountId           — required; skip check if null
   * @param {Array}   transactions            — array of {date, amount, description, external_id?}
   * @param {string}  [currentBatchId]        — exclude rows from this batch in staging check
   * @returns {Promise<Map<number, {confidence: number, reason: string, matchSource: string}>>}
   *   — Map from transaction array index to duplicate-match info.
   *     Only indices with a suspected match are present.
   */
  static async detectTransactionDuplicates(
    supabase,
    companyId,
    bankAccountId,
    transactions,
    currentBatchId
  ) {
    const results = new Map();

    if (!bankAccountId || !transactions || transactions.length === 0) {
      return results;
    }

    // Compute date window spanning the full batch ± 1 day
    const dates = transactions.map(t => t.date).filter(Boolean);
    if (dates.length === 0) return results;

    const minRaw  = dates.reduce((a, b) => a < b ? a : b);
    const maxRaw  = dates.reduce((a, b) => a > b ? a : b);
    const dateFrom = new Date(minRaw);
    dateFrom.setDate(dateFrom.getDate() - FUZZY_DATE_WINDOW_DAYS);
    const dateTo = new Date(maxRaw);
    dateTo.setDate(dateTo.getDate() + FUZZY_DATE_WINDOW_DAYS);

    const dfStr = dateFrom.toISOString().slice(0, 10);
    const dtStr = dateTo.toISOString().slice(0, 10);

    // ── Fetch existing staging rows in date window ─────────────────────────
    let stagingQuery = supabase
      .from('bank_transaction_staging')
      .select('id, date, amount, description, external_id, normalized_description')
      .eq('company_id', companyId)
      .eq('bank_account_id', bankAccountId)
      .not('match_status', 'eq', 'REJECTED')
      .gte('date', dfStr)
      .lte('date', dtStr);

    if (currentBatchId) {
      stagingQuery = stagingQuery.neq('import_batch_id', currentBatchId);
    }

    const { data: stagingRows, error: sErr } = await stagingQuery;
    if (sErr) {
      console.warn('[DuplicateDetectionService.detectTransactionDuplicates] staging query error:', sErr.message);
    }

    // ── Fetch existing bank_transactions in date window ────────────────────
    const { data: liveRows, error: lErr } = await supabase
      .from('bank_transactions')
      .select('id, date, amount, description, external_id')
      .eq('company_id', companyId)
      .eq('bank_account_id', bankAccountId)
      .gte('date', dfStr)
      .lte('date', dtStr);

    if (lErr) {
      console.warn('[DuplicateDetectionService.detectTransactionDuplicates] live query error:', lErr.message);
    }

    const allCandidates = [
      ...(stagingRows || []).map(r => ({ ...r, _source: 'staging' })),
      ...(liveRows    || []).map(r => ({ ...r, _source: 'bank_transactions' })),
    ];

    if (allCandidates.length === 0) return results;

    // ── Per-transaction matching ───────────────────────────────────────────
    for (let i = 0; i < transactions.length; i++) {
      const txn     = transactions[i];
      const txnAmt  = parseFloat(txn.amount);
      const txnDate = new Date(txn.date);
      const txnNorm = DuplicateDetectionService.normalizeDescription(txn.description);

      // Skip rows that already have an externalId — those are handled as hard
      // skips in stageTransactions (they won't be inserted at all).
      const extId = txn.external_id || txn.externalId;
      if (extId) continue;

      let bestConf   = 0;
      let bestReason = null;
      let bestSource = null;

      for (const cand of allCandidates) {
        const cAmt  = parseFloat(cand.amount);
        const cDate = new Date(cand.date);
        const daysDiff = Math.abs((txnDate - cDate) / 86400000);

        // Amount must match within tolerance
        if (Math.abs(txnAmt - cAmt) > FUZZY_AMOUNT_TOLERANCE) continue;

        // Must be within date window
        if (daysDiff > FUZZY_DATE_WINDOW_DAYS) continue;

        // Compute confidence based on description similarity
        const candNorm = cand.normalized_description ||
          DuplicateDetectionService.normalizeDescription(cand.description);

        const sameDate   = daysDiff === 0;
        const descMatch  = txnNorm && candNorm && txnNorm === candNorm;
        const descContains = txnNorm && candNorm && (
          txnNorm.includes(candNorm) || candNorm.includes(txnNorm)
        );

        let conf;
        if (descMatch && sameDate)         conf = 0.90;
        else if (descContains && sameDate)  conf = 0.80;
        else if (sameDate)                  conf = 0.75;
        else if (descMatch)                 conf = 0.70;
        else                                conf = 0.65;

        if (conf > bestConf) {
          bestConf   = conf;
          bestSource = cand._source;
          bestReason = `Amount ${cAmt.toFixed(2)} and date ${cand.date} match`
            + (descMatch    ? ' (descriptions also match)' : '')
            + (descContains ? ' (descriptions overlap)'    : '')
            + (cand._source === 'bank_transactions'
              ? ' — already in bank transactions'
              : ' — already in staging');
        }
      }

      if (bestConf > 0) {
        results.set(i, {
          confidence:  bestConf,
          reason:      bestReason,
          matchSource: bestSource,
        });
      }
    }

    return results;
  }
}

module.exports = DuplicateDetectionService;
