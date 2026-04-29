const express = require('express');
const { supabase } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');
const JournalService = require('../services/journalService');
const AuditLogger = require('../services/auditLogger');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PdfStatementImportService = require('../../../sean/pdf-statement-import-service');
const ImageStatementImportService = require('../../../sean/image-statement-import-service');
const bankLearning = require('../../../sean/bank-learning');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// resolveOrCreateSubaccount
// ─────────────────────────────────────────────────────────────────────────────
// When a user creates or edits a bank account and selects a COA ledger account
// that is already claimed by ANOTHER active bank account in the same company,
// this helper automatically creates a numbered child subaccount under the
// parent COA account and returns the new subaccount's id.
//
// If the requested account is free → returned directly (no-op, backward safe).
//
// Subaccount code format: [parentCode]-01, [parentCode]-02, …
// Example: 1010 → 1010-01, 1010-02
//
// This preserves all existing bank account / ledger linkages and never moves
// journal entries — it simply gives the new bank account its own GL account.
//
// @param supa           Supabase client
// @param companyId      Authenticated company
// @param requestedId    The ledger_account_id the user selected
// @param bankName       Name of the real bank account (used for subaccount label)
// @param excludeBankId  When updating, exclude this bank_account id from the
//                       conflict check (the account being edited already owns
//                       its current ledger account — that is not a conflict)
// @returns { ledgerAccountId, subaccountCreated }
// ─────────────────────────────────────────────────────────────────────────────
async function resolveOrCreateSubaccount(supa, companyId, requestedId, bankName, excludeBankId = null) {
  // Check if the requested COA account is already linked to another active bank account
  let conflictQuery = supa
    .from('bank_accounts')
    .select('id, name')
    .eq('company_id', companyId)
    .eq('ledger_account_id', requestedId)
    .eq('is_active', true);

  if (excludeBankId) conflictQuery = conflictQuery.neq('id', excludeBankId);

  const { data: conflicts } = await conflictQuery;

  if (!conflicts || conflicts.length === 0) {
    // No conflict — use the requested account directly (existing behaviour preserved)
    return { ledgerAccountId: requestedId, subaccountCreated: null };
  }

  // Conflict — fetch parent account details to derive the subaccount
  const { data: parent, error: parentErr } = await supa
    .from('accounts')
    .select('id, code, name, type, sub_type, reporting_group, sort_order')
    .eq('id', requestedId)
    .eq('company_id', companyId)
    .single();

  if (parentErr || !parent) {
    throw new Error('Ledger account not found or does not belong to this company');
  }

  // Count existing child accounts under this parent to determine next sequence number
  const { data: existingSubs } = await supa
    .from('accounts')
    .select('code')
    .eq('company_id', companyId)
    .eq('parent_id', parent.id)
    .order('code');

  const nextNum = (existingSubs?.length || 0) + 1;
  const newCode = `${parent.code}-${String(nextNum).padStart(2, '0')}`;

  // Create the subaccount as a real posting account under the parent
  const { data: sub, error: subErr } = await supa
    .from('accounts')
    .insert({
      company_id: companyId,
      code:             newCode,
      name:             `${parent.name} — ${bankName}`,
      type:             parent.type,
      sub_type:         parent.sub_type  || null,
      reporting_group:  parent.reporting_group || null,
      parent_id:        parent.id,
      description:      `Auto-created subaccount for bank account: ${bankName}`,
      is_active:        true,
      is_system:        false,
      sort_order:       (parent.sort_order || 0) + nextNum,
    })
    .select()
    .single();

  if (subErr) throw new Error(`Failed to create subaccount ${newCode}: ${subErr.message}`);

  console.log(`[bank] Auto-created subaccount ${newCode} (id=${sub.id}) for bank "${bankName}" under parent ${parent.code}`);

  return { ledgerAccountId: sub.id, subaccountCreated: sub };
}

// ─── Multer: memory storage for PDF parsing (buffer only, no disk write) ────
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const isPdf =
      file.mimetype === 'application/pdf' ||
      path.extname(file.originalname).toLowerCase() === '.pdf';
    if (isPdf) return cb(null, true);
    cb(new Error('Only PDF files are accepted for PDF import'));
  }
});

// ─── Multer: memory storage for image OCR parsing (buffer only, no disk write) ─
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (req, file, cb) => {
    const isImage =
      /^image\/(jpeg|jpg|png|webp)$/.test(file.mimetype) ||
      /\.(jpg|jpeg|png|webp)$/i.test(file.originalname);
    if (isImage) return cb(null, true);
    cb(new Error('Only image files are accepted for image import (JPG, PNG, WEBP)'));
  }
});

// Configure multer for file uploads
const uploadDir = path.join(__dirname, '../../../uploads/accounting/bank_attachments');

// Create uploads directory if it doesn't exist
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'attachment-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max file size
  },
  fileFilter: function (req, file, cb) {
    // Accept images, PDFs, and common office documents
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|csv|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/gif',
      'application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv', 'text/plain'
    ];
    const mimeOk = allowedMimeTypes.includes(file.mimetype);

    if (mimeOk || extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed types: images, PDF, DOC, XLS, CSV, TXT'));
    }
  }
});

/**
 * GET /api/bank/accounts
 * List bank accounts
 */
router.get('/accounts', authenticate, hasPermission('bank.view'), async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('company_id', req.user.companyId)
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);

    // Enrich with ledger account code/name via a separate lookup if ledger_account_id present
    const ledgerIds = [...new Set((rows || []).map(r => r.ledger_account_id).filter(Boolean))];
    let ledgerMap = {};
    if (ledgerIds.length > 0) {
      const { data: accts } = await supabase
        .from('accounts')
        .select('id, code, name')
        .in('id', ledgerIds);
      (accts || []).forEach(a => { ledgerMap[a.id] = a; });
    }

    const bankAccounts = (rows || []).map(ba => ({
      ...ba,
      ledger_account_code: ledgerMap[ba.ledger_account_id]?.code ?? null,
      ledger_account_name: ledgerMap[ba.ledger_account_id]?.name ?? null
    }));

    res.json({ bankAccounts, count: bankAccounts.length });

  } catch (error) {
    console.error('Error fetching bank accounts:', error);
    res.status(500).json({ error: 'Failed to fetch bank accounts' });
  }
});

/**
 * POST /api/bank/accounts
 * Create a new bank account
 */
