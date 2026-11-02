const { protectAsyncRoutes, apiErrorHandler } = require('../middleware/asyncRoutes');

const routes = [
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
  if (process.env.BADIZO_STAGED_RESTORE_ENABLED === 'true') {
    const jobs = require('../services/stagedRestoreJobs').createStagedRestoreJobs({directory:process.env.BADIZO_RESTORE_JOB_DIR,shopId:process.env.BADIZO_SHOP_ID,configPath:process.env.BADIZO_RESTORE_CONFIG,python:process.env.BADIZO_PYTHON || 'python'});
    app.use('/api/staged-restore',require('./stagedRestore').createRouter(jobs));
  }
  if (process.env.BADIZO_RECOVERY_REVIEW_ENABLED === 'true') {
    const shopId = process.env.BADIZO_SHOP_ID;
    const store = require('../services/recoveryReviewStore').createRecoveryReviewStore({ directory:process.env.BADIZO_RECOVERY_REVIEW_DIR, shopId });
    app.use('/api/recovery-review', require('./recoveryReview').createRouter({ store, shopId }));
  }
  routes.forEach(([path, router]) => {
    app.use(path, protectAsyncRoutes(router));
  });
  app.use(apiErrorHandler);
}

module.exports = { mountRoutes };
