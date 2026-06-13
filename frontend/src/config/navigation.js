export const USER_ROLES = {
  SERVER: 'SERVER',
  ADMIN: 'ADMIN',
  COUNTER: 'COUNTER'
};

export const APP_TABS = [
  { key: 'dashboard', label: 'Dashboard', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'billing', label: 'Billing (POS)', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN, USER_ROLES.COUNTER] },
  { key: 'closing', label: 'Counter Closing', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN, USER_ROLES.COUNTER] },
  { key: 'inventory', label: 'Products', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN, USER_ROLES.COUNTER] },
  { key: 'importHistory', label: 'Import History', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN], hidden: true },
  { key: 'barcode', label: 'Barcode', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN, USER_ROLES.COUNTER] },
  { key: 'inward', label: 'Inward', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'reports', label: 'Reports', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'books', label: 'Ledger Books', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] },
  { key: 'system', label: 'System', roles: [USER_ROLES.SERVER, USER_ROLES.ADMIN] }
];

export function canAccessTab(tab, user) {
  return tab.roles.includes(user?.role);
}
