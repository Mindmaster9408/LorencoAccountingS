/**
 * ============================================================================
 * Slips — layout learning (what a supplier's slip LOOKS like)
 * ============================================================================
 * Ruan 2026-11-13: layout is global knowledge, the slip itself is the
 * client's. So this learns only:
 *   total_line   'same:<label>' (total on the labelled line) or
 *                'next:<label>' (label alone, amount on the next line)
 *   date_format  'dmy' | 'mdy' | 'ymd' | 'text'
 * per chain (supplier VAT number — same for every branch) and per branch
 * (store number printed on the slip). Never amounts, dates or slip text.
 *
 * Learned ONLY from what a person saved (like supplier memory).
 *
 * Lookup order, per facet, first hit wins:
 *   1. this company, this branch     (>= 2 agreeing slips, majority)
 *   2. this company, whole chain     (>= 2 agreeing slips, majority)
 *   3. global approved, this branch  (Sean proposal approved by a super user)
 *   4. global approved, whole chain
 *   → otherwise the generic parser.
 * The company's own confirmations always beat global knowledge (Rule B9
 * spirit). Global patterns only exist after approval (Rule B2) — see
 * backend/sean/slip-layout-learning.js.
 * ============================================================================
 */

'use strict';

const {
  amountsInLine, normalizeLabel, dateMatches, isoOrNull,
  RE_TOTAL, RE_NOT_TOTAL, RE_TENDER, RE_CHANGE,
} = require('./slipParser');
const { nameKey } = require('./supplierMemory');

// Loaded lazily so the pure functions can be unit-tested without a DB.
const db = () => require('../../../config/database').supabase;

const FACETS = ['total_line', 'date_format'];
const MIN_COMPANY_CONFIRMATIONS = 2;
const VAT_RE = /^4\d{9}$/;

const near = (a, b) => Math.abs(a - b) <= 0.005;

// ── Keys ─────────────────────────────────────────────────────────────────────

/** 'vat:<no>' when the VAT number is valid, else 'name:<key>', else null. */
function chainKeyFor(vatNumber, supplierName) {
  const vat = String(vatNumber || '').replace(/\D/g, '');
  if (VAT_RE.test(vat)) return 'vat:' + vat;
  const key = nameKey(supplierName);
  return key.length >= 3 ? 'name:' + key : null;
}

/** Store / branch number printed on the slip, e.g. "STORE NO: 2417" → 'store:2417'. */
function branchKeyFrom(text) {
  const re = /\b(?:store|branch|shop|site|winkel|tak)\s*(?:no|nr|number|num|code|id|#)?\s*[:#.\-]?\s*([a-z0-9]{1,8})\b/i;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(re);
    if (m && /\d/.test(m[1])) return 'store:' + m[1].toLowerCase();
  }
  return null;
}

/** Subject used for global patterns. Only VAT-keyed chains can go global. */
function globalSubject(chainKey, branchKey, facet) {
  if (!chainKey || !chainKey.startsWith('vat:')) return null;
  return `${chainKey}|${branchKey || '*'}|${facet}`;
}

// ── Deriving the layout from one confirmed slip (pure) ──────────────────────

