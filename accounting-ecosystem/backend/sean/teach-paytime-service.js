'use strict';

const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────────────────────────────────────
// TeachPaytimeService
//
// Parses free-form payroll knowledge text into structured Paytime learning
// proposals. Supports three input formats:
//
//   1. CSV:   Item Name, IRP5 Code[, Taxable, UIF, ...]
//   2. Table: Item Name | IRP5 Code | Taxable | UIF
//   3. Bullet/text: natural sentences containing item names and 4-digit codes
//
// GOVERNANCE:
//   - This service is parse-only. It never writes to the database.
//   - The caller (route handler) is responsible for DB writes after user confirmation.
//   - Minimum valid output: item_name is present (irp5_code is optional).
//   - Uncertain fields are null, never guessed.
//
// ─────────────────────────────────────────────────────────────────────────────

// Valid IRP5 code ranges (SARS — not exhaustive but covers common earnings/deductions/UIF/SDL)
const IRP5_RANGES = [
  [3601, 3630], [3651, 3680], [3697, 3799],
  [3801, 3830], [4001, 4030], [4100, 4160],
  [7001, 7010],
];

function isKnownIrp5(code) {
  const n = parseInt(code, 10);
  if (isNaN(n)) return false;
  return IRP5_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

function isValidIrp5Format(code) {
  return /^\d{4,6}$/.test(String(code).trim());
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

function normalizeItemName(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseBool(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'ja'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'nee'].includes(s)) return false;
  return null;
}

function extractIrp5(text) {
  // Find the first 4-6 digit sequence in the text (common IRP5 code pattern)
  const m = String(text).match(/\b(\d{4,6})\b/);
  return m ? m[1] : null;
}

// ─── Format detection ─────────────────────────────────────────────────────────

function detectFormat(lines) {
  const nonEmpty = lines.filter(l => l.trim());
  if (!nonEmpty.length) return 'unknown';
  const firstLine = nonEmpty[0];
  if (firstLine.includes('|')) return 'table';
  if (firstLine.includes(',') && nonEmpty.length > 1) return 'csv';
  return 'bullet';
}

// ─── CSV parser ──────────────────────────────────────────────────────────────

function parseCsvLines(lines) {
  const nonEmpty = lines.filter(l => l.trim());
  if (!nonEmpty.length) return [];

  // Detect header: first line has text like "item name", "irp5", "code" etc.
  const firstLower = nonEmpty[0].toLowerCase();
  const hasHeader = /item|name|irp5|code|description/.test(firstLower);

  // Map column positions from header (if present)
  let colItem = 0, colCode = 1, colTaxable = -1, colUif = -1, colSdl = -1, colNotes = -1;

  if (hasHeader) {
    const cols = nonEmpty[0].split(',').map(c => c.trim().toLowerCase());
    cols.forEach((c, i) => {
      if (/item|name|description/.test(c)) colItem = i;
      if (/irp5|code/.test(c)) colCode = i;
      if (/taxable/.test(c)) colTaxable = i;
      if (/uif/.test(c)) colUif = i;
      if (/sdl/.test(c)) colSdl = i;
      if (/note|remark|comment/.test(c)) colNotes = i;
    });
  }

  const dataLines = hasHeader ? nonEmpty.slice(1) : nonEmpty;
  return dataLines.map(line => {
    const parts = line.split(',');
    const itemName = (parts[colItem] || '').trim();
    const rawCode  = (parts[colCode]  || '').trim();
    const irp5Code = isValidIrp5Format(rawCode) ? rawCode : extractIrp5(rawCode);
    return {
      item_name:  itemName,
      irp5_code:  irp5Code,
      taxable:    colTaxable >= 0 ? parseBool(parts[colTaxable]) : null,
      affects_uif: colUif >= 0 ? parseBool(parts[colUif]) : null,
      affects_sdl: colSdl >= 0 ? parseBool(parts[colSdl]) : null,
      notes:      colNotes >= 0 ? (parts[colNotes] || '').trim() || null : null,
      source_text: line.trim(),
    };
  }).filter(i => i.item_name);
}

// ─── Table parser (pipe-delimited) ───────────────────────────────────────────

function parseTableLines(lines) {
  const nonEmpty = lines.filter(l => l.includes('|'));
  if (!nonEmpty.length) return [];

  const firstLower = nonEmpty[0].toLowerCase();
  const hasHeader  = /item|name|irp5|code/.test(firstLower);

  let colItem = 0, colCode = 1, colTaxable = -1, colUif = -1, colSdl = -1;

  if (hasHeader) {
    const cols = nonEmpty[0].split('|').map(c => c.trim().toLowerCase());
    cols.forEach((c, i) => {
      if (/item|name|description/.test(c)) colItem = i;
      if (/irp5|code/.test(c)) colCode = i;
      if (/taxable/.test(c)) colTaxable = i;
      if (/uif/.test(c)) colUif = i;
      if (/sdl/.test(c)) colSdl = i;
    });
  }

  const dataLines = hasHeader ? nonEmpty.slice(1) : nonEmpty;
  return dataLines.map(line => {
    const parts = line.split('|').map(p => p.trim());
    const itemName = parts[colItem] || '';
    const rawCode  = parts[colCode]  || '';
    const irp5Code = isValidIrp5Format(rawCode) ? rawCode : extractIrp5(rawCode);
    return {
      item_name:  itemName,
      irp5_code:  irp5Code,
      taxable:    colTaxable >= 0 ? parseBool(parts[colTaxable]) : null,
      affects_uif: colUif >= 0 ? parseBool(parts[colUif]) : null,
      affects_sdl: colSdl >= 0 ? parseBool(parts[colSdl]) : null,
      notes:      null,
      source_text: line.trim(),
    };
  }).filter(i => i.item_name);
}

// ─── Bullet/text parser ───────────────────────────────────────────────────────

function parseBulletLines(lines) {
  const items = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Strip leading bullets: -, •, *, numbers
    const stripped = line.replace(/^[-•*\d+\.\)]\s*/, '').trim();
    if (!stripped) continue;

    const irp5Code = extractIrp5(stripped);

    // Extract item name: text before the IRP5 code or parenthetical
    let itemName = stripped
      .replace(/irp5\s*(code)?:?\s*\d{4,6}/i, '')
      .replace(/code:?\s*\d{4,6}/i, '')
      .replace(/\b\d{4,6}\b/, '')
      .replace(/must\s+use\s*/i, '')
      .replace(/and\s+is\s+(taxable|non-taxable|not\s+taxable).*/i, '')
      .replace(/is\s+(taxable|non-taxable|not\s+taxable).*/i, '')
      .replace(/[\(\)\[\]]/g, '')
      .replace(/:\s*$/, '')
      .replace(/[,;.]\s*$/, '')
      .trim();

    // Taxable detection
    const lcStripped = stripped.toLowerCase();
    let taxable = null;
    if (/non.taxable|not\s+taxable/.test(lcStripped)) taxable = false;
    else if (/taxable/.test(lcStripped)) taxable = true;

    // UIF detection
    let affects_uif = null;
    if (/uif/.test(lcStripped)) {
      affects_uif = !/no\s+uif|not\s+.*uif|uif\s+exempt/.test(lcStripped);
    }

    if (!itemName) continue;

    items.push({
      item_name:  itemName,
      irp5_code:  irp5Code,
      taxable,
      affects_uif,
      affects_sdl: null,
      notes:      null,
      source_text: line,
    });
  }

  return items;
}

