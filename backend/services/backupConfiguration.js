'use strict';
const path = require('node:path');
function backupConfiguration(env = process.env) {
  const root = env.BADIZO_CLOUD_BACKUP_DIR || 'D:\\BadizoCloudBackups';
  return {
    root,
    dailyDir: path.join(root, 'daily'),
    statusFile: path.join(root, 'backup-status.json'),
    cloudEnabled: String(env.GOOGLE_DRIVE_BACKUP_ENABLED || '').toLowerCase() === 'true'
  };
}
module.exports = { backupConfiguration };
