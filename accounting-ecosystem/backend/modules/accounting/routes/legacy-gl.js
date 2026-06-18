'use strict';

/**
 * ============================================================================
 * Legacy GL Import Routes (ACC-SIDEQUEST-001)
 * ============================================================================
 * Mounted at /api/accounting/legacy-gl
 *
 * Implements a multi-phase staged import of historical GL data from legacy
 * accounting systems (Sage, Xero, QuickBooks, Pastel, CSV/Excel exports).
 *
 * Phase flow:
 *   Upload → (staged) → Map accounts → Validate → (ready_for_approval)
 *   → Approve → (approved) → Import → (imported)
 *
 * Key architectural constraints:
 *   - NO direct posting from upload — always staged first
 *   - NO live accounting mutation until user explicitly approves + imports
 *   - Imported journals bypass JournalService.isPeriodLocked() (historical data)
 *   - Imported journals bypass JournalService._assertAccountsPostable() (use direct SQL)
 *   - Imported journals are locked (is_locked = true) and linked to their batch
 *   - NO VAT period assignment for imported journals
 *   - NO localStorage — all state in DB
 *
 * Routes:
 *   POST /import                         — upload + parse + stage
 *   GET  /batches                        — list batches
 *   GET  /batches/:id                    — batch detail + counts
 *   GET  /batches/:id/lines              — paginated staged lines
 *   GET  /batches/:id/unmapped           — source accounts needing mapping
 *   GET  /batches/:id/saved-mappings     — saved account mappings for this company
 *   POST /batches/:id/map-account        — save a source→target mapping + apply
 *   POST /batches/:id/validate           — run validation checks
 *   POST /batches/:id/approve            — approve for import
 *   POST /batches/:id/import             — create locked GL journals
 *   POST /batches/:id/cancel             — cancel batch
 * ============================================================================
 */

const express   = require('express');
const router    = express.Router();
const multer    = require('multer');
const XLSX      = require('xlsx');
const crypto    = require('crypto');

const { supabase, db } = require('../../../config/database');
const { authenticate, hasPermission } = require('../middleware/auth');

// ─── Multer: memory storage, 50 MB limit, Excel/CSV only ────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    if (['xlsx', 'xls', 'csv'].includes(ext)) return cb(null, true);
    cb(new Error('Only Excel (.xlsx/.xls) and CSV files are accepted'));
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userId(req) {
  return req.user && req.user.userId ? req.user.userId : (req.user && req.user.id ? req.user.id : null);
}

function companyId(req) {
  return req.user && (req.user.companyId || req.companyId);
}

// Column name patterns for auto-detection (order matters — first match wins)
const COL_PATTERNS = {
  transaction_date:    /^(date|transaction[\s_-]?date|trans[\s_-]?date|posting[\s_-]?date|txn[\s_-]?date|value[\s_-]?date|doc[\s_-]?date|period)$/i,
  source_account_code: /^(account[\s_-]?code|acc[\s_-]?code|account[\s_-]?no\.?|gl[\s_-]?code|account[\s_-]?number|a\/?c[\s_-]?no\.?|ledger[\s_-]?code|code|acct[\s_-]?code|acct[\s_-]?no)$/i,
  source_account_name: /^(account[\s_-]?name|acc[\s_-]?name|gl[\s_-]?account|account[\s_-]?description|ledger[\s_-]?name|ledger|account)$/i,
  source_description:  /^(description|narrative|details?|memo|particulars|posting[\s_-]?text|narration|detail|notes?)$/i,
  source_reference:    /^(reference|ref\.?|document[\s_-]?no\.?|doc[\s_-]?no\.?|cheque[\s_-]?no\.?|invoice[\s_-]?no\.?|inv[\s_-]?no\.?|voucher[\s_-]?no\.?|trans[\s_-]?ref|source[\s_-]?ref|batch|order[\s_-]?no\.?|transaction[\s_-]?id|txn[\s_-]?id)$/i,
  debit:               /^(debit|dr\.?|debit[\s_-]?amount|debit[\s_-]?value|debits?)$/i,
  credit:              /^(credit|cr\.?|credit[\s_-]?amount|credit[\s_-]?value|credits?)$/i,
  amount:              /^(amount|net[\s_-]?amount|value|total[\s_-]?amount|net|balance|signed[\s_-]?amount)$/i,
};

