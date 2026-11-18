'use strict';

/**
 * Read EVERY row of a Supabase query, page by page.
 *
 * Supabase (PostgREST) returns at most 1000 rows per request — also with .limit(5000) —
 * and silently drops the rest (proved 2026-11-18: audit_log 23 126 rows → 1000 returned).
 * Paytime's recon, EMP501, e@syFile and reports read all payslips of a company for a
 * tax year, so a company with > ~83 employees got silently low totals (audit H2).
 *
 * @param {() => object} makeQuery  returns a NEW query builder each call (builders are single-use),
 *                                  without .range/.limit — e.g. () => supabase.from('t').select('a').eq(...)
 * @param {{pageSize?: number, maxRows?: number, orderBy?: string}} [opts]
 * @returns {Promise<{data: Array|null, error: object|null}>} same shape as a Supabase result
 */
async function fetchAllRows(makeQuery, opts = {}) {
  const pageSize = opts.pageSize || 1000;
  const maxRows  = opts.maxRows || 500000;
  const orderBy  = opts.orderBy || 'id';      // stable order → no row skipped or read twice
  const out = [];
  // Advance by the rows actually returned and stop only on an empty page: the server's
  // row cap may be LOWER than pageSize, so a short page does not mean "last page".
  for (let from = 0; ;) {
    const { data, error } = await makeQuery()
      .order(orderBy, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    const rows = data || [];
    if (!rows.length) break;
    out.push(...rows);
    from += rows.length;
    if (out.length >= maxRows) {
      return { data: null, error: { message: `More than ${maxRows} rows — narrow the request` } };
    }
  }
  return { data: out, error: null };
}

module.exports = { fetchAllRows };
