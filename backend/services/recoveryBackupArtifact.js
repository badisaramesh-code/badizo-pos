const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Shared input preparation for a downloaded Drive backup or cloud export.
// Does not import the database initializer or execute any SQL.
async function prepareRecoveryBackup({ sourcePath, outputDirectory, expectedSha256, shopId, source, maxExpandedBytes = 10 * 1024 ** 3, requireCompleteDump = false }) {
  if (!path.isAbsolute(sourcePath || '') || !path.isAbsolute(outputDirectory || '')) throw Error('Absolute recovery paths required.');
  if (!/^[A-Z][A-Z0-9_-]{2,31}$/.test(shopId || '') || !['google-drive','cloud-export'].includes(source)) throw Error('Explicit shop and backup source required.');
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw Error('Expected backup SHA-256 required.');
  if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes <= 0) throw Error('Invalid expanded backup limit.');
  if (!/\.sql(?:\.gz)?$/i.test(sourcePath)) throw Error('Select a SQL or gzip SQL backup.');
  const stat = await fsp.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw Error('A nonempty regular backup file is required.');
  // Exclusive folder prevents replacement of previous recovery evidence.
  await fsp.mkdir(outputDirectory, { mode: 0o700 });
  const pending = path.join(outputDirectory,'database.sql.pending');
  const compressed = crypto.createHash('sha256'), expanded = crypto.createHash('sha256');
  let bytes = 0, sourceBytes = 0, tail = Buffer.alloc(0);
  const inputMeter = new Transform({ transform(chunk, _encoding, callback) { sourceBytes += chunk.length; compressed.update(chunk); callback(null,chunk); } });
  const outputMeter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxExpandedBytes) return callback(Error('Expanded backup exceeds recovery limit.'));
    expanded.update(chunk);tail=Buffer.concat([tail,chunk]).subarray(-4096);callback(null,chunk);
  } });
  try {
    const stages = [fs.createReadStream(sourcePath), inputMeter];
    if (/\.gz$/i.test(sourcePath)) stages.push(zlib.createGunzip());
    stages.push(outputMeter, fs.createWriteStream(pending,{flags:'wx',mode:0o600}));
    await pipeline(...stages);
    if (!bytes || compressed.digest('hex') !== expectedSha256) throw Error('Backup checksum mismatch or empty SQL.');
    const completed=tail.toString('utf8').match(/-- Dump completed on (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*$/);
    if(requireCompleteDump && !completed)throw Error('A complete mysqldump backup with a completion timestamp is required.');
    const handle = await fsp.open(pending,'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const manifest = { schemaVersion:1,shopId,source,sourceSha256:expectedSha256,sourceBytes,
      sqlSha256:expanded.digest('hex'),sqlBytes:bytes,preparedAt:new Date().toISOString(),
      integrityVerified:true,shopIdentityVerified:false,restoreVerified:false,activated:false,
      reportedBackupTime:completed?.[1]||null,provenanceVerified:false };
    await fsp.rename(pending,path.join(outputDirectory,'database.sql'));
    await fsp.writeFile(path.join(outputDirectory,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
    return manifest;
  } catch(error) {
    await fsp.unlink(pending).catch(()=>{});
    // Keep the exclusive directory as failure evidence; never delete a caller's tree.
    throw error;
  }
}
module.exports = { prepareRecoveryBackup };
