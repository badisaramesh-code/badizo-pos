const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const mysql=require('mysql2/promise');
const {atomic,json}=require('./recoveryControlFiles');
const {fingerprintBusiness,sourceShopIdentity,archiveSync,partialBaselines,resetTables}=require('./recoveryBaselineEnrollment');
const {createSelfMapping}=require('./invoiceOriginIdentity');

// Each host prepares only its own detached clone. Both hosts compare the same
// authenticated cloud fingerprint; neither accepts remote database credentials.
async function prepareSingleBaseline({database,report,index,directory,bindingPath}){
  if(![0,1].includes(index)||!path.isAbsolute(directory||'')||!path.isAbsolute(bindingPath||'')||!/^badizo_recovery_[a-z0-9]{8,32}$/.test(database?.database||'')||database.database!==report.databases[index])throw Error('Invalid local recovery candidate.');
  const journalFile=path.join(directory,'candidate-preparation.json');
  const connection=await mysql.createConnection({...database,connectTimeout:10000});
  try{
    const [[locked]]=await connection.execute('SELECT GET_LOCK(?,0) AS acquired',['badizo-rebuild:'+database.database]);
    if(Number(locked.acquired)!==1)throw Error('Recovery target is already in use.');
    const bound=await json(bindingPath);if(bound.database.database===database.database)throw Error('Cannot prepare the active database.');
    const [[actual]]=await connection.query('SELECT DATABASE() AS name,VERSION() AS version');
    if(actual.name!==database.database||!/^8\.0\./.test(actual.version))throw Error('Recovery target requires MySQL 8.0.');
    if((await fingerprintBusiness(connection)).hash!==report.businessFingerprint.hash)throw Error('Restored copy differs from the frozen cloud snapshot.');
    let journal;try{journal=await json(journalFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(journal&&(journal.operationId!==report.operationId||journal.baselineId!==report.baselineId||journal.database!==database.database))throw Error('Candidate preparation belongs to another operation.');
    if(!journal||journal.state==='archiving'){
      const identity=await sourceShopIdentity(connection,report.shopId);
      const partials=await partialBaselines(connection);
      // An interrupted archive is retained, never adopted or overwritten.
      // No synchronization rows are reset until its completed hash is durable.
      const archiveFile=path.join(directory,'original-sync-'+crypto.randomUUID()+'.jsonl');
      await atomic(journalFile,{operationId:report.operationId,baselineId:report.baselineId,database:database.database,state:'archiving',partialArchive:archiveFile});
      const archive=await archiveSync(connection,archiveFile);
      journal={operationId:report.operationId,baselineId:report.baselineId,database:database.database,sourceIdentity:identity,partials,archive,state:'archived'};
      await atomic(journalFile,journal);
    }
    const digest=crypto.createHash('sha256');for await(const chunk of require('node:fs').createReadStream(journal.archive.file))digest.update(chunk);
    if(digest.digest('hex')!==journal.archive.sha256)throw Error('Retained synchronization history changed.');
    await connection.beginTransaction();
    try{
      const [rows]=await connection.execute('SELECT * FROM sync_enrollment WHERE singleton=1'),row=rows[0];
      const matches=rows.length===1&&row.shop_id===report.shopId&&row.installation_id===report.installationIds[index]&&row.peer_installation_id===report.installationIds[1-index]&&row.baseline_id===report.baselineId&&row.activation_id===report.activationIds[index]&&Number(row.enabled)===0;
      if(!matches){
        if(journal.state==='prepared'||row?.installation_id===report.installationIds[index])throw Error('Candidate was changed or enabled outside recovery.');
        for(const table of resetTables)await connection.query('DELETE FROM `'+table+'`');
        await connection.execute('INSERT INTO sync_enrollment (singleton,shop_id,installation_id,peer_installation_id,baseline_id,activation_id,contract_version,enabled) VALUES (1,?,?,?,?,?,1,0)',[report.shopId,report.installationIds[index],report.installationIds[1-index],report.baselineId,report.activationIds[index]]);
        for(const snapshot of journal.partials)await createSelfMapping(connection,snapshot,report.shopId,report.installationIds[0]);
      }
      await connection.commit();
    }catch(error){await connection.rollback().catch(()=>{});throw error;}
    if((await fingerprintBusiness(connection)).hash!==report.businessFingerprint.hash)throw Error('Candidate business records changed during preparation.');
    await atomic(journalFile,{...journal,state:'prepared'});
    return {prepared:true,archive:journal.archive,sourceIdentity:journal.sourceIdentity};
  }finally{await connection.end();}
}
module.exports={prepareSingleBaseline};
