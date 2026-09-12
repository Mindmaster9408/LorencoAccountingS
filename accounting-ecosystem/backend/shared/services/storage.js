/**
 * Storage Service — Supabase Storage
 * ============================================================================
 * First real caller: modules/collector (2026-09-12) — client-uploaded source
 * documents (bank statements, payroll reports) via a public, no-login upload
 * link. Given that sensitivity, getFileUrl()'s old getPublicUrl() behavior is
 * NOT safe for any bucket holding business documents — always use
 * getSignedUrl() with a short TTL for anything beyond a bucket you have
 * deliberately made public. getFileUrl() is kept only for whatever bucket
 * genuinely wants a permanent public URL (there is no such caller today).
 */

const { supabase } = require('../../config/database');

async function uploadFile(bucket, filePath, file, contentType = 'application/pdf') {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filePath, file, { contentType });

    if (error) throw error;
    return { success: true, path: data.path };
  } catch (err) {
    console.error('Upload error:', err.message);
    return { success: false, error: err.message };
  }
}

// Only safe for buckets that are deliberately public. Do not use for any
// bucket holding client business documents — use getSignedUrl() instead.
async function getFileUrl(bucket, filePath) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data?.publicUrl || null;
}

/**
 * Mint a short-lived signed URL for a private bucket. Never store the
 * returned URL — generate a fresh one on each access.
 */
async function getSignedUrl(bucket, filePath, expiresInSeconds = 600) {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUrl(filePath, expiresInSeconds);
    if (error) throw error;
    return { success: true, url: data.signedUrl };
  } catch (err) {
    console.error('Signed URL error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { uploadFile, getFileUrl, getSignedUrl };
