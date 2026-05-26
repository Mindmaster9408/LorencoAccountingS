/**
 * test_inventory_no_local_storage.mjs
 *
 * Codebox 01 — Browser storage compliance scan for inventory frontend.
 *
 * Scans all inventory frontend files for forbidden browser storage writes
 * per CLAUDE.md Part D (Absolute No Browser Storage Rule).
 *
 * Forbidden patterns:
 *   localStorage.setItem(...)   — for business data
 *   sessionStorage.setItem(...) — for business data
 *   safeLocalStorage.setItem(...) — KV bridge, also forbidden for business data
 *   indexedDB.open(...)
 *
 * Allowed patterns (not flagged):
 *   localStorage.getItem(...)   — read-only, not a write
 *   localStorage.setItem('sb-session', ...)   — auth token, permitted
 *   localStorage.setItem('eco_token', ...)    — auth token, permitted
 *   localStorage.setItem('theme', ...)        — UI preference, permitted
 *
 * Usage:
 *   node scripts/test_inventory_no_local_storage.mjs
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const ROOT = resolve(__dirname, '..');

// Directories to scan
const SCAN_DIRS = [
  join(ROOT, 'accounting-ecosystem', 'frontend-inventory'),
  join(ROOT, 'accounting-ecosystem', 'backend', 'modules', 'inventory')
];

// Patterns that are unconditionally forbidden (business data writes)
const FORBIDDEN_PATTERNS = [
  { regex: /localStorage\.setItem\s*\(/g,    label: 'localStorage.setItem()' },
  { regex: /sessionStorage\.setItem\s*\(/g,  label: 'sessionStorage.setItem()' },
  { regex: /safeLocalStorage\.setItem\s*\(/g, label: 'safeLocalStorage.setItem()' },
  { regex: /indexedDB\.open\s*\(/g,          label: 'indexedDB.open()' }
];

// Auth/UI-pref key names that ARE permitted in localStorage.setItem()
// A match is only waived if the key argument matches one of these exactly.
const PERMITTED_KEYS = new Set([
  'sb-session', 'eco_token', 'accounting_token', 'payroll_token',
  'theme', 'sidebar_collapsed', 'lang'
]);

function walkDir(dir, exts = ['.js', '.html', '.ts']) {
  const files = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          files.push(...walkDir(full, exts));
        } else if (exts.includes(extname(entry))) {
          files.push(full);
        }
      } catch { /* skip inaccessible */ }
    }
  } catch { /* skip missing dirs */ }
  return files;
}

function scanFile(filepath) {
  const violations = [];
  let content;
  try {
    content = readFileSync(filepath, 'utf8');
  } catch {
    return violations;
  }

  const lines = content.split('\n');

  for (const { regex, label } of FORBIDDEN_PATTERNS) {
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(content)) !== null) {
      // Determine line number
      const lineNum = content.slice(0, match.index).split('\n').length;
      const line    = lines[lineNum - 1]?.trim() || '';

      // For localStorage.setItem: check if key is permitted
      if (label === 'localStorage.setItem()') {
        const keyMatch = line.match(/localStorage\.setItem\s*\(\s*['"`]([^'"`]+)['"`]/);
        if (keyMatch && PERMITTED_KEYS.has(keyMatch[1])) continue;
      }

      violations.push({ line: lineNum, label, snippet: line.slice(0, 120) });
    }
    regex.lastIndex = 0;
  }

  return violations;
}

function main() {
  console.log('\n=== Inventory No-LocalStorage Compliance Scan ===\n');

  let totalFiles    = 0;
  let totalViolations = 0;
  const report = [];

  for (const dir of SCAN_DIRS) {
    const files = walkDir(dir);
    for (const file of files) {
      totalFiles++;
      const violations = scanFile(file);
      if (violations.length > 0) {
        totalViolations += violations.length;
        report.push({ file: file.replace(ROOT + '\\', '').replace(ROOT + '/', ''), violations });
      }
    }
  }

  if (report.length === 0) {
    console.log(`Scanned ${totalFiles} files.`);
    console.log('[PASS] No browser storage violations found in inventory module.\n');
    return;
  }

  console.log(`Scanned ${totalFiles} files. Found ${totalViolations} violation(s):\n`);
  for (const { file, violations } of report) {
    console.log(`  ${file}`);
    for (const v of violations) {
      console.log(`    Line ${v.line}: ${v.label}`);
      console.log(`      ${v.snippet}`);
    }
  }

  console.log(`\n[FAIL] ${totalViolations} browser storage violation(s) found.`);
  console.log('See CLAUDE.md Part D for the prohibition rules.\n');
  process.exit(1);
}

main();
