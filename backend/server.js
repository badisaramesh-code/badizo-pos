const express = require('express');
const cors = require('cors');
const fs = require('fs');
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
    maxAge: '1y',
    setHeaders(res, filePath) {
      if (filePath === frontendIndexPath) {
        res.setHeader('Cache-Control', 'no-store');
      }
    }
  }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(frontendIndexPath);
  });
}

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST, () => {
      console.log(`BADIZO POS API running on http://${HOST}:${port}`);
      logInfo('Backend started', { host: HOST, port });
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
