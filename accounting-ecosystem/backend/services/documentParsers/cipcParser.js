/**
 * ============================================================================
 * CIPC / South African Company Registration Document Parser
 * ============================================================================
 * Extracts structured company information from:
 *   - CIPC CoR14.3 (new registration certificate)
 *   - CIPC CoR15.1 (annual returns)
 *   - CK1 / CK2 (close corporation documents)
 *   - General SA company registration proof documents
 *
 * Returns structured fields with per-field confidence levels.
 * Fields that cannot be extracted with confidence are returned as null.
 * Never invents data — only returns what is clearly present in the text.
 * ============================================================================
 */

'use strict';

const PARSER_ID   = 'cipc';
const PARSER_NAME = 'CIPC / SA Company Registration';

// ── Regex patterns ──────────────────────────────────────────────────────────

// SA registration number: YYYY/NNNNNN/NN  e.g. 2022/123456/07
const RE_REG_NUMBER = /\b(\d{4}\/\d{6}\/\d{2})\b/g;

// Company name — labeled field variants
const RE_COMPANY_NAME = [
  /enterprise\s+name\s*[:\-]\s*([^\n\r]+)/i,
  /(?:name\s+of\s+company|company\s+name)\s*[:\-]\s*([^\n\r]+)/i,
  /(?:registered\s+name)\s*[:\-]\s*([^\n\r]+)/i,
  // plain "Name:" only when at start of line (avoid false matches)
  /^name\s*[:\-]\s*([^\n\r]+)/im,
];

// Registration date
const RE_DATE = [
  /(?:date\s+of\s+(?:registration|incorporation|conversion))\s*[:\-]\s*(\d{1,2}[\s\/\-][A-Za-z]+[\s\/\-]\d{4})/i,
  /(?:date\s+of\s+(?:registration|incorporation|conversion))\s*[:\-]\s*(\d{4}[\-\/]\d{2}[\-\/]\d{2})/i,
  /(?:date\s+of\s+(?:registration|incorporation|conversion))\s*[:\-]\s*(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{4})/i,
  /(?:registered\s+on|incorporation\s+date)\s*[:\-]\s*(\d{1,2}[\s\/\-][A-Za-z]+[\s\/\-]\d{4})/i,
  /(?:registered\s+on|incorporation\s+date)\s*[:\-]\s*(\d{4}[\-\/]\d{2}[\-\/]\d{2})/i,
];

// Company type — labeled field or inferred from entity type section
const RE_COMPANY_TYPE = [
  /type\s+of\s+(?:company|enterprise|close\s+corporation)\s*[:\-]\s*([^\n\r]+)/i,
  /entity\s+type\s*[:\-]\s*([^\n\r]+)/i,
  /company\s+type\s*[:\-]\s*([^\n\r]+)/i,
  /nature\s+of\s+entity\s*[:\-]\s*([^\n\r]+)/i,
];

// Registered/physical address
const RE_ADDRESS = [
  /registered\s+(?:office|address)\s*[:\-]\s*([^\n\r]+(?:[\n\r][^\n\r]{5,80}){0,3})/i,
  /physical\s+address\s*[:\-]\s*([^\n\r]+(?:[\n\r][^\n\r]{5,80}){0,3})/i,
  /place\s+of\s+business\s*[:\-]\s*([^\n\r]+(?:[\n\r][^\n\r]{5,80}){0,3})/i,
];

// Director/member/officer names — multiple formats
const RE_DIRECTOR_BLOCK = [
  // "Director 1:" or "Member 1:" etc.
  /(?:director|member|officer)\s*\d+\s*[:\-]\s*([A-Z][A-Za-z\s,\.]{3,80})/gi,
  // "DIRECTOR: NAME"
  /\bDIRECTOR\b\s*[:\-]\s*([A-Z][A-Za-z\s,\.]{3,80})/g,
  // "MEMBER:" blocks
  /\bMEMBER\b\s*[:\-]\s*([A-Z][A-Za-z\s,\.]{3,80})/g,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function _firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim().replace(/\s+/g, ' ');
  }
  return null;
}

function _extractRegNumber(text) {
  RE_REG_NUMBER.lastIndex = 0;
  const matches = [...text.matchAll(RE_REG_NUMBER)];
  return matches.length > 0 ? matches[0][1] : null;
}

function _extractDirectors(text) {
  const found = new Set();
  for (const pattern of RE_DIRECTOR_BLOCK) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      // Filter: reasonable name length, doesn't look like a header or address
      if (name.length >= 4 && name.length <= 80 && !/\d{4}/.test(name)) {
        found.add(name);
      }
    }
  }
  return [...found].slice(0, 20); // cap at 20
}