function lines(text) {
  return String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Where the confirmed total sits → 'same:<label>' | 'next:<label>' | null. */
function deriveTotalLine(ls, amount) {
  const amt = Number(amount);
  if (!(amt > 0)) return null;
  const cands = [];
  ls.forEach((line, i) => {
    const amts = amountsInLine(line);
    if (!amts.length || !near(amts[amts.length - 1], amt)) return;
    const label = normalizeLabel(line);
    if (label) {
      cands.push({ pos: 'same', label, line });
    } else if (i > 0 && !amountsInLine(ls[i - 1]).length) {
      const prev = normalizeLabel(ls[i - 1]);
      if (prev) cands.push({ pos: 'next', label: prev, line: ls[i - 1] });
    }
  });
  // Not the subtotal, not the payment/change lines (those are payment, not layout).
  const usable = cands.filter(c => !RE_NOT_TOTAL.test(c.line)
    && !RE_CHANGE.test(c.line)
    && (!RE_TENDER.test(c.line) || RE_TOTAL.test(c.line)));
  const labelled = usable.filter(c => RE_TOTAL.test(c.line));
  const pick = (labelled.length ? labelled : usable);
  const distinct = [...new Set(pick.map(c => `${c.pos}:${c.label}`))];
  return distinct.length === 1 ? distinct[0] : null;
}

/** How the confirmed date is written → 'dmy' | 'mdy' | 'ymd' | 'text' | null. */
function deriveDateFormat(ls, slipDate) {
  const want = String(slipDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(want)) return null;
  const formats = new Set();
  for (const line of ls) {
    for (const dm of dateMatches(line)) {
      if (dm.kind === 'numeric') {
        const asDmy = isoOrNull(dm.y, dm.b, dm.a) === want;
        const asMdy = isoOrNull(dm.y, dm.a, dm.b) === want;
        if (asDmy && asMdy) continue; // 05/05 — tells us nothing
        if (asDmy) formats.add('dmy');
        if (asMdy) formats.add('mdy');
      } else if (isoOrNull(dm.y, dm.m, dm.d) === want) {
        formats.add(dm.kind);
      }
    }
  }
  return formats.size === 1 ? [...formats][0] : null;
}

/** { total_line?, date_format? } learned from one saved slip (pure). */
function deriveLayout(rawText, { amount, slipDate }) {
  const ls = lines(rawText);
  const out = {};
  const t = deriveTotalLine(ls, amount);
  if (t) out.total_line = t;
  const d = deriveDateFormat(ls, slipDate);
  if (d) out.date_format = d;
  return out;
}

/** Event rows for one saved slip (pure). Chain row always; branch row when printed. */
function buildEventRows({ companyId, slipId, userId, chainKey, branchKey, supplierName, layout }) {
  const rows = [];
  for (const facet of FACETS) {
    const value = layout[facet];
    if (!value) continue;
    const base = {
      company_id: companyId, slip_id: slipId, chain_key: chainKey, branch_key: branchKey || null,
      facet, value, supplier_name: supplierName || null, created_by: userId || null,
    };
    rows.push({ ...base, level: 'chain', global_subject: globalSubject(chainKey, null, facet) });
    if (branchKey) rows.push({ ...base, level: 'branch', global_subject: globalSubject(chainKey, branchKey, facet) });
  }
  return rows;
}

// ── Resolving a layout for a slip being read (pure) ─────────────────────────

function majority(values) {
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [value, count] = ranked[0];
  if (count < MIN_COMPANY_CONFIRMATIONS || count * 2 <= values.length) return null;
  return value;
}

/**
 * @param events   this company's 'chain'-level event rows for the chain key(s)
 * @param patterns approved global patterns for this chain (branch + chain level)
 * @param branchKey branch printed on the slip being read (or null)
 * @returns {{ total_line?, date_format?, sources: object } | null}
 */
function resolveLayout({ events = [], patterns = [], branchKey = null }) {
  const layout = { sources: {} };
  for (const facet of FACETS) {
    const mine = events.filter(e => e.facet === facet);
    const pick = (value, source) => { layout[facet] = value; layout.sources[facet] = source; };

    const companyBranch = branchKey ? majority(mine.filter(e => e.branch_key === branchKey).map(e => e.value)) : null;
    if (companyBranch) { pick(companyBranch, 'company:branch'); continue; }
    const companyChain = majority(mine.map(e => e.value));
    if (companyChain) { pick(companyChain, 'company:chain'); continue; }

    const globals = patterns.filter(p => p.facet === facet);
    const one = list => (new Set(list.map(p => p.layout_value)).size === 1 ? list[0].layout_value : null);
    const globalBranch = branchKey ? one(globals.filter(p => p.branch_key === branchKey)) : null;
    if (globalBranch) { pick(globalBranch, 'global:branch'); continue; }
    const globalChain = one(globals.filter(p => !p.branch_key));
    if (globalChain) pick(globalChain, 'global:chain');
  }
  return Object.keys(layout.sources).length ? layout : null;
}

// ── DB ───────────────────────────────────────────────────────────────────────

/**
 * Layout for a slip being read. Never throws (reading must not fail on it).
 * @param {number} companyId
 * @param {{ text: string, vatNumber?: string, supplierName?: string }} slip
 */
async function lookup(companyId, { text, vatNumber, supplierName }) {
  try {
    const keys = [chainKeyFor(vatNumber, null), chainKeyFor(null, supplierName)].filter(Boolean);
    if (!keys.length) return null;
    const branchKey = branchKeyFrom(text);
    const vatKey = keys.find(k => k.startsWith('vat:')) || null;

    const { data: events, error } = await db().from('slip_layout_events')
      .select('chain_key, branch_key, facet, value')
      .eq('company_id', companyId).eq('level', 'chain').in('chain_key', keys)
      .order('id', { ascending: false }).limit(200);
    if (error) throw new Error(error.message);

    let patterns = [];
    if (vatKey) {
      const subjects = FACETS.flatMap(f => [globalSubject(vatKey, null, f)].concat(branchKey ? [globalSubject(vatKey, branchKey, f)] : []));
      const res = await db().from('slip_layout_patterns')
        .select('layout_value, facet, branch_key')
        .eq('source_app', 'slips').eq('status', 'approved').in('layout_subject', subjects);
      if (res.error) throw new Error(res.error.message);
      patterns = res.data || [];
    }
    return resolveLayout({ events: events || [], patterns, branchKey });
  } catch (err) {
    console.error('[slips] layout lookup failed:', err.message);
    return null;
  }
}

/**
 * Learn from a slip a person just saved. Never throws — learning is a
 * convenience, not part of the save.
 * @param {object} reading latest slip_readings row (needs raw_text)
 */
async function learnFromSave(companyId, slip, reading, userId) {
  try {
    if (!reading || !reading.raw_text) return { learned: 0 };
    const chainKey = chainKeyFor(slip.supplier_vat_number, slip.supplier_name);
    if (!chainKey) return { learned: 0 };
    const layout = deriveLayout(reading.raw_text, { amount: slip.amount, slipDate: slip.slip_date });
    const rows = buildEventRows({
      companyId, slipId: slip.id, userId, chainKey,
      branchKey: branchKeyFrom(reading.raw_text), supplierName: slip.supplier_name, layout,
    });

    // A re-save replaces this slip's rows (it may now say something else).
    const { error: delErr } = await db().from('slip_layout_events')
      .delete().eq('company_id', companyId).eq('slip_id', slip.id);
    if (delErr) throw new Error(delErr.message);
    if (!rows.length) return { learned: 0 };
    const { error } = await db().from('slip_layout_events').insert(rows);
    if (error) throw new Error(error.message);

    if (rows.some(r => r.global_subject)) {
      // Sean looks for patterns shared by several companies → proposals only.
      require('../../../sean/slip-layout-learning').analyzePatterns()
        .catch(err => console.error('[slips] layout analyze failed:', err.message));
    }
    return { learned: rows.length };
  } catch (err) {
    console.error('[slips] layout learn failed:', err.message);
    return { learned: 0, error: err.message };
  }
}

module.exports = {
  FACETS, chainKeyFor, branchKeyFrom, globalSubject,
  deriveLayout, deriveTotalLine, deriveDateFormat, buildEventRows, resolveLayout,
  lookup, learnFromSave,
};
