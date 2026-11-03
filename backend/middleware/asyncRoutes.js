const { logError } = require('../services/logger');

// Express 4 does not forward rejected async handlers to error middleware.
// Wrap registered router layers once, including nested routers/middleware.
function protectAsyncRoutes(router) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      protectAsyncRoutes(layer.route);
    } else if (layer.handle?.stack) {
      protectAsyncRoutes(layer.handle);
    } else if (layer.handle && layer.handle.length < 4 && !layer.handle.badizoAsyncSafe) {
      const handler = layer.handle;
      const wrapped = function (req, res, next) {
        try { Promise.resolve(handler(req, res, next)).catch(next); }
        catch (error) { next(error); }
      };
      wrapped.badizoAsyncSafe = true;
      layer.handle = wrapped;
    }
  }
  return router;
}

function apiErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  logError('API request failed', error, { method: req.method, path: req.path });
  const unavailable = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'ER_CON_COUNT_ERROR'].includes(error?.code);
  const badRequest = error?.type === 'entity.parse.failed';
  res.status(unavailable ? 503 : badRequest ? 400 : 500).json({
    code: unavailable ? 'DATABASE_UNAVAILABLE' : badRequest ? 'INVALID_JSON' : 'REQUEST_FAILED',
    error: unavailable
      ? 'Database connection is unavailable. Check Bill History before retrying a sale.'
      : badRequest ? 'The request contains invalid JSON.' : 'Unable to complete the request. Check Bill History before retrying a sale.',
    retryable: false
  });
}

module.exports = { protectAsyncRoutes, apiErrorHandler };
