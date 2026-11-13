'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const { json } = require('./recoveryControlFiles');
const {validate}=require('./recoveryRuntimeBinding');

function fixedJsonCommand(command, extra = [], timeoutMs = 30 * 60 * 1000) {
  if (!path.isAbsolute(command?.file || '') || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string')) throw Error('A fixed installed recovery command is required.');
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args, ...extra], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', overflow = false, settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(Error('Recovery command timed out; preserve its target for inspection.')); }, timeoutMs);
    child.stdout.on('data', chunk => { if (output.length + chunk.length > 65536) { overflow = true; child.kill(); } else output += chunk.toString(); });
    child.once('error', () => finish(Error('Installed recovery command could not start.')));
    child.once('close', code => {
      if (code !== 0 || overflow) return finish(Error('Installed recovery command did not verify.'));
      try { finish(null, JSON.parse(output)); } catch { finish(Error('Recovery command returned invalid verification.')); }
    });
  });
}
async function connection(config) {
  if (!['localhost', '127.0.0.1'].includes(config?.host) || !config.user || typeof config.password !== 'string') throw Error('Protected loopback recovery credentials required.');
  return mysql.createConnection({ host: config.host, port: config.port || 3306, user: config.user,
    password: config.password, ...(config.database ? { database: config.database } : {}), connectTimeout: 5000, multipleStatements: false });
}
function uploadedRecoveryCommitted({binding,prior,job,request}){
  if(binding.backupRecoveryOperationId===request.id&&binding.activationId===job.targetActivationId&&
    binding.activationId!==prior.activationId&&binding.generation===request.expectedGeneration+1&&binding.nativeReplicationInvalidated===true){
    if(binding.phase==='active'&&binding.billingMode==='active')return true;
    if(binding.phase==='validating')return false;
  }
  if(binding.activationId===prior.activationId&&binding.generation===request.expectedGeneration&&
    binding.billingMode==='standby'&&['active','validating'].includes(binding.phase))return false;
  throw Error('Recovery activation proof is unavailable. Do not change cloud write permissions.');
}
function createBackupRecoveryAdapters(supervisor, base) {
  let installed;
  const load = async () => installed ||= require('./backupUploadRecovery').configuration(supervisor);
  async function withRecoveryFence(c, request, operation) {
    if (!path.isAbsolute(c.fenceConfigPath || '')) throw Error('The recovery database fence has not been installed.');
    const protectedFence = await json(c.fenceConfigPath);
    if(protectedFence.mysql?.port!==undefined&&(!Number.isInteger(protectedFence.mysql.port)||protectedFence.mysql.port<1||protectedFence.mysql.port>65535))throw Error('Invalid pinned target MySQL port.');
    const db = await connection(protectedFence.mysql);
    try {
      const [[storage]]=await db.query('SELECT @@datadir AS data_directory');
      if(await fs.realpath(c.databaseDataDirectory)!==await fs.realpath(storage.data_directory))throw Error('The configured recovery data volume differs from MySQL.');
      const withSession = fn => fn((sql, args) => db.query({ sql, timeout: 10000 }, args));
      if (protectedFence.native) {
        if(protectedFence.native.shopId!==c.shopId)throw Error('Native recovery fence belongs to another shop.');
        const { withNativeRecoveryFence } = require('./nativeReplicaControl');
        if (typeof withNativeRecoveryFence !== 'function') throw Error('The native replication recovery fence is unavailable.');
        const prior=validate(await json(supervisor.bindingPath),c.shopId);
        const isCommitted=async()=>{
          const binding=validate(await json(supervisor.bindingPath),c.shopId);
          const job=await json(path.join(c.directory,request.uploadId,'upload.json'));
          return uploadedRecoveryCommitted({binding,prior,job,request});
        };
        return await withNativeRecoveryFence({ config: protectedFence.native, withSession,isCommitted }, async ({ query }) => {
          // The target POS is already standby and drained; only the detached slot importer can write.
          await query('SET GLOBAL super_read_only=OFF'); await query('SET GLOBAL read_only=OFF');
          return operation();
        });
      }
      if (protectedFence.nativeReplicationAbsentVerified !== true || protectedFence.shopId !== c.shopId ||
          !/^[a-f0-9-]{36}$/.test(protectedFence.serverUuid || '')) throw Error('Verified non-replicated target configuration required.');
      const [[lock]] = await db.query('SELECT GET_LOCK(?,0) AS acquired', ['badizo-native:' + c.shopId]);
      if (Number(lock.acquired) !== 1) throw Error('Database recovery or replication control is busy.');
      try {
        const [[identity]] = await db.query('SELECT @@server_uuid AS server_uuid, @@super_read_only AS super_read_only');
        const [channels] = await db.query('SHOW REPLICA STATUS');
        if (identity.server_uuid !== protectedFence.serverUuid || Number(identity.super_read_only) !== 0 || channels.length) throw Error('Target identity or replication mode changed; no import performed.');
        return await operation();
      } finally { await db.query('SELECT RELEASE_LOCK(?)', ['badizo-native:' + c.shopId]); }
    } finally { await db.end(); }
  }
  async function checkEmpty(slot) {
    const db = await connection(slot);
    try {
      const c = await load(), fence = await json(c.fenceConfigPath);
      const [[identity]] = await db.query('SELECT @@server_uuid AS server_uuid');
      if (identity.server_uuid !== (fence.native?.replicaUuid || fence.serverUuid)) throw Error('Recovery slot is on a different MySQL instance.');
      const [[row]] = await db.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE()'); return Number(row.n) === 0;
    }
    finally { await db.end(); }
  }
  async function restore(configPath) {
    const c = await load();
    const result = await fixedJsonCommand({ file: c.pythonExecutable, args: [require('./restoreScriptPath')] }, [configPath]);
    if (!c.candidateMigration) throw Error('A candidate-only schema migration command must be installed.');
    const config = await json(configPath);
    const migrated = await fixedJsonCommand(c.candidateMigration, [configPath]);
    if (migrated.candidateSchemaVerified !== true || migrated.candidateDataIntegrityVerified !== true || migrated.shopId !== c.shopId || migrated.database !== config.database) throw Error('Candidate schema and data-integrity checks did not verify.');
    return result;
  }
  async function validateCandidate(slot, expectedShop, result) {
    const db = await connection(slot);
    try {
      const [settings] = await db.query("SELECT setting_key,setting_value FROM app_settings WHERE setting_key IN ('gst_number','shop_name')");
      const values = Object.fromEntries(settings.map(row => [row.setting_key, String(row.setting_value || '').trim()]));
      if ((values.gst_number || '').toUpperCase() !== expectedShop.gstNumber.trim().toUpperCase() ||
          expectedShop.shopName && values.shop_name !== expectedShop.shopName.trim()) throw Error('Backup belongs to another shop or identity cannot be verified.');
      const [[check]] = await db.query(`SELECT
        (SELECT COUNT(*) FROM invoice_items x LEFT JOIN invoices i ON i.invoice_no=x.invoice_no WHERE i.invoice_no IS NULL) AS orphan_items,
        (SELECT COUNT(*) FROM invoice_payments x LEFT JOIN invoices i ON i.invoice_no=x.invoice_no WHERE i.invoice_no IS NULL) AS orphan_payments,
        (SELECT COUNT(*) FROM invoice_items WHERE quantity<0 OR returned_qty<0 OR returned_qty>quantity) AS invalid_quantities,
        (SELECT COUNT(*) FROM invoices WHERE grand_total<0) AS invalid_totals`);
      if (Object.values(check).some(value => Number(value) !== 0)) throw Error('Invoice, payment or stock-quantity checks failed.');
      const [[counts]] = await db.query("SELECT (SELECT COUNT(*) FROM products) AS products,(SELECT COUNT(*) FROM invoices) AS invoices,(SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE') AS tableCount");
      // Candidate migrations may add schema, but must not silently remove restored transactions.
      if (Number(counts.products) !== result.products || Number(counts.invoices) !== result.invoices || Number(counts.tableCount) < result.tableCount) throw Error('Candidate migration changed restored business rows.');
      result.tableCount = Number(counts.tableCount);
      result.candidateDataIntegrityVerified = true;
    } finally { await db.end(); }
  }
  async function prepareInvoiceNumbers(value) {
    const candidateConnection = await connection(value.candidateDatabase); let previousConnection;
    try {
      // A lost/corrupt previous database is a normal disaster case. The fresh,
      // operation-scoped invoice namespace is mandatory even without its high-water marks.
      try{previousConnection = await connection(value.previousDatabase);}catch{previousConnection=null;}
      return await require('./recoveryInvoiceNumbers').prepareRecoveryInvoiceNumbers({ candidateConnection,
        previousConnection, nodeRole: value.nodeRole, operationId: value.operationId });
    } finally { await previousConnection?.end(); await candidateConnection.end(); }
  }
  return { ...base, withRecoveryFence, checkEmpty, restore, validateCandidate, prepareInvoiceNumbers };
}
module.exports = { createBackupRecoveryAdapters, fixedJsonCommand,uploadedRecoveryCommitted };
