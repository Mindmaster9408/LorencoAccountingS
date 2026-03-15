/**
 * ============================================================================
 * Role-Based Access Control (RBAC) - Unified Ecosystem
 * ============================================================================
 * Merged permissions from POS and Payroll systems.
 *
 * Role Hierarchy:
 *   super_admin (100)  — Platform-wide access
 *   business_owner (95) — Full company access
 *   accountant (90)     — Finance + payroll access
 *   store_manager (70)  — Store-level POS management
 *   payroll_admin (70)  — Payroll management
 *   assistant_manager (50) — Limited management
 *   cashier (20)        — POS terminal only
 *   trainee (5)         — Supervised access
 * ============================================================================
 */

const ROLE_LEVELS = {
  super_admin: 100,
  business_owner: 95,
  accountant: 90,
  corporate_admin: 90,
  store_manager: 70,
  payroll_admin: 70,
  leave_admin: 50,       // Leave-only Paytime access — no payroll/salary visibility
  assistant_manager: 50,
  shift_supervisor: 40,
  senior_cashier: 30,
  cashier: 20,
  trainee: 5,
  // Legacy mappings
  admin: 70,
};

const MANAGEMENT_ROLES = ['super_admin', 'business_owner', 'accountant', 'corporate_admin', 'store_manager', 'payroll_admin', 'admin'];
const SUPERVISOR_ROLES = [...MANAGEMENT_ROLES, 'leave_admin', 'assistant_manager', 'shift_supervisor'];
const ALL_ROLES = [...SUPERVISOR_ROLES, 'senior_cashier', 'cashier', 'trainee'];

const PERMISSIONS = {
  // ===== SHARED =====
  COMPANIES: {
    VIEW: MANAGEMENT_ROLES,
    CREATE: ['super_admin', 'business_owner'],
    EDIT: ['super_admin', 'business_owner'],
    DELETE: ['super_admin'],
  },
  USERS: {
    VIEW: MANAGEMENT_ROLES,
    CREATE: MANAGEMENT_ROLES,
    EDIT: MANAGEMENT_ROLES,
    DELETE: ['super_admin', 'business_owner'],
  },
  EMPLOYEES: {
    VIEW: MANAGEMENT_ROLES,
    CREATE: MANAGEMENT_ROLES,
    EDIT: MANAGEMENT_ROLES,
    DELETE: ['super_admin', 'business_owner'],
  },
  AUDIT: {
    VIEW: ['super_admin', 'business_owner', 'accountant'],
    EXPORT: ['super_admin', 'business_owner'],
  },

  // ===== POS MODULE =====
  PRODUCTS: {
    VIEW: ALL_ROLES,
    CREATE: MANAGEMENT_ROLES,
    EDIT: MANAGEMENT_ROLES,
    DELETE: ['super_admin', 'business_owner', 'store_manager'],
    PRICE_CHANGE: MANAGEMENT_ROLES,
  },
  SALES: {
    VIEW: ALL_ROLES,
    CREATE: ALL_ROLES.filter(r => r !== 'trainee'),
    VOID: SUPERVISOR_ROLES,
    REFUND: MANAGEMENT_ROLES,
    DISCOUNT: SUPERVISOR_ROLES,
  },
  CUSTOMERS: {
    VIEW: ALL_ROLES,
    CREATE: SUPERVISOR_ROLES,
    EDIT: SUPERVISOR_ROLES,
    DELETE: MANAGEMENT_ROLES,
  },
  INVENTORY: {
    VIEW: SUPERVISOR_ROLES,
    ADJUST: MANAGEMENT_ROLES,
    TRANSFER: MANAGEMENT_ROLES,
  },
  TILLS: {
    VIEW: ALL_ROLES,
    OPEN: ALL_ROLES.filter(r => r !== 'trainee'),
    CLOSE: ALL_ROLES.filter(r => r !== 'trainee'),
    MANAGE: MANAGEMENT_ROLES,
  },
  REPORTS: {
    VIEW: SUPERVISOR_ROLES,
    EXPORT: MANAGEMENT_ROLES,
  },

  // ===== ACCOUNTING MODULE =====
  ACCOUNTS: {
    VIEW: ['super_admin', 'business_owner', 'accountant', 'payroll_admin'],
    CREATE: ['super_admin', 'business_owner', 'accountant'],
    EDIT: ['super_admin', 'business_owner', 'accountant'],
    DELETE: ['super_admin', 'business_owner'],
  },
  JOURNALS: {
    VIEW: ['super_admin', 'business_owner', 'accountant', 'payroll_admin'],
    CREATE: ['super_admin', 'business_owner', 'accountant'],
    POST: ['super_admin', 'business_owner', 'accountant'],
    REVERSE: ['super_admin', 'business_owner', 'accountant'],
  },
  BANK: {
    VIEW: ['super_admin', 'business_owner', 'accountant', 'payroll_admin'],
    CREATE: ['super_admin', 'business_owner', 'accountant'],
    ALLOCATE: ['super_admin', 'business_owner', 'accountant'],
    RECONCILE: ['super_admin', 'business_owner', 'accountant'],
  },
  GL_REPORTS: {
    VIEW: ['super_admin', 'business_owner', 'accountant', 'payroll_admin'],
    EXPORT: ['super_admin', 'business_owner', 'accountant'],
    CLOSE_PERIOD: ['super_admin', 'business_owner', 'accountant'],
  },

  // ===== PAYROLL MODULE =====
  PAYROLL: {
    VIEW: ['super_admin', 'business_owner', 'accountant', 'payroll_admin'],
    CREATE: ['super_admin', 'business_owner', 'accountant', 'payroll_admin'],
    APPROVE: ['super_admin', 'business_owner'],
    PROCESS: ['super_admin', 'business_owner', 'accountant'],
  },
  PAYSLIPS: {
    VIEW: ['super_admin', 'business_owner', 'accountant', 'payroll_admin'],
    GENERATE: ['super_admin', 'business_owner', 'accountant', 'payroll_admin'],
  },
  ATTENDANCE: {
    VIEW: SUPERVISOR_ROLES,
    RECORD: ALL_ROLES.filter(r => r !== 'trainee'),
    EDIT: MANAGEMENT_ROLES,
  },
  // Leave management — accessible to leave_admin (cannot access PAYROLL.VIEW)
  LEAVE: {
    VIEW: ['super_admin', 'business_owner', 'accountant', 'payroll_admin', 'leave_admin'],
    CREATE: ['super_admin', 'business_owner', 'accountant', 'payroll_admin', 'leave_admin'],
    APPROVE: ['super_admin', 'business_owner', 'accountant', 'payroll_admin', 'leave_admin'],
  },
};

