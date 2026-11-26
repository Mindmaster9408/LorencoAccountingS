'use strict';

/**
 * ============================================================================
 * VAT cycle — which periods a company files, per its SARS category
 * ============================================================================
 * The company's VAT cycle lives on companies.vat_period (+ vat_cycle_type for
 * bi-monthly). journalService already uses it to place journals in periods;
 * this module makes the VAT page use the SAME cycle, so the period list, the
 * period dates and therefore every VAT report follow it:
 *
 *   monthly        Category C
 *   bi-monthly     Category A (odd: ends Jan, Mar, …) / B (even: ends Feb, Apr, …)
 *   four-monthly   Category F (ends Feb, Jun, Oct)
 *   six-monthly    Category D (ends Feb, Aug)
 *   annually       Category E (vatPeriodUtils: Mar–Feb)
 *   quarterly      non-SA (UK)
 *
 *   periodOptions()      periods to choose from (default 36 months back),
 *                        merged with existing vat_periods rows
 *   ensureCyclePeriod()  create the period row with the cycle's dates, or
 *                        realign an unlocked, unfiled row created under
 *                        another cycle (e.g. a "monthly" row made by the old
 *                        page). Locked / filed rows are never changed.
 *   setCycle()           change the company's cycle (admin / accountant)
 *
 * A company without a cycle set keeps the old behaviour (calendar months, the
 * page's own dates) and is asked to choose one.
 * ============================================================================
 */

const { supabase } = require('../../../config/database');
const { derivePeriodForDate, generatePeriods } = require('./vatPeriodUtils');

const FREQUENCIES = ['monthly', 'bi-monthly', 'four-monthly', 'six-monthly', 'annually', 'quarterly'];

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

