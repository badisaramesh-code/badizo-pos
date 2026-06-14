const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const SYSTEM_LOG = path.join(LOG_DIR, 'system.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');

async function appendLog(filePath, level, message, details = {}) {
  await fs.promises.mkdir(LOG_DIR, { recursive: true }).catch(() => {});
  const payload = {
    at: new Date().toISOString(),
    level,
    message,
    ...details
  };
  await fs.promises.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8').catch(() => {});
}

function logInfo(message, details = {}) {
  appendLog(SYSTEM_LOG, 'INFO', message, details);
}

function logError(message, err, details = {}) {
  appendLog(ERROR_LOG, 'ERROR', message, {
    ...details,
    error: err?.message || String(err || ''),
    stack: err?.stack || ''
  });
}

module.exports = {
  ERROR_LOG,
  LOG_DIR,
  SYSTEM_LOG,
  logError,
  logInfo
};
