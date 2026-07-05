const express = require('express');
const cors = require('cors');
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

const PORT = process.env.PORT || 5000;

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`BADIZO POS API running on port ${port}`);
      logInfo('Backend started', { port });
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
