const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const {loadBackupConfiguration}=require('../services/backupConfiguration');
router.use(authenticate);

router.get('/', async (_req, res) => {
  let backupConfig;
  try {
    backupConfig=await loadBackupConfiguration(require('../config/db'));
    const statusFile=backupConfig.statusFile,dailyDir=backupConfig.dailyDir;
    let status = null;
    if (fs.existsSync(statusFile)) {
      status = JSON.parse(await fs.promises.readFile(statusFile, 'utf8'));
    }

    const dailyFiles = fs.existsSync(dailyDir)
      ? (await fs.promises.readdir(dailyDir)).filter((name) => /^badizo_daily_.*\.sql(?:\.gz)?$/i.test(name))
      : [];
    const dailyEntries = await Promise.all(dailyFiles.map(async (name) => {
      const stats = await fs.promises.stat(path.join(dailyDir, name));
      return { name, modifiedAt: stats.mtime };
    }));
    dailyEntries.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    const latest = dailyEntries[0] || null;

    const oldCloudFailure=status?.status==='failed' && /^Google Drive upload pending/.test(status?.message||'');
    const localStatus=status?.localStatus || (oldCloudFailure?'success':status?.status==='failed'?'failed':latest||['success','local-only','cloud-failed'].includes(status?.status)?'success':'unknown');
    const cloudStatus=!backupConfig.cloudEnabled?'disabled':status?.cloudStatus||(oldCloudFailure?'failed':status?.status==='success'?'success':status?.status==='cloud-failed'?'failed':'unknown');
    const localAt=localStatus==='success'?(status?.localAt||latest?.modifiedAt||null):latest?.modifiedAt||null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      enabled:backupConfig.enabled, localEnabled:true, cloudEnabled:backupConfig.cloudEnabled,
      keepLocalCopies:backupConfig.keepLocal, dailyTime:backupConfig.dailyTime,
      status:localStatus==='failed'?'failed':cloudStatus==='failed'?'cloud-failed':!backupConfig.cloudEnabled&&localStatus==='success'?'local-only':localStatus,
      localStatus, cloudStatus,
      localMessage:localStatus==='failed'?String(status?.message||'Local backup failed.'):'',
      cloudMessage:cloudStatus==='failed'?String(status?.message||'Google Drive upload failed.'):'',
      kind:status?.kind||'daily',at:status?.at||null,file:status?.file||latest?.name||null,
      latestSuccessAt:cloudStatus==='success'?(status?.at||null):null,
      latestLocalBackupAt:localAt,localAt,
      message:localStatus==='failed'?String(status?.message||'Local backup failed.'):cloudStatus==='failed'?String(status?.message||'Google Drive upload failed.'):'',
      retainedDailyBackups:dailyFiles.length,keepDailyBackups:backupConfig.localKeepCount

    });
  } catch (err) {
    if(backupConfig)return res.json({enabled:backupConfig.enabled,cloudEnabled:backupConfig.cloudEnabled,localEnabled:true,localStatus:'failed',status:'failed',localMessage:'Unable to read local backup status: '+err.message,message:'Unable to read local backup status: '+err.message,at:new Date().toISOString(),dailyTime:backupConfig.dailyTime});
    res.status(500).json({ error: 'Backup settings are unavailable; backup status cannot be verified.' });
  }
});

module.exports = router;
