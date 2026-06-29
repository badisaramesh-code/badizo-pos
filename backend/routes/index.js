const routes = [
  ['/api/auth', require('./auth')],
  ['/api/audit', require('./audit')],
  ['/api/accounting-vouchers', require('./accountingVouchers')],
  ['/api/backup', require('./backup')],
  ['/api/barcode', require('./barcode')],
  ['/api/books', require('./books')],
  ['/api/products', require('./products')],
  ['/api/billing', require('./billing')],
  ['/api/counter-closing', require('./counterClosing')],
  ['/api/counter-cash-ledger', require('./counterCashLedger')],
  ['/api/customers', require('./customers')],
  ['/api/gate-pass', require('./gatePass')],
  ['/api/inward', require('./inward')],
  ['/api/settings', require('./settings')],
  ['/api/staff-payroll', require('./staffPayroll')],
  ['/api/system-health', require('./health')],
  ['/api/reports', require('./reports')],
  ['/api/special-orders', require('./specialOrders')],
  ['/api/users', require('./users')]
];

function mountRoutes(app) {
  routes.forEach(([path, router]) => {
    app.use(path, router);
  });
}

module.exports = { mountRoutes };
