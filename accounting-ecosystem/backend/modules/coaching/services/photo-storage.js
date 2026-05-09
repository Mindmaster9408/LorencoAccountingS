/**
 * Coaching Module — Client Photo Storage Service (CJS)
 *
 * Stores client profile photos in a private Supabase Storage bucket.
 * Uses the main backend's Supabase service-role client so it bypasses RLS.
 *
 * TENANT ISOLATION:
 *   Every object path is namespaced by coach_id:
 *     coach_{coachId}/client_{clientId}/profile.{ext}
 *   A client from coach A can never access coach B's storage path because
 *   the coach_id comes from the DB record (not user input), and all API routes
 *   enforce requireClientAccess before calling this service.
 *
 * BUCKET SETUP (one-time):
 *   Supabase Dashboard → Storage → New Bucket
 *   Name: client-profile-photos
 *   Private (not public)
 *   No public RLS policies — backend uses service key only.
 *
 * SECURITY:
 *   - Service role key used only server-side; never exposed to the browser.
 *   - All URLs returned are time-limited signed URLs (3 hours).
 *   - Frontend never has direct bucket access.
 */

const { supabase } = require('../../../config/database');

const BUCKET = 'client-profile-photos';

// Signed URL TTL: 3 hours.
// If a user has the dashboard open longer than this, photos will
// show as broken images and the fallback initial letter is shown.
// They will refresh on the next page load or dashboard re-render.
const SIGNED_URL_TTL_SECONDS = 10800;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the storage object path for a client's profile photo.
 * Always scoped to the coach — enforces tenant isolation at the storage layer.
 */
function buildPhotoPath(coachId, clientId, mimeType) {
    const ext = mimeType === 'image/png'  ? 'png'
              : mimeType === 'image/webp' ? 'webp'
              : 'jpg';
    return `coach_${coachId}/client_${clientId}/profile.${ext}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Upload a photo buffer to Supabase Storage.
 * Uses upsert:true so re-uploads overwrite the existing file.
 *
 * @param {number}  coachId    - coach who owns the client (for path namespacing)
 * @param {number}  clientId   - the client the photo belongs to
 * @param {Buffer}  fileBuffer - raw image bytes from multer memoryStorage
 * @param {string}  mimeType   - validated MIME type (image/jpeg|png|webp)
 * @returns {string} the Supabase Storage object path (save this in the DB)
 * @throws  if the storage upload fails
 */
async function uploadPhoto(coachId, clientId, fileBuffer, mimeType) {
    const storagePath = buildPhotoPath(coachId, clientId, mimeType);

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, fileBuffer, {
            contentType: mimeType,
            upsert: true
        });

    if (error) {
        throw new Error(`Storage upload failed: ${error.message}`);
    }

    return storagePath;
}

/**
 * Delete a photo from Supabase Storage.
 * Errors are logged but not thrown — deletion failure must not block DB cleanup.
 *
 * @param {string} storagePath - the path returned by uploadPhoto / stored in DB
 */
async function deletePhoto(storagePath) {
    if (!storagePath) return;

    const { error } = await supabase.storage
        .from(BUCKET)
        .remove([storagePath]);

    if (error) {
        // Non-fatal — the file may have already been deleted externally
        console.warn(`[Photo Storage] Delete warning for "${storagePath}": ${error.message}`);
    }
}

/**
 * Generate a single time-limited signed URL for a storage path.
 *
 * @param {string|null} storagePath
 * @returns {string|null} signed URL, or null if path is empty or generation fails
 */
async function getSignedUrl(storagePath) {
    if (!storagePath) return null;

    const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

    if (error) {
        console.warn(`[Photo Storage] Signed URL error for "${storagePath}": ${error.message}`);
        return null;
    }

    return (data && data.signedUrl) || null;
}

/**
 * Generate signed URLs for multiple storage paths in a single batch request.
 * This is more efficient than calling getSignedUrl() in a loop.
 *
 * @param {string[]} paths - array of storage object paths (nulls/empties are filtered)
 * @returns {Object} map of { storagePath: signedUrl }
 */
async function getSignedUrls(paths) {
    const validPaths = (paths || []).filter(p => p && typeof p === 'string');
    if (!validPaths.length) return {};

    const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls(validPaths, SIGNED_URL_TTL_SECONDS);

    if (error) {
        console.warn(`[Photo Storage] Batch signed URLs error: ${error.message}`);
        return {};
    }

    const map = {};
    (data || []).forEach(item => {
        if (item.signedUrl) map[item.path] = item.signedUrl;
    });
    return map;
}

module.exports = { uploadPhoto, deletePhoto, getSignedUrl, getSignedUrls };
