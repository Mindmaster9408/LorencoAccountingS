'use strict';

/**
 * Sean — payroll item MEANING (Paytime spec 14 SN-04; CLAUDE.md B3, B10)
 *
 * Two items are "the same" when they mean the same thing, not only when they are
 * spelt the same: "Comm." = "Commission" = "Monthly Commission". And an earning
 * called "Savings" is NOT the same item as a deduction called "Savings" — the side
 * (earning / deduction / employer contribution) is part of the meaning.
 *
 * Deliberately conservative: only unambiguous abbreviations and synonyms are listed.
 * A wrong match here could put the wrong IRP5 code on a client's item (after an
 * approval), so anything doubtful stays unmatched and is left to the reviewer.
 *
 * Subject format (stored in sean_irp5_mapping_patterns.normalized_item_name):
 *   "commission"              — earning side (default)
 *   "savings [deduction]"     — deduction side
 *   "pension fund [employer]" — employer contribution side
 */

// Word-level abbreviations (after lower-casing and stripping punctuation).
const WORDS = {
  comm: 'commission', comms: 'commission', commis: 'commission', commissions: 'commission',
  allow: 'allowance', allw: 'allowance', alw: 'allowance', allowances: 'allowance',
  sal: 'salary', salaries: 'salary',
  ot: 'overtime',
  prov: 'provident', pens: 'pension',
  trav: 'travel', travelling: 'travel', traveling: 'travel',
  cellphone: 'cell', cellular: 'cell',
  med: 'medical',
  ins: 'insurance',
  contrib: 'contribution', contr: 'contribution', contributions: 'contribution',
  loans: 'loan', advances: 'advance'
};

// Whole-phrase synonyms → one canonical meaning (applied after word expansion).
const PHRASES = {
  'basic': 'basic salary',
  'basic pay': 'basic salary',
  'basic wage': 'basic salary',
  'basic wages': 'basic salary',
  'salary': 'basic salary',
  'wage': 'basic salary',
  'wages': 'basic salary',
  'o t': 'overtime',
  '13th cheque': 'bonus',
  '13th check': 'bonus',
  'thirteenth cheque': 'bonus',
  'cell phone allowance': 'cell allowance',
  'phone allowance': 'cell allowance',
  'medical': 'medical aid',
  'pf': 'provident fund',
  'ra': 'retirement annuity'
};

/** The existing light clean-up (unchanged from irp5-learning's original normalizeName). */
function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(monthly|weekly|annual|yearly|2024|2025|2026|per month|per year)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical meaning of an item NAME: "Comm." → "commission", "Basic Pay" → "basic salary". */
function meaningOf(name) {
  const base = normalizeName(name);
  if (!base) return '';
  if (PHRASES[base]) return PHRASES[base];
  const expanded = base.split(' ').map(w => WORDS[w] || w).join(' ');
  return PHRASES[expanded] || expanded;
}

/** Side of an item from its type/category. Unknown → earning (the common case). */
function sideOf(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'deduction') return 'deduction';
  if (t === 'company_contribution' || t === 'employer_contribution') return 'employer';
  return 'earning';
}

/** The matching key: meaning + side. Empty when the name is empty. */
function subjectFor(name, type) {
  const m = meaningOf(name);
  if (!m) return '';
  const side = sideOf(type);
  return side === 'earning' ? m : `${m} [${side}]`;
}

/**
 * Re-canonicalise a stored/passed subject. Idempotent on subjects produced by
 * subjectFor(); a bare old-style normalized name is read as an earning-side name.
 */
function canonicalSubject(subject) {
  const m = /^(.*) \[(deduction|employer)\]$/.exec(String(subject || '').trim());
  if (m) return subjectFor(m[1], m[2] === 'employer' ? 'employer_contribution' : 'deduction');
  return subjectFor(subject, null);
}

module.exports = { normalizeName, meaningOf, sideOf, subjectFor, canonicalSubject, WORDS, PHRASES };
