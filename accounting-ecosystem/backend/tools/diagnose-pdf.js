/**
 * diagnose-pdf.js — quick diagnostic for PDF text extraction issues
 *
 * Usage:
 *   node backend/tools/diagnose-pdf.js <path-to-pdf>
 *
 * Prints: char count, word count, first 2000 chars of extracted text,
 * plus whether it would pass the scanned-PDF guard.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node backend/tools/diagnose-pdf.js <path-to-pdf>');
  process.exit(1);
}

const absPath = path.resolve(filePath);
if (!fs.existsSync(absPath)) {
  console.error('File not found:', absPath);
  process.exit(1);
}

const _pdfParseLib = require('pdf-parse');
const pdfParse = typeof _pdfParseLib === 'function'
  ? _pdfParseLib
  : (_pdfParseLib.default || _pdfParseLib.parse);

(async () => {
  const buf  = fs.readFileSync(absPath);
  let pdfData;
  try {
    pdfData = await pdfParse(buf, { pagerender: null });
  } catch (err) {
    console.error('pdf-parse threw:', err.message);
    process.exit(1);
  }

  const raw  = (pdfData.text || '').trim();
  const chars = raw.length;
  const words = raw.split(/\s+/).filter(w => w.length > 0).length;
  const pages = pdfData.numpages || '?';

  console.log('═══════════════════════════════════════════');
  console.log('PDF Diagnostic Report');
  console.log('═══════════════════════════════════════════');
  console.log('File  :', path.basename(absPath));
  console.log('Pages :', pages);
  console.log('Chars :', chars, chars < 100 ? '  ⚠ BELOW threshold (100)' : '  ✓ OK');
  console.log('Words :', words, words < 20  ? '  ⚠ BELOW threshold (20)' : '  ✓ OK');
  console.log('Result:', (chars < 100 || words < 20)
    ? '❌ Would be flagged as SCANNED — pdf-parse cannot extract readable text'
    : '✓ Would pass scanned check — parser will run');
  console.log('───────────────────────────────────────────');
  console.log('First 2000 chars of extracted text:');
  console.log('───────────────────────────────────────────');
  console.log(raw.slice(0, 2000));
  console.log('═══════════════════════════════════════════');
})();