router.post('/accounts', authenticate, hasPermission('bank.manage'), async (req, res) => {
  try {
    const { name, bankName, accountNumberMasked, currency = 'ZAR', ledgerAccountId, openingBalance = 0, openingBalanceDate } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Resolve ledger account — auto-create numbered subaccount if the selected
    // COA account is already owned by another active bank account in this company.
    // Falls through unchanged when the account is free (backward-compatible).
    let resolvedLedgerId = ledgerAccountId || null;
    let subaccountCreated = null;

    if (resolvedLedgerId) {
      // First verify the account belongs to this company
      const { data: acctCheck } = await supabase
        .from('accounts')
        .select('id')
        .eq('id', resolvedLedgerId)
        .eq('company_id', req.user.companyId)
        .single();

      if (!acctCheck) {
        return res.status(400).json({ error: 'Ledger account not found' });
      }

      const resolved = await resolveOrCreateSubaccount(
        supabase, req.user.companyId, resolvedLedgerId, name
      );
      resolvedLedgerId     = resolved.ledgerAccountId;
      subaccountCreated    = resolved.subaccountCreated;
    }

    const { data: bankAccount, error } = await supabase
      .from('bank_accounts')
      .insert({
        company_id:           req.user.companyId,
        name,
        bank_name:            bankName,
        account_number_masked: accountNumberMasked,
        currency,
        ledger_account_id:    resolvedLedgerId,
        opening_balance:      openingBalance,
        opening_balance_date: openingBalanceDate || null,
        is_active:            true
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await AuditLogger.logUserAction(
      req,
      'CREATE',
      'BANK_ACCOUNT',
      bankAccount.id,
      null,
      { name: bankAccount.name, bankName: bankAccount.bank_name, ledgerAccountId: resolvedLedgerId },
      subaccountCreated
        ? `Bank account created; auto-created subaccount ${subaccountCreated.code}`
        : 'Bank account created'
    );

    res.status(201).json({
      ...bankAccount,
      // Inform the caller if a new subaccount was created on their behalf
      ...(subaccountCreated ? { subaccount_created: subaccountCreated } : {})
    });

  } catch (error) {
    console.error('Error creating bank account:', error);
    res.status(500).json({ error: 'Failed to create bank account' });
  }
});

/**
 * PUT /api/bank/accounts/:id
 * Update a bank account (name, bankName, accountNumberMasked, ledgerAccountId, isActive)
 */
router.put('/accounts/:id', authenticate, hasPermission('bank.manage'), async (req, res) => {
  try {
    const { name, bankName, accountNumberMasked, ledgerAccountId, isActive } = req.body;

    // Fetch existing record and verify ownership
    const { data: existing, error: fetchErr } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('id', req.params.id)
      .eq('company_id', req.user.companyId)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    const before = existing;

    // Resolve ledger account for update.
    // Rules:
    //   • If ledgerAccountId not provided in body → keep existing (no change)
    //   • If set to null → clear the link
    //   • If set to a new account id that equals the CURRENT link → no-op
    //   • If set to a new account id that differs from current → verify ownership,
    //     then auto-create subaccount if that account is already taken by another
    //     bank account in this company (same logic as POST /accounts)
    let resolvedLedgerAccountId = before.ledger_account_id;
    let subaccountCreated = null;

    if (ledgerAccountId === null) {
      // Explicitly clearing the link
      resolvedLedgerAccountId = null;

    } else if (ledgerAccountId !== undefined && ledgerAccountId !== before.ledger_account_id) {
      // Changing to a different COA account — verify and resolve
      const { data: acctCheck } = await supabase
        .from('accounts')
        .select('id')
        .eq('id', ledgerAccountId)
        .eq('company_id', req.user.companyId)
        .single();

      if (!acctCheck) {
        return res.status(400).json({ error: 'Ledger account not found' });
      }

      const resolved = await resolveOrCreateSubaccount(
        supabase, req.user.companyId, ledgerAccountId,
        (req.body.name || before.name),
        parseInt(req.params.id)   // exclude self from conflict check
      );
      resolvedLedgerAccountId = resolved.ledgerAccountId;
      subaccountCreated       = resolved.subaccountCreated;

    } else if (ledgerAccountId !== undefined && ledgerAccountId === before.ledger_account_id) {
      // Same value as current — no-op
      resolvedLedgerAccountId = before.ledger_account_id;
    }

    const { error: updateErr } = await supabase
      .from('bank_accounts')
      .update({
        name: name || before.name,
        bank_name: bankName !== undefined ? bankName : before.bank_name,
        account_number_masked: accountNumberMasked !== undefined ? accountNumberMasked : before.account_number_masked,
        ledger_account_id: resolvedLedgerAccountId,
        is_active: isActive !== undefined ? isActive : before.is_active
      })
      .eq('id', req.params.id)
      .eq('company_id', req.user.companyId);

    if (updateErr) throw new Error(updateErr.message);

    await AuditLogger.logUserAction(
      req,
      'UPDATE',
      'BANK_ACCOUNT',
      before.id,
      { name: before.name, ledgerAccountId: before.ledger_account_id },
      { name: name || before.name, ledgerAccountId: resolvedLedgerAccountId },
      subaccountCreated
        ? `Bank account updated; auto-created subaccount ${subaccountCreated.code}`
        : 'Bank account updated'
    );

    // Return with joined ledger account info
    const { data: full, error: fullErr } = await supabase
      .from('bank_accounts')
      .select('*, accounts!ledger_account_id(code, name)')
      .eq('id', req.params.id)
      .single();

    if (fullErr) throw new Error(fullErr.message);

    res.json({
      ...full,
      ledger_account_code: full.accounts?.code,
      ledger_account_name: full.accounts?.name,
      ...(subaccountCreated ? { subaccount_created: subaccountCreated } : {})
    });

  } catch (error) {
    console.error('Error updating bank account:', error);
    res.status(500).json({ error: 'Failed to update bank account' });
  }
});

/**
 * GET /api/bank/transactions
 * List bank transactions
 */
router.get('/transactions', authenticate, hasPermission('bank.view'), async (req, res) => {
  try {
    const { bankAccountId, status, fromDate, toDate, limit = 100, offset = 0 } = req.query;

    // Try query with company_id filter (requires migration 012).
    // company_id column was added by ALTER TABLE in migration 012.
    let query = supabase
      .from('bank_transactions')
      .select('*, bank_accounts!bank_account_id(name)')
      .eq('company_id', req.user.companyId);

    if (bankAccountId) query = query.eq('bank_account_id', bankAccountId);
    if (status)        query = query.eq('status', status);
    if (fromDate)      query = query.gte('date', fromDate);
    if (toDate)        query = query.lte('date', toDate);

    query = query
      .order('date', { ascending: true })
      .order('id', { ascending: true })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    let { data, error } = await query;

    if (error) {
      // Fallback: company_id not yet present — scope by bank account instead
      console.warn('[bank/transactions] company_id filter failed, using bank_account fallback:', error.message);

      // Get this company's bank account IDs and filter by those
      const { data: accounts } = await supabase
        .from('bank_accounts')
        .select('id')
        .eq('company_id', req.user.companyId);

      if (!accounts || accounts.length === 0) {
        return res.json({ transactions: [], count: 0 });
      }

      const accountIds = accounts.map(a => a.id);
      let fbQuery = supabase
        .from('bank_transactions')
        .select('*')
        .in('bank_account_id', accountIds);

      if (bankAccountId) fbQuery = fbQuery.eq('bank_account_id', bankAccountId);
      if (fromDate)      fbQuery = fbQuery.gte('date', fromDate);
      if (toDate)        fbQuery = fbQuery.lte('date', toDate);

      fbQuery = fbQuery
        .order('date', { ascending: true })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

      ({ data, error } = await fbQuery);
      if (error) throw new Error(error.message);
    }

    const transactions = (data || []).map(t => ({
      ...t,
      bank_account_name: t.bank_accounts?.name ?? null
    }));

    res.json({
      transactions,
      count: transactions.length
    });

  } catch (error) {
    console.error('Error fetching bank transactions:', error);
    res.status(500).json({ error: 'Failed to fetch bank transactions' });
  }
});

/**
 * POST /api/bank/import
 * Import bank transactions from CSV
 */
router.post('/import', authenticate, hasPermission('bank.import'), async (req, res) => {
  try {
    const { bankAccountId, transactions, importSource } = req.body;
    const resolvedSource = ['pdf', 'api', 'csv', 'manual'].includes(importSource) ? importSource : 'csv';

    if (!bankAccountId || !transactions || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'Bank account ID and transactions array are required' });
    }

    // Verify bank account exists and belongs to this company
    const { data: bankAccountCheck } = await supabase
      .from('bank_accounts')
      .select('id')
      .eq('id', bankAccountId)
      .eq('company_id', req.user.companyId)
      .single();

    if (!bankAccountCheck) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    const skippedTransactions = [];

    // ── 1. Bulk duplicate check — ONE query instead of one per row ────────────
    // Collect all externalIds from the incoming batch that are non-empty
    const incomingExternalIds = transactions
      .map(t => t.externalId)
      .filter(Boolean);

    let existingExternalIdSet = new Set();
    if (incomingExternalIds.length > 0) {
      const { data: existingRows } = await supabase
        .from('bank_transactions')
        .select('external_id')
        .eq('bank_account_id', bankAccountId)
        .in('external_id', incomingExternalIds);
      if (existingRows) {
        existingRows.forEach(r => existingExternalIdSet.add(r.external_id));
      }
    }

    // ── 2. Validate rows and split into valid / skipped ───────────────────────
    const rowsToInsert = [];
    transactions.forEach((txn, idx) => {
      const rowIndex = idx + 1;
      const { date, description, amount, reference, externalId, balance } = txn;

      if (!date || !description || amount == null || isNaN(amount)) {
        skippedTransactions.push({
          row: rowIndex,
          reason: 'Missing required field(s): ' +
            [!date ? 'date' : '', !description ? 'description' : '', (amount == null || isNaN(amount)) ? 'amount' : ''].filter(Boolean).join(', '),
          txn
        });
        return;
      }

      if (externalId && existingExternalIdSet.has(externalId)) {
        skippedTransactions.push({ row: rowIndex, reason: 'Duplicate (externalId already exists)', txn });
        return;
      }

      rowsToInsert.push({
        company_id:      req.user.companyId,
        bank_account_id: bankAccountId,
        date,
        description,
        amount,
        balance:      balance != null ? balance : null,
        reference:    reference || null,
        external_id:  externalId || null,
        status:       'unmatched',
        import_source: resolvedSource
      });
    });

    // ── 3. Bulk insert — ONE round-trip for all valid rows ────────────────────
    let importedTransactions = [];
    if (rowsToInsert.length > 0) {
      let { data: inserted, error: insertErr } = await supabase
        .from('bank_transactions')
        .insert(rowsToInsert)
        .select();

      // Fallback: import_source column missing on older deployments
      if (insertErr && insertErr.message && insertErr.message.includes('import_source')) {
        console.warn('[bank/import] import_source column missing — retrying without it.');
        const rowsWithoutSource = rowsToInsert.map(({ import_source, ...rest }) => rest);
        ({ data: inserted, error: insertErr } = await supabase
          .from('bank_transactions')
          .insert(rowsWithoutSource)
          .select());
      }

      if (insertErr) {
        console.error('[bank/import] Bulk insert error:', insertErr);
        return res.status(500).json({ error: 'Failed to insert transactions: ' + insertErr.message });
      }

      importedTransactions = inserted || [];
    }

    await AuditLogger.logUserAction(
      req,
      'IMPORT',
      'BANK_TRANSACTIONS',
      bankAccountId,
      null,
      { count: importedTransactions.length, skipped: skippedTransactions.length },
      'Bank transactions imported'
    );

    let message = 'Bank transactions imported successfully.';
    if (skippedTransactions.length > 0) {
      message += ` ${skippedTransactions.length} row(s) skipped.`;
    }

    res.status(201).json({
      message,
      imported: importedTransactions.length,
      transactions: importedTransactions,
      skipped: skippedTransactions
    });

  } catch (error) {
    console.error('Error importing bank transactions:', error);
    res.status(500).json({ error: 'Failed to import bank transactions' });
  }
});