function _normalizeDate(raw) {
  if (!raw) return null;
  try {
    // Handle "15 March 2022", "2022-03-15", "15/03/2022"
    const d = new Date(raw.replace(/[\-\/]/g, ' '));
    if (!isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() <= 2100) {
      return d.toISOString().split('T')[0]; // YYYY-MM-DD
    }
  } catch (_) { /* ignore */ }
  return raw.trim(); // return as-is if unparseable
}

function _inferCompanyType(text, name) {
  const combined = `${text} ${name || ''}`.toLowerCase();
  if (/(proprietary limited|\(pty\)\s*ltd|pty ltd)/i.test(combined)) return 'Private Company (Pty) Ltd';
  if (/\bpublic company\b|(?<!\(proprietary\) )limited(?! liability)/i.test(combined)) return 'Public Company Ltd';
  if (/close corporation|\bcc\b/i.test(combined)) return 'Close Corporation CC';
  if (/non.?profit company|\bnpc\b/i.test(combined)) return 'Non-Profit Company NPC';
  if (/non.?profit organisation|\bnpo\b/i.test(combined)) return 'Non-Profit Organisation NPO';
  if (/\bincorporated\b|\binc\b/i.test(combined)) return 'Incorporated Inc';
  if (/sole proprietor/i.test(combined)) return 'Sole Proprietorship';
  if (/partnership/i.test(combined)) return 'Partnership';
  if (/trust/i.test(combined)) return 'Trust';
  return null;
}

function _isCipcDocument(text) {
  return (
    /cipc/i.test(text) ||
    /companies\s+and\s+intellectual\s+property\s+commission/i.test(text) ||
    /\bCoR\s*\d+/i.test(text) ||
    /\bCK\s*[12]\b/i.test(text) ||
    /registration\s+number\s*[:\-]\s*\d{4}\/\d{6}\/\d{2}/i.test(text)
  );
}

// ── Main parse function ──────────────────────────────────────────────────────

/**
 * Parse CIPC / SA company registration document text.
 *
 * @param {string} text  Raw text extracted from PDF
 * @returns {{
 *   fields: {
 *     company_name:        string|null,
 *     registration_number: string|null,
 *     company_type:        string|null,
 *     registration_date:   string|null,   // ISO YYYY-MM-DD or raw string
 *     address:             string|null,
 *     directors:           string[],
 *   },
 *   confidence: {
 *     company_name:        'high'|'medium'|'low'|'not_found',
 *     registration_number: 'high'|'medium'|'low'|'not_found',
 *     company_type:        'high'|'medium'|'low'|'not_found',
 *     registration_date:   'high'|'medium'|'low'|'not_found',
 *     address:             'high'|'medium'|'low'|'not_found',
 *     directors:           'high'|'medium'|'low'|'not_found',
 *   },
 *   isCipcDocument: boolean,
 * }}
 */
function parse(text) {
  const regNumber    = _extractRegNumber(text);
  const companyNameRaw = _firstMatch(text, RE_COMPANY_NAME);
  const companyTypeRaw = _firstMatch(text, RE_COMPANY_TYPE);
  const regDateRaw   = _firstMatch(text, RE_DATE);
  const addressRaw   = _firstMatch(text, RE_ADDRESS);
  const directors    = _extractDirectors(text);

  // Clean company name — trim whitespace and trailing punctuation
  const companyName = companyNameRaw
    ? companyNameRaw.replace(/[,;\.]+$/, '').trim()
    : null;

  // Infer company type from text/name if labeled field not found
  const companyType = companyTypeRaw
    ? companyTypeRaw.replace(/[,;\.]+$/, '').trim()
    : _inferCompanyType(text, companyName);

  // Normalize address — collapse multi-line to single line
  const address = addressRaw
    ? addressRaw.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean).slice(0, 4).join(', ')
    : null;

  const fields = {
    company_name:        companyName || null,
    registration_number: regNumber   || null,
    company_type:        companyType || null,
    registration_date:   _normalizeDate(regDateRaw) || null,
    address:             address     || null,
    directors:           directors,
  };

  // Confidence assignment
  const confidence = {
    // Reg number has very specific format — if matched, it's high confidence
    registration_number: regNumber
      ? 'high'
      : 'not_found',

    // Name: high if we have a reg number too (document is structured), medium otherwise
    company_name: companyName
      ? (regNumber ? 'high' : 'medium')
      : 'not_found',

    // Type: medium if from label, low if inferred from text
    company_type: companyTypeRaw
      ? 'medium'
      : companyType
        ? 'low'   // inferred from text/name
        : 'not_found',

    // Date: medium if labeled, not_found otherwise
    registration_date: regDateRaw ? 'medium' : 'not_found',

    // Address: medium if labeled, not_found otherwise
    address: address ? 'medium' : 'not_found',

    // Directors: always low — names are hard to extract reliably
    directors: directors.length > 0 ? 'low' : 'not_found',
  };

  return {
    fields,
    confidence,
    isCipcDocument: _isCipcDocument(text),
  };
}

module.exports = { PARSER_ID, PARSER_NAME, parse };
