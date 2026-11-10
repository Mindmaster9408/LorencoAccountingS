/**
 * ============================================================================
 * Slips — supplier memory (reading layer 1)
 * ============================================================================
 * Per company: "this VAT number / this name on a slip = this supplier, in
 * this category". Learned ONLY when a person saves a slip's details — never
 * from raw OCR guesses — so the memory holds human-confirmed facts.
 *
 * Company-scoped by design. Sharing a mapping with other companies would be
 * a global change and must go through Sean's approval flow (CLAUDE.md
 * Part B, Rules B2/B9) — this module never does that.
 * ============================================================================
 */

'use strict';

// Loaded on first DB call, so the pure matchers can be unit-tested without a DB.
const db = () => require('../../../config/database').supabase;

const MAX_MEMORY_ROWS = 1000;

function nameKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Pure matcher (testable): find the remembered supplier for this slip.
 * @param {object[]} rows   memory rows for ONE company
 * @param {string} text     OCR text
 * @param {string|null} vatNumber  VAT number read from the slip, if any
 * @returns {{ row: object, how: 'vat_number'|'name' } | null}
 */
function matchMemory(rows, text, vatNumber) {
  if (vatNumber) {
    const byVat = rows.filter(r => r.supplier_vat_number === vatNumber)
      .sort((a, b) => b.times_confirmed - a.times_confirmed)[0];
    if (byVat) return { row: byVat, how: 'vat_number' };
  }
  // Supplier names sit at the top of a slip; also allow OCR spacing errors.
  const top = nameKey(String(text || '').split(/\r?\n/).slice(0, 8).join(' '));
  let best = null;
  for (const r of rows) {
    if (r.name_key.length < 4 || !top.includes(r.name_key)) continue;
    if (!best || r.name_key.length > best.name_key.length) best = r;
  }
  return best ? { row: best, how: 'name' } : null;
}

/** Applies a memory match onto parsed fields (memory wins for supplier/category). */
function applyMemory(fields, match) {
  if (!match) return fields;
  const conf = match.how === 'vat_number' ? 'high' : 'medium';
  const reason = match.how === 'vat_number'
    ? 'known supplier (VAT number seen before)'
    : 'known supplier (name seen before)';
  const out = { ...fields };
  out.supplier_name = { value: match.row.supplier_name, confidence: conf, source: 'memory', reason };
  if (match.row.category) out.category = { value: match.row.category, confidence: conf, source: 'memory', reason };
  if (match.row.supplier_vat_number && !out.supplier_vat_number) {
    out.supplier_vat_number = { value: match.row.supplier_vat_number, confidence: conf, source: 'memory', reason };
  }
  return out;
}

async function lookup(companyId, text, vatNumber) {
  const { data, error } = await db()
    .from('slip_supplier_memory')
    .select('id, name_key, supplier_name, supplier_vat_number, category, times_confirmed')
    .eq('company_id', companyId)
    .order('times_confirmed', { ascending: false })
    .limit(MAX_MEMORY_ROWS);
  if (error) {
    console.error('[slips] supplier memory lookup failed:', error.message);
    return null;
  }
  return matchMemory(data || [], text, vatNumber);
}

/**
 * Remember what a person confirmed. Called after a successful slip save.
 * Never throws — memory is a convenience, not part of the save.
 */
async function learn(companyId, slip, asName) {
  try {
    // asName: also remember the name as the OCR printed it (e.g. the slip says
    // "LYNNWOOD SERVICE STN" but the person saved "Engen Lynnwood").
    const key = nameKey(asName || slip.supplier_name);
    if (key.length < 3) return;
    const now = new Date().toISOString();
    const { data: existing } = await db()
      .from('slip_supplier_memory').select('id, times_confirmed, category, supplier_vat_number')
      .eq('company_id', companyId).eq('name_key', key).maybeSingle();
    if (existing) {
      await db().from('slip_supplier_memory').update({
        supplier_name: slip.supplier_name,
        category: slip.category || existing.category,
        supplier_vat_number: slip.supplier_vat_number || existing.supplier_vat_number,
        times_confirmed: existing.times_confirmed + 1,
        last_confirmed_at: now,
        updated_at: now,
      }).eq('id', existing.id);
    } else {
      await db().from('slip_supplier_memory').insert({
        company_id: companyId,
        name_key: key,
        supplier_name: slip.supplier_name,
        category: slip.category || null,
        supplier_vat_number: slip.supplier_vat_number || null,
      });
    }
  } catch (err) {
    console.error('[slips] supplier memory learn failed:', err.message);
  }
}

module.exports = { lookup, learn, matchMemory, applyMemory, nameKey };
