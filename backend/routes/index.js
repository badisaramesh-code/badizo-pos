const routes = [
  ['/api/auth', require('./auth')],
  ['/api/audit', require('./audit')],
  ['/api/backup', require('./backup')],
  ['/api/barcode', require('./barcode')],
  ['/api/books', require('./books')],
  ['/api/products', require('./products')],
  ['/api/billing', require('./billing')],
  ['/api/counter-closing', require('./counterClosing')],
  ['/api/customers', require('./customers')],
  ['/api/inward', require('./inward')],
  ['/api/settings', require('./settings')],
  ['/api/reports', require('./reports')],
  ['/api/users', require('./users')]
];

function mountRoutes(app) {
  routes.forEach(([path, router]) => {
    app.use(path, router);
  });
}

module.exports = { mountRoutes };