/**
 * POST /api/bank/import/pdf
 * Parse a PDF bank statement and return structured transactions for review.
 * Does NOT write to the database — user must confirm via POST /api/bank/import.
 *
 * Request: multipart/form-data
 *   file         — PDF bank statement
 *   bankAccountId — (form field, optional) for duplicate detection
 *
 * Response 200:
 *   { success, bank, parserId, parserConfidence, isGenericFallback,
 *     accountNumber, statementPeriod, transactions, duplicateCount,
 *     warnings, skippedLines }
 */
router.post('/import/pdf',
  authenticate,
  hasPermission('bank.import'),
  pdfUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No PDF file uploaded' });
      }

      const bankAccountId = req.body.bankAccountId
        ? parseInt(req.body.bankAccountId, 10)
        : null;

      // If bankAccountId provided, verify it belongs to this company before
      // using it for duplicate detection queries
      let verifiedBankAccountId = null;
      if (bankAccountId) {
        const { data: check } = await supabase
          .from('bank_accounts')
          .select('id')
          .eq('id', bankAccountId)
          .eq('company_id', req.user.companyId)
          .single();

        if (check) verifiedBankAccountId = bankAccountId;
      }

      // Pass dbClient: null — PDF parsing doesn't require db for initial parse step.
      // Duplicate detection is handled at the confirm (POST /import) stage.
      const result = await PdfStatementImportService.parsePdf(
        req.file.buffer,
        req.file.originalname,
        { dbClient: null, bankAccountId: verifiedBankAccountId }
      );

      if (!result.success) {
        return res.status(422).json({
          error: result.error,
          isPdfScanned: result.isPdfScanned,
          warnings: result.warnings
        });
      }

      await AuditLogger.logUserAction(
        req,
        'PARSE',
        'PDF_STATEMENT',
        verifiedBankAccountId,
        null,
        {
          filename: req.file.originalname,
          bank: result.bank,
          parserId: result.parserId,
          confidence: result.parserConfidence,
          transactionCount: result.transactions.length
        },
        'PDF bank statement parsed for review'
      );

      // ── Account detection: match extracted accountNumber against bank_accounts ──
      // Helps the frontend pre-select or propose the correct bank account.
      // Does NOT block the response — account matching failure is surfaced as
      // accountMatch.found = false, not as an error.
      let accountMatch = {
        found:    false,
        extracted: {
          accountNumber: result.accountNumber || null,
          bank:          result.bank || null,
        },
      };

      if (result.accountNumber) {
        // Extract digits only, then take the last 4 for masked-account matching.
        // e.g., "1234567890" → "7890"; "****1234" → "1234"
        const digitsOnly = result.accountNumber.replace(/\D/g, '');
        const lastFour   = digitsOnly.slice(-4);

        if (lastFour.length === 4) {
          const { data: matched } = await supabase
            .from('bank_accounts')
            .select('id, name, bank_name, account_number_masked')
            .eq('company_id', req.user.companyId)
            .eq('is_active', true)
            .ilike('account_number_masked', `%${lastFour}`);

          if (matched && matched.length === 1) {
            accountMatch = {
              found:              true,
              bankAccountId:      matched[0].id,
              bankAccountName:    matched[0].name,
              bankName:           matched[0].bank_name,
              accountNumberMasked: matched[0].account_number_masked,
              extracted:          accountMatch.extracted,
            };
          } else if (matched && matched.length > 1) {
            accountMatch = {
              found:          false,
              multipleMatches: true,
              candidates:     matched,
              extracted:      accountMatch.extracted,
            };
          }
          // If matched.length === 0: accountMatch stays found=false with extracted details
          // Frontend should offer to create a new bank account with these details
        }
      }

      return res.json({ ...result, accountMatch });

    } catch (err) {
      console.error('PDF import error:', err);
      // Multer file-type error
      if (err.message && err.message.includes('Only PDF files')) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: 'Failed to process PDF statement' });
    }
  }
);

/**
 * POST /api/bank/import/image
 * OCR a bank statement photo/image and return structured transactions for review.
 * Does NOT write to the database — result is returned to the frontend for
 * user review and optional CSV export only.
 *
 * Request: multipart/form-data
 *   file   — Image file (JPG, JPEG, PNG, WEBP), max 15 MB
 *
 * Response 200:
 *   { success, isImageOcr, bank, parserId, parserConfidence, isGenericFallback,
 *     isLowQuality, accountNumber, statementPeriod, transactions, warnings, skippedLines }
 *
 * Response 422:
 *   { error, isLowQuality, warnings }  — when OCR produced insufficient text
 *
 * Response 400:
 *   { error }  — bad file type or missing file
 *
 * Response 503:
 *   { error }  — OCR service unavailable (tesseract not installed)
 */
