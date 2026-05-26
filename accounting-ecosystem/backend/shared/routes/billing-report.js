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
const XLSX      = require('xlsx');
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
            .select('company_id, employee_id, is_active')
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

    // ── Summary sheet ──────────────────────────────────────────────────────
    const summaryRows = [
      ['Lorenco Ecosystem — Monthly Platform Billing Report'],
      [],
      ['Practice:',       practiceName],
      ['Period:',         `${monthName} ${year}`],
      ['Generated:',      generatedAt],
      ['Total Clients:',  clients.length],
      [],
      ['Client Name', 'Apps Enabled', 'Active Employees', 'Payroll Runs', 'Payslips Generated', 'Payroll Status'],
    ];

    for (const client of clients) {
      const cid      = client.client_company_id;
      const apps     = Array.isArray(client.apps) ? client.apps : [];
      const appsStr  = apps.length > 0 ? apps.join(', ') : '(none)';
      const actEmps  = cid ? (activeEmpCount[cid] || 0) : 0;
      const runCt    = cid ? (payrollRunCount[cid] || 0) : 0;
      const snapCt   = cid ? (payslipCount[cid] || 0) : 0;

      const payStatus = !apps.includes('payroll')
        ? 'No Payroll App'
        : (runCt === 0 ? 'No run this period' : `${runCt} run${runCt !== 1 ? 's' : ''}`);

      summaryRows.push([client.name, appsStr, actEmps, runCt, snapCt, payStatus]);
    }

    // ── Payroll detail sheet ───────────────────────────────────────────────
    const payrollRows = [[
      'Practice Name',
      'Client Company Name',
      'Client Company ID',
      'Month',
      'Year',
      'Active Employees',
      'Employees Paid This Month',
      'Payroll Runs This Month',
      'Payslips Generated',
      'UIF Registered',
      'SDL Registered',
      'Billing Basis',
      'Rate Per Employee (R)',
      'Estimated Payroll Billing (R)',
      'Notes',
    ]];

    const payrollClients = clients.filter(c => Array.isArray(c.apps) && c.apps.includes('payroll'));

    if (payrollClients.length === 0) {
      payrollRows.push(['No payroll clients found for this practice.']);
    } else {
      for (const client of payrollClients) {
        const cid        = client.client_company_id;
        const actEmps    = cid ? (activeEmpCount[cid] || 0) : 0;
        const runCt      = cid ? (payrollRunCount[cid] || 0) : 0;
        const snapCt     = cid ? (payslipCount[cid] || 0) : 0;
        const paidCt     = cid ? (uniquePaidSet[cid]?.size || 0) : 0;
        const uifStr     = cid ? (uifMap[cid] !== false  ? 'Yes' : 'No') : '—';
        const sdlStr     = cid ? (sdlMap[cid] !== false  ? 'Yes' : 'No') : '—';
        const clientName = cid ? (companyNameMap[cid] || client.name) : client.name;
        const notes      = runCt === 0 ? 'No payroll run found for selected period' : '';

        payrollRows.push([
          practiceName,
          clientName,
          cid || '—',
          String(month).padStart(2, '0'),
          year,
          actEmps,
          paidCt,
          runCt,
          snapCt,
          uifStr,
          sdlStr,
          'Per Active Employee',
          '',   // Rate Per Employee — to be completed manually per billing agreement
          '',   // Estimated Billing — to be calculated per rate agreement
          notes,
        ]);
      }
    }

    // ── 6. Build XLSX workbook ─────────────────────────────────────────────
    const wb         = XLSX.utils.book_new();
    const wsSummary  = XLSX.utils.aoa_to_sheet(summaryRows);
    const wsPayroll  = XLSX.utils.aoa_to_sheet(payrollRows);

    wsSummary['!cols'] = [
      { wch: 30 }, { wch: 25 }, { wch: 20 },
      { wch: 14 }, { wch: 22 }, { wch: 22 },
    ];
    wsPayroll['!cols'] = [
      { wch: 22 }, { wch: 28 }, { wch: 20 }, { wch: 8  }, { wch: 6  },
      { wch: 18 }, { wch: 22 }, { wch: 20 }, { wch: 20 }, { wch: 16 },
      { wch: 16 }, { wch: 22 }, { wch: 20 }, { wch: 26 }, { wch: 42 },
    ];

    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');
    XLSX.utils.book_append_sheet(wb, wsPayroll, 'Payroll');

    // ── 7. Write buffer and send ────────────────────────────────────────────
    const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Sanitize practice name for use in filename
    const safeName   = practiceName.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '_');
    const filename   = `Billing_Report_${safeName}_${year}_${String(month).padStart(2, '0')}.xlsx`;

    res.set({
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      xlsxBuffer.length,
    });
    res.send(xlsxBuffer);

  } catch (err) {
    console.error('[billing-report] Error generating report:', err.message);
    res.status(500).json({ error: 'Failed to generate billing report' });
  }
});

module.exports = router;