function canonicalKey(key) {
  const m = /^(\d{4})[-.](\d{2})$/.exec(String(key || '').trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

/** SA date (YYYY-MM-DD) for a timestamp / date value. */
function saDate(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
  const d = new Date(v);
  if (isNaN(d)) return null;
  return new Date(d.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);   // SAST = UTC+2, no DST
}

function todaySA() { return saDate(new Date().toISOString()); }

function monthsBack(dateStr, months) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - months, 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Merge generated cycle periods with stored rows. Pure — exported for tests.
 * Stored rows outside the cycle are kept only when they are history
 * (locked or filed); unlocked strays (e.g. old monthly rows) are hidden.
 */
function mergePeriodOptions(generated, stored, filedIds) {
  const byKey = new Map(stored.map(r => [canonicalKey(r.period_key), r]));
  const seen = new Set();
  const out = generated.map(g => {
    const row = byKey.get(g.periodKey);
    seen.add(g.periodKey);
    const locked = row ? String(row.status || '').toUpperCase() === 'LOCKED' : false;
    const filed = row ? filedIds.has(row.id) : false;
    const differ = !!row && (row.from_date !== g.fromDate || row.to_date !== g.toDate);
    // a locked/filed row keeps its own dates — that's what was filed
    const keepRow = differ && (locked || filed);
    return {
      periodKey: g.periodKey,
      fromDate: keepRow ? row.from_date : g.fromDate,
      toDate: keepRow ? row.to_date : g.toDate,
      periodId: row ? row.id : null,
      locked, filed,
      otherCycle: keepRow,
    };
  });
  for (const r of stored) {
    const k = canonicalKey(r.period_key);
    if (!k || seen.has(k)) continue;
    const locked = String(r.status || '').toUpperCase() === 'LOCKED';
    const filed = filedIds.has(r.id);
    if (!locked && !filed) continue;
    out.push({ periodKey: k, fromDate: r.from_date, toDate: r.to_date, periodId: r.id, locked, filed, otherCycle: true });
  }
  return out.sort((a, b) => b.toDate.localeCompare(a.toDate) || b.periodKey.localeCompare(a.periodKey));
}

class VatCycleService {

  async settings(companyId) {
    const { data, error } = await supabase
      .from('companies')
      .select('is_vat_registered, vat_period, vat_cycle_type, vat_registered_date')
      .eq('id', companyId)
      .single();
    if (error || !data) throw new Error('Company not found');
    const configured = FREQUENCIES.includes(String(data.vat_period || '').toLowerCase());
    const frequency = configured ? data.vat_period.toLowerCase() : 'monthly';
    return {
      configured,
      isVatRegistered: !!data.is_vat_registered,
      frequency,
      cycle: frequency === 'bi-monthly' ? (data.vat_cycle_type || 'even').toLowerCase() : null,
      registeredDate: saDate(data.vat_registered_date),
    };
  }

  async periodOptions(companyId, { months = 36 } = {}) {
    const s = await this.settings(companyId);
    const today = todaySA();
    let from = monthsBack(today, Math.min(Math.max(parseInt(months, 10) || 36, 1), 120));
    if (s.registeredDate && s.registeredDate > from) from = s.registeredDate;
    const generated = generatePeriods(from, today, s.frequency, s.cycle || 'even');

    const { data: stored, error } = await supabase
      .from('vat_periods')
      .select('id, period_key, from_date, to_date, status')
      .eq('company_id', companyId);
    if (error) throw new Error(error.message);
    const ids = (stored || []).map(r => r.id);
    let filedIds = new Set();
    if (ids.length) {
      const { data: filed, error: fErr } = await supabase
        .from('vat_returns').select('vat_period_id').eq('company_id', companyId).eq('status', 'filed');
      if (fErr && fErr.code !== '42P01') throw new Error(fErr.message);
      filedIds = new Set((filed || []).map(r => r.vat_period_id));
    }
    return { settings: s, today, periods: mergePeriodOptions(generated, stored || [], filedIds) };
  }

  /**
   * The vat_periods row for periodKey under the company's cycle. Returns null
   * when no cycle is set (caller keeps the old behaviour).
   */
  async ensureCyclePeriod(companyId, periodKeyInput) {
    const s = await this.settings(companyId);
    if (!s.configured) return null;
    const key = canonicalKey(periodKeyInput);
    if (!key) throw badRequest('Invalid VAT period');
    const derived = derivePeriodForDate(`${key}-01`, s.frequency, s.cycle || 'even');
    if (derived.periodKey !== key) {
      throw badRequest(`${key} is not a VAT period end for this company's cycle (${s.frequency}${s.cycle ? ', ' + s.cycle : ''}) — reload the page`);
    }

    const { data: rows, error } = await supabase
      .from('vat_periods').select('*').eq('company_id', companyId)
      .in('period_key', [key, key.replace('-', '.')]);
    if (error) throw new Error(error.message);
    const existing = (rows || []).find(r => r.period_key === key) || (rows || [])[0];   // prefer canonical over legacy 'YYYY.MM'

    if (!existing) {
      const { data: created, error: insErr } = await supabase
        .from('vat_periods')
        .insert({
          company_id: companyId, period_key: key, from_date: derived.fromDate, to_date: derived.toDate,
          filing_frequency: s.frequency, vat_cycle_type: s.cycle || null, status: 'DRAFT',
        })
        .select().single();
      if (insErr) {
        if (insErr.code === '23505') return this.ensureCyclePeriod(companyId, key);    // created meanwhile
        throw new Error(insErr.message);
      }
      return created;
    }

    if (existing.from_date === derived.fromDate && existing.to_date === derived.toDate) return existing;

    // Dates from another cycle: realign only if nothing was filed or locked on it.
    const locked = String(existing.status || '').toUpperCase() === 'LOCKED';
    const { data: filed, error: fErr } = await supabase
      .from('vat_returns').select('id').eq('company_id', companyId).eq('vat_period_id', existing.id).limit(1);
    if (fErr && fErr.code !== '42P01') throw new Error(fErr.message);
    if (locked || (filed && filed.length)) return existing;

    const { data: updated, error: upErr } = await supabase
      .from('vat_periods')
      .update({ from_date: derived.fromDate, to_date: derived.toDate, filing_frequency: s.frequency,
        vat_cycle_type: s.cycle || null, updated_at: new Date().toISOString() })
      .eq('id', existing.id).eq('company_id', companyId)
      .select().single();
    if (upErr) throw new Error(upErr.message);
    return updated;
  }

  async setCycle(companyId, { frequency, cycle }) {
    const f = String(frequency || '').toLowerCase();
    if (!FREQUENCIES.includes(f)) throw badRequest('Choose a VAT cycle');
    const c = f === 'bi-monthly' ? String(cycle || '').toLowerCase() : null;
    if (f === 'bi-monthly' && !['odd', 'even'].includes(c)) throw badRequest('Choose odd or even months for a bi-monthly cycle');
    const before = await this.settings(companyId);
    // Choosing a SARS VAT cycle means the company is a VAT vendor: journalService
    // only places entries in VAT periods for registered companies, and Firmflow
    // takes the cycle from Leo only for registered companies (practice/lib/company-sync).
    const update = { vat_period: f, is_vat_registered: true, updated_at: new Date().toISOString() };
    if (c) update.vat_cycle_type = c;
    const { error } = await supabase.from('companies').update(update).eq('id', companyId);
    if (error) throw new Error(error.message);
    return { before, after: await this.settings(companyId) };
  }
}

module.exports = new VatCycleService();
Object.assign(module.exports, { mergePeriodOptions, canonicalKey, saDate, monthsBack, FREQUENCIES });
