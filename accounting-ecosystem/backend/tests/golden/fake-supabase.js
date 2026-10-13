'use strict';

/**
 * ============================================================================
 * In-memory Supabase stand-in for the Paytime golden test set
 * ============================================================================
 * Implements only the query-builder surface that PayrollDataService uses:
 *   from().select(cols).eq/neq/in/is/not/ilike/order/limit
 *   terminals: await (thenable), maybeSingle(), single()
 *   from().insert(row).select().single()   (payroll_periods auto-create)
 *   from().upsert(row, { onConflict }).select().single()   (tax tables, KV mirror)
 *   from().update(patch).eq(...) / from().delete().eq(...)  (filters honoured)
 *   rpc(name, args) → db.__rpc[name](args, db) or a PGRST202 "function not found" error
 *
 * Column projection is honoured, including nested joins such as
 * "payroll_items(code, name)". This matters: a real PostgREST select only
 * returns the columns asked for, so a column the service forgets to select
 * (e.g. payroll_period_inputs.is_taxable) must stay invisible here too —
 * otherwise the golden set would hide exactly the bugs it exists to catch.
 * ============================================================================
 */

function splitTopLevel(str) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Returns null for "*" (all columns), else [{ key, sub }] where sub is a nested spec.
function parseSelect(str) {
  if (!str || str.trim() === '*') return null;
  return splitTopLevel(str).map(part => {
    const open = part.indexOf('(');
    if (open === -1) return { key: part.trim(), sub: undefined };
    return { key: part.slice(0, open).trim(), sub: parseSelect(part.slice(open + 1, part.lastIndexOf(')'))) };
  });
}

function project(row, spec) {
  if (row === null || row === undefined) return row;
  if (spec === null || spec === undefined) return JSON.parse(JSON.stringify(row));
  const out = {};
  for (const { key, sub } of spec) {
    if (!(key in row)) continue;
    out[key] = sub === undefined ? row[key] : project(row[key], sub);
  }
  return out;
}

const same = (a, b) => String(a) === String(b);

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.cols = null;
    this.op = 'select';
    this.sortKey = null;
    this.sortAsc = true;
    this.max = null;
  }
  select(cols) {
    this.cols = parseSelect(cols);
    return this;
  }
  eq(c, v)   { this.filters.push(r => same(r[c], v)); return this; }
  neq(c, v)  { this.filters.push(r => !same(r[c], v)); return this; }
  in(c, arr) { this.filters.push(r => arr.some(v => same(r[c], v))); return this; }
  is(c, v)   { this.filters.push(r => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
  not(c, op, v) {
    if (op === 'is' && v === null) this.filters.push(r => r[c] !== null && r[c] !== undefined);
    return this;
  }
  ilike(c, v) { this.filters.push(r => String(r[c] || '').toLowerCase() === String(v).toLowerCase()); return this; }
  order(c, opts) { this.sortKey = c; this.sortAsc = !opts || opts.ascending !== false; return this; }
  limit(n) { this.max = n; return this; }
  insert(row) { this.op = 'insert'; this.payload = row; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  upsert(row, opts) { this.op = 'upsert'; this.payload = row; this.conflict = ((opts && opts.onConflict) || 'id').split(','); return this; }

  _run() {
    const rows = this.db[this.table] || (this.db[this.table] = []);
    if (this.op === 'insert') {
      const added = (Array.isArray(this.payload) ? this.payload : [this.payload])
        .map(p => { const r = Object.assign({ id: rows.length + 1000 }, p); rows.push(r); return r; });
      return { data: added.map(r => project(r, this.cols)), error: null };
    }
    if (this.op === 'update' || this.op === 'delete') {
      const hit = rows.filter(r => this.filters.every(f => f(r)));
      if (this.op === 'update') hit.forEach(r => Object.assign(r, this.payload));
      else this.db[this.table] = rows.filter(r => !hit.includes(r));
      return { data: hit.map(r => project(r, this.cols)), error: null };
    }
    if (this.op === 'upsert') {
      const keys = this.conflict.map(k => k.trim());
      let r = rows.find(x => keys.every(k => same(x[k], this.payload[k])));
      if (r) Object.assign(r, this.payload);
      else { r = Object.assign({ id: rows.length + 1000 }, this.payload); rows.push(r); }
      return { data: [project(r, this.cols)], error: null };
    }
    let out = rows.filter(r => this.filters.every(f => f(r)));
    if (this.sortKey) {
      const k = this.sortKey, s = this.sortAsc ? 1 : -1;
      out = out.slice().sort((a, b) => (a[k] > b[k] ? s : a[k] < b[k] ? -s : 0));
    }
    if (this.max !== null) out = out.slice(0, this.max);
    return { data: out.map(r => project(r, this.cols)), error: null };
  }
  maybeSingle() {
    const { data } = this._run();
    if (data.length > 1) return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'multiple rows' } });
    return Promise.resolve({ data: data[0] || null, error: null });
  }
  single() {
    const { data } = this._run();
    if (data.length !== 1) return Promise.resolve({ data: null, error: { code: 'PGRST116', message: data.length + ' rows' } });
    return Promise.resolve({ data: data[0], error: null });
  }
  then(resolve, reject) {
    return Promise.resolve(this._run()).then(resolve, reject);
  }
}

function createFakeSupabase(db) {
  return {
    from: table => new Query(db, table),
    rpc: async (name, args) => {
      const fn = db.__rpc && db.__rpc[name];
      if (!fn) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name } };
      try { return { data: await fn(args, db), error: null }; }
      catch (e) { return { data: null, error: { code: 'P0001', message: e.message } }; }
    }
  };
}

module.exports = { createFakeSupabase };
