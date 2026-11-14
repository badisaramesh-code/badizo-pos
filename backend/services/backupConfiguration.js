'use strict';
const path = require('node:path');
const BACKUP_SETTING_KEYS = ['backup_local_folder','backup_local_keep_count','backup_drive_enabled','backup_keep_local','backup_drive_keep_count','backup_daily_time'];
const boolean = (value, fallback) => value === undefined ? fallback : ['true','1','yes','on'].includes(String(value).toLowerCase());
const count = (value, fallback, min=0) => Number.isInteger(Number(value)) && Number(value)>=min ? Number(value) : fallback;
function backupConfiguration(env = process.env, settings = {}) {
  const root = settings.backup_local_folder || env.BADIZO_CLOUD_BACKUP_DIR || 'D:\\BadizoCloudBackups';
  const legacyDriveConfigured=Boolean(env.GOOGLE_DRIVE_SYNC_FOLDER || (env.GOOGLE_DRIVE_BACKUP_FOLDER_ID && (env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || (env.GOOGLE_DRIVE_CLIENT_EMAIL&&env.GOOGLE_DRIVE_PRIVATE_KEY) || (env.GOOGLE_DRIVE_CLIENT_ID&&env.GOOGLE_DRIVE_CLIENT_SECRET&&env.GOOGLE_DRIVE_REFRESH_TOKEN))));
  const cloudEnabled = boolean(settings.backup_drive_enabled, boolean(env.GOOGLE_DRIVE_BACKUP_ENABLED,legacyDriveConfigured));
  const dailyTime = settings.backup_daily_time || env.BACKUP_DAILY_TIME || '09:00';
  return {
    root, dailyDir:path.join(root,'daily'), statusFile:path.join(root,'backup-status.json'),
    manualDir:settings.backup_local_folder ? path.join(root,'manual') : (env.BACKUP_DIR || path.join(__dirname,'..','backups')),
    cloudEnabled, keepLocal:!cloudEnabled || boolean(settings.backup_keep_local,true),
    localKeepCount:count(settings.backup_local_keep_count ?? env.LOCAL_BACKUP_KEEP_COUNT,0),
    driveKeepCount:count(settings.backup_drive_keep_count ?? env.GOOGLE_DRIVE_BACKUP_KEEP_COUNT,730,1),
    dailyTime:/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)?dailyTime:'09:00',
    enabled:env.BADIZO_DISABLE_SCHEDULED_CLOUD_BACKUP!=='true' && env.BADIZO_DISABLE_SCHEDULED_JOBS!=='true'
  };
}
async function loadBackupConfiguration(executor, env=process.env) {
  const [rows]=await executor.query('SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)',[BACKUP_SETTING_KEYS]);
  return backupConfiguration(env,Object.fromEntries(rows.map(row=>[row.setting_key,row.setting_value])));
}
function publicBackupSettings(settings,env=process.env) {
  const c=backupConfiguration(env,settings);
  return {backup_local_folder:c.root,backup_local_keep_count:c.localKeepCount,backup_drive_enabled:c.cloudEnabled,backup_keep_local:c.keepLocal,backup_drive_keep_count:c.driveKeepCount};
}
function validateBackupSettings(input,current,env=process.env) {
  const merged={...publicBackupSettings(current,env),backup_daily_time:backupConfiguration(env,current).dailyTime,...input};
  for(const key of ['backup_drive_enabled','backup_keep_local']) {
    if(![true,false,'true','false','1','0',1,0].includes(merged[key]))throw Error('Backup switches must be true or false.');
    merged[key]=boolean(merged[key],false);
  }
  const folder=String(merged.backup_local_folder||'').trim();
  if(!folder || folder.length>1000 || /[\0\r\n]/.test(folder) || !(path.isAbsolute(folder)||path.win32.isAbsolute(folder)))throw Error('Enter an absolute local backup folder path.');
  merged.backup_local_folder=folder;
  for(const key of ['backup_local_keep_count','backup_drive_keep_count']) {
    const min=key==='backup_local_keep_count'?0:1,n=Number(merged[key]);
    if(!Number.isInteger(n)||n<min||n>10000)throw Error('Backup retention must be a whole number from '+min+' to 10000.');
    merged[key]=n;
  }
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(merged.backup_daily_time)))throw Error('Enter a valid backup time.');
  if(!merged.backup_drive_enabled)merged.backup_keep_local=true;
  return Object.fromEntries(BACKUP_SETTING_KEYS.map(key=>[key,String(merged[key])]));
}
module.exports={BACKUP_SETTING_KEYS,backupConfiguration,loadBackupConfiguration,publicBackupSettings,validateBackupSettings};
