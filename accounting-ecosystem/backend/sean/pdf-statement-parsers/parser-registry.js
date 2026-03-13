/**
 * ============================================================================
 * PDF Statement Parser Registry
 * ============================================================================
 * Central registry of all available bank statement parsers.
 *
 * To add a new bank parser:
 *   1. Create the parser in this directory extending base-parser.js
 *   2. Import it here and add it to PARSERS array
 *   3. No other files need to change
 *
 * Selection logic:
 *   - Each parser's canParse() is called with the extracted PDF text
 *   - The parser with the highest confidence score is selected
 *   - If highest confidence < MIN_CONFIDENCE_THRESHOLD, generic parser is used
 *   - If generic parser also returns very low confidence, an error is returned
 * ============================================================================
 */

const FNBParser = require('./fnb-parser');
const ABSAParser = require('./absa-parser');
const StandardBankParser = require('./standard-bank-parser');
const NedbankParser = require('./nedbank-parser');
const CapitecParser = require('./capitec-parser');
const GenericParser = require('./generic-parser');

// Order matters: specific parsers first, generic last
const PARSERS = [
  FNBParser,
  ABSAParser,
  StandardBankParser,
  NedbankParser,
  CapitecParser,
  GenericParser
];

// Below this threshold, even the best specific parser won't be selected;
// generic parser will be used instead (with a warning).
const SPECIFIC_MIN_CONFIDENCE = 0.4;

class ParserRegistry {

  /**
   * List all registered parsers with their metadata.
   */
  static listParsers() {
    return PARSERS.map(P => ({
      id: P.PARSER_ID,
      bank: P.BANK_NAME,
      isGeneric: P.PARSER_ID === 'generic-v1'
    }));
  }

  /**
   * Select the best parser for the given PDF text.
   *
   * @param {string} text - Full extracted PDF text
   * @returns {{
   *   parser: class,
   *   confidence: number,
   *   allScores: object[],
   *   isGenericFallback: boolean
   * }}
   */
  static selectParser(text) {
    const scores = PARSERS.map(P => ({
      parser: P,
      id: P.PARSER_ID,
      bank: P.BANK_NAME,
      ...P.canParse(text)
    }));

    // Separate specific parsers from generic
    const specificScores = scores.filter(s => s.id !== 'generic-v1');
    const genericScore = scores.find(s => s.id === 'generic-v1');

    // Sort specific parsers by confidence descending
    specificScores.sort((a, b) => b.confidence - a.confidence);

    const best = specificScores[0];

    if (best && best.confidence >= SPECIFIC_MIN_CONFIDENCE) {
      return {
        parser: best.parser,
        confidence: best.confidence,
        bank: best.bank,
        allScores: scores.map(s => ({ id: s.id, bank: s.bank, confidence: s.confidence })),
        isGenericFallback: false
      };
    }

    // Fall back to generic
    return {
      parser: GenericParser,
      confidence: genericScore ? genericScore.confidence : 0.1,
      bank: 'Unknown',
      allScores: scores.map(s => ({ id: s.id, bank: s.bank, confidence: s.confidence })),
      isGenericFallback: true
    };
  }

  /**
   * Get a parser by its ID.
   * @param {string} parserId
   * @returns {class|null}
   */
  static getById(parserId) {
    return PARSERS.find(P => P.PARSER_ID === parserId) || null;
  }
}

module.exports = ParserRegistry;
