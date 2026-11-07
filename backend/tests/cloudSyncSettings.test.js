const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { DEFAULT_CONFIG, validateConfig, nextScheduledAt, createCloudSyncSettingsService } = require('../services/cloudSyncSettingsService');
const { createRouter } = require('../routes/cloudSync');
const { JWT_SECRET } = require('../middleware/auth');

async function isolated(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'badizo-cloud-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, service: createCloudSyncSettingsService({ configDirectory: directory, ...options }) };
}

test('daily 20:30 IST is the default; no connection means no active schedule', async t => {
  const { directory, service } = await isolated(t);
  const result = await service.state();
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.equal(result.service.ready, false);
  assert.equal(result.nextRunAt, null);
  assert.equal(result.lastSuccessAt, null);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('daily and hourly preferences persist per installation without changing database or backup settings', async t => {
  const { directory, service } = await isolated(t);
  await service.save({ ...DEFAULT_CONFIG, frequency: 'hourly' }, { username: 'server' });
  const restarted = createCloudSyncSettingsService({ configDirectory: directory });
  assert.equal((await restarted.state()).config.frequency, 'hourly');
  assert.equal((await restarted.state()).updatedBy, 'server');
  await restarted.save({ ...DEFAULT_CONFIG, dailyTime: '21:15' }, { username: 'server' });
  assert.equal((await service.state()).config.dailyTime, '21:15');
  assert.deepEqual(await fs.readdir(directory), ['schedule.json']);
});

test('unconfigured transfers cannot be enabled and cloud nodes cannot change local schedules', async t => {
  const { directory, service } = await isolated(t);
  await assert.rejects(service.save({ ...DEFAULT_CONFIG, enabled: true }, {}), error => error.status === 409);
  assert.deepEqual(await fs.readdir(directory), []);
  const cloud = createCloudSyncSettingsService({ configDirectory: directory, nodeRole: 'cloud-standby' });
  await assert.rejects(cloud.save(DEFAULT_CONFIG, {}), error => error.status === 403);
  assert.equal((await cloud.state()).editable, false);
});

test('invalid times, timezone overrides and connection/identity fields are rejected', () => {
  for (const dailyTime of ['24:00', '20:60', '8:30', '', null]) assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, dailyTime }));
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, timezone: 'UTC' }));
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, frequency: 'every-minute' }));
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, enabled: 'true' }));
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, cloudPassword: 'not-allowed' }));
  assert.throws(() => validateConfig({ frequency: 'daily' }));
});

test('schedule calculation uses IST even across UTC days and year boundaries', () => {
  const enabled = { ...DEFAULT_CONFIG, enabled: true };
  assert.equal(nextScheduledAt(enabled, '2026-11-02T14:59:59Z'), '2026-11-02T15:00:00.000Z');
  assert.equal(nextScheduledAt(enabled, '2026-11-02T15:00:00Z'), '2026-11-03T15:00:00.000Z');
  assert.equal(nextScheduledAt({ ...enabled, dailyTime: '00:15' }, '2026-12-31T18:44:00Z'), '2026-12-31T18:45:00.000Z');
  assert.equal(nextScheduledAt({ ...enabled, dailyTime: '00:15' }, '2026-12-31T18:45:00Z'), '2027-01-01T18:45:00.000Z');
  assert.equal(nextScheduledAt({ ...enabled, frequency: 'hourly' }, '2026-11-02T14:00:00Z'), '2026-11-02T14:30:00.000Z');
  assert.equal(nextScheduledAt({ ...enabled, frequency: 'hourly' }, '2026-11-02T14:30:00Z'), '2026-11-02T15:30:00.000Z');
  assert.equal(nextScheduledAt(DEFAULT_CONFIG, '2026-11-02T14:00:00Z'), null);
});

test('server can save schedules, admin can update daily time only, counters cannot access settings', async t => {
  const { service } = await isolated(t);
  const app = express(); app.use(express.json()); app.use('/api/cloud-sync', createRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/cloud-sync/settings`;
  const request = (role, method = 'GET', config = DEFAULT_CONFIG) => fetch(endpoint, { method, headers: {
    ...(role ? { Authorization: `Bearer ${jwt.sign({ role, username: role.toLowerCase() }, JWT_SECRET)}` } : {}),
    ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
  }, ...(method === 'POST' ? { body: JSON.stringify(config) } : {}) });
  assert.equal((await request(null)).status, 401);
  assert.equal((await request('COUNTER')).status, 403);
  assert.equal((await request('ADMIN')).status, 200);
  assert.equal((await request('ADMIN', 'POST')).status, 403);
  const changed = await request('ADMIN', 'POST', {dailyTime:'19:15'});
  assert.equal(changed.status, 200);
  assert.deepEqual((await changed.json()).config, {...DEFAULT_CONFIG,dailyTime:'19:15'});
  assert.equal((await request('COUNTER','POST',{dailyTime:'19:00'})).status,403);
  assert.equal((await request('SERVER', 'POST')).status, 200);
  assert.equal((await request('SERVER', 'POST', { ...DEFAULT_CONFIG, enabled: true })).status, 409);
});

test('a corrupt schedule does not silently become an active default', async t => {
  const { directory, service } = await isolated(t);
  await fs.writeFile(path.join(directory, 'schedule.json'), '{broken-json');
  await assert.rejects(service.state(), error => error.status === 500);
});

test('manual cloud update is owner-only, rejects supplied connection data and records authenticated actor',async t=>{
  let actor=null,ready=true;
  const {service}=await isolated(t,{getWorkerState:async()=>({ready,state:'idle'}),requestTransfer:async user=>{actor=user.username;}});
  const app=express();app.use(express.json());app.use('/api/cloud-sync',createRouter(service));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(role,body={})=>fetch(`http://127.0.0.1:${server.address().port}/api/cloud-sync/run`,{method:'POST',headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${jwt.sign({role,username:'real-owner'},JWT_SECRET)}`}:{})},body:JSON.stringify(body)});
  assert.equal((await request(null)).status,401);
  for(const role of ['ADMIN','COUNTER'])assert.equal((await request(role)).status,403);
  assert.equal((await request('SERVER',{username:'forged-owner'})).status,400);assert.equal(actor,null);
  assert.equal((await request('SERVER')).status,202);assert.equal(actor,'real-owner');
  ready=false;assert.equal((await request('SERVER')).status,409);
});

test('default installations and cloud nodes cannot request transfers',async t=>{
  const {service}=await isolated(t);await assert.rejects(service.requestNow({username:'owner'}),error=>error.status===409);
  const cloud=await isolated(t,{nodeRole:'cloud-standby',getWorkerState:async()=>({ready:true}),requestTransfer:async()=>{throw Error('Unexpected transfer');}});
  await assert.rejects(cloud.service.requestNow({username:'owner'}),error=>error.status===403);
});
