import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../src/utils/backupHealth.js', import.meta.url), 'utf8');
const {backupAlerts, backupSettingsPayload, generalSettingsPayload, acknowledgeBackupAlert, acknowledgedBackupAlerts, backupHealthUnavailable} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const now = new Date(2026, 10, 14, 12, 0);
const at = new Date(2026, 10, 14, 9, 5).toISOString();

test('general settings save never persists backup defaults or unsaved storage switches', () => {
  const settings={shop_name:'Example',gst_slabs:'0,5,18',backup_local_folder:'D:\\Default',backup_local_keep_count:0,backup_drive_enabled:true,backup_keep_local:false,backup_drive_keep_count:3,backup_daily_time:'09:00'};
  assert.deepEqual(generalSettingsPayload(settings),{shop_name:'Example',gst_slabs:'0,5,18'});
  assert.equal(settings.backup_local_folder,'D:\\Default');
  assert.equal(backupSettingsPayload(settings).backup_drive_enabled,true);
});

test('health-fetch errors show uncertainty without falsely blaming Drive or claiming backup failure', () => {
  const alert=backupHealthUnavailable(now);
  assert.equal(alert.title,'Backup Status Unavailable');
  assert.equal(alert.status,'unavailable');
  assert.match(alert.description,/does not confirm/);
  assert.doesNotMatch(JSON.stringify(alert),/Google|OAuth/);
  assert.equal(alert.alertId,backupHealthUnavailable(new Date(2026,10,14,13)).alertId);
  assert.notEqual(alert.alertId,backupHealthUnavailable(new Date(2026,10,15,13)).alertId);
});

test('disabled Drive never hides a failed local backup, including legacy health response', () => {
  for (const health of [
    {enabled:false, status:'failed',at,message:'Disk full'},
    {enabled:true,cloudEnabled:false,localStatus:'failed',localMessage:'Disk full',cloudStatus:'failed',at}
  ]) {
    const alerts = backupAlerts(health, now);
    assert.equal(alerts.length,1); assert.equal(alerts[0].channel,'local');
    assert.equal(alerts[0].status,'failed'); assert.equal(alerts[0].title,'Local Backup Failed');
    assert.equal(alerts[0].message,'Disk full');
  }
});
test('local success with Drive off has a local label and no Google error', () => {
  const alerts = backupAlerts({enabled:true,cloudEnabled:false,localStatus:'success',latestLocalBackupAt:at,cloudStatus:'failed',cloudMessage:'old OAuth error'},now);
  assert.equal(alerts.length,1); assert.equal(alerts[0].title,'Local Backup Successful');
  assert.doesNotMatch(alerts[0].message,/OAuth/);
});
test('Drive failures remain separate from a successful local backup', () => {
  const alerts=backupAlerts({enabled:true,cloudEnabled:true,localStatus:'success',latestLocalBackupAt:at,cloudStatus:'failed',cloudMessage:'Upload failed',at},now);
  assert.equal(alerts.length,1); assert.equal(alerts[0].channel,'cloud'); assert.equal(alerts[0].status,'failed');
});
test('local failure is highest priority even with a successful cloud status', () => {
  const alerts=backupAlerts({enabled:true,cloudEnabled:true,localStatus:'failed',cloudStatus:'success',latestSuccessAt:at,at},now);
  assert.equal(alerts[0].channel,'local'); assert.equal(alerts[0].status,'failed');
});
test('disabled scheduler suppresses pending, never reported local failure', () => {
  assert.deepEqual(backupAlerts({enabled:false,cloudEnabled:false,localStatus:'unknown'},now),[]);
  assert.equal(backupAlerts({enabled:false,cloudEnabled:false,localStatus:'failed',at},now)[0].status,'failed');
});
test('pending uses configured schedule and grace period', () => {
  assert.deepEqual(backupAlerts({enabled:true,cloudEnabled:false,localStatus:'unknown',dailyTime:'14:00'},now),[]);
  assert.equal(backupAlerts({enabled:true,cloudEnabled:false,localStatus:'unknown',dailyTime:'10:30'},now)[0].status,'pending');
});
test('legacy cloud-success response remains supported', () => {
  const alerts=backupAlerts({status:'success',latestSuccessAt:at,latestLocalBackupAt:at,at},now);
  assert.equal(alerts.length,1);assert.equal(alerts[0].channel,'cloud');assert.equal(alerts[0].status,'success');
});
test('local retention is mandatory without Drive, defaults on with Drive and can opt out', () => {
  const base={backup_local_folder:'D:\\Backups',backup_local_keep_count:14,backup_drive_keep_count:3};
  assert.equal(backupSettingsPayload({...base,backup_drive_enabled:false,backup_keep_local:false}).backup_keep_local,true);
  assert.equal(backupSettingsPayload({...base,backup_drive_enabled:true}).backup_keep_local,true);
  assert.equal(backupSettingsPayload({...base,backup_drive_enabled:true,backup_keep_local:false}).backup_keep_local,false);
  assert.throws(()=>backupSettingsPayload({...base,backup_local_keep_count:-1}),/whole-number/);
  assert.throws(()=>backupSettingsPayload({...base,backup_drive_keep_count:0}),/whole-number/);
  assert.throws(()=>backupSettingsPayload({...base,backup_local_folder:''}),/folder/);
});
test('acknowledging two channels does not alternate old alerts indefinitely', () => {
  const values=new Map(); const storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  acknowledgeBackupAlert(storage,'local-failed');acknowledgeBackupAlert(storage,'cloud-failed');
  assert.deepEqual(acknowledgedBackupAlerts(storage),['local-failed','cloud-failed']);
  values.set('badizo_backup_alert_acks','broken');assert.deepEqual(acknowledgedBackupAlerts(storage),[]);
});
