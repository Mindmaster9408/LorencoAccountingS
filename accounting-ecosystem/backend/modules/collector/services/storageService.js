/**
 * ============================================================================
 * Collector — Storage Service
 * ============================================================================
 * Wraps shared/services/storage.js with this module's bucket/path
 * conventions. Bucket must be created once as PRIVATE in the Supabase
 * dashboard before this works — see BUCKET_NAME below. There is no scenario
 * where a public URL is acceptable for client bank statements/payroll
 * reports; staff view files exclusively via getSignedDownloadUrl() below,
 * minted fresh on each access and never stored.
 * ============================================================================
 */

const crypto = require('crypto');
const { uploadFile, getSignedUrl } = require('../../../shared/services/storage');

const BUCKET_NAME = 'collector-documents';

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildStoragePath({ companyId, clientId, periodId, documentId, sha256, originalFilename }) {
  const ext = (originalFilename && originalFilename.includes('.'))
    ? originalFilename.slice(originalFilename.lastIndexOf('.'))
    : '';
  const shaPrefix = sha256.slice(0, 12);
  return `${companyId}/${clientId}/${periodId}/${documentId}_${shaPrefix}${ext}`;
}

/**
 * Uploads a document buffer for a to-be-created collector_documents row.
 * The caller must already know the document's id (insert the row first with
 * a placeholder storage_path, then call this, then update storage_path) OR
 * pass a pre-generated id — routes/public-portal.js uses the two-step
 * insert-then-update approach so storage_path always encodes the real id.
 */
async function uploadDocument({ companyId, clientId, periodId, documentId, buffer, originalFilename, contentType, sha256: precomputedSha256 }) {
  const sha256 = precomputedSha256 || sha256Hex(buffer);
  const storagePath = buildStoragePath({ companyId, clientId, periodId, documentId, sha256, originalFilename });

  const result = await uploadFile(BUCKET_NAME, storagePath, buffer, contentType);
  if (!result.success) {
    throw new Error(result.error || 'Storage upload failed');
  }

  return { storageBucket: BUCKET_NAME, storagePath, sha256 };
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
  uploadDocument,
  getSignedDownloadUrl,
};
