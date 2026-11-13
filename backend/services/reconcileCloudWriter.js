'use strict';

const path = require('node:path');
const { json } = require('./recoveryControlFiles');
const { validate } = require('./recoveryRuntimeBinding');

function approvedWriter(binding, history, shopId) {
  return binding.shopId === shopId && binding.phase === 'active' && binding.billingMode === 'active' &&
    binding.nativeReplicationInvalidated === true && binding.reconciliationRequired === true && !binding.handoffId &&
    typeof binding.invoiceEpoch === 'string' && /^badizo_recovery_[a-z0-9]{8,32}$/.test(binding.database.database) &&
    history?.schemaVersion === 1 && history.shopId === shopId && history.operationId === binding.backupRecoveryOperationId &&
    history.activationId === binding.activationId && history.generation === binding.generation;
}

// MySQL deliberately boots read-only. A completed uploaded recovery lets the
// external supervisor restore write access on that exact instance after reboot.
async function reconcileCloudWriter(config, openConnection, read = json) {
  if (config.nodeRole !== 'cloud-standby' || !config.uploadRecoveryConfigPath) return false;
  const binding = validate(await read(config.bindingPath), config.shopId);
  if (!binding.backupRecoveryOperationId || binding.billingMode !== 'active') return false;
  const upload = await read(config.uploadRecoveryConfigPath);
  const loadProof = () => read(path.join(upload.directory, 'activation-history.json'));
  if (upload.shopId !== config.shopId || !approvedWriter(binding, await loadProof(), config.shopId)) return false;
  const fence = await read(upload.fenceConfigPath);
  if (!fence.native || fence.native.shopId !== config.shopId || binding.database.port !== fence.mysql.port) return false;
  const db = await openConnection(fence.mysql);
  try {
    const lock = 'badizo-native:' + config.shopId;
    const [[{ acquired }]] = await db.query('SELECT GET_LOCK(?,0) AS acquired', [lock]);
    if (Number(acquired) !== 1) return false;
    try {
      const [[state]] = await db.query('SELECT @@server_uuid AS uuid, @@port AS port, @@read_only AS ro, @@super_read_only AS sro');
      if (state.uuid !== fence.native.replicaUuid || Number(state.port) !== binding.database.port || (!Number(state.ro) && !Number(state.sro))) return false;
      const [channels] = await db.query('SHOW REPLICA STATUS');
      if (channels.length !== 1 || channels[0].Channel_Name !== fence.native.channel ||
          channels[0].Source_UUID !== fence.native.sourceUuid || channels[0].Replica_IO_Running !== 'No' || channels[0].Replica_SQL_Running !== 'No') return false;
      const latest = validate(await read(config.bindingPath), config.shopId);
      if (latest.database.database !== binding.database.database || latest.database.port !== binding.database.port ||
          latest.activationId !== binding.activationId || !approvedWriter(latest, await loadProof(), config.shopId)) return false;
      await db.query('SET GLOBAL super_read_only=OFF');
      await db.query('SET GLOBAL read_only=OFF');
      const [[verified]] = await db.query('SELECT @@read_only AS ro, @@super_read_only AS sro');
      if (Number(verified.ro) || Number(verified.sro)) throw Error('Cloud recovery writer remains read-only.');
      return true;
    } finally { await db.query('SELECT RELEASE_LOCK(?)', [lock]); }
  } finally { await db.end(); }
}
module.exports = { approvedWriter, reconcileCloudWriter };
