/**
 * ============================================================================
 * Slips — capture + archive routes (authenticated)
 * ============================================================================
 * Mounted at /api/slips (see ../index.js and server.js).
 *
 *   GET    /                list/search this company's slips
 *   POST   /upload          upload ONE file (multipart field "file") + optional details
 *   GET    /:id             one slip
 *   PATCH  /:id             edit details (date, amount, supplier, category, note)
 *   GET    /:id/file        short-lived signed URL for the stored original
 *   POST   /:id/hide        soft hide (the app's "delete") — reversible
 *   POST   /:id/restore     undo a hide
 *
 * Rules (concept doc: docs/future-build/SLIP_CAPTURE_APP_CONCEPT.md):
 *   - Every query is company-scoped via req.companyId from the JWT.
 *   - The stored original is never replaced or removed here. Migration 172
 *     enforces this in the DB too (immutable columns, no delete before
 *     retain_until).
 *   - retain_until = 7 years after the LATER of upload date and slip date,
 *     and only ever moves later.
 *   - Every write (and every file view) is audit-logged via auditFromReq.
 *   - Nothing here touches the GL. Linking a slip to a Leo transaction is
 *     Phase 2 and will go through an adapter, not direct coupling.
 * ============================================================================
 */

const express = require('express');
const multer = require('multer');
const { supabase } = require('../../../config/database');
const { auditFromReq } = require('../../../middleware/audit');
const { sha256Hex, uploadSlipFile, getSignedDownloadUrl } = require('../services/storageService');

const router = express.Router();

const RETENTION_YEARS = 7;
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
]);
const ALLOWED_EXTENSIONS = /\.(pdf|jpe?g|png|heic|heif|webp)$/i;