router.post('/import/image',
  authenticate,
  hasPermission('bank.import'),
  imageUpload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No image file uploaded' });
      }

      // Secondary validation (belt-and-suspenders beyond multer fileFilter)
      if (!ImageStatementImportService.isAllowedFile(req.file.mimetype, req.file.originalname)) {
        return res.status(400).json({
          error: 'Unsupported file type. Please upload a JPG, PNG, or WEBP image.'
        });
      }

      const result = await ImageStatementImportService.parseImage(
        req.file.buffer,
        req.file.originalname
      );

      if (!result.success) {
        const status = result.error && result.error.includes('not available') ? 503 : 422;
        return res.status(status).json({
          error: result.error,
          isLowQuality: result.isLowQuality || false,
          warnings: result.warnings || []
        });
      }

      await AuditLogger.logUserAction(
        req,
        'PARSE',
        'IMAGE_STATEMENT',
        null,
        null,
        {
          filename: req.file.originalname,
          bank: result.bank,
          parserId: result.parserId,
          confidence: result.parserConfidence,
          transactionCount: result.transactions.length,
          warnings: result.warnings
        },
        'Image bank statement parsed for review via OCR'
      );

      return res.json(result);

    } catch (err) {
      console.error('[image import] Error:', err);
      if (err.message && err.message.includes('Only image files')) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: 'Failed to process image statement' });
    }
  }
);

/**
 * POST /api/bank/transactions
 * Create a single manual bank transaction
 */
router.post('/transactions', authenticate, hasPermission('bank.manage'), async (req, res) => {
  try {
    const { bankAccountId, date, description, reference, amount, balance } = req.body;

    if (!bankAccountId) return res.status(400).json({ error: 'bankAccountId is required' });
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'description is required' });
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) return res.status(400).json({ error: 'amount must be a valid number' });

    // Verify bank account belongs to this company
    const { data: accountCheck } = await supabase
      .from('bank_accounts')
      .select('id')
      .eq('id', bankAccountId)
      .eq('company_id', req.user.companyId)
      .single();

    if (!accountCheck) {
      return res.status(404).json({ error: 'Bank account not found or does not belong to this company' });
    }

    const { data: row, error } = await supabase
      .from('bank_transactions')
      .insert({
        company_id: req.user.companyId,
        bank_account_id: bankAccountId,
        date,
        description: description.trim(),
        amount: parsedAmount,
        balance: balance != null ? parseFloat(balance) : null,
        reference: reference || null,
        status: 'unmatched',
        import_source: 'manual'
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await AuditLogger.logUserAction(
      req, 'CREATE', 'BANK_TRANSACTION', row.id,
      null, { description: description.trim(), amount: parsedAmount },
      'Manual bank transaction created'
    );

    res.status(201).json({ transaction: row });

  } catch (error) {
    console.error('Error creating bank transaction:', error);
    res.status(500).json({ error: 'Failed to create bank transaction' });
  }
});

/**
 * PATCH /api/bank/transactions/:id/flip
 * Flip the sign of an unmatched transaction (money in ↔ money out).
 * Used to correct import errors where debit/credit direction was wrong.
 */
router.patch('/transactions/:id/flip', authenticate, hasPermission('bank.manage'), async (req, res) => {
  try {
    const { data: txn, error: fetchErr } = await supabase
      .from('bank_transactions')
      .select('id, amount, status')
      .eq('id', req.params.id)
      .eq('company_id', req.user.companyId)
      .single();

    if (fetchErr || !txn) return res.status(404).json({ error: 'Bank transaction not found' });
    if (txn.status !== 'unmatched') return res.status(409).json({ error: 'Only unmatched transactions can be flipped' });

    const newAmount = -(parseFloat(txn.amount));
    const { error: updErr } = await supabase
      .from('bank_transactions')
      .update({ amount: newAmount })
      .eq('id', txn.id);

    if (updErr) throw new Error(updErr.message);

    await AuditLogger.logUserAction(
      req, 'FLIP', 'BANK_TRANSACTION', txn.id,
      { amount: txn.amount }, { amount: newAmount },
      'Bank transaction amount sign flipped (in ↔ out)'
    );

    res.json({ transaction: { id: txn.id, amount: newAmount } });
  } catch (error) {
    console.error('Error flipping bank transaction:', error);
    res.status(500).json({ error: error.message || 'Failed to flip transaction' });
  }
});

/**
 * Resolve VAT Input (1400) or VAT Output (2300) account for a company.
 * Returns the account row or null if not found.
 */
async function findVatAccount(companyId, code) {
  const { data } = await supabase
    .from('accounts')
    .select('id, code, name')
    .eq('company_id', companyId)
    .eq('code', code)
    .eq('is_active', true)
    .maybeSingle();
  return data || null;
}

/**
 * Post-posting safety guard — re-reads the journal and its lines fresh from the
 * database and verifies that every integrity condition is met before the bank
 * transaction is allowed to move to 'matched'.
 *
 * Called AFTER JournalService.postJournal() succeeds, BEFORE the bank_transaction
 * status update.  If any check fails the caller must reverse the journal and
 * return an error — the bank transaction stays 'unmatched'.
 *
 * Checks:
 *   1. Journal exists with status='posted'
 *   2. Journal company_id matches the allocating company (tenant safety)
 *   3. journal.metadata.bankTransactionId matches the bank transaction id
 *   4. Journal has at least 2 lines
 *   5. Total debits === total credits (within 0.01)
 *   6. At least one line uses the bank ledger account (bank-side line present)
 *   7. At least one line does NOT use the bank ledger account (allocation line present)
 *   8. Bank-side line gross amount matches the bank transaction amount (within 0.01)
 *
 * @returns {{ valid: true }} on success
 * @returns {{ valid: false, reason: string }} on failure
 */
async function _validatePostedAllocationJournal(companyId, journalId, bankTxn, ledgerAccountId) {
  const { data: journal, error: jErr } = await supabase
    .from('journals')
    .select('id, status, company_id, metadata')
    .eq('id', journalId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (jErr || !journal) {
    return { valid: false, reason: `Journal ${journalId} not found after posting (${jErr?.message || 'no row'})` };
  }
  if (journal.status !== 'posted') {
    return { valid: false, reason: `Journal ${journalId} status is '${journal.status}', expected 'posted'` };
  }
  // company_id already filtered in the query above — belt-and-suspenders explicit check
  if (String(journal.company_id) !== String(companyId)) {
    return { valid: false, reason: `Journal ${journalId} company ${journal.company_id} !== allocating company ${companyId}` };
  }
  const meta = journal.metadata || {};
  if (parseInt(meta.bankTransactionId) !== parseInt(bankTxn.id)) {
    return { valid: false, reason: `Journal ${journalId} metadata.bankTransactionId (${meta.bankTransactionId}) !== bank transaction ${bankTxn.id}` };
  }

  const { data: jLines, error: lErr } = await supabase
    .from('journal_lines')
    .select('account_id, debit, credit')
    .eq('journal_id', journalId);

  if (lErr) return { valid: false, reason: `Failed to read journal lines: ${lErr.message}` };
  if (!jLines || jLines.length < 2) {
    return { valid: false, reason: `Journal ${journalId} has ${jLines?.length ?? 0} line(s) — minimum 2 required` };
  }

  const totalDebit  = jLines.reduce((s, l) => s + parseFloat(l.debit  || 0), 0);
  const totalCredit = jLines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return { valid: false, reason: `Journal ${journalId} out of balance: debits=${totalDebit.toFixed(2)}, credits=${totalCredit.toFixed(2)}` };
  }

  const bankLines    = jLines.filter(l => l.account_id === ledgerAccountId);
  const nonBankLines = jLines.filter(l => l.account_id !== ledgerAccountId);
  if (bankLines.length === 0) {
    return { valid: false, reason: `Journal ${journalId} has no line for bank ledger account ${ledgerAccountId}` };
  }
  if (nonBankLines.length === 0) {
    return { valid: false, reason: `Journal ${journalId} has no allocation line (all lines are bank account lines)` };
  }

  // Bank-side gross = sum of whichever side carries the bank amount (debit for money-in, credit for money-out)
  const bankSideGross = bankLines.reduce((s, l) => s + parseFloat(l.debit || 0) + parseFloat(l.credit || 0), 0);
  const expectedGross = Math.abs(parseFloat(bankTxn.amount));
  if (Math.abs(bankSideGross - expectedGross) > 0.01) {
    return { valid: false, reason: `Journal ${journalId} bank-side amount ${bankSideGross.toFixed(2)} !== bank transaction amount ${expectedGross.toFixed(2)}` };
  }

  return { valid: true };
}

