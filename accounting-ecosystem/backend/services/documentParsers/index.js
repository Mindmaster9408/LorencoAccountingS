/**
 * ============================================================================
 * Document Parser Registry
 * ============================================================================
 * Extensible registry for document-type-specific parsers.
 *
 * To add a new document type parser:
 *   1. Create backend/services/documentParsers/myParser.js
 *      (must export: PARSER_ID, PARSER_NAME, parse(text))
 *   2. require() it here and add to PARSERS map
 *
 * Parser contract:
 *   parse(text: string) → {
 *     fields:         Object,  // extracted fields (null if not found)
 *     confidence:     Object,  // per-field confidence level
 *     isCipcDocument: boolean, // (or similar recognition flag)
 *   }
 * ============================================================================
 */

'use strict';

const cipcParser = require('./cipcParser');

// Registry: parserId → parser module
const PARSERS = new Map([
  [cipcParser.PARSER_ID, cipcParser],
]);

/**
 * Parse a document using the specified parser or auto-detect.
 *
 * @param {string}  text      - Extracted text from document
 * @param {string}  [parserId] - Specific parser ID; omit for auto-detect
 * @returns {{
 *   parserId:   string,
 *   parserName: string,
 *   recognized: boolean,
 *   fields:     Object,
 *   confidence: Object,
 * }}
 */
function parseDocument(text, parserId = null) {
  // Use specified parser if valid
  if (parserId && PARSERS.has(parserId)) {
    const parser = PARSERS.get(parserId);
    const result = parser.parse(text);
    return {
      parserId:   parser.PARSER_ID,
      parserName: parser.PARSER_NAME,
      recognized: result.isCipcDocument || false,
      fields:     result.fields,
      confidence: result.confidence,
    };
  }

  // Auto-detect: try parsers in registration order, use first that recognizes doc
  for (const [id, parser] of PARSERS) {
    const result = parser.parse(text);
    if (result.isCipcDocument) {
      return {
        parserId:   id,
        parserName: parser.PARSER_NAME,
        recognized: true,
        fields:     result.fields,
        confidence: result.confidence,
      };
    }
  }

  // Fallback: use CIPC parser even if document not recognized (best-effort extraction)
  const fallback = cipcParser.parse(text);
  return {
    parserId:   cipcParser.PARSER_ID,
    parserName: cipcParser.PARSER_NAME,
    recognized: false,
    fields:     fallback.fields,
    confidence: fallback.confidence,
  };
}

/**
 * List available parsers.
 * @returns {{ id: string, name: string }[]}
 */
function listParsers() {
  return [...PARSERS.values()].map(p => ({ id: p.PARSER_ID, name: p.PARSER_NAME }));
}

module.exports = { parseDocument, listParsers, PARSERS };