// Roles that may hide/restore slips uploaded by someone else. Everyone may
// hide/restore their own uploads.
const MANAGER_ROLES = new Set([
  'super_admin', 'business_owner', 'practice_manager', 'administrator', 'accountant',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const mimeOk = ALLOWED_MIME_TYPES.has(file.mimetype);
    const extOk = ALLOWED_EXTENSIONS.test(file.originalname || '');
    if (mimeOk && extOk) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.originalname}. Allowed: PDF, JPG, PNG, HEIC, WEBP.`));
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function isManager(req) {
  return !!req.user?.isSuperAdmin || MANAGER_ROLES.has(req.user?.role);
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addYears(isoDate, years) {
  const [y, m, d] = isoDate.split('-').map(Number);
  // 29 Feb + 7 years -> 1 Mar (Date rolls over), which only lengthens retention.
  return toIsoDate(new Date(Date.UTC(y + years, m - 1, d)));
}

function computeRetainUntil(uploadIsoDate, slipIsoDate) {
  const base = (slipIsoDate && slipIsoDate > uploadIsoDate) ? slipIsoDate : uploadIsoDate;
  return addYears(base, RETENTION_YEARS);
}

/**
 * Validates the editable detail fields. Only keys present in `body` are
 * returned, so PATCH can update a subset. Empty string clears a field.
 * Returns { values } or { error }.
 */
function parseDetails(body) {
  const values = {};
  const b = body || {};

  if (b.slip_date !== undefined) {
    if (b.slip_date === '' || b.slip_date === null) {
      values.slip_date = null;
    } else {
      const s = String(b.slip_date);
      const d = new Date(s + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d.getTime()) || toIsoDate(d) !== s) {
        return { error: 'slip_date must be a valid date (YYYY-MM-DD).' };
      }
      if (s < '1990-01-01' || s > addYears(toIsoDate(new Date()), 1)) {
        return { error: 'slip_date is out of range.' };
      }
      values.slip_date = s;
    }
  }

  if (b.amount !== undefined) {
    if (b.amount === '' || b.amount === null) {
      values.amount = null;
    } else {
      // Accepts "1234.50", "1 234,50", "1,234.50" and "R 1 234.50".
      let s = String(b.amount).replace(/[\s ]/g, '').replace(/^[^\d\-.,]+/, '');
      s = s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.');
      const n = /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
      if (!Number.isFinite(n) || Math.abs(n) >= 1e12) {
        return { error: 'amount must be a number.' };
      }
      values.amount = Math.round(n * 100) / 100;
    }
  }

  const textFields = { supplier_name: 200, category: 100, note: 2000 };
  for (const [key, max] of Object.entries(textFields)) {
    if (b[key] === undefined) continue;
    const t = b[key] === null ? '' : String(b[key]).trim();
    if (t.length > max) return { error: `${key} must be at most ${max} characters.` };
    values[key] = t || null;
  }

  return { values };
}

async function attachUploaderNames(slips) {
  const ids = [...new Set(slips.map(s => s.uploaded_by_user_id).filter(Boolean))];
  if (!ids.length) return slips;
  const { data: users } = await supabase.from('users').select('id, full_name, username').in('id', ids);
  const byId = new Map((users || []).map(u => [u.id, u.full_name || u.username]));
  return slips.map(s => ({ ...s, uploaded_by_name: byId.get(s.uploaded_by_user_id) || null }));
}

async function loadSlip(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid slip id' });
    return null;
  }
  const { data: slip, error } = await supabase
    .from('slips').select('*')
    .eq('id', id).eq('company_id', req.companyId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return null;
  }
  if (!slip) {
    res.status(404).json({ error: 'Slip not found' });
    return null;
  }
  return slip;
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const status = ['active', 'hidden', 'all'].includes(req.query.status) ? req.query.status : 'active';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let q = supabase
    .from('slips').select('*', { count: 'exact' })
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status !== 'all') q = q.eq('status', status);

  // Strip characters that have meaning inside a PostgREST or() filter.
  const search = String(req.query.q || '').replace(/[,()*%\\:]/g, ' ').trim();
  if (search) {
    const p = `%${search}%`;
    q = q.or(`supplier_name.ilike.${p},note.ilike.${p},category.ilike.${p},original_filename.ilike.${p}`);
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (dateRe.test(req.query.from || '')) q = q.gte('created_at', `${req.query.from}T00:00:00Z`);
  if (dateRe.test(req.query.to || '')) q = q.lte('created_at', `${req.query.to}T23:59:59.999Z`);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ slips: await attachUploaderNames(data || []), total: count || 0, limit, offset });
});

router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 20 MB).' : err.message;
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  const file = req.file;
  if (!file || !file.buffer || !file.buffer.length) {
    return res.status(400).json({ error: 'No file received. Attach the slip as field "file".' });
  }

  const parsed = parseDetails(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const sha256 = sha256Hex(file.buffer);

  // The exact same file (byte for byte) is already stored for this company.
  const { data: existing } = await supabase
    .from('slips').select('id, status, created_at')
    .eq('company_id', req.companyId).eq('sha256', sha256)
    .limit(1);
  if (existing && existing.length) {
    return res.status(409).json({
      error: 'This exact file has already been uploaded.',
      code: 'DUPLICATE_SLIP',
      duplicate_of: existing[0],
    });
  }

  let stored;
  try {
    stored = await uploadSlipFile({
      companyId: req.companyId,
      buffer: file.buffer,
      originalFilename: file.originalname,
      contentType: file.mimetype,
      sha256,
    });
  } catch (err) {
    console.error('[slips] storage upload failed:', err.message);
    return res.status(502).json({ error: 'Could not store the file. Please try again.', detail: err.message });
  }

  const today = toIsoDate(new Date());
  const row = {
    company_id: req.companyId,
    uploaded_by_user_id: req.user?.userId || null,
    original_filename: (file.originalname || '').slice(0, 255) || null,
    content_type: file.mimetype,
    file_size_bytes: file.buffer.length,
    sha256,
    storage_bucket: stored.storageBucket,
    storage_path: stored.storagePath,
    ...parsed.values,
    retain_until: computeRetainUntil(today, parsed.values.slip_date || null),
  };

  const { data: slip, error } = await supabase.from('slips').insert(row).select().single();
  if (error) {
    // The file is in storage but has no row. It is harmless (private bucket,
    // unreferenced) but logged so it can be found and cleaned up.
    console.error('[slips] insert failed AFTER storage upload — orphan file:', stored.storagePath, error.message);
    return res.status(500).json({ error: 'Could not save the slip record. Please try again.' });
  }

  await auditFromReq(req, 'CREATE', 'slip', slip.id, {
    module: 'slips',
    metadata: { sha256, file_size_bytes: row.file_size_bytes, content_type: row.content_type },
  });

  const [withName] = await attachUploaderNames([slip]);
  res.status(201).json({ slip: withName });
});

router.get('/:id', async (req, res) => {
  const slip = await loadSlip(req, res);
  if (!slip) return;
  const [withName] = await attachUploaderNames([slip]);
  res.json({ slip: withName });
});

router.patch('/:id', async (req, res) => {
  const slip = await loadSlip(req, res);
  if (!slip) return;

  const parsed = parseDetails(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const values = parsed.values;
  if (!Object.keys(values).length) return res.status(400).json({ error: 'Nothing to update.' });

  const changes = {};
  for (const [k, v] of Object.entries(values)) {
    const old = slip[k] === null || slip[k] === undefined ? null : (k === 'amount' ? Number(slip[k]) : slip[k]);
    if (old !== v) changes[k] = { old, new: v };
  }
  if (!Object.keys(changes).length) {
    const [withName] = await attachUploaderNames([slip]);
    return res.json({ slip: withName });
  }

  const update = { ...values, updated_at: new Date().toISOString() };
  if (values.slip_date) {
    const candidate = computeRetainUntil(String(slip.created_at).slice(0, 10), values.slip_date);
    if (candidate > slip.retain_until) update.retain_until = candidate;
  }

  const { data: updated, error } = await supabase
    .from('slips').update(update)
    .eq('id', slip.id).eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, 'UPDATE', 'slip', slip.id, { module: 'slips', metadata: { changes } });

  const [withName] = await attachUploaderNames([updated]);
  res.json({ slip: withName });
});

router.get('/:id/file', async (req, res) => {
  const slip = await loadSlip(req, res);
  if (!slip) return;
  try {
    const url = await getSignedDownloadUrl(slip.storage_path, 600);
    await auditFromReq(req, 'VIEW', 'slip', slip.id, { module: 'slips' });
    res.json({ url, content_type: slip.content_type, expires_in_seconds: 600 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function setHidden(req, res, hide) {
  const slip = await loadSlip(req, res);
  if (!slip) return;

  const isOwn = slip.uploaded_by_user_id && slip.uploaded_by_user_id === req.user?.userId;
  if (!isOwn && !isManager(req)) {
    return res.status(403).json({ error: 'You can only change slips you uploaded yourself.' });
  }
  if ((slip.status === 'hidden') === hide) {
    const [withName] = await attachUploaderNames([slip]);
    return res.json({ slip: withName });
  }

  const reason = hide ? (String(req.body?.reason || '').trim().slice(0, 500) || null) : null;
  const now = new Date().toISOString();
  const update = hide
    ? { status: 'hidden', hidden_at: now, hidden_by_user_id: req.user?.userId || null, hidden_reason: reason, updated_at: now }
    : { status: 'active', hidden_at: null, hidden_by_user_id: null, hidden_reason: null, updated_at: now };

  const { data: updated, error } = await supabase
    .from('slips').update(update)
    .eq('id', slip.id).eq('company_id', req.companyId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  await auditFromReq(req, hide ? 'HIDE' : 'RESTORE', 'slip', slip.id, {
    module: 'slips',
    metadata: hide ? { reason } : {},
  });

  const [withName] = await attachUploaderNames([updated]);
  res.json({ slip: withName });
}

router.post('/:id/hide', (req, res) => setHidden(req, res, true));
router.post('/:id/restore', (req, res) => setHidden(req, res, false));

module.exports = router;
module.exports._test = { computeRetainUntil, parseDetails, addYears };
