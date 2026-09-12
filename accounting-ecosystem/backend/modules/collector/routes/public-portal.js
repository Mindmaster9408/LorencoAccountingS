/**
 * ============================================================================
 * Collector — PUBLIC Portal (NO AUTHENTICATION)
 * ============================================================================
 * Mounted in server.js WITHOUT authenticateToken/requireModule — the only
 * gate is a valid upload token. Nothing here may ever trust client-supplied
 * client_id/period_id; both are derived solely from tokenService.validateToken().
 *
 * Every failure mode (bad token, expired, revoked, period closed, client
 * inactive) returns the SAME generic 404 — anti-enumeration, same principle
 * as the password-reset flow in shared/routes/auth.js.
 *
 * Malware scanning is explicitly NOT implemented in v1 (matches this
 * codebase's current posture everywhere else — zero AV scanning exists
 * anywhere today). Validation here is MIME/extension allow-list + size cap,
 * the same baseline every existing upload route in this repo already uses.
 * This is a tracked fast-follow before Collector is ever exposed to a firm
 * other than Lorenco — see the plan file / project_document_collector_agent_concept
 * memory.
 * ============================================================================
 */

const express = require('express');
const multer = require('multer');
const { supabase } = require('../../../config/database');
const { logAudit } = require('../../../middleware/audit');
const { validateToken } = require('../services/tokenService');
const { sha256Hex, uploadDocument } = require('../services/storageService');

const router = express.Router();

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
]);
const ALLOWED_EXTENSIONS = /\.(pdf|jpe?g|png|heic|heif|webp)$/i;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES_PER_REQUEST },
  fileFilter: (req, file, cb) => {
    const mimeOk = ALLOWED_MIME_TYPES.has(file.mimetype);
    const extOk = ALLOWED_EXTENSIONS.test(file.originalname || '');
    if (mimeOk && extOk) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.originalname}. Allowed: PDF, JPG, PNG, HEIC, WEBP.`));
  },
});

const GENERIC_NOT_FOUND = { error: 'This link is invalid or has expired.' };

/**
 * GET /api/collector/public/:token
 * View the outstanding-document checklist for this client/period.
 */
router.get('/:token', async (req, res) => {
  try {
    const ctx = await validateToken(req.params.token);
    if (!ctx) return res.status(404).json(GENERIC_NOT_FOUND);

    const { data: items, error } = await supabase
      .from('collector_period_items')
      .select('id, label, doc_type, is_required, status')
      .eq('period_id', ctx.period.id)
      .order('id');
    if (error) return res.status(500).json({ error: 'Server error' });

    res.json({
      client_name: ctx.client.display_name,
      period_label: ctx.period.period_label,
      items: (items || []).map(i => ({
        id: i.id,
        label: i.label,
        is_required: i.is_required,
        status: i.status,
      })),
    });
  } catch (err) {
    console.error('[collector public] GET /:token error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/collector/public/:token/upload
 * Accepts one or more files against this token's period. client_id/
 * period_id are ALWAYS derived from the validated token, never the request.
 */
router.post('/:token/upload', (req, res, next) => {
  upload.array('files', MAX_FILES_PER_REQUEST)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    const ctx = await validateToken(req.params.token);
    if (!ctx) return res.status(404).json(GENERIC_NOT_FOUND);

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files were uploaded.' });
    }

    const ip = String(req.ip || req.headers['x-forwarded-for'] || '').slice(0, 45) || null;
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 500) || null;

    const results = [];

    for (const file of files) {
      try {
        const sha256 = sha256Hex(file.buffer);

        const { data: dupe } = await supabase
          .from('collector_documents')
          .select('id')
          .eq('period_id', ctx.period.id)
          .eq('sha256_hash', sha256)
          .maybeSingle();

        const initialStatus = dupe ? 'needs_review' : 'uploaded';
        const flagReason = dupe ? 'possible_duplicate' : null;

        // Two-step insert: placeholder storage_path first (NOT NULL column,
        // but the real path needs the row's own id), then upload + update.
        const { data: doc, error: insertErr } = await supabase
          .from('collector_documents')
          .insert({
            company_id: ctx.client.company_id,
            client_id: ctx.client.id,
            period_id: ctx.period.id,
            status: initialStatus,
            flag_reason: flagReason,
            original_filename: file.originalname,
            file_mime_type: file.mimetype,
            file_size_bytes: file.size,
            storage_path: 'pending',
            sha256_hash: sha256,
            uploaded_via_token_id: ctx.tokenRow.id,
            uploaded_ip: ip,
            uploaded_user_agent: userAgent,
          })
          .select()
          .single();
        if (insertErr) throw new Error(insertErr.message);

        const { storageBucket, storagePath } = await uploadDocument({
          companyId: ctx.client.company_id,
          clientId: ctx.client.id,
          periodId: ctx.period.id,
          documentId: doc.id,
          buffer: file.buffer,
          originalFilename: file.originalname,
          contentType: file.mimetype,
          sha256,
        });

        await supabase
          .from('collector_documents')
          .update({ storage_bucket: storageBucket, storage_path: storagePath, updated_at: new Date().toISOString() })
          .eq('id', doc.id);

        results.push({ filename: file.originalname, accepted: true, status: initialStatus, possible_duplicate: !!dupe });
      } catch (fileErr) {
        console.error('[collector public] upload error for', file.originalname, fileErr.message);
        results.push({ filename: file.originalname, accepted: false, error: 'Upload failed. Please try again.' });
      }
    }

    await logAudit({
      companyId: ctx.client.company_id,
      userEmail: 'client_upload',
      module: 'collector',
      actionType: 'UPLOAD',
      entityType: 'collector_document',
      entityId: null,
      ipAddress: ip,
      userAgent,
      metadata: {
        period_id: ctx.period.id,
        client_id: ctx.client.id,
        file_count: files.length,
        via: 'public_token',
      },
    });

    res.json({ results });
  } catch (err) {
    console.error('[collector public] POST /:token/upload error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