// ─── Main: TeachPaytimeService ────────────────────────────────────────────────

class TeachPaytimeService {

  /**
   * Parse raw text and return structured Paytime learning items.
   * No database writes — pure parsing only.
   *
   * @param {string} rawText   — user-pasted knowledge text
   * @returns {{
   *   success: boolean,
   *   format: string,
   *   importBatchId: string,
   *   items: Array,
   *   warnings: string[],
   *   duplicatesInBatch: number,
   *   skippedCount: number
   * }}
   */
  static parseInput(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
      return { success: false, error: 'No text provided. Paste payroll item knowledge to parse.' };
    }

    const lines   = text.split(/\r?\n/);
    const format  = detectFormat(lines);
    const warnings = [];

    let rawItems = [];
    if (format === 'csv')    rawItems = parseCsvLines(lines);
    else if (format === 'table') rawItems = parseTableLines(lines);
    else                         rawItems = parseBulletLines(lines);

    if (!rawItems.length) {
      return {
        success: false,
        error: 'No payroll items could be extracted. Check the format or try a different layout.',
      };
    }

    let skippedCount = 0;
    const importBatchId = uuidv4();
    const seenKeys = new Map(); // normalized key → first index, for intra-batch dedup

    const items = rawItems.map((raw, idx) => {
      const item_name       = raw.item_name.trim();
      const item_name_norm  = normalizeItemName(item_name);
      const irp5_code       = raw.irp5_code ? String(raw.irp5_code).trim() : null;

      // Skip if no name
      if (!item_name) { skippedCount++; return null; }

      // Confidence scoring
      let confidence = 0.50; // base: name only
      const itemWarnings = [];

      if (irp5_code) {
        if (isKnownIrp5(irp5_code)) {
          confidence = format === 'csv' ? 0.95 : (format === 'table' ? 0.90 : 0.82);
        } else if (isValidIrp5Format(irp5_code)) {
          confidence = format === 'csv' ? 0.75 : (format === 'table' ? 0.72 : 0.65);
          itemWarnings.push(`IRP5 code ${irp5_code} is not in the standard SARS range — verify before approving.`);
        }
      } else {
        itemWarnings.push('No IRP5 code found — proposal can be saved as draft and completed later.');
      }

      // Intra-batch duplicate check
      const batchKey = `${item_name_norm}|${irp5_code || ''}`;
      let isDuplicate = false;
      if (seenKeys.has(batchKey)) {
        isDuplicate = true;
        itemWarnings.push(`Duplicate of row ${seenKeys.get(batchKey) + 1} in this batch.`);
      } else {
        seenKeys.set(batchKey, idx);
      }

      return {
        item_name,
        item_name_normalized: item_name_norm,
        irp5_code,
        taxable:     raw.taxable,
        affects_uif: raw.affects_uif,
        affects_sdl: raw.affects_sdl,
        notes:       raw.notes,
        source_text: raw.source_text,
        confidence:  Math.round(confidence * 100) / 100,
        isDuplicate,
        warnings:    itemWarnings,
      };
    }).filter(Boolean);

    const duplicatesInBatch = items.filter(i => i.isDuplicate).length;

    if (duplicatesInBatch > 0) {
      warnings.push(`${duplicatesInBatch} duplicate item(s) found within this batch — highlighted below.`);
    }
    if (skippedCount > 0) {
      warnings.push(`${skippedCount} line(s) skipped — no item name could be extracted.`);
    }

    return {
      success: true,
      format,
      importBatchId,
      items,
      warnings,
      duplicatesInBatch,
      skippedCount,
    };
  }

  /**
   * Check for existing pending proposals in the store for the given company.
   * Returns a Set of normalized keys already pending: 'item_name_norm|irp5_code'
   */
  static async checkExistingProposals(supabase, companyId) {
    const { data } = await supabase
      .from('sean_transaction_store')
      .select('item_key, proposed_value')
      .eq('company_id', companyId)
      .eq('entity_type', 'paytime_learning')
      .eq('status', 'pending');

    const existing = new Set();
    (data || []).forEach(row => {
      existing.add(`${row.item_key}|${row.proposed_value || ''}`);
    });
    return existing;
  }

  static normalizeItemName(name) {
    return normalizeItemName(name);
  }

  static normalizeKey(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
}

module.exports = TeachPaytimeService;
