const express = require('express');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { mountRoutes } = require('./routes');
const { scheduleDailyBackup } = require('./services/backupService');
const { scheduleDailySaleAlerts } = require('./services/saleAlertService');
const { logError, logInfo } = require('./services/logger');

const app = express();

function getCorsOptions() {
  const allowedOrigins = String(process.env.BADIZO_CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (!allowedOrigins.length) {
    return undefined;
  }

  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin is not allowed by Badizo CORS policy.'));
    }
  };
}

app.use(cors(getCorsOptions()));
app.use(express.json({ limit: process.env.BADIZO_JSON_LIMIT || '250mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

mountRoutes(app);

const frontendBuildPath = path.resolve(__dirname, '..', 'frontend', 'build');
const frontendIndexPath = path.join(frontendBuildPath, 'index.html');
if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendBuildPath, {
    index: false,
    maxAge: 0,
    setHeaders(res, filePath) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(frontendIndexPath);
  });
}

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
const LEGACY_FRONTEND_PORT = Number(process.env.BADIZO_LEGACY_FRONTEND_PORT || 3000);

function getRedirectHost(reqHost, targetPort) {
  const host = String(reqHost || '').split(':')[0] || 'localhost';
  return `${host}:${targetPort}`;
}

function startLegacyFrontendRedirect(targetPort) {
  if (String(process.env.BADIZO_DISABLE_3000_REDIRECT || '').toLowerCase() === 'true') {
    return null;
  }
  if (Number(targetPort) === LEGACY_FRONTEND_PORT) {
    return null;
  }

  const redirectServer = http.createServer((req, res) => {
    const targetHost = getRedirectHost(req.headers.host, targetPort);
    const targetUrl = `http://${targetHost}${req.url || '/'}`;
    res.statusCode = req.url === '/api/health' ? 200 : 302;
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/api/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, redirectedToPort: Number(targetPort) }));
      return;
    }
    res.setHeader('Location', targetUrl);
    res.end(`Badizo moved to ${targetUrl}`);
  });

  redirectServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logInfo('Legacy frontend redirect port already in use', { port: LEGACY_FRONTEND_PORT });
      return;
    }
    logError('Legacy frontend redirect failed', err, { port: LEGACY_FRONTEND_PORT });
  });

  redirectServer.listen(LEGACY_FRONTEND_PORT, HOST, () => {
    console.log(`BADIZO legacy port ${LEGACY_FRONTEND_PORT} redirects to ${targetPort}`);
    logInfo('Legacy frontend redirect started', {
      host: HOST,
      legacyPort: LEGACY_FRONTEND_PORT,
      targetPort: Number(targetPort)
    });
  });

  return redirectServer;
}

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST, () => {
      console.log(`BADIZO POS API running on http://${HOST}:${port}`);
      logInfo('Backend started', { host: HOST, port });
      startLegacyFrontendRedirect(port);
      scheduleDailyBackup();
      scheduleDailySaleAlerts();
      resolve(server);
    });

    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(err);
    logError('Backend startup failed', err);
    process.exit(1);
  });
}

module.exports = { app, startServer };
