const express = require('express');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { mountRoutes } = require('./routes');
const { scheduleCloudBackupSync, scheduleDailyBackup } = require('./services/backupService');
const { scheduleDailySaleAlerts } = require('./services/saleAlertService');
const { logError, logInfo } = require('./services/logger');

const app = express();
const heartbeatLogPath = path.join(__dirname, 'logs', 'heartbeat.log');

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

function recordHealthPing(req) {
  try {
    fs.mkdirSync(path.dirname(heartbeatLogPath), { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      at_local: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }),
      ip: req.ip || req.socket?.remoteAddress || '',
      user: String(req.query?.user || '').slice(0, 40),
      role: String(req.query?.role || '').slice(0, 20),
      counter: String(req.query?.counter || '').slice(0, 10),
      source: String(req.query?.source || 'health').slice(0, 30)
    };
    fs.appendFile(heartbeatLogPath, `${JSON.stringify(entry)}\n`, () => {});
  } catch (_err) {
    // Health must stay fast and reliable even if ping logging fails.
  }
}

app.get('/api/health', (req, res) => {
  recordHealthPing(req);
  res.json({ ok: true });
});

mountRoutes(app);

const frontendBuildPath = path.resolve(__dirname, '..', 'frontend', 'build');
const frontendIndexPath = path.join(frontendBuildPath, 'index.html');
// Register frontend routes even while a production build is being replaced.
// Otherwise, if the backend starts during the brief period where index.html is
// absent, the API stays healthy but the UI remains unavailable until restart.
app.use(express.static(frontendBuildPath, {
  index: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (!fs.existsSync(frontendIndexPath)) {
    return res.status(503).send('Badizo frontend is being updated. Please try again shortly.');
  }

  return res.sendFile(frontendIndexPath);
});

function normalizePort(value, fallback = 5000) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function normalizeHost(value) {
  const host = String(value || '').trim();
  if (!host || ['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase())) {
    return '0.0.0.0';
  }
  return host;
}

function tuneHttpServer(server) {
  server.keepAliveTimeout = Number.parseInt(process.env.BADIZO_KEEP_ALIVE_TIMEOUT_MS, 10) || 65000;
  server.headersTimeout = Number.parseInt(process.env.BADIZO_HEADERS_TIMEOUT_MS, 10) || 66000;
  server.requestTimeout = Number.parseInt(process.env.BADIZO_REQUEST_TIMEOUT_MS, 10) || 120000;
}

const PORT = normalizePort(process.env.PORT, 5000);
const HOST = normalizeHost(process.env.HOST);
const LEGACY_FRONTEND_PORT = normalizePort(process.env.BADIZO_LEGACY_FRONTEND_PORT, 3000);

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

  tuneHttpServer(redirectServer);

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
    const listenPort = normalizePort(port, PORT);
    const server = app.listen(listenPort, HOST, () => {
      console.log(`BADIZO POS API running on http://${HOST}:${listenPort}`);
      logInfo('Backend started', { host: HOST, port: listenPort });
      startLegacyFrontendRedirect(listenPort);
      scheduleDailyBackup();
      scheduleCloudBackupSync();
      scheduleDailySaleAlerts();
      resolve(server);
    });

    tuneHttpServer(server);
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
