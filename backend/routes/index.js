const { protectAsyncRoutes, apiErrorHandler } = require('../middleware/asyncRoutes');

const routes = [
  ['/api/shop-maintenance', require('./shopMaintenance')],
  ['/api/auth', require('./auth')],
  ['/api/audit', require('./audit')],
  ['/api/accounting-vouchers', require('./accountingVouchers')],
  ['/api/backup', require('./backup')],
  ['/api/backup-health', require('./backupHealth')],
  ['/api/cloud-sync', require('./cloudSync')],
  ['/api/barcode', require('./barcode')],
  ['/api/books', require('./books')],
  ['/api/products', require('./products')],
  ['/api/quotations', require('./quotations')],
  ['/api/billing', require('./billing')],
  ['/api/counter-closing', require('./counterClosing')],
  ['/api/counter-cash-ledger', require('./counterCashLedger')],
  ['/api/customers', require('./customers')],
  ['/api/gate-pass', require('./gatePass')],
  ['/api/inward', require('./inward')],
  ['/api/local-accounts', require('./localAccounts')],
  ['/api/settings', require('./settings')],
  ['/api/staff-payroll', require('./staffPayroll')],
  ['/api/system-health', require('./health')],
  ['/api/reports', require('./reports')],
  ['/api/special-orders', require('./specialOrders')],
  ['/api/users', require('./users')]
];

function mountRoutes(app) {
  routes.forEach(([path, router]) => {
    app.use(path, protectAsyncRoutes(router));
  });
  app.use(apiErrorHandler);
}

module.exports = { mountRoutes };