function detectColumns(headerRow) {
  const mapping = {};
  const headers = headerRow
    .map((h, i) => ({ key: String(h || '').trim(), idx: i }))
    .filter(h => h.key);

  for (const [field, pattern] of Object.entries(COL_PATTERNS)) {
    for (const h of headers) {
      if (pattern.test(h.key)) {
        if (mapping[field] === undefined) mapping[field] = h.idx;
        break;
      }
    }
  }

  const hasDate    = mapping.transaction_date    !== undefined;
  const hasAccount = mapping.source_account_code !== undefined || mapping.source_account_name !== undefined;
  const hasAmounts = (mapping.debit !== undefined && mapping.credit !== undefined) || mapping.amount !== undefined;

  return {
    mapping,
    isValid:       hasDate && hasAccount && hasAmounts,
    missingFields: [
      !hasDate    && 'date column (Date / Transaction Date / Posting Date)',
      !hasAccount && 'account column (Account Code / Account Name / GL Code)',
      !hasAmounts && 'amount column(s) (Debit + Credit, or Amount)',
    ].filter(Boolean),
  };
}

function normalizeDate(rawDate) {
  if (rawDate == null || rawDate === '') return null;

  // Already a JS Date (xlsx cellDates:true)
  if (rawDate instanceof Date) {
    if (isNaN(rawDate.getTime())) return null;
    return rawDate.toISOString().slice(0, 10);
  }

  const s = String(rawDate).trim();

  // Excel serial number (5-digit integer)
  if (/^\d{5}$/.test(s)) {
    try {
      const parsed = XLSX.SSF.parse_date_code(parseInt(s, 10));
      if (parsed && parsed.y) {
        return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
      }
    } catch (_) {}
  }

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;

  // DD/MM/YYYY or DD-MM-YYYY (South African / European format — preferred)
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;

  // "01 Jan 2023" or "January 1, 2023"
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);

  return null;
}

