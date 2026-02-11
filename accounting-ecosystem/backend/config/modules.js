/**
 * ============================================================================
 * Module Configuration - Accounting Ecosystem
 * ============================================================================
 * Controls which modules are active. Server.js only registers routes
 * for enabled modules. The module-check middleware blocks requests
 * to disabled modules.
 *
 * Modules:
 *   pos        — Checkout Charlie Point of Sale (ENABLED by default)
 *   payroll    — Lorenco Paytime Payroll       (DISABLED — ready but inactive)
 *   accounting — General Ledger / Accounting   (DISABLED — future)
 * ============================================================================
 */

const modules = {
  pos: {
    name: 'Checkout Charlie POS',
    key: 'pos',
    active: (process.env.MODULE_POS_ENABLED || process.env['MODULE_POS-ENABLED'] || '').toLowerCase() === 'true',
    version: '1.0.0',
    description: 'Point of Sale — products, sales, tills, customers, inventory',
    routePrefix: '/api/pos',
    requiredTables: ['products', 'categories', 'sales', 'sale_items', 'sale_payments', 'customers', 'inventory_adjustments'],
  },
  payroll: {
    name: 'Lorenco Paytime Payroll',
    key: 'payroll',
    active: (process.env.MODULE_PAYROLL_ENABLED || '').toLowerCase() === 'true',
    version: '1.0.0',
    description: 'Payroll — pay runs, payslips, tax, attendance, leave',
    routePrefix: '/api/payroll',
    requiredTables: ['payroll_periods', 'payroll_transactions', 'payslip_items', 'payroll_items_master', 'attendance', 'employee_bank_details'],
  },
  accounting: {
    name: 'Lorenco Accounting',
    key: 'accounting',
    active: (process.env.MODULE_ACCOUNTING_ENABLED || '').toLowerCase() === 'true',
    version: '1.0.0',
    description: 'General Ledger, Chart of Accounts, Journals, Bank Reconciliation, Reports',
    routePrefix: '/api/accounting',
    requiredTables: ['chart_of_accounts', 'journal_entries', 'journal_lines', 'bank_accounts', 'bank_transactions_gl', 'financial_periods'],
  },
  sean: {
    name: 'SEAN AI Assistant',
    key: 'sean',
    active: (process.env.MODULE_SEAN_ENABLED || '').toLowerCase() === 'true',
    version: '1.0.0',
    description: 'Privacy-first AI accounting assistant — allocations, tax calculations, self-learning codex',
    routePrefix: '/api/sean',
    requiredTables: ['sean_codex_private', 'sean_patterns_global', 'sean_learning_log', 'sean_knowledge_items', 'sean_allocation_rules', 'sean_bank_transactions'],
  }
};

/**
 * Check if a module is enabled
 * @param {string} moduleKey - 'pos', 'payroll', or 'accounting'
 * @returns {boolean}
 */
function isModuleEnabled(moduleKey) {
  return modules[moduleKey] && modules[moduleKey].active === true;
}

/**
 * Get all enabled modules
 * @returns {Object[]}
 */
function getEnabledModules() {
  return Object.values(modules).filter(m => m.active);
}

/**
 * Get all modules (enabled + disabled) for status endpoint
 */
function getAllModules() {
  return Object.values(modules).map(m => ({
    key: m.key,
    name: m.name,
    active: m.active,
    version: m.version,
    description: m.description
  }));
}

/**
 * Check if a user's company has a specific module enabled
 * (Checks the company's modules_enabled array in the database)
 */
async function companyHasModule(supabase, companyId, moduleKey) {
  if (!companyId) return false;
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('modules_enabled')
      .eq('id', companyId)
      .single();

    if (error || !data) return false;
    return Array.isArray(data.modules_enabled) && data.modules_enabled.includes(moduleKey);
  } catch {
    return false;
  }
}

module.exports = {
  modules,
  isModuleEnabled,
  getEnabledModules,
  getAllModules,
  companyHasModule
};
