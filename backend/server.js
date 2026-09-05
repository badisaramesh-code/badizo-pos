const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { mountRoutes } = require('./routes');
const { scheduleDailySaleAlerts } = require('./services/saleAlertService');
const { logError, logInfo } = require('./services/logger');

const app = express();
const heartbeatLogPath = path.join(__dirname, 'logs', 'heartbeat.log');
const HEARTBEAT_LOG_MAX_BYTES = 20 * 1024 * 1024;
const HEARTBEAT_LOG_KEEP_FILES = 5;
let lastHeartbeatLogCheckAt = 0;

function rotateHeartbeatLogIfNeeded() {
  const now = Date.now();
  if (now - lastHeartbeatLogCheckAt < 60 * 1000) return;
  lastHeartbeatLogCheckAt = now;

  try {
    if (!fs.existsSync(heartbeatLogPath) || fs.statSync(heartbeatLogPath).size < HEARTBEAT_LOG_MAX_BYTES) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(heartbeatLogPath, path.join(path.dirname(heartbeatLogPath), `heartbeat-${stamp}.log`));
    const archives = fs.readdirSync(path.dirname(heartbeatLogPath))
      .filter((name) => /^heartbeat-.*\.log$/i.test(name))
      .sort()
      .reverse();
    archives.slice(HEARTBEAT_LOG_KEEP_FILES).forEach((name) => {
      fs.rmSync(path.join(path.dirname(heartbeatLogPath), name), { force: true });
    });
  } catch (_err) {
    // Heartbeat logging must never interrupt billing or health responses.
  }
}

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
    rotateHeartbeatLogIfNeeded();
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

const scheduledDailyBackupDir = 'D:\\BadizoCloudBackups\\daily';
const scheduledDailyBackupScript = path.join(__dirname, 'scripts', 'badizo_cloud_backup.js');
const scheduledDailyBackupStatusFile = 'D:\\BadizoCloudBackups\\backup-status.json';
let dailyCatchUpRunning = false;

function localDatePrefix(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `badizo_daily_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_`;
}

function hasTodayScheduledBackup() {
  try {
    const prefix = localDatePrefix();
    return fs.existsSync(scheduledDailyBackupDir)
      && fs.readdirSync(scheduledDailyBackupDir).some((name) => name.startsWith(prefix) && (name.endsWith('.sql.gz') || name.endsWith('.sql')));
  } catch (err) {
    logError('Daily backup catch-up check failed', err);
    return false;
  }
}

function hasTodaySuccessfulCloudBackup() {
  try {
    if (!fs.existsSync(scheduledDailyBackupStatusFile)) return false;
    const status = JSON.parse(fs.readFileSync(scheduledDailyBackupStatusFile, 'utf8'));
    return status.status === 'success' && String(status.file || '').startsWith(localDatePrefix());
  } catch (err) {
    logError('Daily cloud backup status check failed', err);
    return false;
  }
}

function checkDailyBackupCatchUp() {
  const now = new Date();
  const afterBackupGraceTime = now.getHours() > 9 || (now.getHours() === 9 && now.getMinutes() >= 5);
  if (!afterBackupGraceTime || dailyCatchUpRunning) return;

  const hasTodayLocal = hasTodayScheduledBackup();
  if (hasTodayLocal && hasTodaySuccessfulCloudBackup()) return;

  const mode = hasTodayLocal ? 'sync-pending' : 'daily';
  dailyCatchUpRunning = true;
  logInfo('Starting daily backup recovery', { at: now.toISOString(), mode });
  const child = spawn(process.execPath, [scheduledDailyBackupScript, mode], {
    cwd: __dirname,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.on('error', (err) => {
    dailyCatchUpRunning = false;
    logError('Unable to start daily backup catch-up', err);
  });
  child.on('exit', (code) => {
    dailyCatchUpRunning = false;
    if (code !== 0) logError('Daily backup catch-up exited unsuccessfully', new Error(`Exit code ${code}`));
  });
}

function scheduleDailyBackupCatchUpCheck() {
  setTimeout(checkDailyBackupCatchUp, 60 * 1000).unref?.();
  const timer = setInterval(checkDailyBackupCatchUp, 5 * 60 * 1000);
  timer.unref?.();
  return timer;
}

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const listenPort = normalizePort(port, PORT);
    const server = app.listen(listenPort, HOST, () => {
      console.log(`BADIZO POS API running on http://${HOST}:${listenPort}`);
      logInfo('Backend started', { host: HOST, port: listenPort });
      startLegacyFrontendRedirect(listenPort);
      scheduleDailySaleAlerts();
      scheduleDailyBackupCatchUpCheck();
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