/**
 * POST /api/bank/transactions/:id/allocate
 * Allocate bank transaction and atomically post the journal.
 * Journal is always 'posted' on success — no silent draft-only state possible.
 *
 * VAT support (ACCOUNT allocations only):
 *   Each line may include { vatSettingId, vatInclusive }.
 *   When vatSettingId is provided and VAT rate > 0:
 *     - The line amount is treated as VAT-inclusive (gross) by default.
 *     - ex-VAT amount → the user-chosen allocation account
 *     - VAT amount → VAT Input (1400) for payments out, VAT Output (2300) for receipts in
 *   CUSTOMER/SUPPLIER payment lines must NOT carry vatSettingId — they are settling
 *   invoices where VAT is already handled on the invoice side.
 */
router.post('/transactions/:id/allocate', authenticate, hasPermission('bank.allocate'), async (req, res) => {
  try {
    const { lines, description } = req.body;

    if (!lines || !Array.isArray(lines)) {
      return res.status(400).json({ error: 'Lines array is required' });
    }

    // Get bank transaction with linked bank account ledger_account_id
    const { data: bankTxn, error: txnErr } = await supabase
      .from('bank_transactions')
      .select('*, bank_accounts!bank_account_id(ledger_account_id, name)')
      .eq('id', req.params.id)
      .eq('company_id', req.user.companyId)
      .single();

    if (txnErr || !bankTxn) {
      return res.status(404).json({ error: 'Bank transaction not found' });
    }

    if (bankTxn.status !== 'unmatched') {
      return res.status(409).json({ error: 'Transaction already allocated' });
    }

    // Flatten the ledger_account_id from the nested bank_accounts relation
    const ledgerAccountId = bankTxn.bank_accounts?.ledger_account_id;
    const bankAccountName = bankTxn.bank_accounts?.name;

    if (!ledgerAccountId) {
      return res.status(400).json({ error: 'Bank account has no linked ledger account' });
    }

    // Build journal lines (bank account + user-specified allocations)
    const journalLines = [];
    const isMoneyIn = bankTxn.amount > 0;

    // Bank account line (always the full gross amount)
    journalLines.push({
      accountId:   ledgerAccountId,
      debit:       isMoneyIn ? Math.abs(bankTxn.amount) : 0,
      credit:      isMoneyIn ? 0 : Math.abs(bankTxn.amount),
      description: `Bank: ${bankTxn.description}`
    });

    // Resolve VAT settings for any lines that carry a vatSettingId
    // We do this once outside the loop to avoid N+1 queries per line.
    const vatSettingIds = [...new Set(
      lines.filter(l => l.vatSettingId).map(l => l.vatSettingId)
    )];
    const vatSettingMap = {};
    if (vatSettingIds.length > 0) {
      const { data: vsRows } = await supabase
        .from('vat_settings')
        .select('id, code, name, rate, is_capital')
        .eq('company_id', req.user.companyId)
        .in('id', vatSettingIds);
      (vsRows || []).forEach(vs => { vatSettingMap[vs.id] = vs; });
    }

    // Pre-cache the VAT account once — isMoneyIn is constant per transaction so
    // the required VAT account code (1400 input / 2300 output) never changes
    // across lines. Avoids N sequential DB queries for N VAT-bearing lines.
    let cachedVatAccount = null;
    if (vatSettingIds.length > 0) {
      const vatCode = isMoneyIn ? '2300' : '1400';
      cachedVatAccount = await findVatAccount(req.user.companyId, vatCode);
    }

    // Process each allocation line
    for (const line of lines) {
      const gross = Math.round(Number(line.amount) * 100) / 100;
      const lineDesc = line.description || bankTxn.description;
      const vs = line.vatSettingId ? vatSettingMap[line.vatSettingId] : null;

      if (vs && vs.rate > 0) {
        // VAT-bearing allocation (ACCOUNT type only — not CUSTOMER/SUPPLIER payments)
        // Default: gross amount is VAT-inclusive. Override with vatInclusive: false if ex-VAT.
        const vatInclusive = line.vatInclusive !== false; // default true
        let exVat, vatAmt;

        if (vatInclusive) {
          exVat  = Math.round((gross / (1 + vs.rate / 100)) * 100) / 100;
          vatAmt = Math.round((gross - exVat) * 100) / 100;
        } else {
          exVat  = gross;
          vatAmt = Math.round((gross * vs.rate / 100) * 100) / 100;
        }

        // Allocation account line at ex-VAT amount
        journalLines.push({
          accountId:   line.accountId,
          debit:       isMoneyIn ? 0 : exVat,
          credit:      isMoneyIn ? exVat : 0,
          description: lineDesc
        });

        // VAT account line — Input (1400) for payments out, Output (2300) for receipts in
        const vatAccount = cachedVatAccount;
        if (vatAccount) {
          journalLines.push({
            accountId:   vatAccount.id,
            debit:       isMoneyIn ? 0 : vatAmt,
            credit:      isMoneyIn ? vatAmt : 0,
            description: `VAT — ${vs.name} (${vs.rate}%) on: ${lineDesc}`
          });
        } else {
          // VAT account not found in COA — fall back to posting full gross to allocation account
          // Log warning so accountant is alerted
          console.warn(
            `[bank.allocate] VAT account ${vatAccountCode} not found for company ${req.user.companyId}. ` +
            `Posting full amount without VAT split. Check Chart of Accounts.`
          );
          // Replace the ex-VAT line with a full-gross line
          journalLines[journalLines.length - 1].debit  = isMoneyIn ? 0 : gross;
          journalLines[journalLines.length - 1].credit = isMoneyIn ? gross : 0;
        }
      } else {
        // No VAT — standard single-line allocation
        journalLines.push({
          accountId:   line.accountId,
          debit:       isMoneyIn ? 0 : gross,
          credit:      isMoneyIn ? gross : 0,
          description: lineDesc
        });
      }
    }

    // Create draft journal (no pg client — uses Supabase directly)
    const journal = await JournalService.createDraftJournal({
      companyId: req.user.companyId,
      date: bankTxn.date,
      reference: bankTxn.reference,
      description: description || `Bank: ${bankTxn.description}`,
      sourceType: 'bank',
      createdByUserId: req.user.id,
      lines: journalLines,
      metadata: { bankTransactionId: bankTxn.id }
    });

    // Post the journal — guarantees journal.status = 'posted' on success.
    await JournalService.postJournal(journal.id, req.user.companyId, req.user.id);

    // ── Post-posting safety validation ───────────────────────────────────────
    // Re-read the journal fresh from the DB and confirm every accounting
    // integrity condition before allowing the bank transaction to be marked
    // 'matched'.  A failed check reverses the journal and surfaces a clear error.
    const validation = await _validatePostedAllocationJournal(
      req.user.companyId, journal.id, bankTxn, ledgerAccountId
    );
    if (!validation.valid) {
      console.error(
        '[bank.allocate] Post-posting validation failed. Journal ID:', journal.id,
        '| Reason:', validation.reason,
        '— Attempting reversal to prevent a dangling GL entry.'
      );
      try {
        await JournalService.reverseJournal(
          journal.id,
          req.user.companyId,
          req.user.id,
          `Auto-reversed: post-posting validation failed — ${validation.reason}`
        );
      } catch (revErr) {
        console.error('[bank.allocate] Reversal also failed. Journal', journal.id,
          'may be dangling in GL. Manual cleanup required.', revErr.message);
      }
      return res.status(500).json({
        error: `Allocation failed post-posting validation: ${validation.reason}. The journal has been reversed.`,
        journalId: journal.id
      });
    }

    // Mark transaction as matched
    const { error: updErr } = await supabase
      .from('bank_transactions')
      .update({
        status: 'matched',
        matched_entity_type: 'JOURNAL',
        matched_entity_id: journal.id,
        matched_by_user_id: req.user.id
      })
      .eq('id', bankTxn.id);

    if (updErr) {
      // Journal is posted but bank transaction linkage update failed.
      // This would leave a dangling posted journal in the GL with no bank transaction pointing at it.
      // Attempt to reverse the journal to restore a clean state, then surface a real error to the caller.
      console.error(
        '[bank.allocate] Bank transaction status update failed after journal posted.',
        'Journal ID:', journal.id, '| Bank transaction ID:', bankTxn.id,
        '| Error:', updErr.message,
        '— Attempting journal reversal to prevent dangling GL entry.'
      );
      try {
        await JournalService.reverseJournal(
          journal.id,
          req.user.companyId,
          req.user.id,
          `Auto-reversed: bank transaction ${bankTxn.id} linkage update failed during allocation`
        );
        console.warn('[bank.allocate] Journal', journal.id, 'reversed after bank transaction link failure. Bank transaction remains unmatched.');
      } catch (reverseErr) {
        // Reversal also failed — GL has a dangling posted journal that needs manual cleanup.
        console.error(
          '[bank.allocate] Reversal also failed. Journal ID', journal.id,
          'is posted in GL without a bank transaction link. Manual cleanup required.',
          reverseErr.message
        );
      }
      return res.status(500).json({
        error: 'Allocation failed: the journal was posted but the bank transaction could not be linked. The journal has been reversed. Please try again.',
        journalId: journal.id
      });
    }

    await AuditLogger.logUserAction(
      req,
      'ALLOCATE',
      'BANK_TRANSACTION',
      bankTxn.id,
      { status: 'unmatched' },
      { status: 'matched', journalId: journal.id },
      'Bank transaction allocated to journal'
    );

    // SEAN Bank Learning — fire async event for trusted sources (pdf / api).
    // Untrusted sources (csv / manual) are silently ignored inside recordBankAllocationEvent.
    // Only the first allocation line is recorded (primary account code for the transaction).
    const primaryLine = lines[0];
    if (primaryLine && primaryLine.accountId) {
      // Resolve account code for the learning event (non-blocking — errors are swallowed)
      supabase
        .from('accounts')
        .select('code, name')
        .eq('id', primaryLine.accountId)
        .eq('company_id', req.user.companyId)
        .maybeSingle()
        .then(({ data: acct }) => {
          bankLearning.recordBankAllocationEvent({
            companyId:            req.user.companyId,
            bankTransactionId:    bankTxn.id,
            importSource:         bankTxn.import_source || 'manual',
            bankName:             bankTxn.bank_accounts?.name || null,
            rawDescription:       bankTxn.description,
            allocatedAccountId:   primaryLine.accountId,
            allocatedAccountCode: acct?.code || null,
            allocatedAccountName: acct?.name || null,
            journalId:            journal.id,
            createdByUserId:      req.user.id
          }).catch(err =>
            console.error('[SEAN Bank Learning] recordBankAllocationEvent error:', err.message)
          );
        })
        .catch(() => {}); // non-blocking — never fail the allocation response
    }

    const fullJournal = await JournalService.getJournalWithLines(journal.id, req.user.companyId);

    res.status(201).json({
      message: 'Bank transaction allocated and posted to General Ledger',
      journal: fullJournal
    });

  } catch (error) {
    console.error('Error allocating bank transaction:', error);
    res.status(400).json({ error: error.message || 'Failed to allocate bank transaction' });
  }
});