/**
 * Check if a role has a specific permission
 * @param {string} role
 * @param {string} category - e.g. 'PRODUCTS'
 * @param {string} action - e.g. 'CREATE'
 * @returns {boolean}
 */
function hasPermission(role, category, action) {
  if (!PERMISSIONS[category] || !PERMISSIONS[category][action]) return false;
  return PERMISSIONS[category][action].includes(role);
}

/**
 * Check if roleA can manage roleB (needs higher level)
 */
function canManageRole(managerRole, targetRole) {
  const managerLevel = ROLE_LEVELS[managerRole] || 0;
  const targetLevel = ROLE_LEVELS[targetRole] || 0;
  return managerLevel > targetLevel;
}

/**
 * Get all available roles
 */
function getAllRoles() {
  return Object.entries(ROLE_LEVELS)
    .filter(([role]) => role !== 'admin') // exclude legacy alias
    .map(([role, level]) => ({ role, level }))
    .sort((a, b) => b.level - a.level);
}

/**
 * Get permissions summary for a role
 */
function getRolePermissions(role) {
  const perms = {};
  for (const [category, actions] of Object.entries(PERMISSIONS)) {
    perms[category] = {};
    for (const [action, roles] of Object.entries(actions)) {
      perms[category][action] = roles.includes(role);
    }
  }
  return perms;
}

module.exports = {
  ROLE_LEVELS,
  PERMISSIONS,
  MANAGEMENT_ROLES,
  SUPERVISOR_ROLES,
  ALL_ROLES,
  hasPermission,
  canManageRole,
  getAllRoles,
  getRolePermissions,
};
