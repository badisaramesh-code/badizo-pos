export const USER_ROLES = {
  SERVER: 'SERVER',
  ADMIN: 'ADMIN',
  COUNTER: 'COUNTER',
  SECURITY: 'SECURITY'
};

export const APP_TABS = [
  { key: 'dashboard', label: 'Dashboard', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'billing', label: 'Badizo billing', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN, USER_ROLES.COUNTER] },
  { key: 'closing', label: 'Counter Closing', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN, USER_ROLES.COUNTER] },
  { key: 'cashLedger', label: 'Cash Ledger', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'gatePass', label: 'Gate Pass', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN, USER_ROLES.SECURITY] },
  { key: 'inventory', label: 'Products', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'importHistory', label: 'Import History', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN], hidden: true },
  { key: 'orders', label: 'Orders', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'priceList', label: 'Mass Update', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'barcode', label: 'Barcode', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'inward', label: 'Inward', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'staffPayroll', label: 'Staff Payroll', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'reports', label: 'Reports', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'books', label: 'Ledger Books', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'system', label: 'System', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] }
];

export function canAccessTab(tab, user) {
  return tab.roles.includes(user?.role);
}