/**
 * DELETE /api/bank/transactions/:id/allocate  (unallocate)
 * Reverse the posted journal and reset the transaction back to unmatched.
 * Works on both 'matched' and 'reconciled' statuses.
 */
router.delete('/transactions/:id/allocate', authenticate, hasPermission('bank.allocate'), async (req, res) => {
  try {
    const { data: bankTxn, error: txnErr } = await supabase
      .from('bank_transactions')
      .select('id, status, matched_entity_id, description')
      .eq('id', req.params.id)
      .eq('company_id', req.user.companyId)
      .single();

    if (txnErr || !bankTxn) {
      return res.status(404).json({ error: 'Bank transaction not found' });
    }

    if (bankTxn.status === 'unmatched') {
      return res.status(409).json({ error: 'Transaction is not allocated' });
    }

    // VAT period lock guard: block unallocate if linked journal is in a locked VAT period
    if (bankTxn.matched_entity_id) {
      const vatLock = await JournalService.isVatPeriodLocked(bankTxn.matched_entity_id);
      if (vatLock.locked) {
        return res.status(403).json({
          error: `Cannot unallocate this transaction — it is included in locked VAT period ${vatLock.periodKey}. VAT periods that have been locked cannot be changed.`,
        });
      }
    }

    // Reverse the linked journal if one exists
    if (bankTxn.matched_entity_id) {
      try {
        await JournalService.reverseJournal(
          bankTxn.matched_entity_id,
          req.user.companyId,
          req.user.id,
          `Unallocated: ${bankTxn.description}`
        );
      } catch (journalErr) {
        // If journal already reversed or not found, continue — still reset the transaction
        console.warn('Unallocate: journal reverse warning:', journalErr.message);
      }
    }

    // Reset transaction to unmatched
    await supabase
      .from('bank_transactions')
      .update({
        status: 'unmatched',
        matched_entity_type: null,
        matched_entity_id: null,
        matched_by_user_id: null,
        reconciled_at: null
      })
      .eq('id', bankTxn.id);

    await AuditLogger.logUserAction(
      req, 'UNALLOCATE', 'BANK_TRANSACTION', bankTxn.id,
      { status: bankTxn.status, journalId: bankTxn.matched_entity_id },
      { status: 'unmatched' },
      'Bank transaction unallocated'
    );

    res.json({ message: 'Transaction unallocated. Journal reversed.' });
  } catch (error) {
    console.error('Error unallocating bank transaction:', error);
    res.status(500).json({ error: error.message || 'Failed to unallocate bank transaction' });
  }
});

/**
 * POST /api/bank/transactions/:id/unreconcile
 * Move a reconciled transaction back to matched (allows editing allocation).
 */
router.post('/transactions/:id/unreconcile', authenticate, hasPermission('bank.reconcile'), async (req, res) => {
  try {
    const { data: bankTxn, error: txnErr } = await supabase
      .from('bank_transactions')
      .select('id, status')
      .eq('id', req.params.id)
      .eq('company_id', req.user.companyId)
      .single();

    if (txnErr || !bankTxn) {
      return res.status(404).json({ error: 'Bank transaction not found' });
    }

    if (bankTxn.status !== 'reconciled') {
      return res.status(409).json({ error: 'Transaction is not reconciled' });
    }

    await supabase
      .from('bank_transactions')
      .update({ status: 'matched', reconciled_at: null })
      .eq('id', bankTxn.id);

    await AuditLogger.logUserAction(
      req, 'UNRECONCILE', 'BANK_TRANSACTION', bankTxn.id,
      { status: 'reconciled' }, { status: 'matched' },
      'Bank transaction unreconciled'
    );

    res.json({ message: 'Transaction moved back to matched.' });
  } catch (error) {
    console.error('Error unreconciling bank transaction:', error);
    res.status(500).json({ error: error.message || 'Failed to unreconcile' });
  }
});

