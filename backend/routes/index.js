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

function mountRoutes(app, { cloudSyncRuntime, recoveryExecutorFactory } = {}) {
  if (process.env.BADIZO_RECOVERY_CONTROL_CONFIG) {
    const control = require('../services/recoveryControl').createRecoveryControl({configPath:process.env.BADIZO_RECOVERY_CONTROL_CONFIG,shopId:process.env.BADIZO_SHOP_ID});
    app.use('/api/recovery-control',require('./recoveryControl').createRouter(control));
  }
  if (process.env.BADIZO_STAGED_RESTORE_ENABLED === 'true') {
    const jobs = require('../services/stagedRestoreJobs').createStagedRestoreJobs({directory:process.env.BADIZO_RESTORE_JOB_DIR,shopId:process.env.BADIZO_SHOP_ID,configPath:process.env.BADIZO_RESTORE_CONFIG,python:process.env.BADIZO_PYTHON || 'python'});
    app.use('/api/staged-restore',require('./stagedRestore').createRouter(jobs));
  }
  if (process.env.BADIZO_RECOVERY_REVIEW_ENABLED === 'true') {
    const shopId = process.env.BADIZO_SHOP_ID;
    const store = require('../services/recoveryReviewStore').createRecoveryReviewStore({ directory:process.env.BADIZO_RECOVERY_REVIEW_DIR, shopId });
    if (!recoveryExecutorFactory && process.env.BADIZO_RECOVERY_APPLY_ENABLED === 'true') {
      if ((process.env.BADIZO_NODE_ROLE || 'local-server') !== 'local-server') throw Error('Recovery decisions must be applied from the local server.');
      const identity = {shopId,localInstallationId:process.env.BADIZO_INSTALLATION_ID,peerInstallationId:process.env.BADIZO_SYNC_PEER_INSTALLATION_ID};
      if (!identity.localInstallationId || !identity.peerInstallationId || identity.localInstallationId === identity.peerInstallationId) throw Error('Recovery execution requires enrolled installation identities.');
      recoveryExecutorFactory = reviewStore => require('../services/recoveryConflictExecution').createRecoveryConflictExecution({pool:require('../config/db'),store:reviewStore,identity,canApply:async()=>true});
    }
    app.use('/api/recovery-review', require('./recoveryReview').createRouter({ store, shopId, executor: recoveryExecutorFactory ? recoveryExecutorFactory(store) : null }));
  }
  routes.forEach(([path, router]) => {
    const mountedRouter = path === '/api/cloud-sync' && cloudSyncRuntime
      ? require('./cloudSync').createRouter(cloudSyncRuntime.settings)
      : router;
    app.use(path, protectAsyncRoutes(mountedRouter));
  });
  app.use(apiErrorHandler);
}

module.exports = { mountRoutes };
