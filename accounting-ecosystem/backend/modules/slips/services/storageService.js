/**
 * ============================================================================
 * Slips — Storage Service
 * ============================================================================
 * Wraps shared/services/storage.js with this module's bucket/path
 * conventions (same pattern as modules/collector/services/storageService.js).
 *
 * The bucket must be created ONCE as PRIVATE in the Supabase dashboard
 * before uploads work — see BUCKET_NAME. Slips are business documents, so a
 * public URL is never acceptable; files are viewed exclusively through a
 * short-lived signed URL minted fresh on each access and never stored.
 *
 * Paths are generated BEFORE the row is inserted (uuid), so the DB row is
 * written once, complete, and its storage columns never change afterwards
 * (migration 172 makes them immutable).
 * ============================================================================
 */

const crypto = require('crypto');
const { uploadFile, getSignedUrl } = require('../../../shared/services/storage');

const BUCKET_NAME = 'slip-files';

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildStoragePath({ companyId, sha256, originalFilename }) {
  const ext = (originalFilename && originalFilename.includes('.'))
    ? originalFilename.slice(originalFilename.lastIndexOf('.')).toLowerCase()
    : '';
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${companyId}/${yyyy}/${mm}/${crypto.randomUUID()}_${sha256.slice(0, 12)}${ext}`;
}

async function uploadSlipFile({ companyId, buffer, originalFilename, contentType, sha256 }) {
  const storagePath = buildStoragePath({ companyId, sha256, originalFilename });
  const result = await uploadFile(BUCKET_NAME, storagePath, buffer, contentType);
  if (!result.success) {
    throw new Error(result.error || 'Storage upload failed');
  }
  return { storageBucket: BUCKET_NAME, storagePath };
}

async function getSignedDownloadUrl(storagePath, expiresInSeconds = 600) {
  const result = await getSignedUrl(BUCKET_NAME, storagePath, expiresInSeconds);
  if (!result.success) {
    throw new Error(result.error || 'Failed to generate signed URL');
  }
  return result.url;
}

module.exports = {
  BUCKET_NAME,
  sha256Hex,
  uploadSlipFile,
  getSignedDownloadUrl,
};