/**
 * POST /api/bank/reconcile
 * Mark transactions as reconciled
 */
router.post('/reconcile', authenticate, hasPermission('bank.reconcile'), async (req, res) => {
  try {
    const { transactionIds } = req.body;

    if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
      return res.status(400).json({ error: 'Transaction IDs array is required' });
    }

    // ── Step 1: Fetch all requested transactions scoped to this company ──────
    const { data: txns, error: fetchErr } = await supabase
      .from('bank_transactions')
      .select('id, status, matched_entity_id, matched_entity_type, description')
      .in('id', transactionIds)
      .eq('company_id', req.user.companyId);

    if (fetchErr) throw new Error(fetchErr.message);

    const txnMap = {};
    (txns || []).forEach(t => { txnMap[t.id] = t; });

    // ── Step 2: Validate each requested transaction ──────────────────────────
    // A transaction may only be reconciled if:
    //   a) it exists and belongs to this company
    //   b) its status is 'matched'
    //   c) it has a linked journal (matched_entity_id is not null)
    const valid   = [];   // can proceed to journal verification
    const invalid = [];   // rejected with reason — nothing will be reconciled

    for (const txnId of transactionIds) {
      const txn = txnMap[txnId];
      if (!txn) {
        invalid.push({ id: txnId, reason: 'Transaction not found or does not belong to this company' });
        continue;
      }
      if (txn.status !== 'matched') {
        invalid.push({ id: txnId, reason: `Status is '${txn.status}', expected 'matched'` });
        continue;
      }
      if (!txn.matched_entity_id) {
        invalid.push({
          id: txnId,
          reason: 'Transaction has no linked journal (matched_entity_id is missing). Unallocate and reallocate the transaction first.'
        });
        continue;
      }
      valid.push(txn);
    }

    // ── Step 3: Verify all linked journals exist and are posted ──────────────
    // Reconciliation MUST be backed by a real posted journal.
    // A transaction pointing at a missing or unposted journal cannot be reconciled.
    if (valid.length > 0) {
      const journalIds = [...new Set(valid.map(t => t.matched_entity_id))];
      const { data: journals, error: jErr } = await supabase
        .from('journals')
        .select('id, status')
        .in('id', journalIds)
        .eq('company_id', req.user.companyId);

      if (jErr) throw new Error(jErr.message);

      const journalMap = {};
      (journals || []).forEach(j => { journalMap[j.id] = j; });

      const verified = [];
      for (const txn of valid) {
        const j = journalMap[txn.matched_entity_id];
        if (!j) {
          invalid.push({
            id: txn.id,
            reason: `Linked journal (ID ${txn.matched_entity_id}) not found in the GL. ` +
                    `Cannot reconcile without a valid posted journal. Unallocate and reallocate.`
          });
        } else if (j.status !== 'posted') {
          invalid.push({
            id: txn.id,
            reason: `Linked journal (ID ${txn.matched_entity_id}) has status '${j.status}', ` +
                    `not 'posted'. Only transactions backed by a posted journal can be reconciled.`
          });
        } else {
          verified.push(txn);
        }
      }
      valid.length = 0;
      valid.push(...verified);
    }

    // ── Step 4: Reject the entire batch if any transaction cannot be reconciled
    // All-or-nothing: don't partially reconcile. Return the validation errors so
    // the accountant can fix the problem before retrying.
    if (invalid.length > 0) {
      return res.status(422).json({
        error: `${invalid.length} transaction(s) failed validation. No changes were made.`,
        invalidTransactions: invalid,
        validCount: valid.length
      });
    }

    // ── Step 5: Mark all verified transactions as reconciled ─────────────────
    const reconciledAt = new Date().toISOString();
    const succeeded    = [];
    const failed       = [];

    for (const txn of valid) {
      try {
        const { error: updErr } = await supabase
          .from('bank_transactions')
          .update({ status: 'reconciled', reconciled_at: reconciledAt })
          .eq('id', txn.id)
          .eq('company_id', req.user.companyId)
          .eq('status', 'matched');  // double-guard: must still be matched at write time

        if (updErr) {
          failed.push({ id: txn.id, reason: updErr.message });
          console.error('[bank.reconcile] Update failed for txn', txn.id, ':', updErr.message);
        } else {
          succeeded.push(txn.id);
        }
      } catch (itemErr) {
        failed.push({ id: txn.id, reason: itemErr.message });
        console.error('[bank.reconcile] Exception for txn', txn.id, ':', itemErr.message);
      }
    }

    // ── Step 6: Audit log — one entry per successfully reconciled transaction ─
    for (const txnId of succeeded) {
      const txn = txnMap[txnId];
      AuditLogger.logUserAction(
        req,
        'RECONCILE',
        'BANK_TRANSACTION',
        txnId,
        { status: 'matched', journalId: txn?.matched_entity_id },
        { status: 'reconciled', reconciled_at: reconciledAt },
        'Bank transaction reconciled'
      ).catch(err => console.error('[bank.reconcile] Audit log error for txn', txnId, ':', err.message));
    }

    // ── Step 7: Return structured result ─────────────────────────────────────
    if (failed.length > 0 && succeeded.length === 0) {
      return res.status(500).json({
        error: 'All reconciliation updates failed',
        failedTransactions: failed
      });
    }

    if (failed.length > 0) {
      return res.status(207).json({
        message: `${succeeded.length} transaction(s) reconciled. ${failed.length} update(s) failed.`,
        count: succeeded.length,
        reconciledIds: succeeded,
        failedTransactions: failed
      });
    }

    res.json({
      message: `${succeeded.length} transaction(s) reconciled successfully`,
      count: succeeded.length,
      reconciledIds: succeeded
    });

  } catch (error) {
    console.error('Error reconciling transactions:', error);
    res.status(500).json({ error: 'Failed to reconcile transactions' });
  }
});

/**
 * POST /api/bank/transactions/:id/attachments
 * Upload attachment for a bank transaction
 */
router.post('/transactions/:id/attachments', authenticate, hasPermission('bank.manage'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Verify transaction exists and belongs to user's company
    const { data: txnCheck } = await supabase
      .from('bank_transactions')
      .select('id')
      .eq('id', req.params.id)
      .eq('company_id', req.user.companyId)
      .single();

    if (!txnCheck) {
      // Delete uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Bank transaction not found' });
    }

    // Save attachment record
    const { data: attachment, error } = await supabase
      .from('bank_transaction_attachments')
      .insert({
        company_id: req.user.companyId,
        bank_transaction_id: req.params.id,
        filename: req.file.filename,
        original_filename: req.file.originalname,
        file_path: req.file.path,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
        uploaded_by_user_id: req.user.id
      })
      .select()
      .single();

    if (error) {
      // Delete uploaded file if database operation failed
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      throw new Error(error.message);
    }

    await AuditLogger.logUserAction(
      req,
      'UPLOAD',
      'BANK_TRANSACTION_ATTACHMENT',
      attachment.id,
      null,
      { filename: req.file.originalname, transactionId: req.params.id },
      'Attachment uploaded to bank transaction'
    );

    res.status(201).json({
      message: 'Attachment uploaded successfully',
      attachment
    });

  } catch (error) {
    // Delete uploaded file if database operation failed
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error uploading attachment:', error);
    res.status(500).json({ error: error.message || 'Failed to upload attachment' });
  }
});

