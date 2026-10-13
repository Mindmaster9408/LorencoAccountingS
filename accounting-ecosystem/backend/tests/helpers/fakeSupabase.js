'use strict';

/**
 * In-memory stand-in for the Supabase JS client, for route-level tests that need
 * real filter behaviour (tenant isolation, membership checks) without a database.
 *
 * Supports the query-builder subset the shared routes use:
 *   from(t).select().eq().neq().in().is().or().ilike().order().limit()
 *   .insert(rows).select().single() / .update(p) / .delete() / .upsert(rows)
 *   .single() / .maybeSingle() / await (thenable)
 *
 * `or('a.eq.x,b.eq.y')` supports only `.eq.` terms — enough for the
 * username-or-email lookups in auth/users routes.
 *
 * Usage:
 *   const { createFakeSupabase } = require('./helpers/fakeSupabase');
 *   const fake = createFakeSupabase({ users: [...], user_company_access: [...] });
 *   jest.mock('../config/database', () => ({ supabase: mockFake.client }));
 */
function createFakeSupabase(seed = {}) {
  const db = {};
  let nextId = 1000;

  function reset(newSeed = seed) {
    Object.keys(db).forEach(k => delete db[k]);
    for (const [table, rows] of Object.entries(newSeed)) {
      db[table] = rows.map(r => ({ ...r }));
    }
  }
  reset(seed);

  const same = (a, b) => String(a) === String(b);

  function from(table) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let returnSingle = false;
    let limitN = null;

    const matches = row => filters.every(f => f(row));

    function execute() {
      const rows = db[table] || (db[table] = []);
      let result;
      if (op === 'insert' || op === 'upsert') {
        const inserted = [].concat(payload).map(r => ({ id: r.id !== undefined ? r.id : nextId++, ...r }));
        rows.push(...inserted);
        result = inserted;
      } else if (op === 'update') {
        result = rows.filter(matches);
        result.forEach(r => Object.assign(r, payload));
      } else if (op === 'delete') {
        result = rows.filter(matches);
        db[table] = rows.filter(r => !matches(r));
      } else {
        result = rows.filter(matches);
      }
      if (limitN !== null) result = result.slice(0, limitN);
      const data = returnSingle ? (result[0] || null) : result.map(r => ({ ...r }));
      return { data: returnSingle && data ? { ...data } : data, error: null };
    }

    const builder = {
      select() { return builder; },
      eq(col, val) { filters.push(r => same(r[col], val)); return builder; },
      neq(col, val) { filters.push(r => !same(r[col], val)); return builder; },
      in(col, vals) { filters.push(r => vals.some(v => same(r[col], v))); return builder; },
      is(col, val) { filters.push(r => (val === null ? r[col] === null || r[col] === undefined : r[col] === val)); return builder; },
      ilike(col, val) { filters.push(r => String(r[col] || '').toLowerCase() === String(val).toLowerCase()); return builder; },
      or(expr) {
        const terms = expr.split(',').map(t => t.split('.eq.'));
        filters.push(r => terms.some(([col, val]) => same(r[col], val)));
        return builder;
      },
      order() { return builder; },
      limit(n) { limitN = n; return builder; },
      insert(rows) { op = 'insert'; payload = rows; return builder; },
      upsert(rows) { op = 'upsert'; payload = rows; return builder; },
      update(p) { op = 'update'; payload = p; return builder; },
      delete() { op = 'delete'; return builder; },
      single() { returnSingle = true; return Promise.resolve(execute()); },
      maybeSingle() { returnSingle = true; return Promise.resolve(execute()); },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
    };
    return builder;
  }

  return {
    client: { from },
    db,
    reset,
    rows: table => db[table] || [],
    find: (table, pred) => (db[table] || []).find(pred),
  };
}

/**
 * Invoke the final handler of an Express router route directly — skipping the
 * route-level middleware (auth/permission), which the caller simulates through
 * the `req` it passes in.
 */
async function callRoute(router, method, routePath, req) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route`);
  const handlers = layer.route.stack;
  let status = 200;
  let body;
  const res = {
    status(s) { status = s; return res; },
    json(b) { body = b; return res; },
  };
  await handlers[handlers.length - 1].handle({ params: {}, body: {}, query: {}, headers: {}, ...req }, res);
  return { status, body };
}

module.exports = { createFakeSupabase, callRoute };
