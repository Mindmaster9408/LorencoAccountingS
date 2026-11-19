'use strict';

/**
 * Login identity (username / email) — one rule for the whole ecosystem.
 *
 * Root cause this fixes (2026-11-19): some create paths stored the email exactly as typed
 * ("Leo@…", "Trisha@…") while others lower-cased it, and some lookups matched exactly while
 * others lower-cased first. A mixed-case user then could not be found by forgot-password or
 * "link existing user", and could only log in by typing the exact capitals.
 *
 *   - Writes: always store normalizeLogin(value)  → trimmed + lower-case.
 *   - Reads:  match with loginOrFilter(value)      → finds the user whether the stored value is
 *             lower-case (new / migrated) or still mixed-case (legacy rows).
 *
 * Values are double-quoted for PostgREST so a typed comma or bracket cannot add extra filter
 * conditions to the query.
 */

/** Trimmed, lower-cased login value, or null when empty. */
function normalizeLogin(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase();
  return s || null;
}

/** Quote one value for a PostgREST .or() filter. */
function pgQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * PostgREST .or() filter matching username or email, case-insensitively for both legacy
 * mixed-case rows and normalized rows.
 * @param {string} value              what the person typed
 * @param {string[]} [columns]        defaults to ['username', 'email']
 */
function loginOrFilter(value, columns = ['username', 'email']) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  const variants = [...new Set([raw, raw.toLowerCase()])].filter(Boolean);
  const parts = [];
  for (const c of columns) for (const v of variants) parts.push(`${c}.eq.${pgQuote(v)}`);
  return parts.join(',');
}

module.exports = { normalizeLogin, loginOrFilter, pgQuote };
