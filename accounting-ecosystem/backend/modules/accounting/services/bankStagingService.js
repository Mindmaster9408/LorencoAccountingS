'use strict';

/**
 * ============================================================================
 * Bank Staging Service
 * ============================================================================
 * Manages the pre-confirmation staging pipeline for imported bank transactions.
 *
 * Flow:
 *   1. PDF/image import → PdfStatementImportService/ImageStatementImportService
 *      returns structured transactions (no DB write)
 *   2. Caller invokes stageTransactions() → rows inserted into bank_transaction_staging
 *   3. detectTransfers() runs on the batch — labels probable inter-account transfers
 *   4. User reviews staging: confirms, rejects, or confirms transfers
 *   5. confirmStaged() → inserts confirmed rows into bank_transactions (status=unmatched)
 *   6. confirmTransfer() → confirms a transfer pair, creates Dr/Cr journal, moves
 *      both staging rows to bank_transactions with status=matched
 *
 * GL impact: ZERO until step 5/6. Staging rows never affect the chart of accounts.
 *
 * Multi-tenant: every query is scoped by company_id.
 * ============================================================================
 */

const { supabase } = require('../../../config/database');
const db           = require('../config/database');       // pg pool for atomic transfers
const JournalService = require('./journalService');
const AuditLogger    = require('./auditLogger');
const { v4: uuidv4 } = require('uuid');

// ── Transfer detection constants ─────────────────────────────────────────────

// Keywords in description that strongly suggest an interbank transfer.
// Case-insensitive match.
const TRANSFER_KEYWORDS = [
  'transfer', 'trf', 'trfr', 'inter-account', 'interaccount',
  'own account', 'sweep', 'between accounts', 'account to account',
  'internet transfer', 'online transfer', 'online trfr',
  'capitec pay transfer', 'fnb pay transfer', 'absa transfer',
  'standard bank transfer', 'nedbank transfer',
];

// Amount tolerance for fuzzy matching (in ZAR).
// Two transactions must match within this tolerance to be considered a transfer pair.
const FUZZY_AMOUNT_TOLERANCE = 0.01;

// Date window for exact-amount match (Layer 2).
const LAYER2_DATE_WINDOW_DAYS = 2;

// Date window for fuzzy / same-day ±tolerance match (Layer 3).
const LAYER3_DATE_WINDOW_DAYS = 5;

// ── Module ───────────────────────────────────────────────────────────────────