function cleanAmount(raw) {
  if (raw == null || raw === '') return 0;
  const s = String(raw).trim().replace(/[^0-9.\-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.abs(n); // always return positive; sign handled by caller
}

function parseRows(dataRows, colMap) {
  const m = colMap.mapping;
  const get = (row, field) => {
    const idx = m[field];
    return idx !== undefined ? String(row[idx] ?? '').trim() : '';
  };

  const lines = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (!row || row.every(cell => cell === '' || cell == null)) continue;

    const rawDate = m.transaction_date !== undefined ? row[m.transaction_date] : null;
    const txDate  = normalizeDate(rawDate);
    if (!txDate) continue; // skip rows with no parseable date

    let debit  = 0;
    let credit = 0;
    if (m.debit !== undefined && m.credit !== undefined) {
      debit  = cleanAmount(row[m.debit]);
      credit = cleanAmount(row[m.credit]);
    } else if (m.amount !== undefined) {
      const raw = String(row[m.amount] ?? '').trim();
      // Strip currency symbols but preserve sign
      const s = raw.replace(/[^0-9.\-]/g, '');
      const n = parseFloat(s);
      if (!isNaN(n)) {
        if (n >= 0) debit  = n;
        else        credit = Math.abs(n);
      }
    }

    // Skip rows that are purely zero (likely blank filler rows)
    if (debit === 0 && credit === 0) continue;

    lines.push({
      source_row_number:   i + 2, // +2: 1-indexed + header row
      transaction_date:    txDate,
      source_account_code: get(row, 'source_account_code') || null,
      source_account_name: get(row, 'source_account_name') || null,
      source_description:  get(row, 'source_description')  || null,
      source_reference:    get(row, 'source_reference')     || null,
      debit,
      credit,
      source_currency: 'ZAR',
      mapping_status:  'unmapped',
      validation_status: 'pending',
    });
  }
  return lines;
}

// Bulk-insert lines in chunks to avoid parametre limits
async function insertLinesBulk(pgClient, batchId, cid, lines) {
  const CHUNK = 500;
  const cols = [
    'batch_id','company_id','source_row_number','transaction_date',
    'source_account_code','source_account_name','source_description','source_reference',
    'debit','credit','source_currency','mapping_status','validation_status',
  ];
  for (let i = 0; i < lines.length; i += CHUNK) {
    const chunk = lines.slice(i, i + CHUNK);
    const vals  = [];
    const params = [];
    let p = 1;
    for (const ln of chunk) {
      vals.push(`(${cols.map(() => `$${p++}`).join(',')})`);
      params.push(
        batchId, cid, ln.source_row_number, ln.transaction_date,
        ln.source_account_code, ln.source_account_name, ln.source_description, ln.source_reference,
        ln.debit, ln.credit, ln.source_currency, ln.mapping_status, ln.validation_status
      );
    }
    await pgClient.query(
      `INSERT INTO legacy_gl_import_lines (${cols.join(',')}) VALUES ${vals.join(',')}`,
      params
    );
  }
}

// Apply saved account mappings to staged lines
async function applySavedMappings(pgClient, batchId, cid) {
  // Single UPDATE joining lines against saved mappings
  await pgClient.query(`
    UPDATE legacy_gl_import_lines ln
    SET
      mapped_account_id = m.mapped_account_id,
      mapping_source    = 'saved',
      mapping_status    = 'mapped'
    FROM legacy_gl_account_mappings m
    WHERE ln.batch_id   = $1
      AND ln.company_id = $2
      AND ln.mapping_status = 'unmapped'
      AND m.company_id  = $2
      AND COALESCE(ln.source_account_code, '') = COALESCE(m.source_account_code, '')
      AND COALESCE(ln.source_account_name, '') = COALESCE(m.source_account_name, '')
  `, [batchId, cid]);
}

async function refreshBatchCounts(pgClient, batchId) {
  await pgClient.query(`
    UPDATE legacy_gl_import_batches b
    SET
      total_lines    = sub.total,
      mapped_lines   = sub.mapped,
      unmapped_lines = sub.unmapped,
      skipped_lines  = sub.skipped,
      total_debits   = sub.t_debit,
      total_credits  = sub.t_credit,
      updated_at     = NOW()
    FROM (
      SELECT
        COUNT(*)                                    AS total,
        COUNT(*) FILTER (WHERE mapping_status = 'mapped')   AS mapped,
        COUNT(*) FILTER (WHERE mapping_status = 'unmapped') AS unmapped,
        COUNT(*) FILTER (WHERE mapping_status = 'skipped')  AS skipped,
        COALESCE(SUM(debit), 0)                    AS t_debit,
        COALESCE(SUM(credit), 0)                   AS t_credit
      FROM legacy_gl_import_lines
      WHERE batch_id = $1
    ) sub
    WHERE b.id = $1
  `, [batchId]);
}

// ─── POST /import — upload, parse, stage ─────────────────────────────────────

router.post('/import', authenticate, hasPermission('legacy_gl.import'),
  upload.single('file'),
  async (req, res) => {
    const cid = parseInt(companyId(req));
    if (!cid) return res.status(400).json({ error: 'Company context required' });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { buffer, originalname } = req.file;
    const sourceSystem  = req.body.source_system  || 'other';
    const periodStart   = req.body.period_start   || null;
    const periodEnd     = req.body.period_end     || null;
    const userNotes     = req.body.notes          || null;

    // Compute file hash for duplicate detection
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Check for duplicate (same file already staged/active for this company)
    const { data: existing } = await supabase
      .from('legacy_gl_import_batches')
      .select('id, status, file_name')
      .eq('company_id', cid)
      .eq('file_hash', fileHash)
      .neq('status', 'cancelled')
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        error:    'This file has already been imported for this company',
        batchId:  existing.id,
        status:   existing.status,
        fileName: existing.file_name,
        message:  'Cancel the existing batch before re-uploading the same file.',
      });
    }

    // Parse file with xlsx (handles both XLSX and CSV)
    let workbook;
    try {
      workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
    } catch (err) {
      return res.status(400).json({ error: `Failed to parse file: ${err.message}` });
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: 'File contains no sheets' });

    const sheet    = workbook.Sheets[sheetName];
    const allRows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

    if (allRows.length < 2) {
      return res.status(400).json({ error: 'File must have at least one header row and one data row' });
    }

    const [headerRow, ...dataRows] = allRows;

    // Auto-detect column mapping
    const colDetection = detectColumns(headerRow);
    if (!colDetection.isValid) {
      return res.status(422).json({
        error:         'Could not auto-detect required columns',
        missingFields: colDetection.missingFields,
        detectedColumns: colDetection.mapping,
        headers:       headerRow.map((h, i) => ({ index: i, name: String(h || '') })),
        hint:          'Rename your spreadsheet headers to match: Date, Account Code (or Account Name), Debit, Credit (or Amount), Description, Reference',
      });
    }

    // Parse rows into normalized line objects
    const lines = parseRows(dataRows, colDetection);
    if (lines.length === 0) {
      return res.status(400).json({ error: 'No data rows could be parsed from the file (all rows may be blank or have no valid date)' });
    }

    // Persist in a transaction: create batch → bulk insert lines → apply saved mappings → refresh counts
    const pgClient = await db.getClient();
    let batchId;
    try {
      await pgClient.query('BEGIN');

      const { rows: [batch] } = await pgClient.query(`
        INSERT INTO legacy_gl_import_batches
          (company_id, file_name, file_hash, source_system,
           import_period_start, import_period_end, notes,
           detected_columns, status, created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staged',$9)
        RETURNING id
      `, [
        cid, originalname, fileHash, sourceSystem,
        periodStart, periodEnd, userNotes,
        JSON.stringify(colDetection.mapping), userId(req)
      ]);

      batchId = batch.id;

      await insertLinesBulk(pgClient, batchId, cid, lines);
      await applySavedMappings(pgClient, batchId, cid);
      await refreshBatchCounts(pgClient, batchId);

      await pgClient.query('COMMIT');
    } catch (err) {
      await pgClient.query('ROLLBACK');
      pgClient.release();
      console.error('[legacy-gl] import staging error', err);
      return res.status(500).json({ error: 'Failed to stage import', detail: err.message });
    }
    pgClient.release();

    // Return summary
    const { data: result } = await supabase
      .from('legacy_gl_import_batches')
      .select('*')
      .eq('id', batchId)
      .single();

    res.status(201).json({
      batch:   result,
      message: `Staged ${result.total_lines} lines. ${result.mapped_lines} auto-mapped using saved mappings. ${result.unmapped_lines} accounts need mapping.`,
    });
  }
);