/**
 * GET /api/bank/transactions/:id/attachments
 * Get all attachments for a bank transaction
 */
router.get('/transactions/:id/attachments', authenticate, hasPermission('bank.view'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bank_transaction_attachments')
      .select('*, users!uploaded_by_user_id(email, first_name, last_name)')
      .eq('bank_transaction_id', req.params.id)
      .eq('company_id', req.user.companyId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    const attachments = (data || []).map(a => ({
      ...a,
      uploaded_by_email: a.users?.email,
      first_name: a.users?.first_name,
      last_name: a.users?.last_name
    }));

    res.json({
      attachments,
      count: attachments.length
    });

  } catch (error) {
    console.error('Error fetching attachments:', error);
    res.status(500).json({ error: 'Failed to fetch attachments' });
  }
});

/**
 * GET /api/bank/attachments/:attachmentId/download
 * Download an attachment
 */
router.get('/attachments/:attachmentId/download', authenticate, hasPermission('bank.view'), async (req, res) => {
  try {
    const { data: attachment, error } = await supabase
      .from('bank_transaction_attachments')
      .select('*')
      .eq('id', req.params.attachmentId)
      .eq('company_id', req.user.companyId)
      .single();

    if (error || !attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    if (!fs.existsSync(attachment.file_path)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    res.download(attachment.file_path, attachment.original_filename);

  } catch (error) {
    console.error('Error downloading attachment:', error);
    res.status(500).json({ error: 'Failed to download attachment' });
  }
});

/**
 * DELETE /api/bank/attachments/:attachmentId
 * Delete an attachment
 */
router.delete('/attachments/:attachmentId', authenticate, hasPermission('bank.manage'), async (req, res) => {
  try {
    const { data: attachment, error: fetchErr } = await supabase
      .from('bank_transaction_attachments')
      .select('*')
      .eq('id', req.params.attachmentId)
      .eq('company_id', req.user.companyId)
      .single();

    if (fetchErr || !attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    // Delete from database
    const { error: deleteErr } = await supabase
      .from('bank_transaction_attachments')
      .delete()
      .eq('id', req.params.attachmentId);

    if (deleteErr) throw new Error(deleteErr.message);

    // Delete file from disk
    if (fs.existsSync(attachment.file_path)) {
      fs.unlinkSync(attachment.file_path);
    }

    await AuditLogger.logUserAction(
      req,
      'DELETE',
      'BANK_TRANSACTION_ATTACHMENT',
      req.params.attachmentId,
      { filename: attachment.original_filename },
      null,
      'Attachment deleted from bank transaction'
    );

    res.json({
      message: 'Attachment deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting attachment:', error);
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
});

/**
 * DELETE /api/bank/transactions/bulk
 * Delete multiple bank transactions in one request.
 * Body: { ids: string[], force?: boolean }
 * MUST be registered before DELETE /transactions/:id so Express doesn't match "bulk" as :id.
 */
router.delete('/transactions/bulk', authenticate, hasPermission('bank.manage'), async (req, res) => {
  const { ids, force } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const companyId = req.user.companyId;

  try {
    const { data: txns, error: fetchErr } = await supabase
      .from('bank_transactions')
      .select('id, status, description, amount, date, matched_entity_id')
      .in('id', ids)
      .eq('company_id', companyId);

    if (fetchErr) throw new Error(fetchErr.message);

    const found    = txns || [];
    const blocked  = [];
    const eligible = [];

    for (const txn of found) {
      if (txn.status === 'reconciled') {
        blocked.push({ id: txn.id, reason: 'reconciled' });
      } else if (txn.status === 'matched' && !force) {
        blocked.push({ id: txn.id, reason: 'allocated', journalRef: txn.matched_entity_id });
      } else {
        eligible.push(txn);
      }
    }

    if (eligible.length === 0) {
      return res.json({ success: true, deleted: 0, blocked });
    }

    const eligibleIds = eligible.map(t => t.id);

    const { data: attachments } = await supabase
      .from('bank_transaction_attachments')
      .select('id, file_path, bank_transaction_id')
      .in('bank_transaction_id', eligibleIds);

    for (const att of (attachments || [])) {
      if (att.file_path && fs.existsSync(att.file_path)) {
        try { fs.unlinkSync(att.file_path); } catch (_) { /* non-fatal */ }
      }
    }

    if ((attachments || []).length > 0) {
      await supabase
        .from('bank_transaction_attachments')
        .delete()
        .in('bank_transaction_id', eligibleIds);
    }

    const { error: deleteErr } = await supabase
      .from('bank_transactions')
      .delete()
      .in('id', eligibleIds)
      .eq('company_id', companyId);

    if (deleteErr) throw new Error(deleteErr.message);

    await AuditLogger.logUserAction(
      req, 'DELETE', 'BANK_TRANSACTION', eligibleIds.join(','),
      { count: eligibleIds.length }, null,
      `Bulk deleted ${eligibleIds.length} bank transaction(s)`
    );

    res.json({ success: true, deleted: eligibleIds.length, blocked });

  } catch (error) {
    console.error('Error bulk-deleting bank transactions:', error);
    res.status(500).json({ error: 'Failed to delete transactions' });
  }
});

/**
 * DELETE /api/bank/transactions/:id
 * Delete a bank transaction.
 * Rules:
 *   - Status 'reconciled'  → always blocked (must reverse reconciliation first)
 *   - Status 'matched'     → blocked unless ?force=1  (leaves journal entry orphaned — caller's responsibility)
 *   - Attachments are deleted from disk and DB before the transaction row is removed.
 */
router.delete('/transactions/:id', authenticate, hasPermission('bank.manage'), async (req, res) => {
  const { id } = req.params;
  const forceDelete = req.query.force === '1';

  try {
    // Fetch and ownership-check the transaction
    const { data: txn, error: fetchErr } = await supabase
      .from('bank_transactions')
      .select('*')
      .eq('id', id)
      .eq('company_id', req.user.companyId)
      .single();

    if (fetchErr || !txn) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (txn.status === 'reconciled') {
      return res.status(403).json({
        error: 'Cannot delete a reconciled transaction. Reverse the reconciliation first.',
        code: 'RECONCILED'
      });
    }

    if (txn.status === 'matched' && !forceDelete) {
      return res.status(409).json({
        error: 'Transaction is allocated to a journal entry. Add ?force=1 to confirm deletion.',
        code: 'ALLOCATED',
        journalRef: txn.matched_entity_id
      });
    }

    // Delete attachments from disk first, then DB
    const { data: attachments } = await supabase
      .from('bank_transaction_attachments')
      .select('*')
      .eq('bank_transaction_id', id);

    for (const att of (attachments || [])) {
      if (att.file_path && fs.existsSync(att.file_path)) {
        try { fs.unlinkSync(att.file_path); } catch (_) { /* non-fatal */ }
      }
    }

    await supabase
      .from('bank_transaction_attachments')
      .delete()
      .eq('bank_transaction_id', id);

    // Delete the transaction
    const { error: deleteErr } = await supabase
      .from('bank_transactions')
      .delete()
      .eq('id', id)
      .eq('company_id', req.user.companyId);

    if (deleteErr) throw new Error(deleteErr.message);

    await AuditLogger.logUserAction(
      req,
      'DELETE',
      'BANK_TRANSACTION',
      id,
      { description: txn.description, amount: txn.amount, status: txn.status, date: txn.date },
      null,
      forceDelete && txn.status === 'matched'
        ? 'Bank transaction force-deleted (was allocated to journal)'
        : 'Bank transaction deleted'
    );

    res.json({ success: true, message: 'Transaction deleted' });

  } catch (error) {
    console.error('Error deleting bank transaction:', error);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

module.exports = router;