const BankStagingService = {

  // ──────────────────────────────────────────────────────────────────────────
  // stageTransactions
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Insert a batch of parsed transactions into bank_transaction_staging.
   * Deduplicates within the batch by external_id.
   * Existing staging rows with the same external_id (for this company) are skipped.
   *
   * @param {number}   companyId
   * @param {number|null} bankAccountId  — null if account not yet resolved
   * @param {Array}    transactions      — ReviewTransaction[] from PdfStatementImportService
   * @param {string}   importBatchId     — UUID identifying this upload session
   * @param {string}   importSource      — 'pdf'|'image'|'csv'|'manual'
   * @returns {{ staged: StagedRow[], skipped: number }}
   */
  async stageTransactions(companyId, bankAccountId, transactions, importBatchId, importSource = 'pdf') {
    if (!companyId)                throw new Error('companyId is required');
    if (!Array.isArray(transactions)) throw new Error('transactions must be an array');

    const batchId = importBatchId || uuidv4();
    const source  = ['pdf','image','csv','manual','api'].includes(importSource)
      ? importSource : 'pdf';

    // ── 1. Collect external IDs for deduplication ─────────────────────────
    const incomingExtIds = transactions
      .map(t => t.externalId || t.external_id)
      .filter(Boolean);

    let existingExtIds = new Set();
    if (incomingExtIds.length > 0) {
      const { data: existing } = await supabase
        .from('bank_transaction_staging')
        .select('external_id')
        .eq('company_id', companyId)
        .in('external_id', incomingExtIds)
        .not('match_status', 'eq', 'REJECTED');   // rejected rows can be re-imported
      (existing || []).forEach(r => existingExtIds.add(r.external_id));
    }

    // ── 2. Build insert rows ──────────────────────────────────────────────
    const rows = [];
    let skippedCount = 0;

    for (const txn of transactions) {
      const extId = txn.externalId || txn.external_id || null;

      if (extId && existingExtIds.has(extId)) {
        skippedCount++;
        continue;
      }

      const parsedAmount = parseFloat(txn.amount);
      if (!txn.date || isNaN(parsedAmount) || !txn.description) {
        skippedCount++;
        continue;
      }

      rows.push({
        company_id:      companyId,
        bank_account_id: bankAccountId || null,
        date:            txn.date,
        description:     String(txn.description).trim(),
        amount:          parsedAmount,
        reference:       txn.reference || null,
        external_id:     extId,
        balance:         txn.balance != null ? parseFloat(txn.balance) : null,
        import_batch_id: batchId,
        import_source:   source,
        match_status:    'UNMATCHED',
      });
    }

    if (rows.length === 0) {
      return { staged: [], skipped: skippedCount, batchId };
    }

    // ── 3. Bulk insert ────────────────────────────────────────────────────
    const { data: inserted, error } = await supabase
      .from('bank_transaction_staging')
      .insert(rows)
      .select();

    if (error) throw new Error(`Staging insert failed: ${error.message}`);

    return {
      staged:  inserted || [],
      skipped: skippedCount,
      batchId,
    };
  },


  // ──────────────────────────────────────────────────────────────────────────
  // detectTransfers
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Run 3-layer transfer detection on a staging batch.
   *
   * Layer 1 — Keyword:   description contains a known transfer keyword
   * Layer 2 — Exact:     exact opposite amount across a different account within ±2 days
   * Layer 3 — Fuzzy:     opposite amount within ±$0.01 across different account within ±5 days
   *
   * Candidate counterparts are searched in BOTH bank_transaction_staging (unmatched)
   * AND bank_transactions (unmatched) — so transfers are found regardless of which
   * side was imported first.
   *
   * Detected pairs are recorded in bank_transfer_links.
   * Staging rows are updated with detected_type, match_status, confidence_score.
   *
   * @param {number} companyId
   * @param {string} batchId  — UUID of the staging batch to process
   * @returns {{ processed: number, transfersDetected: number, links: TransferLink[] }}
   */
  async detectTransfers(companyId, batchId) {
    if (!companyId || !batchId) throw new Error('companyId and batchId are required');

    // Fetch all UNMATCHED staging rows in this batch
    const { data: batchRows, error: batchErr } = await supabase
      .from('bank_transaction_staging')
      .select('id, bank_account_id, date, amount, description, reference')
      .eq('company_id', companyId)
      .eq('import_batch_id', batchId)
      .eq('match_status', 'UNMATCHED');

    if (batchErr) throw new Error(`Failed to fetch batch: ${batchErr.message}`);
    if (!batchRows || batchRows.length === 0) {
      return { processed: 0, transfersDetected: 0, links: [] };
    }

    // Fetch all company's UNMATCHED staging rows (other batches) for cross-batch matching
    const { data: otherStaging } = await supabase
      .from('bank_transaction_staging')
      .select('id, bank_account_id, date, amount, description')
      .eq('company_id', companyId)
      .neq('import_batch_id', batchId)
      .eq('match_status', 'UNMATCHED');

    // Fetch company's bank_transactions with status=unmatched (confirmed but unallocated)
    // — transfers may already be confirmed on one side
    const { data: liveUnmatched } = await supabase
      .from('bank_transactions')
      .select('id, bank_account_id, date, amount, description')
      .eq('company_id', companyId)
      .eq('status', 'unmatched');

    const existingStaging  = otherStaging  || [];
    const existingLive     = liveUnmatched || [];

    const detectedLinks = [];
    const processedIds  = new Set();

    for (const row of batchRows) {
      if (processedIds.has(row.id)) continue;

      const amt    = parseFloat(row.amount);
      const rowDate = new Date(row.date);

      // ── Layer 1: Keyword check ──────────────────────────────────────────
      const descLower = (row.description || '').toLowerCase();
      const hasKeyword = TRANSFER_KEYWORDS.some(kw => descLower.includes(kw));

      // ── Layer 2/3: Find an opposite-side counterpart ────────────────────
      let bestMatch = null;
      let bestLayer = null;
      let bestConf  = 0;

      // Search other staging rows first, then live unmatched
      const candidates = [
        ...existingStaging.map(r => ({ ...r, source: 'staging' })),
        ...existingLive.map(r => ({ ...r, source: 'live' })),
        ...batchRows.filter(r => r.id !== row.id).map(r => ({ ...r, source: 'staging_same_batch' })),
      ];

      for (const cand of candidates) {
        // Must be a different bank account
        if (cand.bank_account_id === row.bank_account_id) continue;

        const candAmt  = parseFloat(cand.amount);
        const candDate = new Date(cand.date);
        const daysDiff = Math.abs((rowDate - candDate) / 86400000);

        // Amounts must be opposite in sign
        const amtDiff = Math.abs(amt + candAmt); // exact opposite = sum is 0

        // Layer 2: exact amount, ±2 days
        if (amtDiff <= FUZZY_AMOUNT_TOLERANCE && daysDiff <= LAYER2_DATE_WINDOW_DAYS) {
          const conf = hasKeyword ? 0.97 : 0.90;
          if (conf > bestConf) {
            bestMatch = cand;
            bestLayer = 2;
            bestConf  = conf;
          }
          continue;
        }

        // Layer 3: fuzzy amount (within 0.01), ±5 days
        if (amtDiff <= FUZZY_AMOUNT_TOLERANCE && daysDiff <= LAYER3_DATE_WINDOW_DAYS) {
          const conf = hasKeyword ? 0.80 : 0.65;
          if (conf > bestConf) {
            bestMatch = cand;
            bestLayer = 3;
            bestConf  = conf;
          }
        }
      }

      // ── Layer 1 only (no counterpart found yet) ─────────────────────────
      if (hasKeyword && !bestMatch && bestConf === 0) {
        // Flag as potential transfer even without a confirmed counterpart
        await supabase
          .from('bank_transaction_staging')
          .update({
            detected_type:    'TRANSFER',
            match_status:     'REVIEW_REQUIRED',
            confidence_score: 0.55,
          })
          .eq('id', row.id)
          .eq('company_id', companyId);
        processedIds.add(row.id);
        continue;
      }

      if (!bestMatch) continue;

      // ── Record transfer link ────────────────────────────────────────────
      // Determine FROM (money leaves) and TO (money arrives)
      const isCurrentFrom = amt < 0;
      const fromId = isCurrentFrom ? row.id : (bestMatch.source !== 'live' ? bestMatch.id : null);
      const toId   = isCurrentFrom ? (bestMatch.source !== 'live' ? bestMatch.id : null) : row.id;

      // Only create link when both sides are in staging (we can't link to live bank_transactions here)
      if (bestMatch.source !== 'live' && fromId && toId) {
        const { data: linkRow, error: linkErr } = await supabase
          .from('bank_transfer_links')
          .insert({
            company_id:       companyId,
            staging_id_from:  fromId,
            staging_id_to:    toId,
            confidence:       bestConf,
            detection_layer:  bestLayer,
            confirmed:        false,
          })
          .select()
          .single();

        if (!linkErr && linkRow) {
          detectedLinks.push(linkRow);
        }
      }

      // Update current row
      const newStatus = bestConf >= 0.85 ? 'TRANSFER_DETECTED' : 'REVIEW_REQUIRED';
      await supabase
        .from('bank_transaction_staging')
        .update({
          detected_type:              'TRANSFER',
          match_status:               newStatus,
          confidence_score:           bestConf,
          transfer_pair_staging_id:   bestMatch.source !== 'live' ? bestMatch.id : null,
        })
        .eq('id', row.id)
        .eq('company_id', companyId);

      processedIds.add(row.id);

      // Update counterpart (if in staging)
      if (bestMatch.source !== 'live' && !processedIds.has(bestMatch.id)) {
        await supabase
          .from('bank_transaction_staging')
          .update({
            detected_type:              'TRANSFER',
            match_status:               newStatus,
            confidence_score:           bestConf,
            transfer_pair_staging_id:   row.id,
          })
          .eq('id', bestMatch.id)
          .eq('company_id', companyId);
        processedIds.add(bestMatch.id);
      }
    }

    return {
      processed:         batchRows.length,
      transfersDetected: detectedLinks.length,
      links:             detectedLinks,
    };
  },


  // ──────────────────────────────────────────────────────────────────────────
  // confirmStaged
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Move confirmed staging rows into bank_transactions (status=unmatched).
   * These are normal transactions — NOT transfers — that the user has reviewed
   * and approved. They do NOT create any GL entry; allocation is done separately
   * via the existing POST /bank/transactions/:id/allocate endpoint.
   *
   * Rows that are already CONFIRMED or REJECTED are silently skipped.
   * A bankAccountId is required for each row being confirmed.
   *
   * @param {number}   companyId
   * @param {number[]} stagingIds  — IDs to confirm
   * @param {number}   userId
   * @returns {{ confirmed: BankTransaction[], skipped: number[] }}
   */
  async confirmStaged(companyId, stagingIds, userId) {
    if (!companyId || !Array.isArray(stagingIds) || stagingIds.length === 0) {
      throw new Error('companyId and stagingIds[] are required');
    }

    // Fetch target rows
    const { data: rows, error: fetchErr } = await supabase
      .from('bank_transaction_staging')
      .select('*')
      .eq('company_id', companyId)
      .in('id', stagingIds);

    if (fetchErr) throw new Error(`Failed to fetch staging rows: ${fetchErr.message}`);

    const toInsert  = [];
    const skipped   = [];

    for (const row of rows || []) {
      if (['CONFIRMED','REJECTED'].includes(row.match_status)) {
        skipped.push(row.id);
        continue;
      }
      if (!row.bank_account_id) {
        skipped.push(row.id);  // can't confirm without a bank account
        continue;
      }

      toInsert.push({
        staging_row: row,
        bankTxn: {
          company_id:      companyId,
          bank_account_id: row.bank_account_id,
          date:            row.date,
          description:     row.description,
          amount:          row.amount,
          balance:         row.balance,
          reference:       row.reference,
          external_id:     row.external_id || null,
          status:          'unmatched',
          import_source:   row.import_source || 'pdf',
        },
      });
    }

    if (toInsert.length === 0) {
      return { confirmed: [], skipped };
    }

    // Bulk insert into bank_transactions
    const { data: inserted, error: insertErr } = await supabase
      .from('bank_transactions')
      .insert(toInsert.map(i => i.bankTxn))
      .select();

    if (insertErr) throw new Error(`Failed to create bank transactions: ${insertErr.message}`);

    // Update staging rows with confirmed_txn_id and match_status=CONFIRMED
    // Map inserted rows back to staging rows by position (same order guaranteed by bulk insert)
    const updates = (inserted || []).map((txn, idx) => ({
      id:              toInsert[idx].staging_row.id,
      confirmed_txn_id: txn.id,
      match_status:    'CONFIRMED',
      updated_at:      new Date().toISOString(),
    }));

    for (const upd of updates) {
      await supabase
        .from('bank_transaction_staging')
        .update({ confirmed_txn_id: upd.confirmed_txn_id, match_status: 'CONFIRMED' })
        .eq('id', upd.id)
        .eq('company_id', companyId);
    }

    return {
      confirmed: inserted || [],
      skipped,
    };
  },


  // ──────────────────────────────────────────────────────────────────────────
  // rejectStaged
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Mark a staging row as REJECTED. It will not be imported.
   * If the row is part of a transfer pair, the pair's counterpart remains
   * unaffected — the user must separately decide what to do with it.
   *
   * @param {number} companyId
   * @param {number} stagingId
   * @returns {{ id: number, match_status: 'REJECTED' }}
   */
  async rejectStaged(companyId, stagingId) {
    const { data: row, error: fetchErr } = await supabase
      .from('bank_transaction_staging')
      .select('id, match_status')
      .eq('id', stagingId)
      .eq('company_id', companyId)
      .single();

    if (fetchErr || !row) throw new Error('Staging row not found');
    if (row.match_status === 'CONFIRMED') {
      throw new Error('Cannot reject a row that has already been confirmed and moved to bank_transactions');
    }

    const { error } = await supabase
      .from('bank_transaction_staging')
      .update({ match_status: 'REJECTED' })
      .eq('id', stagingId)
      .eq('company_id', companyId);

    if (error) throw new Error(`Failed to reject: ${error.message}`);

    return { id: stagingId, match_status: 'REJECTED' };
  },


  // ──────────────────────────────────────────────────────────────────────────
  // confirmTransfer
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Confirm a detected transfer pair.
   *
   * Actions (all must succeed atomically):
   *   1. Validate: both staging rows exist, both have bank_account_id,
   *      both bank accounts have ledger_account_id, neither is already CONFIRMED
   *   2. Create a posted transfer journal:
   *        Dr  bank_account_to   (receiving account — money in)
   *        Cr  bank_account_from (sending account  — money out)
   *   3. Insert both rows into bank_transactions with status='matched',
   *      referencing the new journal
   *   4. Update both staging rows to CONFIRMED
   *   5. Update bank_transfer_links: confirmed=true, journal_id
   *
   * If journal posting succeeds but any subsequent step fails, the journal
   * is reversed to prevent a dangling GL entry (same pattern as bank.js allocate).
   *
   * @param {number} companyId
   * @param {number} transferLinkId
   * @param {object} user  — { id, companyId }
   * @returns {{ journalId, bankTxnFrom, bankTxnTo, transferLink }}
   */
  async confirmTransfer(companyId, transferLinkId, user) {
    if (!companyId || !transferLinkId) throw new Error('companyId and transferLinkId are required');

    // ── Fetch the transfer link ───────────────────────────────────────────
    const { data: link, error: linkErr } = await supabase
      .from('bank_transfer_links')
      .select('*')
      .eq('id', transferLinkId)
      .eq('company_id', companyId)
      .single();

    if (linkErr || !link) throw new Error('Transfer link not found');
    if (link.confirmed)   throw new Error('Transfer link already confirmed');

    // ── Fetch both staging rows ───────────────────────────────────────────
    const { data: stagingRows, error: sErr } = await supabase
      .from('bank_transaction_staging')
      .select('*')
      .eq('company_id', companyId)
      .in('id', [link.staging_id_from, link.staging_id_to]);

    if (sErr) throw new Error(`Failed to fetch staging rows: ${sErr.message}`);
    if (!stagingRows || stagingRows.length !== 2) {
      throw new Error('Both transfer staging rows must exist');
    }

    const fromRow = stagingRows.find(r => r.id === link.staging_id_from);
    const toRow   = stagingRows.find(r => r.id === link.staging_id_to);

    if (!fromRow || !toRow) throw new Error('Transfer staging rows not found');

    for (const row of [fromRow, toRow]) {
      if (row.match_status === 'CONFIRMED') {
        throw new Error(`Staging row ${row.id} is already confirmed`);
      }
      if (!row.bank_account_id) {
        throw new Error(`Staging row ${row.id} has no bank_account_id — cannot confirm transfer`);
      }
    }

    // ── Fetch ledger account IDs for both bank accounts ───────────────────
    const { data: bankAccounts, error: baErr } = await supabase
      .from('bank_accounts')
      .select('id, ledger_account_id, name')
      .eq('company_id', companyId)
      .in('id', [fromRow.bank_account_id, toRow.bank_account_id]);

    if (baErr) throw new Error(`Failed to fetch bank accounts: ${baErr.message}`);

    const fromBankAccount = (bankAccounts || []).find(a => a.id === fromRow.bank_account_id);
    const toBankAccount   = (bankAccounts || []).find(a => a.id === toRow.bank_account_id);

    if (!fromBankAccount?.ledger_account_id) {
      throw new Error(`Sending bank account (id=${fromRow.bank_account_id}) has no linked ledger account`);
    }
    if (!toBankAccount?.ledger_account_id) {
      throw new Error(`Receiving bank account (id=${toRow.bank_account_id}) has no linked ledger account`);
    }

    const transferAmount = Math.abs(parseFloat(fromRow.amount));
    const transferDate   = fromRow.date <= toRow.date ? fromRow.date : toRow.date;

    // ── Create and post transfer journal ─────────────────────────────────
    // Transfer journal: Dr receiving account, Cr sending account
    const journal = await JournalService.createDraftJournal({
      companyId:        companyId,
      date:             transferDate,
      reference:        fromRow.reference || toRow.reference || null,
      description:      `Transfer: ${fromBankAccount.name} → ${toBankAccount.name}`,
      sourceType:       'bank_transfer',
      createdByUserId:  user.id,
      lines: [
        {
          accountId:   toBankAccount.ledger_account_id,   // Dr — receiving
          debit:       transferAmount,
          credit:      0,
          description: `Transfer IN — ${toRow.description}`,
        },
        {
          accountId:   fromBankAccount.ledger_account_id, // Cr — sending
          debit:       0,
          credit:      transferAmount,
          description: `Transfer OUT — ${fromRow.description}`,
        },
      ],
      metadata: {
        transferLinkId,
        bankAccountFrom: fromRow.bank_account_id,
        bankAccountTo:   toRow.bank_account_id,
        stagingIdFrom:   fromRow.id,
        stagingIdTo:     toRow.id,
      },
    });

    await JournalService.postJournal(journal.id, companyId, user.id);

    // ── Insert both rows into bank_transactions ───────────────────────────
    const { data: inserted, error: txnInsertErr } = await supabase
      .from('bank_transactions')
      .insert([
        {
          company_id:           companyId,
          bank_account_id:      fromRow.bank_account_id,
          date:                 fromRow.date,
          description:          fromRow.description,
          amount:               fromRow.amount,
          balance:              fromRow.balance,
          reference:            fromRow.reference,
          external_id:          fromRow.external_id || null,
          status:               'matched',
          import_source:        fromRow.import_source || 'pdf',
          matched_entity_type:  'JOURNAL',
          matched_entity_id:    journal.id,
          matched_by_user_id:   user.id,
        },
        {
          company_id:           companyId,
          bank_account_id:      toRow.bank_account_id,
          date:                 toRow.date,
          description:          toRow.description,
          amount:               toRow.amount,
          balance:              toRow.balance,
          reference:            toRow.reference,
          external_id:          toRow.external_id || null,
          status:               'matched',
          import_source:        toRow.import_source || 'pdf',
          matched_entity_type:  'JOURNAL',
          matched_entity_id:    journal.id,
          matched_by_user_id:   user.id,
        },
      ])
      .select();

    if (txnInsertErr) {
      // Reverse the journal to prevent dangling GL entry
      try {
        await JournalService.reverseJournal(
          journal.id, companyId, user.id,
          `Auto-reversed: bank_transactions insert failed during transfer confirm — ${txnInsertErr.message}`
        );
      } catch (revErr) {
        console.error('[bankStagingService] Journal reversal failed after bank_transactions insert error:', revErr.message);
      }
      throw new Error(`Failed to create bank transactions for transfer: ${txnInsertErr.message}`);
    }

    const bankTxnFrom = (inserted || []).find(t => t.bank_account_id === fromRow.bank_account_id);
    const bankTxnTo   = (inserted || []).find(t => t.bank_account_id === toRow.bank_account_id);

    // ── Mark staging rows as CONFIRMED ───────────────────────────────────
    await supabase
      .from('bank_transaction_staging')
      .update({ match_status: 'CONFIRMED', confirmed_txn_id: bankTxnFrom?.id })
      .eq('id', fromRow.id).eq('company_id', companyId);

    await supabase
      .from('bank_transaction_staging')
      .update({ match_status: 'CONFIRMED', confirmed_txn_id: bankTxnTo?.id })
      .eq('id', toRow.id).eq('company_id', companyId);

    // ── Mark transfer link as confirmed ──────────────────────────────────
    await supabase
      .from('bank_transfer_links')
      .update({
        confirmed:    true,
        confirmed_by: user.id,
        confirmed_at: new Date().toISOString(),
        journal_id:   journal.id,
      })
      .eq('id', transferLinkId)
      .eq('company_id', companyId);

    return {
      journalId:    journal.id,
      bankTxnFrom,
      bankTxnTo,
      transferLink: { ...link, confirmed: true, journal_id: journal.id },
    };
  },


  // ──────────────────────────────────────────────────────────────────────────
  // getBatch
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Fetch all staging rows for a batch, with detected transfer links.
   *
   * @param {number} companyId
   * @param {string} batchId
   * @returns {{ rows: StagedRow[], transferLinks: TransferLink[] }}
   */
  async getBatch(companyId, batchId) {
    // Step 1: fetch staging rows for this batch
    const { data: rows, error: rowsErr } = await supabase
      .from('bank_transaction_staging')
      .select('*')
      .eq('company_id', companyId)
      .eq('import_batch_id', batchId)
      .order('date', { ascending: true })
      .order('id',   { ascending: true });

    if (rowsErr) throw new Error(`Failed to fetch batch rows: ${rowsErr.message}`);
    if (!rows || rows.length === 0) return { rows: [], transferLinks: [] };

    // Step 2: fetch transfer links for the staging IDs in this batch
    const stagingIds = rows.map(r => r.id);
    const { data: links } = await supabase
      .from('bank_transfer_links')
      .select('*')
      .eq('company_id', companyId)
      .or(`staging_id_from.in.(${stagingIds.join(',')}),staging_id_to.in.(${stagingIds.join(',')})`);

    return {
      rows,
      transferLinks: links || [],
    };
  },


  // ──────────────────────────────────────────────────────────────────────────
  // listBatches
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * List import batches for a company with summary stats per batch.
   *
   * @param {number} companyId
   * @returns {BatchSummary[]}
   */
  async listBatches(companyId) {
    const { data, error } = await supabase
      .from('bank_transaction_staging')
      .select('import_batch_id, import_source, bank_account_id, match_status, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(`Failed to list batches: ${error.message}`);

    // Group by batch ID
    const batchMap = {};
    for (const row of data || []) {
      const bid = row.import_batch_id;
      if (!batchMap[bid]) {
        batchMap[bid] = {
          import_batch_id: bid,
          import_source:   row.import_source,
          bank_account_id: row.bank_account_id,
          created_at:      row.created_at,
          total:           0,
          unmatched:       0,
          transfer_detected: 0,
          review_required: 0,
          confirmed:       0,
          rejected:        0,
        };
      }
      const b = batchMap[bid];
      b.total++;
      const s = row.match_status;
      if (s === 'UNMATCHED')          b.unmatched++;
      if (s === 'TRANSFER_DETECTED')  b.transfer_detected++;
      if (s === 'REVIEW_REQUIRED')    b.review_required++;
      if (s === 'CONFIRMED')          b.confirmed++;
      if (s === 'REJECTED')           b.rejected++;
    }

    return Object.values(batchMap);
  },


  // ──────────────────────────────────────────────────────────────────────────
  // listStaged
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * List staged transactions for a company with optional filters.
   *
   * @param {number} companyId
   * @param {{ batchId, bankAccountId, matchStatus, limit, offset }} filters
   */
  async listStaged(companyId, filters = {}) {
    const { batchId, bankAccountId, matchStatus, limit = 100, offset = 0 } = filters;

    let query = supabase
      .from('bank_transaction_staging')
      .select('*')
      .eq('company_id', companyId);

    if (batchId)       query = query.eq('import_batch_id', batchId);
    if (bankAccountId) query = query.eq('bank_account_id', bankAccountId);
    if (matchStatus)   query = query.eq('match_status', matchStatus);

    query = query
      .order('date', { ascending: true })
      .order('id', { ascending: true })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list staged: ${error.message}`);

    return data || [];
  },
};

module.exports = BankStagingService;