// ─── GET /batches — list all batches for company ─────────────────────────────

router.get('/batches', authenticate, hasPermission('legacy_gl.view'), async (req, res) => {
  const cid = parseInt(companyId(req));
  if (!cid) return res.status(400).json({ error: 'Company context required' });

  const { data, error } = await supabase
    .from('legacy_gl_import_batches')
    .select('id,file_name,source_system,status,total_lines,mapped_lines,unmapped_lines,total_debits,total_credits,journals_created,created_at,updated_at,imported_at,approved_at')
    .eq('company_id', cid)
    .order('id', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ batches: data || [] });
});

// ─── GET /batches/:id — batch detail ─────────────────────────────────────────

router.get('/batches/:id', authenticate, hasPermission('legacy_gl.view'), async (req, res) => {
  const cid = parseInt(companyId(req));
  const bid = parseInt(req.params.id);

  const { data: batch, error } = await supabase
    .from('legacy_gl_import_batches')
    .select('*')
    .eq('id', bid)
    .eq('company_id', cid)
    .maybeSingle();

  if (error)  return res.status(500).json({ error: error.message });
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  res.json({ batch });
});

// ─── GET /batches/:id/lines — paginated staged lines ─────────────────────────

router.get('/batches/:id/lines', authenticate, hasPermission('legacy_gl.view'), async (req, res) => {
  const cid    = parseInt(companyId(req));
  const bid    = parseInt(req.params.id);
  const page   = Math.max(1, parseInt(req.query.page   || '1'));
  const limit  = Math.min(200, Math.max(10, parseInt(req.query.limit || '100')));
  const offset = (page - 1) * limit;
  const filterStatus = req.query.mapping_status || null;

  // Verify ownership
  const { data: batch } = await supabase
    .from('legacy_gl_import_batches')
    .select('id, total_lines')
    .eq('id', bid)
    .eq('company_id', cid)
    .maybeSingle();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  let query = supabase
    .from('legacy_gl_import_lines')
    .select('id,source_row_number,transaction_date,source_account_code,source_account_name,source_description,source_reference,debit,credit,mapping_status,mapped_account_id,mapping_source,validation_status,validation_notes')
    .eq('batch_id', bid)
    .order('source_row_number', { ascending: true })
    .range(offset, offset + limit - 1);

  if (filterStatus) query = query.eq('mapping_status', filterStatus);

  const { data: lines, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // If mapped, fetch account names
  const mappedIds = [...new Set((lines || []).filter(l => l.mapped_account_id).map(l => l.mapped_account_id))];
  let accountMap = {};
  if (mappedIds.length > 0) {
    const { data: accts } = await supabase.from('accounts').select('id,code,name').in('id', mappedIds);
    (accts || []).forEach(a => { accountMap[a.id] = a; });
  }

  const enriched = (lines || []).map(l => ({
    ...l,
    mapped_account: l.mapped_account_id ? accountMap[l.mapped_account_id] : null,
  }));

  res.json({
    lines:      enriched,
    pagination: { page, limit, offset, total: batch.total_lines },
  });
});

// ─── GET /batches/:id/unmapped — distinct unmapped source accounts ────────────

router.get('/batches/:id/unmapped', authenticate, hasPermission('legacy_gl.view'), async (req, res) => {
  const cid = parseInt(companyId(req));
  const bid = parseInt(req.params.id);

  const { data: batch } = await supabase
    .from('legacy_gl_import_batches')
    .select('id')
    .eq('id', bid)
    .eq('company_id', cid)
    .maybeSingle();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  // Distinct unmapped source accounts with line count
  const pgClient = await db.getClient();
  let rows;
  try {
    const { rows: r } = await pgClient.query(`
      SELECT
        COALESCE(source_account_code, '')  AS source_account_code,
        COALESCE(source_account_name, '')  AS source_account_name,
        COUNT(*)                           AS line_count,
        SUM(debit)                         AS total_debit,
        SUM(credit)                        AS total_credit
      FROM legacy_gl_import_lines
      WHERE batch_id = $1 AND mapping_status = 'unmapped'
      GROUP BY COALESCE(source_account_code,''), COALESCE(source_account_name,'')
      ORDER BY COALESCE(source_account_code,''), COALESCE(source_account_name,'')
    `, [bid]);
    rows = r;
  } finally {
    pgClient.release();
  }

  res.json({ unmappedAccounts: rows });
});

// ─── GET /batches/:id/saved-mappings — company's saved mappings ───────────────

router.get('/batches/:id/saved-mappings', authenticate, hasPermission('legacy_gl.view'), async (req, res) => {
  const cid = parseInt(companyId(req));

  const { data, error } = await supabase
    .from('legacy_gl_account_mappings')
    .select('id,source_account_code,source_account_name,mapped_account_id')
    .eq('company_id', cid)
    .order('source_account_code');

  if (error) return res.status(500).json({ error: error.message });

  const ids = [...new Set((data || []).map(m => m.mapped_account_id))];
  let accountMap = {};
  if (ids.length > 0) {
    const { data: accts } = await supabase.from('accounts').select('id,code,name,account_type').in('id', ids);
    (accts || []).forEach(a => { accountMap[a.id] = a; });
  }

  res.json({
    mappings: (data || []).map(m => ({ ...m, mapped_account: accountMap[m.mapped_account_id] || null })),
  });
});

// ─── POST /batches/:id/map-account — save + apply a source→target mapping ────

router.post('/batches/:id/map-account', authenticate, hasPermission('legacy_gl.import'), async (req, res) => {
  const cid = parseInt(companyId(req));
  const bid = parseInt(req.params.id);
  const { source_account_code, source_account_name, mapped_account_id, skip } = req.body;

  if (!skip && !mapped_account_id) {
    return res.status(400).json({ error: 'mapped_account_id is required (or set skip:true to mark lines as skipped)' });
  }

  // Verify batch ownership
  const { data: batch } = await supabase
    .from('legacy_gl_import_batches')
    .select('id, status')
    .eq('id', bid)
    .eq('company_id', cid)
    .maybeSingle();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (['imported','cancelled'].includes(batch.status)) {
    return res.status(409).json({ error: `Cannot map accounts on a ${batch.status} batch` });
  }

  // Verify target account belongs to this company (tenant safety)
  if (mapped_account_id) {
    const { data: acct } = await supabase
      .from('accounts')
      .select('id, code, name, account_type, is_postable')
      .eq('id', parseInt(mapped_account_id))
      .eq('company_id', cid)
      .maybeSingle();
    if (!acct) return res.status(404).json({ error: 'Target account not found in this company' });
    if (!acct.is_postable) {
      return res.status(422).json({ error: `Account "${acct.code} ${acct.name}" is a header/group account and cannot receive postings` });
    }
  }

  const pgClient = await db.getClient();
  try {
    await pgClient.query('BEGIN');

    if (skip) {
      // Mark matching lines as skipped
      await pgClient.query(`
        UPDATE legacy_gl_import_lines
        SET mapping_status = 'skipped', mapping_source = 'manual', updated_at = NOW()
        WHERE batch_id = $1
          AND mapping_status = 'unmapped'
          AND COALESCE(source_account_code, '') = $2
          AND COALESCE(source_account_name, '') = $3
      `, [bid, source_account_code || '', source_account_name || '']);
    } else {
      // Upsert the saved mapping (for future auto-application to new uploads)
      await pgClient.query(`
        INSERT INTO legacy_gl_account_mappings
          (company_id, source_account_code, source_account_name, mapped_account_id, created_by_user_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (company_id, COALESCE(source_account_code,''), COALESCE(source_account_name,''))
        DO UPDATE SET mapped_account_id = EXCLUDED.mapped_account_id, updated_at = NOW()
      `, [cid, source_account_code || null, source_account_name || null, mapped_account_id, userId(req)]);

      // Apply to all matching unmapped lines in this batch
      await pgClient.query(`
        UPDATE legacy_gl_import_lines
        SET
          mapped_account_id = $1,
          mapping_source    = 'manual',
          mapping_status    = 'mapped',
          updated_at        = NOW()
        WHERE batch_id = $2
          AND mapping_status = 'unmapped'
          AND COALESCE(source_account_code, '') = $3
          AND COALESCE(source_account_name, '') = $4
      `, [mapped_account_id, bid, source_account_code || '', source_account_name || '']);
    }

    await refreshBatchCounts(pgClient, bid);
    await pgClient.query('COMMIT');
  } catch (err) {
    await pgClient.query('ROLLBACK');
    pgClient.release();
    return res.status(500).json({ error: 'Failed to save mapping', detail: err.message });
  }
  pgClient.release();

  const { data: updated } = await supabase
    .from('legacy_gl_import_batches')
    .select('id,total_lines,mapped_lines,unmapped_lines,skipped_lines')
    .eq('id', bid)
    .single();

  res.json({ success: true, batch: updated });
});

// ─── POST /batches/:id/validate — run validation checks ──────────────────────

router.post('/batches/:id/validate', authenticate, hasPermission('legacy_gl.import'), async (req, res) => {
  const cid = parseInt(companyId(req));
  const bid = parseInt(req.params.id);

  const { data: batch } = await supabase
    .from('legacy_gl_import_batches')
    .select('*')
    .eq('id', bid)
    .eq('company_id', cid)
    .maybeSingle();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (['imported','cancelled'].includes(batch.status)) {
    return res.status(409).json({ error: `Cannot validate a ${batch.status} batch` });
  }

  const pgClient = await db.getClient();
  let stats;
  try {
    // Fetch aggregate validation stats
    const { rows: [s] } = await pgClient.query(`
      SELECT
        COUNT(*)                                              AS total,
        COUNT(*) FILTER (WHERE mapping_status = 'unmapped')  AS unmapped,
        COUNT(*) FILTER (WHERE mapping_status = 'skipped')   AS skipped,
        COUNT(*) FILTER (WHERE transaction_date IS NULL)     AS missing_date,
        COUNT(*) FILTER (WHERE debit = 0 AND credit = 0)    AS zero_amount,
        COALESCE(SUM(debit), 0)                             AS total_debit,
        COALESCE(SUM(credit), 0)                            AS total_credit,
        COUNT(DISTINCT transaction_date)                    AS distinct_dates,
        MIN(transaction_date)                               AS min_date,
        MAX(transaction_date)                               AS max_date
      FROM legacy_gl_import_lines
      WHERE batch_id = $1 AND mapping_status <> 'skipped'
    `, [bid]);
    stats = s;
  } finally {
    pgClient.release();
  }

  const totalD   = parseFloat(stats.total_debit  || 0);
  const totalC   = parseFloat(stats.total_credit || 0);
  const diff     = Math.abs(totalD - totalC);
  const balanced = diff < 0.01; // floating point tolerance

  const checks = [
    {
      check:   'all_accounts_mapped',
      label:   'All accounts mapped',
      status:  parseInt(stats.unmapped) === 0 ? 'PASS' : 'FAIL',
      detail:  parseInt(stats.unmapped) === 0
        ? 'All accounts have been mapped to a target GL account'
        : `${stats.unmapped} account line(s) still unmapped — map or skip them before importing`,
    },
    {
      check:   'batch_balanced',
      label:   'Batch debits equal credits',
      status:  balanced ? 'PASS' : 'WARNING',
      detail:  balanced
        ? `Batch balances: Debit ${totalD.toFixed(2)} = Credit ${totalC.toFixed(2)}`
        : `Batch does not balance: Debit ${totalD.toFixed(2)} vs Credit ${totalC.toFixed(2)} (difference: ${diff.toFixed(2)}). Individual journals may still balance if dates+references are consistent.`,
    },
    {
      check:   'no_missing_dates',
      label:   'No missing transaction dates',
      status:  parseInt(stats.missing_date) === 0 ? 'PASS' : 'FAIL',
      detail:  parseInt(stats.missing_date) === 0
        ? 'All rows have valid transaction dates'
        : `${stats.missing_date} row(s) have no parseable date and were excluded from staging`,
    },
    {
      check:   'no_zero_amount_lines',
      label:   'No zero-amount lines',
      status:  parseInt(stats.zero_amount) === 0 ? 'PASS' : 'WARNING',
      detail:  parseInt(stats.zero_amount) === 0
        ? 'No zero-amount lines detected'
        : `${stats.zero_amount} line(s) have zero debit and zero credit — these will create empty journal lines`,
    },
    {
      check:   'date_range',
      label:   'Date range',
      status:  'INFO',
      detail:  `Data spans ${stats.distinct_dates} date(s) from ${stats.min_date} to ${stats.max_date}`,
    },
    {
      check:   'line_count',
      label:   'Line count',
      status:  'INFO',
      detail:  `${stats.total} lines will be imported (${stats.skipped} skipped)`,
    },
  ];

  const hasFail    = checks.some(c => c.status === 'FAIL');
  const hasWarning = checks.some(c => c.status === 'WARNING');
  const newStatus  = hasFail ? 'validation_failed' : 'ready_for_approval';

  // Update per-line validation_status
  const pgClient2 = await db.getClient();
  try {
    await pgClient2.query(`
      UPDATE legacy_gl_import_lines
      SET validation_status = CASE
            WHEN mapping_status = 'unmapped' THEN 'fail'
            WHEN debit = 0 AND credit = 0    THEN 'warning'
            ELSE 'pass'
          END
      WHERE batch_id = $1
    `, [bid]);

    await pgClient2.query(`
      UPDATE legacy_gl_import_batches
      SET
        status             = $1,
        validation_summary = $2,
        total_debits       = $3,
        total_credits      = $4,
        updated_at         = NOW()
      WHERE id = $5
    `, [newStatus, JSON.stringify({ checks, totalDebit: totalD, totalCredit: totalC, balanced }), totalD, totalC, bid]);
  } finally {
    pgClient2.release();
  }

  res.json({
    status:      newStatus,
    hasFail,
    hasWarning,
    checks,
    summary: {
      totalLines:    parseInt(stats.total),
      skippedLines:  parseInt(stats.skipped),
      totalDebit:    totalD,
      totalCredit:   totalC,
      balanced,
      difference:    diff,
      dateRange: { min: stats.min_date, max: stats.max_date },
    },
  });
});

// ─── POST /batches/:id/approve — authorise for import ────────────────────────

router.post('/batches/:id/approve', authenticate, hasPermission('legacy_gl.import'), async (req, res) => {
  const cid = parseInt(companyId(req));
  const bid = parseInt(req.params.id);

  const { data: batch } = await supabase
    .from('legacy_gl_import_batches')
    .select('id, status')
    .eq('id', bid)
    .eq('company_id', cid)
    .maybeSingle();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status !== 'ready_for_approval') {
    return res.status(409).json({
      error:   `Batch cannot be approved — current status is "${batch.status}"`,
      hint:    batch.status === 'validation_failed'
        ? 'Fix validation errors and re-run validation before approving'
        : `Run validation first`,
    });
  }

  const { error } = await supabase
    .from('legacy_gl_import_batches')
    .update({
      status:               'approved',
      approved_by_user_id:  userId(req),
      approved_at:          new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    })
    .eq('id', bid);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, status: 'approved' });
});

