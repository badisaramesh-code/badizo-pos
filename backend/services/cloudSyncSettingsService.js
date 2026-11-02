const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_CONFIG = Object.freeze({ enabled: false, frequency: 'daily', dailyTime: '20:30', timezone: 'Asia/Kolkata' });
function invalid(message, status = 400) { const error = new Error(message); error.status = status; return error; }
function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.keys(DEFAULT_CONFIG).includes(key))
    || Object.keys(DEFAULT_CONFIG).some(key => !Object.hasOwn(value, key))) throw invalid('Send the complete cloud sync schedule.');
  if (typeof value.enabled !== 'boolean') throw invalid('Enabled must be true or false.');
  if (!['daily', 'hourly'].includes(value.frequency)) throw invalid('Choose daily or hourly sync.');
  if (typeof value.dailyTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.dailyTime)) throw invalid('Choose a valid daily time.');
  if (value.timezone !== 'Asia/Kolkata') throw invalid('Cloud sync uses India Standard Time.');
  return { enabled: value.enabled, frequency: value.frequency, dailyTime: value.dailyTime, timezone: value.timezone };
}

// Pure schedule calculation shared with the durable transfer worker.
function nextScheduledAt(config, now = new Date()) {
  validateConfig(config);
  if (!config.enabled) return null;
  const time = new Date(now).getTime();
  if (!Number.isFinite(time)) throw invalid('Invalid schedule reference time.');
  const offset = 330 * 60 * 1000;
  if (config.frequency === 'hourly') return new Date((Math.floor((time + offset) / 3600000) + 1) * 3600000 - offset).toISOString();
  const local = new Date(time + offset);
  const [hour, minute] = config.dailyTime.split(':').map(Number);
  let next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - offset;
  if (next <= time) next += 86400000;
  return new Date(next).toISOString();
}

function createCloudSyncSettingsService({
  configDirectory = process.env.BADIZO_CLOUD_SYNC_CONFIG_DIR || path.join(os.homedir(), 'BadizoCloudSync'),
  nodeRole = process.env.BADIZO_NODE_ROLE || 'local-server',
  // The composition root supplies a worker only after validating enrollment,
  // supported domains, baseline and billing authority. Default remains off.
  getWorkerState = async () => ({ ready: false, state: 'not-configured', lastSuccessAt: null }),
  requestTransfer = null,
  clock = () => new Date()
} = {}) {
  const configFile = path.join(configDirectory, 'schedule.json');
  let writeQueue = Promise.resolve();
  async function load() {
    try {
      const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
      return { config: validateConfig(saved.config), updatedAt: saved.updatedAt || null, updatedBy: saved.updatedBy || null };
    } catch (error) {
      if (error.code === 'ENOENT') return { config: { ...DEFAULT_CONFIG }, updatedAt: null, updatedBy: null };
      throw invalid('Unable to read cloud sync settings. The existing schedule was not replaced.', 500);
    }
  }
  async function state() {
    const saved = await load();
    const worker = await getWorkerState();
    const editable = nodeRole === 'local-server';
    const ready = editable && worker.ready === true;
    return { ...saved, nodeRole, editable, service: { ready, state: ready ? (worker.state || 'paused') : 'not-configured', direction:worker.direction==='two-way'?'two-way':'upload' },
      lastSuccessAt: worker.lastSuccessAt || null,
      nextRunAt: ready ? (Object.hasOwn(worker,'nextRunAt') ? worker.nextRunAt : nextScheduledAt(saved.config, clock())) : null,
      manualPending: worker.manualPending === true,
      failureCount: Number(worker.failureCount || 0),
      message: !editable ? 'Manage the schedule on the local shop server.' : !ready
        ? worker.reason==='restored-database-requires-enrollment' ? 'Local billing can continue. This restored database needs a newly verified sync baseline before cloud updates can resume.' : 'Schedule preferences can be saved. Automatic updates and Update Cloud Now are unavailable until the cloud sync connection is configured.'
        : saved.config.enabled ? 'Automatic cloud sync is enabled.' : 'Automatic cloud sync is paused.' };
  }
  function save(input, user) {
    const operation = writeQueue.catch(() => {}).then(async () => {
      if (nodeRole !== 'local-server') throw invalid('Cloud sync schedules can only be changed on the local shop server.', 403);
      const config = validateConfig(input);
      const worker = await getWorkerState();
      if (config.enabled && worker.ready !== true) throw invalid('The cloud sync connection is not configured. Save the schedule with automatic sync paused.', 409);
      const payload = { config, updatedAt: clock().toISOString(), updatedBy: String(user?.username || 'server').slice(0, 100) };
      await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
      const temporary = `${configFile}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(payload, null, 2), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, configFile);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw invalid('Unable to save cloud sync settings. Please retry.', 500);
      }
      return state();
    });
    writeQueue = operation;
    return operation;
  }
  async function requestNow(user) {
    if(nodeRole !== 'local-server') throw invalid('Start this update on the local shop server.',403);
    if(typeof requestTransfer !== 'function' || (await getWorkerState()).ready !== true) throw invalid('Cloud sync is not configured.',409);
    await requestTransfer(user);
    return state();
  }
  return { state, save, requestNow, loadSchedule: async () => (await load()).config };
}
module.exports = { DEFAULT_CONFIG, validateConfig, nextScheduledAt, createCloudSyncSettingsService };
