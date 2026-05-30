/**
 * ============================================================================
 * Billing Report Route — /api/ecosystem/billing-report
 * ============================================================================
 * Generates a monthly platform billing report per practice (account holder).
 * Super admin access only.
 *
 * Endpoint:
 *   GET /api/ecosystem/billing-report/practice/:practiceId
 *       ?month=5&year=2026&format=xlsx
 *
 * Returns: XLSX file download
 *   - Sheet 1: Summary (all clients, all apps)
 *   - Sheet 2: Payroll (clients with payroll app, employee counts, run counts)
 *
 * Security:
 *   - requireSuperAdmin applied to all routes in this file
 *   - practiceId validated against DB (never trusted from frontend)
 *   - All queries scoped to the practice's own clients only
 *   - No cross-practice data exposure
 * ============================================================================
 */

const express   = require('express');
const { supabase }          = require('../../config/database');
const { requireSuperAdmin } = require('../../middleware/auth');

const router = express.Router();

// All billing report endpoints are super-admin-only
router.use(requireSuperAdmin);

// ─── GET /api/ecosystem/billing-report/practice/:practiceId ──────────────────
router.get('/practice/:practiceId', async (req, res) => {
  try {
    // ── Validate inputs ────────────────────────────────────────────────────
    const practiceId = parseInt(req.params.practiceId, 10);
    if (!Number.isFinite(practiceId) || practiceId <= 0) {
      return res.status(400).json({ error: 'Invalid practiceId' });
    }

    const month = parseInt(req.query.month, 10);
    const year  = parseInt(req.query.year,  10);

    if (!month || month < 1 || month > 12) {
      return res.status(400).json({ error: 'month must be between 1 and 12' });
    }
    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ error: 'year is outside valid range (2020–2100)' });
    }

    // period_key format used throughout the payroll system: YYYY-MM
    const periodKey = `${year}-${String(month).padStart(2, '0')}`;

    // ── 1. Validate practice exists ────────────────────────────────────────
    const { data: practiceCompany, error: practiceErr } = await supabase
      .from('companies')
      .select('id, company_name, trading_name')
      .eq('id', practiceId)
      .maybeSingle();

    if (practiceErr) throw practiceErr;
    if (!practiceCompany) {
      return res.status(404).json({ error: 'Practice not found' });
    }

    const practiceName = practiceCompany.trading_name || practiceCompany.company_name || `Practice ${practiceId}`;

    // ── 2. Fetch all active clients managed by this practice ───────────────
    const { data: ecoClients, error: clientsErr } = await supabase
      .from('eco_clients')
      .select('id, name, client_company_id, apps, addons, is_active')
      .eq('company_id', practiceId)
      .eq('is_active', true)
      .order('name');

    if (clientsErr) throw clientsErr;

    const clients = ecoClients || [];

    // Collect all unique client_company_ids for batch queries
    const clientCompanyIds = [...new Set(
      clients.map(c => c.client_company_id).filter(Boolean)
    )];

    // ── 3. Batch fetch all data in parallel ────────────────────────────────
    // Each query is scoped to the practice's client_company_ids only.
    const [empsResult, runsResult, snapshotsResult, setupsResult, companiesResult] = await Promise.all([
      clientCompanyIds.length > 0
        ? supabase
            .from('employees')
            .select('company_id, is_active')
            .in('company_id', clientCompanyIds)
        : Promise.resolve({ data: [], error: null }),

      clientCompanyIds.length > 0
        ? supabase
            .from('payroll_runs')
            .select('company_id, id, status')
            .in('company_id', clientCompanyIds)
            .eq('period_key', periodKey)
        : Promise.resolve({ data: [], error: null }),

      clientCompanyIds.length > 0
        ? supabase
            .from('payroll_snapshots')
            .select('company_id, employee_id, is_locked')
            .in('company_id', clientCompanyIds)
            .eq('period_key', periodKey)
        : Promise.resolve({ data: [], error: null }),

      clientCompanyIds.length > 0
        ? supabase
            .from('company_setups')
            .select('company_id, sdl_registered, uif_registered')
            .in('company_id', clientCompanyIds)
        : Promise.resolve({ data: [], error: null }),

      clientCompanyIds.length > 0
        ? supabase
            .from('companies')
            .select('id, company_name, trading_name')
            .in('id', clientCompanyIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (empsResult.error)      throw empsResult.error;
    if (runsResult.error)      throw runsResult.error;
    if (snapshotsResult.error) throw snapshotsResult.error;
    if (companiesResult.error) throw companiesResult.error;
    // company_setups may not exist for every client — treat error as empty, not fatal
    const setupsData = setupsResult.error ? [] : (setupsResult.data || []);

    // ── 4. Build lookup maps ───────────────────────────────────────────────
    const activeEmpCount  = {};  // client_company_id → count of active employees
    const payrollRunCount = {};  // client_company_id → count of payroll_runs for period
    const payslipCount    = {};  // client_company_id → count of snapshots for period
    const uniquePaidSet   = {};  // client_company_id → Set of distinct employee_ids with snapshot
    const sdlMap          = {};  // client_company_id → bool (SDL registered)
    const uifMap          = {};  // client_company_id → bool (UIF registered)
    const companyNameMap  = {};  // client_company_id → display name

    (empsResult.data || []).forEach(e => {
      if (e.is_active) {
        activeEmpCount[e.company_id] = (activeEmpCount[e.company_id] || 0) + 1;
      }
    });

    (runsResult.data || []).forEach(r => {
      payrollRunCount[r.company_id] = (payrollRunCount[r.company_id] || 0) + 1;
    });

    (snapshotsResult.data || []).forEach(s => {
      payslipCount[s.company_id] = (payslipCount[s.company_id] || 0) + 1;
      if (!uniquePaidSet[s.company_id]) uniquePaidSet[s.company_id] = new Set();
      uniquePaidSet[s.company_id].add(s.employee_id);
    });

    setupsData.forEach(s => {
      // null/undefined means registered (default to true per PayrollDataService convention)
      sdlMap[s.company_id] = s.sdl_registered !== false;
      uifMap[s.company_id] = s.uif_registered !== false;
    });

    (companiesResult.data || []).forEach(c => {
      companyNameMap[c.id] = c.trading_name || c.company_name || null;
    });

    // ── 5. Build report data ───────────────────────────────────────────────
    const now       = new Date();
    const monthName = new Date(year, month - 1, 1).toLocaleString('en-ZA', { month: 'long' });
    const generatedAt = now.toLocaleString('en-ZA', {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    });

    // ── 6. Build HTML report ────────────────────────────────────────────────
    const afMonths = ['','Januarie','Februarie','Maart','April','Mei','Junie',
                      'Julie','Augustus','September','Oktober','November','Desember'];
    const monthLabel = afMonths[month] || monthName;

    // HTML-escape helper — escapes user-controlled strings into safe HTML
    const e = s => s == null ? '' : String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // ── Summary section rows ─────────────────────────────────────────────────
    const summaryTableBody = clients.length === 0
      ? '<tr><td colspan="4" class="empty-row">Geen aktiewe kli\u00ebnte.</td></tr>'
      : clients.map(client => {
          const cid     = client.client_company_id;
          const apps    = Array.isArray(client.apps) ? client.apps : [];
          const appsStr = apps.length > 0 ? apps.join(', ') : '(geen)';
          const actEmps = cid ? (activeEmpCount[cid] || 0) : 0;
          const runCt   = cid ? (payrollRunCount[cid] || 0) : 0;
          const payTag  = !apps.includes('payroll')
            ? '<span class="tag tag-none">Geen Payroll</span>'
            : (runCt === 0
              ? '<span class="tag tag-warn">Geen lopie</span>'
              : `<span class="tag tag-ok">${runCt} lopie${runCt !== 1 ? 's' : ''}</span>`);
          return `<tr><td>${e(client.name)}</td><td><small>${e(appsStr)}</small></td>`
               + `<td style="text-align:center">${actEmps}</td><td>${payTag}</td></tr>`;
        }).join('');

    // -- Payroll detail rows ----------------------------------------------------------
    const payrollClients = clients.filter(c => Array.isArray(c.apps) && c.apps.includes('payroll'));

    let totActEmps = 0, totPaidCt = 0, totRunCt = 0, totSnapCt = 0;

    const payrollRows = payrollClients.length === 0
      ? '<tr><td colspan="8" class="empty-row">Geen payroll-kliënte vir hierdie praktyk.</td></tr>'
      : payrollClients.map(client => {
          const cid        = client.client_company_id;
          const actEmps    = cid ? (activeEmpCount[cid] || 0) : 0;
          const runCt      = cid ? (payrollRunCount[cid] || 0) : 0;
          const snapCt     = cid ? (payslipCount[cid] || 0) : 0;
          const paidCt     = cid ? (uniquePaidSet[cid]?.size || 0) : 0;
          const uifStr     = cid != null ? (uifMap[cid] !== false ? 'Ja' : 'Nee') : '—';
          const sdlStr     = cid != null ? (sdlMap[cid] !== false ? 'Ja' : 'Nee') : '—';
          const clientName = cid ? (companyNameMap[cid] || client.name) : client.name;
          const notes      = runCt === 0 ? 'Geen lopie hierdie tydperk' : '';
          const rowCls     = runCt === 0 ? ' class="row-warn"' : '';

          totActEmps += actEmps;
          totPaidCt  += paidCt;
          totRunCt   += runCt;
          totSnapCt  += snapCt;

          return `<tr${rowCls}>`
               + `<td>${e(clientName)}</td>`
               + `<td style="text-align:center">${actEmps}</td>`
               + `<td style="text-align:center">${paidCt}</td>`
               + `<td style="text-align:center">${runCt}</td>`
               + `<td style="text-align:center">${snapCt}</td>`
               + `<td style="text-align:center">${uifStr}</td>`
               + `<td style="text-align:center">${sdlStr}</td>`
               + `<td>${notes ? `<em style="color:#a0aec0;font-size:11px">${e(notes)}</em>` : ""}</td>`
               + `</tr>`;
        }).join('');

    const payrollTotalsRow = payrollClients.length === 0 ? '' :
        '<tr class="totals-row">'
      + '<td><strong>Totaal (' + payrollClients.length + ' kliënte)</strong></td>'
      + `<td style="text-align:center"><strong>${totActEmps}</strong></td>`
      + `<td style="text-align:center"><strong>${totPaidCt}</strong></td>`
      + `<td style="text-align:center"><strong>${totRunCt}</strong></td>`
      + `<td style="text-align:center"><strong>${totSnapCt}</strong></td>`
      + '<td colspan="3"></td>'
      + '</tr>';

    const payrollTableBody = payrollRows + payrollTotalsRow;

    // ── HTML page assembly ────────────────────────────────────────────────────
    const pending = mod =>
      `  <div class="section">`
      + `<div class="section-head"><h2>${mod}</h2>`
      + `<span class="badge badge-pending">Databron Hangende</span></div>`
      + `<div class="pending-block">Gebruik-databron is nog nie ge\u00efntegreer in hierdie verslag nie. `
      + `Sal outomaties beskikbaar wees sodra die databron gekoppel is.</div>`
      + `</div>`;

    const reportHtml = [
      '<!DOCTYPE html><html lang="af"><head>',
      '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>Billing Verslag \u2014 ${e(practiceName)} \u2014 ${e(monthLabel)} ${year}</title>`,
      '<style>',
      '*{box-sizing:border-box;margin:0;padding:0}',
      "body{font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a202c;background:#f7fafc}",
      '.action-bar{background:#1e293b;padding:12px 32px;display:flex;gap:12px;align-items:center;position:sticky;top:0;z-index:100;border-bottom:1px solid #2d3748}',
      '.bar-title{flex:1;color:#a0aec0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.btn-print{padding:8px 18px;background:#3182ce;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500}.btn-print:hover{background:#2b6cb0}',
      '.btn-close{padding:8px 18px;background:transparent;color:#cbd5e0;border:1px solid #4a5568;border-radius:6px;cursor:pointer;font-size:13px}.btn-close:hover{background:#2d3748;color:#e2e8f0}',
      '.page{max-width:1100px;margin:0 auto;padding:32px;background:#fff}',
      '.report-header{margin-bottom:28px;padding-bottom:20px;border-bottom:2px solid #e2e8f0}',
      '.brand{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:#718096;margin-bottom:8px;font-weight:600}',
      '.report-title{font-size:22px;font-weight:700;color:#1a202c;margin-bottom:16px}',
      '.meta-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}',
      '.meta-item{background:#f7fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 14px}',
      '.mi-label{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#718096;margin-bottom:3px}',
      '.mi-value{font-size:14px;font-weight:600;color:#2d3748}',
      '.section{margin-bottom:32px}',
      '.section-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #edf2f7}',
      '.section-head h2{font-size:15px;font-weight:600;color:#2d3748}',
      '.badge{font-size:10px;text-transform:uppercase;letter-spacing:.8px;padding:3px 8px;border-radius:4px;font-weight:600}',
      '.badge-live{background:#c6f6d5;color:#276749}.badge-pending{background:#fef3c7;color:#92400e}',
      'table{width:100%;border-collapse:collapse;font-size:12px}',
      'th{background:#f7fafc;color:#4a5568;font-weight:600;text-align:left;padding:8px 12px;border-bottom:2px solid #e2e8f0;white-space:nowrap;font-size:11px;text-transform:uppercase;letter-spacing:.5px}',
      'td{padding:8px 12px;border-bottom:1px solid #edf2f7;color:#2d3748;vertical-align:top}',
      'tr:last-child td{border-bottom:none}',
      '.row-warn td{background:#fffff8}',
      '.totals-row td{background:#edf2f7;border-top:2px solid #cbd5e0;font-size:12px}',
      '.empty-row{color:#718096;font-style:italic;text-align:center!important;padding:24px}',
      '.tag{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:500}',
      '.tag-ok{background:#c6f6d5;color:#276749}.tag-warn{background:#fef3c7;color:#92400e}.tag-none{background:#edf2f7;color:#718096}',
      '.pending-block{background:#fffbeb;border:1px dashed #f6ad55;border-radius:6px;padding:14px 18px;color:#744210;font-size:12px}',
      'footer{margin-top:40px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:11px;color:#a0aec0;text-align:center}',
      '@media print{',
      '.action-bar{display:none!important}',
      'body{background:#fff;font-size:11px}',
      '.page{padding:16px;max-width:100%}',
      '.section{page-break-inside:avoid}',
      '.meta-item,.pending-block{border:1px solid #ccc}',
      '}',
      '</style>',
      '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},400);});</script>',
      '</head><body>',
      '<div class="action-bar">',
      `  <span class="bar-title">Lorenco &mdash; Billing Verslag &mdash; ${e(practiceName)} &mdash; ${e(monthLabel)} ${year}</span>`,
      '  <button class="btn-print" onclick="window.print()">&#128438; Print / Stoor as PDF</button>',
      '  <button class="btn-close" onclick="window.close()">&#x2715; Sluit</button>',
      '</div>',
      '<div class="page">',
      '  <div class="report-header">',
      '    <div class="brand">Lorenco Ecosystem &mdash; Platform Billing Verslag</div>',
      '    <h1 class="report-title">Maandelikse Billing Verslag</h1>',
      '    <div class="meta-grid">',
      `      <div class="meta-item"><div class="mi-label">Praktyk</div><div class="mi-value">${e(practiceName)}</div></div>`,
      `      <div class="meta-item"><div class="mi-label">Tydperk</div><div class="mi-value">${e(monthLabel)} ${year}</div></div>`,
      `      <div class="meta-item"><div class="mi-label">Gegenereer</div><div class="mi-value">${e(generatedAt)}</div></div>`,
      `      <div class="meta-item"><div class="mi-label">Totale Kli\u00ebnte</div><div class="mi-value">${clients.length}</div></div>`,
      '    </div>',
      '  </div>',
      '  <div class="section">',
      '    <div class="section-head"><h2>&#128203; Oorsig &mdash; Alle Kli\u00ebnte</h2><span class="badge badge-live">Lewendig</span></div>',
      '    <table><thead><tr>',
      '      <th>Kli\u00ebnt Naam</th><th>Apps Geaktiveer</th><th style="text-align:center">Aktiewe Werknemers</th><th>Payroll Status</th>',
      `    </tr></thead><tbody>${summaryTableBody}</tbody></table>`,
      '  </div>',
      '  <div class="section">',
      '    <div class="section-head"><h2>&#128202; Payroll (Salarisrekening)</h2><span class="badge badge-live">Lewendig</span></div>',
      '    <table><thead><tr>',
      '      <th>Kli\u00ebnt Naam</th>',
      '      <th style="text-align:center">Aktiewe Werknemers</th>',
      '      <th style="text-align:center">Betaal Hierdie Maand</th>',
      '      <th style="text-align:center">Lopies</th>',
      '      <th style="text-align:center">Besoldigingstrookies</th>',
      '      <th style="text-align:center">UIF</th>',
      '      <th style="text-align:center">SDL</th>',
      '      <th>Notas</th>',
      `    </tr></thead><tbody>${payrollTableBody}</tbody></table>`,
      '  </div>',
      pending('&#128218; Rekeningkunde (Accounting)'),
      pending('&#128722; Checkout Charlie (POS)'),
      pending('&#128230; Storehouse (Voorraad)'),
      pending('&#129302; Sean AI'),
      `  <footer><p>Lorenco Ecosystem &mdash; Vertroulik &mdash; Slegs vir interne gebruik &mdash; ${e(generatedAt)}</p></footer>`,
      '</div></body></html>',
    ].join('\n');

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(reportHtml);
  } catch (err) {
    console.error('[billing-report] Error generating report:', err.message);
    res.status(500).json({ error: 'Failed to generate billing report' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Payroll invoice — pricing schedule
// Applied to PRACTICE TOTAL active employees (not per payroll company).
// ─────────────────────────────────────────────────────────────────────────────
const PAYROLL_PRICING = [
  { min: 0,   max: 5,   rate: 17.50,  base: 50.00    },
  { min: 6,   max: 10,  rate: 14.00,  base: 137.50   },
  { min: 11,  max: 300, rate: 12.00,  base: 207.50   },
  { min: 301, max: 500, rate: 9.00,   base: 3687.50  },
];

function getPayrollBracket(empCount) {
  for (const tier of PAYROLL_PRICING) {
    if (empCount >= tier.min && empCount <= tier.max) return tier;
  }
  // Above 500 — apply highest tier
  return PAYROLL_PRICING[PAYROLL_PRICING.length - 1];
}

function fmtCurrency(n) {
  const abs = Math.abs(parseFloat(n) || 0).toFixed(2);
  return 'R ' + abs.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// ── GET /api/ecosystem/billing-report/payroll-invoice/:practiceId ─────────────
// Generates and streams a professional PDF Tax Invoice for the practice's
// combined payroll usage (all payroll-linked client companies aggregated).
//
// Query params: month (1-12), year (YYYY)
// Returns: application/pdf — triggers browser download
// Security: requireSuperAdmin (inherited from router.use at top of file)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/payroll-invoice/:practiceId', async (req, res) => {
  const PDFDocument = require('pdfkit');

  try {
    // ── 1. Validate inputs ─────────────────────────────────────────────────
    const practiceId = parseInt(req.params.practiceId, 10);
    if (!Number.isFinite(practiceId) || practiceId <= 0) {
      return res.status(400).json({ error: 'Invalid practiceId' });
    }

    const month = parseInt(req.query.month, 10);
    const year  = parseInt(req.query.year,  10);

    if (!month || month < 1 || month > 12) {
      return res.status(400).json({ error: 'month must be between 1 and 12' });
    }
    if (!year || year < 2020 || year > 2100) {
      return res.status(400).json({ error: 'year is outside valid range (2020–2100)' });
    }

    const periodKey = `${year}-${String(month).padStart(2, '0')}`;

    // ── 2. Validate practice ───────────────────────────────────────────────
    const { data: practiceCompany, error: practiceErr } = await supabase
      .from('companies')
      .select('id, company_name, trading_name')
      .eq('id', practiceId)
      .maybeSingle();

    if (practiceErr) throw practiceErr;
    if (!practiceCompany) {
      return res.status(404).json({ error: 'Practice not found' });
    }

    const practiceName = practiceCompany.trading_name || practiceCompany.company_name
      || `Practice ${practiceId}`;

    // ── 3. Fetch all payroll-linked eco_clients for this practice ──────────
    const { data: ecoClients, error: clientsErr } = await supabase
      .from('eco_clients')
      .select('id, name, client_company_id, apps, is_active')
      .eq('company_id', practiceId)
      .eq('is_active', true)
      .order('name');

    if (clientsErr) throw clientsErr;

    const payrollClients = (ecoClients || []).filter(
      c => Array.isArray(c.apps) && c.apps.includes('payroll')
    );

    const clientCompanyIds = [...new Set(
      payrollClients.map(c => c.client_company_id).filter(Boolean)
    )];

    // ── 4. Aggregate active employee counts ────────────────────────────────
    let activeEmpCount = {};   // { company_id → count }
    let companyNameMap = {};   // { company_id → display name }

    if (clientCompanyIds.length > 0) {
      const [empsResult, companiesResult] = await Promise.all([
        supabase
          .from('employees')
          .select('company_id, is_active')
          .in('company_id', clientCompanyIds),
        supabase
          .from('companies')
          .select('id, company_name, trading_name')
          .in('id', clientCompanyIds),
      ]);

      if (empsResult.error)      throw empsResult.error;
      if (companiesResult.error) throw companiesResult.error;

      (empsResult.data || []).forEach(e => {
        if (e.is_active) {
          activeEmpCount[e.company_id] = (activeEmpCount[e.company_id] || 0) + 1;
        }
      });

      (companiesResult.data || []).forEach(c => {
        companyNameMap[c.id] = c.trading_name || c.company_name || null;
      });
    }

    // ── 5. Build company breakdown and totals ──────────────────────────────
    const companyBreakdown = payrollClients.map(client => {
      const cid  = client.client_company_id;
      const name = (cid && companyNameMap[cid]) || client.name;
      const emps = cid ? (activeEmpCount[cid] || 0) : 0;
      return { name, activeEmployees: emps };
    }).sort((a, b) => b.activeEmployees - a.activeEmployees);

    const totalActiveEmployees = companyBreakdown.reduce(
      (sum, c) => sum + c.activeEmployees, 0
    );

    // ── 6. Calculate billing ───────────────────────────────────────────────
    const bracket      = getPayrollBracket(totalActiveEmployees);
    const employeeFee  = Math.round(totalActiveEmployees * bracket.rate * 100) / 100;
    const baseFee      = bracket.base;
    const monthlyTotal = Math.round((employeeFee + baseFee) * 100) / 100;

    // ── 7. Invoice metadata ────────────────────────────────────────────────
    const invoiceDate = new Date().toLocaleDateString('en-ZA', {
      day: '2-digit', month: 'long', year: 'numeric'
    });
    const invoiceNumber = `LTPI-${year}${String(month).padStart(2, '0')}-${String(practiceId).padStart(4, '0')}`;

    const afMonths = ['','Januarie','Februarie','Maart','April','Mei','Junie',
                      'Julie','Augustus','September','Oktober','November','Desember'];
    const monthLabel = afMonths[month] || String(month);
    const periodLabel = `${monthLabel} ${year}`;

    const generatedBy  = (req.user && (req.user.email || req.user.username)) || 'System';
    const generatedAt  = new Date().toLocaleString('en-ZA', {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    });

    const safeFilename = practiceName.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').toLowerCase();
    const filename = `lorenco-payroll-invoice-${safeFilename}-${year}-${String(month).padStart(2, '0')}.pdf`;

    // ── 8. Generate PDF ────────────────────────────────────────────────────
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title:   `Lorenco Paytime Tax Invoice — ${practiceName} — ${periodLabel}`,
        Author:  'Lorenco Ecosystem',
        Creator: 'Lorenco Paytime Billing',
      },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    // ── Constants ──────────────────────────────────────────────────────────
    const PAGE_W = doc.page.width;         // 595.28
    const L      = 50;                     // left margin
    const W      = PAGE_W - 100;           // content width (~495)
    const R      = L + W;                  // right edge

    // Palette
    const NAVY     = '#0f172a';
    const NAVY2    = '#1e293b';
    const BLUE     = '#2563eb';
    const TEAL     = '#0d9488';
    const WHITE    = '#ffffff';
    const DARK     = '#1a202c';
    const MUTED    = '#64748b';
    const BORDER   = '#e2e8f0';
    const TBL_HDR  = '#f1f5f9';
    const TBL_ALT  = '#fafbfc';
    const HI_BG    = '#f0fdf4';
    const HI_BAR   = '#22c55e';
    const HI_TEXT  = '#14532d';
    const TOT_BG   = NAVY2;

    let y = 0;  // current drawing Y (doc will start at margin 50)

    // ── Helper: check if new page needed ──────────────────────────────────
    function maybeNewPage(neededPts = 60) {
      if (y + neededPts > doc.page.height - 60) {
        doc.addPage();
        y = 50;
      }
    }

    // ── Helper: draw table header row ─────────────────────────────────────
    function tblHeader(cols) {
      doc.rect(L, y, W, 22).fill(TBL_HDR);
      let x = L;
      cols.forEach(col => {
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(MUTED)
           .text(col.label.toUpperCase(), x + 6, y + 7,
                 { width: col.w - 12, align: col.align || 'left', lineBreak: false });
        x += col.w;
      });
      doc.rect(L, y + 22, W, 0.5).fill(BORDER);
      y += 22;
    }

    // ── Helper: draw a table row ───────────────────────────────────────────
    // opts: { bg, bold, textColor, highlight, height }
    function tblRow(cells, cols, opts = {}) {
      const rh = opts.height || 24;
      maybeNewPage(rh + 4);

      if (opts.bg) doc.rect(L, y, W, rh).fill(opts.bg);
      if (opts.highlight) {
        // left accent bar for highlighted bracket row
        doc.rect(L, y, 3, rh).fill(HI_BAR);
      }

      let x = L;
      cells.forEach((cell, i) => {
        const col     = cols[i];
        const align   = col.align || 'left';
        const txtX    = align === 'right' ? x + col.w - 70 : x + 6;
        const txtW    = align === 'right' ? 64 : col.w - 12;
        doc.fontSize(9)
           .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
           .fillColor(opts.textColor || DARK)
           .text(String(cell ?? ''), txtX, y + (rh - 10) / 2 + 1,
                 { width: txtW, align, lineBreak: false });
        x += col.w;
      });

      doc.rect(L, y + rh, W, 0.5).fill(BORDER);
      y += rh;
    }

    // ── Helper: section heading ────────────────────────────────────────────
    function sectionHeading(label) {
      maybeNewPage(40);
      doc.rect(L, y, 3, 18).fill(BLUE);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DARK)
         .text(label, L + 10, y + 2, { lineBreak: false });
      y += 28;
    }

    // ── DRAW: Header block ─────────────────────────────────────────────────
    const HDR_H = 110;
    doc.rect(0, 0, PAGE_W, HDR_H).fill(NAVY);
    doc.rect(0, HDR_H, PAGE_W, 4).fill(BLUE);

    // Brand line
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(BLUE)
       .text('LORENCO ECOSYSTEM  ·  PAYTIME PAYROLL', L, 18, { lineBreak: false });

    // Main title
    doc.fontSize(22).font('Helvetica-Bold').fillColor(WHITE)
       .text('TAX INVOICE', L, 30, { lineBreak: false });

    // Invoice number (right side)
    doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
       .text('INVOICE NO.', R - 130, 22, { width: 130, align: 'right', lineBreak: false });
    doc.fontSize(11).font('Helvetica-Bold').fillColor(WHITE)
       .text(invoiceNumber, R - 130, 33, { width: 130, align: 'right', lineBreak: false });

    // Practice name
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#e2e8f0')
       .text(practiceName, L, 64, { width: W - 140, lineBreak: false });

    // Period tag
    doc.rect(R - 120, 58, 120, 22).fill(BLUE);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE)
       .text(periodLabel, R - 120, 64, { width: 120, align: 'center', lineBreak: false });

    y = HDR_H + 18;

    // ── DRAW: Meta grid (4 boxes) ──────────────────────────────────────────
    const META_ITEMS = [
      { label: 'Practice',      value: practiceName      },
      { label: 'Billing Period', value: periodLabel       },
      { label: 'Invoice Date',  value: invoiceDate       },
      { label: 'Generated By',  value: generatedBy       },
    ];

    const boxW = Math.floor(W / 4);
    META_ITEMS.forEach((item, i) => {
      const bx = L + i * boxW;
      doc.rect(bx, y, boxW - 4, 44).fill(TBL_HDR)
         .rect(bx, y, boxW - 4, 1).fill(BORDER);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
         .text(item.label.toUpperCase(), bx + 7, y + 7,
               { width: boxW - 18, lineBreak: false });
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(DARK)
         .text(item.value, bx + 7, y + 20,
               { width: boxW - 18, lineBreak: true });
    });

    y += 58;

    // ── DRAW: Section 1 — Payroll Billing ─────────────────────────────────
    sectionHeading('Section 1 — Payroll Billing');

    const billingCols = [
      { label: 'Description',            w: 250 },
      { label: 'Quantity',               w: 75,  align: 'right' },
      { label: 'Rate',                   w: 85,  align: 'right' },
      { label: 'Amount',                 w: W - 410, align: 'right' },
    ];

    tblHeader(billingCols);

    tblRow(
      [
        'Active Employees Processed',
        String(totalActiveEmployees),
        fmtCurrency(bracket.rate),
        fmtCurrency(employeeFee),
      ],
      billingCols,
      { bg: totalActiveEmployees === 0 ? TBL_ALT : WHITE }
    );

    tblRow(
      [
        'Payroll Base Fee',
        '1',
        fmtCurrency(baseFee),
        fmtCurrency(baseFee),
      ],
      billingCols,
      { bg: TBL_ALT }
    );

    if (totalActiveEmployees === 0) {
      tblRow(
        ['No active payroll employees found for selected period.', '', '', ''],
        billingCols,
        { bg: '#fffbeb', textColor: '#92400e', height: 28 }
      );
    }

    // Total row
    tblRow(
      ['', '', 'Monthly Total', fmtCurrency(monthlyTotal)],
      billingCols,
      { bg: TOT_BG, bold: true, textColor: WHITE, height: 28 }
    );

    y += 20;

    // ── DRAW: Section 2 — Billing Basis ───────────────────────────────────
    maybeNewPage(180);
    sectionHeading('Section 2 — Pricing Basis');

    const pricingCols = [
      { label: 'Employee Range',   w: 150 },
      { label: 'Rate per Employee', w: 115, align: 'right' },
      { label: 'Base Fee',         w: 115, align: 'right' },
      { label: 'Applied',          w: W - 380, align: 'center' },
    ];

    tblHeader(pricingCols);

    PAYROLL_PRICING.forEach(tier => {
      const isApplied = tier === bracket;
      const rangeLabel = tier.max >= 500
        ? `${tier.min}–${tier.max} employees (max)`
        : `${tier.min}–${tier.max} employees`;

      tblRow(
        [
          rangeLabel,
          fmtCurrency(tier.rate) + ' / emp',
          fmtCurrency(tier.base),
          isApplied ? '✓ Applied' : '',
        ],
        pricingCols,
        {
          bg:        isApplied ? HI_BG     : (tier === PAYROLL_PRICING[1] ? TBL_ALT : WHITE),
          highlight: isApplied,
          textColor: isApplied ? HI_TEXT   : DARK,
          bold:      isApplied,
          height:    26,
        }
      );
    });

    y += 20;

    // ── DRAW: Section 3 — Company Breakdown ───────────────────────────────
    maybeNewPage(60 + companyBreakdown.length * 25);
    sectionHeading('Section 3 — Payroll Company Breakdown');

    const breakdownCols = [
      { label: 'Payroll Company',   w: W - 135 },
      { label: 'Active Employees',  w: 135, align: 'right' },
    ];

    tblHeader(breakdownCols);

    if (companyBreakdown.length === 0) {
      tblRow(
        ['No payroll companies linked to this practice.', ''],
        breakdownCols,
        { bg: TBL_ALT, textColor: MUTED, height: 28 }
      );
    } else {
      companyBreakdown.forEach((co, idx) => {
        tblRow(
          [co.name, String(co.activeEmployees)],
          breakdownCols,
          { bg: idx % 2 === 1 ? TBL_ALT : WHITE, height: 24 }
        );
      });

      // Total row
      tblRow(
        [`TOTAL (${companyBreakdown.length} compan${companyBreakdown.length === 1 ? 'y' : 'ies'})`,
         String(totalActiveEmployees)],
        breakdownCols,
        { bg: TOT_BG, bold: true, textColor: WHITE, height: 28 }
      );
    }

    y += 28;

    // ── DRAW: Footer ───────────────────────────────────────────────────────
    maybeNewPage(60);
    doc.rect(L, y, W, 0.5).fill(BORDER);
    y += 10;

    doc.fontSize(7.5).font('Helvetica').fillColor(MUTED)
       .text(
         `Lorenco Ecosystem  ·  Platform Billing  ·  Confidential — Internal Use Only  ·  Generated: ${generatedAt}`,
         L, y, { width: W, align: 'center', lineBreak: false }
       );

    y += 14;
    doc.fontSize(7).font('Helvetica').fillColor(MUTED)
       .text(
         `This invoice reflects the combined payroll usage of ${practiceName} across all linked payroll companies for the period ${periodLabel}.`,
         L, y, { width: W, align: 'center', lineBreak: true }
       );

    doc.end();

  } catch (err) {
    console.error('[payroll-invoice] Error generating PDF:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate payroll invoice' });
    }
  }
});

module.exports = router;