// ─── POST /batches/:id/import — create locked GL journals ────────────────────
//
// CRITICAL: This endpoint bypasses JournalService.isPeriodLocked() and
// JournalService._assertAccountsPostable(). It uses direct pg INSERTs so
// historical data can be imported into closed periods without restriction.
// Imported journals are immediately set to status='posted' and is_locked=true.
// NO VAT period assignment — historical data must not affect VAT submissions.

router.post('/batches/:id/import', authenticate, hasPermission('legacy_gl.import'), async (req, res) => {
  const cid = parseInt(companyId(req));
  const bid = parseInt(req.params.id);

  // Verify batch is approved
  const { data: batch } = await supabase
    .from('legacy_gl_import_batches')
    .select('*')
    .eq('id', bid)
    .eq('company_id', cid)
    .maybeSingle();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status !== 'approved') {
    return res.status(409).json({
      error: `Batch cannot be imported — current status is "${batch.status}"`,
      hint:  'Batch must be approved before importing',
    });
  }

  // Mark as importing
  await supabase
    .from('legacy_gl_import_batches')
    .update({ status: 'importing', updated_at: new Date().toISOString() })
    .eq('id', bid);

  // Fetch all mapped, non-skipped lines
  const { data: allLines, error: linesErr } = await supabase
    .from('legacy_gl_import_lines')
    .select('*')
    .eq('batch_id', bid)
    .eq('mapping_status', 'mapped')
    .order('transaction_date,source_reference,source_row_number');

  if (linesErr) {
    await supabase.from('legacy_gl_import_batches').update({ status: 'failed', import_error: linesErr.message }).eq('id', bid);
    return res.status(500).json({ error: linesErr.message });
  }

  if (!allLines || allLines.length === 0) {
    await supabase.from('legacy_gl_import_batches').update({ status: 'failed', import_error: 'No mapped lines to import' }).eq('id', bid);
    return res.status(422).json({ error: 'No mapped lines to import' });
  }

  // Group lines into journal groups by (transaction_date, source_reference)
  const groups = new Map();
  for (const ln of allLines) {
    const key = `${ln.transaction_date}||${ln.source_reference || ''}`;
    if (!groups.has(key)) groups.set(key, { date: ln.transaction_date, reference: ln.source_reference || '', lines: [] });
    groups.get(key).lines.push(ln);
  }

  const pgClient = await db.getClient();
  let journalsCreated = 0;
  const lineIdToJournalId = new Map();

  try {
    await pgClient.query('BEGIN');

    for (const [, grp] of groups) {
      // Build journal description from reference or date
      const description = grp.reference
        ? `Legacy GL Import: ${grp.reference}`
        : `Legacy GL Import: ${grp.date}`;

      // INSERT journal header — bypassing JournalService (no period lock, no VAT period)
      const { rows: [jrn] } = await pgClient.query(`
        INSERT INTO journals
          (company_id, date, reference, description, status, source_type,
           is_locked, legacy_batch_id, created_by_user_id, metadata)
        VALUES ($1, $2, $3, $4, 'posted', 'legacy_gl_import', true, $5, $6, $7)
        RETURNING id
      `, [
        cid,
        grp.date,
        grp.reference || `IMPORT-${bid}`,
        description,
        bid,
        userId(req),
        JSON.stringify({ source: 'legacy_gl_import', batchId: bid, fileName: batch.file_name }),
      ]);

      const journalId = jrn.id;
      journalsCreated++;

      // INSERT journal lines
      const lineVals   = [];
      const lineParams = [];
      let p = 1;
      for (let i = 0; i < grp.lines.length; i++) {
        const ln = grp.lines[i];
        lineVals.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5})`);
        lineParams.push(
          journalId,
          ln.mapped_account_id,
          i + 1,                        // line_number
          ln.source_description || '',
          ln.debit || 0,
          ln.credit || 0
        );
        p += 6;
        lineIdToJournalId.set(ln.id, journalId);
      }

      await pgClient.query(`
        INSERT INTO journal_lines (journal_id, account_id, line_number, description, debit, credit)
        VALUES ${lineVals.join(',')}
      `, lineParams);
    }

    // Back-link lines to their journals (update in chunks)
    const lineIds = [...lineIdToJournalId.keys()];
    for (let i = 0; i < lineIds.length; i += 500) {
      const chunk = lineIds.slice(i, i + 500);
      // Build CASE WHEN for efficiency
      let caseExpr = 'CASE id ';
      const caseParams = [];
      let pp = 1;
      for (const lid of chunk) {
        caseExpr += `WHEN $${pp} THEN $${pp+1} `;
        caseParams.push(lid, lineIdToJournalId.get(lid));
        pp += 2;
      }
      caseExpr += 'END';
      caseParams.push(...chunk);
      const inList = chunk.map((_, ci) => `$${pp + ci}`).join(',');
      await pgClient.query(
        `UPDATE legacy_gl_import_lines SET journal_id = ${caseExpr} WHERE id IN (${inList})`,
        caseParams
      );
    }

    // Finalise batch
    await pgClient.query(`
      UPDATE legacy_gl_import_batches
      SET
        status              = 'imported',
        journals_created    = $1,
        imported_by_user_id = $2,
        imported_at         = NOW(),
        import_error        = NULL,
        updated_at          = NOW()
      WHERE id = $3
    `, [journalsCreated, userId(req), bid]);

    await pgClient.query('COMMIT');
  } catch (err) {
    await pgClient.query('ROLLBACK');
    pgClient.release();
    console.error('[legacy-gl] import error', err);
    await supabase.from('legacy_gl_import_batches').update({
      status:       'failed',
      import_error: err.message,
      updated_at:   new Date().toISOString(),
    }).eq('id', bid);
    return res.status(500).json({ error: 'Import failed', detail: err.message });
  }
  pgClient.release();

  res.json({
    success:         true,
    journalsCreated,
    message:         `Successfully created ${journalsCreated} locked GL journal(s) from ${allLines.length} lines.`,
  });
});

// ─── POST /batches/:id/cancel — cancel a batch ───────────────────────────────

router.post('/batches/:id/cancel', authenticate, hasPermission('legacy_gl.import'), async (req, res) => {
  const cid = parseInt(companyId(req));
  const bid = parseInt(req.params.id);

  const { data: batch } = await supabase
    .from('legacy_gl_import_batches')
    .select('id, status')
    .eq('id', bid)
    .eq('company_id', cid)
    .maybeSingle();
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.status === 'imported') {
    return res.status(409).json({ error: 'Cannot cancel a batch that has already been imported' });
  }
  if (batch.status === 'cancelled') {
    return res.status(409).json({ error: 'Batch is already cancelled' });
  }

  const { error } = await supabase
    .from('legacy_gl_import_batches')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', bid);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, status: 'cancelled' });
});

module.exports = router;
