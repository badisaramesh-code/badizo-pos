const path = require('node:path');
function validateShop(config) {
  const keys = ['schemaVersion', 'shopId', 'displayName', 'mysqlVersion', 'localInstallationId', 'cloudInstallationId', 'sync'];
  if (!config || Object.keys(config).some(k => !keys.includes(k)) || keys.some(k => !(k in config))) throw Error('Supply only the documented shop configuration fields; keep credentials separately.');
  if (config.schemaVersion !== 1) throw Error('Unsupported configuration version.');
  if (!/^[A-Z][A-Z0-9_-]{2,31}$/.test(config.shopId)) throw Error('Invalid shop ID.');
  if (typeof config.displayName !== 'string' || !config.displayName.trim() || config.displayName.length > 120) throw Error('Invalid shop name.');
  if (!/^8\.0\.\d+$/.test(config.mysqlVersion)) throw Error('This deployment profile requires the verified MySQL 8.0 shop version.');
  for (const field of ['localInstallationId', 'cloudInstallationId']) {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(config[field])) throw Error('Invalid installation identity.');
  }
  if (config.localInstallationId === config.cloudInstallationId) throw Error('Local and cloud installation identities must differ.');
  require('../../backend/services/cloudSyncSettingsService').validateConfig(config.sync);
  if (config.sync.enabled) throw Error('New installations must enroll and validate synchronization before enabling it.');
  return structuredClone(config);
}
function validateFleet(configs) {
  const shops = new Set(), installations = new Set();
  return configs.map(value => {
    const config = validateShop(value);
    if (shops.has(config.shopId)) throw Error('Duplicate shop identity.');
    shops.add(config.shopId);
    for (const id of [config.localInstallationId, config.cloudInstallationId]) {
      if (installations.has(id)) throw Error('Installation identity belongs to multiple shops.');
      installations.add(id);
    }
    return config;
  });
}
function deploymentPlan(value) {
  const config = validateShop(value);
  return { shop: config, cloudRole: 'cloud-standby', productionChangesApplied: false,
    namespace: config.shopId.toLowerCase(),
    cloudStateDirectory: path.posix.join('/var/lib/badizo/shops', config.shopId),
    prerequisites: ['verified-shop-backup', 'restore-test', 'separate-credentials', 'private-counter-connectivity', 'printer-test', 'sync-checkpoint-validation', 'failover-and-failback-test'] };
}
module.exports = { validateShop, validateFleet, deploymentPlan };
if (require.main === module) {
  try {
    const configs = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
    console.log(JSON.stringify(validateFleet(configs).map(deploymentPlan), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
