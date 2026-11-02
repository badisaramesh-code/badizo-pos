const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {prepareRecoveryBackup}=require('../services/recoveryBackupArtifact');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
test('both recovery sources prepare verified SQL without touching a database',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-restore-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sql=Buffer.from('CREATE TABLE example (id INT);\n');
  for(const source of ['google-drive','cloud-export']) {
    const data=source==='google-drive'?zlib.gzipSync(sql):sql;
    const sourcePath=path.join(root,source+(source==='google-drive'?'.sql.gz':'.sql'));
    await fs.writeFile(sourcePath,data);
    const options={sourcePath,outputDirectory:path.join(root,source),expectedSha256:hash(data),shopId:'HFM001',source};
    const result=await prepareRecoveryBackup(options);
    assert.deepEqual(await fs.readFile(path.join(options.outputDirectory,'database.sql')),sql);
    assert.equal(result.integrityVerified,true);assert.equal(result.restoreVerified,false);assert.equal(result.activated,false);
    await assert.rejects(prepareRecoveryBackup(options));
  }
});
test('corrupt, oversized or mismatched backups never publish a usable manifest',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'badizo-restore-fail-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const valid=zlib.gzipSync(Buffer.from('SELECT 1;'.repeat(100)));
  for(const [name,data,checksum,limit] of [['wrong',valid,'0'.repeat(64),10000],['truncated',valid.subarray(0,15),hash(valid.subarray(0,15)),10000],['large',valid,hash(valid),10]]) {
    const sourcePath=path.join(root,name+'.sql.gz'),outputDirectory=path.join(root,name);await fs.writeFile(sourcePath,data);
    await assert.rejects(prepareRecoveryBackup({sourcePath,outputDirectory,expectedSha256:checksum,maxExpandedBytes:limit,shopId:'HFM001',source:'google-drive'}));
    await assert.rejects(fs.access(path.join(outputDirectory,'manifest.json')));
    await assert.rejects(fs.access(path.join(outputDirectory,'database.sql.pending')));
  }
});
