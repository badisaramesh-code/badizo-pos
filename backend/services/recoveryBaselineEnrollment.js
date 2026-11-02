const fs=require('node:fs/promises'),nativeFs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {canonical}=require('./syncEventProtocol');
const {atomic,json}=require('./recoveryControlFiles');
const {allowedDatabase,assertDetached}=require('./recoveryBaselineRebuild');
const {invoiceSnapshot,createSelfMapping}=require('./invoiceOriginIdentity');
const {decimal}=require('./checkoutSyncHandler');
const hash=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
const identifier=value=>{if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value))throw Error('Unsupported snapshot identifier.');return '`'+value+'`';};
const resetTables=['sync_invoice_batch_map','sync_invoice_item_map','sync_invoice_map','sync_stock_adjustment_map','sync_supplier_payment_map','sync_recovery_applications','sync_worker_state','sync_inbox','sync_outbox','sync_enrollment'];
const preservedProofTables=['sync_checkout_requests'];
const normalizeSchema=sql=>sql.replace(/ AUTO_INCREMENT=\d+/g,'');
async function verifiedArtifact(directory,shopId,database){
  if(!path.isAbsolute(directory||''))throw Error('Verified restore artifact required.');
  const manifest=await json(path.join(directory,'manifest.json')),result=await json(path.join(directory,'restore-result.json'));
  if(manifest.shopId!==shopId||manifest.integrityVerified!==true||result.shopId!==shopId||result.database!==database||result.stagedRestoreVerified!==true||result.activated!==false||result.sqlSha256!==manifest.sqlSha256||!/^[a-f0-9]{64}$/.test(manifest.sqlSha256||''))throw Error('Restore artifact provenance differs.');
  const digest=crypto.createHash('sha256');let size=0;
  for await(const chunk of nativeFs.createReadStream(path.join(directory,'database.sql'))){size+=chunk.length;digest.update(chunk);}
  if(size!==manifest.sqlBytes||digest.digest('hex')!==manifest.sqlSha256)throw Error('Verified snapshot SQL changed.');
  return {sqlSha256:manifest.sqlSha256,sqlBytes:size};
}
async function tables(connection){
  const [rows]=await connection.query('SELECT TABLE_NAME AS name,ENGINE AS engine,TABLE_TYPE AS type FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY TABLE_NAME');
  if(!rows.length||rows.some(row=>row.engine!=='InnoDB'||row.type!=='BASE TABLE'))throw Error('Snapshot requires transactional base tables only.');
  for(const row of rows){identifier(row.name);if(row.name.startsWith('sync_')&&!resetTables.includes(row.name)&&!preservedProofTables.includes(row.name)&&row.name!=='sync_schema_migrations')throw Error('Unknown synchronization table requires an explicit migration review.');}
  if([...resetTables,...preservedProofTables].some(name=>!rows.some(row=>row.name===name)))throw Error('Install verified synchronization tables in each candidate first.');
  return rows.map(row=>row.name);
}
async function* tableRows(connection,table){
  const [keys]=await connection.query('SHOW KEYS FROM '+identifier(table)+" WHERE Key_name='PRIMARY'");
  const columns=keys.sort((a,b)=>Number(a.Seq_in_index)-Number(b.Seq_in_index)).map(row=>row.Column_name);
  let last=null,offset=0;
  for(;;){
    const after=last?' WHERE ('+columns.map(identifier).join(',')+') > ('+columns.map(()=>'?').join(',')+')':'';
    const order=columns.length?' ORDER BY '+columns.map(identifier).join(','):'';
    const [rows]=await connection.query({sql:'SELECT * FROM '+identifier(table)+after+order+' LIMIT 250'+(columns.length?'':' OFFSET '+offset),dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},last||[]);
    for(const row of rows)yield JSON.parse(JSON.stringify(row));
    if(rows.length<250)break;
    if(columns.length)last=columns.map(column=>rows[rows.length-1][column]);else offset+=rows.length;
  }
}
async function fingerprintBusiness(connection,{maxRows=2000000}={}){
  const names=(await tables(connection)).filter(name=>!name.startsWith('sync_')||preservedProofTables.includes(name)),fingerprints=[];let total=0;
  const [[routines]]=await connection.query('SELECT COUNT(*) AS n FROM information_schema.routines WHERE routine_schema=DATABASE()');
  const [[scheduled]]=await connection.query('SELECT COUNT(*) AS n FROM information_schema.events WHERE event_schema=DATABASE()');
  if(Number(routines.n)!==0||Number(scheduled.n)!==0)throw Error('Unreviewed stored routines or scheduled events prevent baseline preparation.');
  const [triggerRows]=await connection.query('SELECT TRIGGER_NAME AS name,EVENT_MANIPULATION AS event,EVENT_OBJECT_TABLE AS tableName,ACTION_TIMING AS timing,ACTION_STATEMENT AS statement,SQL_MODE AS sqlMode FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY TRIGGER_NAME');
  const triggers=JSON.parse(JSON.stringify(triggerRows));
  for(const name of names){
    const [[ddl]]=await connection.query('SHOW CREATE TABLE '+identifier(name));
    const schema=normalizeSchema(Object.values(ddl).find(value=>typeof value==='string'&&value.startsWith('CREATE TABLE'))||'');if(!schema)throw Error('Cannot inspect snapshot schema.');
    const rowHashes=[];for await(const row of tableRows(connection,name)){if(++total>maxRows)throw Error('Snapshot fingerprint exceeds bounded row limit.');rowHashes.push(hash(row));}
    rowHashes.sort();fingerprints.push({table:name,schemaHash:hash(schema),rows:rowHashes.length,dataHash:hash(rowHashes)});
  }
  return {tables:fingerprints,triggers,rows:total,hash:hash({tables:fingerprints,triggers})};
}
async function archiveSync(connection,file){
  const output=await fs.open(file,'wx',0o600),digest=crypto.createHash('sha256');let bytes=0,rows=0;
  async function write(value){const line=canonical(value)+'\n';bytes+=Buffer.byteLength(line);if(bytes>256*1024*1024)throw Error('Retained synchronization evidence exceeds archive limit.');digest.update(line);await output.writeFile(line);}
  try{
    for(const table of resetTables){
      const [[ddl]]=await connection.query('SHOW CREATE TABLE '+identifier(table));await write({table,schema:Object.values(ddl).find(value=>typeof value==='string'&&value.startsWith('CREATE TABLE'))});
      for await(const row of tableRows(connection,table)){await write({table,row});rows++;}
    }
    await output.sync();return {file,sha256:digest.digest('hex'),bytes,rows};
  }finally{await output.close();}
}
function eligiblePartial(snapshot){
  try{return snapshot.invoice.invoice_status==='PARTIALLY_RETURNED'&&Number(snapshot.invoice.exchange_total)===0&&snapshot.invoice.exchange_items_json===null&&Number(snapshot.invoice.loyalty_redeemed_points)===0&&Number(snapshot.invoice.loyalty_redeemed_amount)===0&&snapshot.loyaltyTransactions.length===0&&snapshot.items.length>0&&snapshot.items.every(item=>Number(item.is_free_bonus)===0&&item.free_offer_id===null&&decimal(item.returned_qty)<=decimal(item.quantity));}catch{return false;}
}
async function partialBaselines(connection){
  const [invoices]=await connection.query("SELECT invoice_no FROM invoices WHERE invoice_status='PARTIALLY_RETURNED' ORDER BY id");
  const result=[];
  for(const invoice of invoices){const snapshot=await invoiceSnapshot(connection,invoice.invoice_no);if(!eligiblePartial(snapshot))throw Error('A partially returned historical invoice requires its own recovery profile.');result.push(snapshot);if(result.length>10000)throw Error('Historical return baseline exceeds run limit.');}
  return result;
}
async function sourceShopIdentity(connection,shopId){
  const [rows]=await connection.execute('SELECT * FROM sync_enrollment WHERE singleton=1');
  const row=rows[0];
  // A manifest's shopId is supplied by the restore caller. File integrity and
  // an echoed label do not establish ownership of a legacy shop's database.
  if(rows.length!==1||row.shop_id!==shopId||Number(row.contract_version)!==1||!/^[A-Za-z0-9_-]{3,64}$/.test(row.installation_id||'')||!/^[A-Za-z0-9_-]{3,64}$/.test(row.peer_installation_id||'')||row.installation_id===row.peer_installation_id||!/^[a-f0-9]{64}$/.test(row.baseline_id||''))throw Error('Verified source shop enrollment is required before candidate reset.');
  return {shopId:row.shop_id,installationId:row.installation_id,peerInstallationId:row.peer_installation_id,baselineId:row.baseline_id};
}

// Explicit COPY path only. These are TWO detached clones of one verified
// snapshot, not divergent histories. Originals and every old sync row remain
// retained. Fresh enrollment is prepared disabled; no live pointer is changed.
async function prepareSameSnapshotEnrollment({pools,configuration,reportPath}){
  const {shopId,sides,confirmation}=configuration||{};
  if(confirmation!=='COPY VERIFIED SNAPSHOT; PRESERVE ORIGINAL DATABASES'||!/^[A-Z][A-Z0-9_-]{2,31}$/.test(shopId||'')||!Array.isArray(sides)||sides.length!==2||!Array.isArray(pools)||pools.length!==2||!path.isAbsolute(reportPath||'')||sides.some(side=>!allowedDatabase(side.databaseName))||sides[0].databaseName===sides[1].databaseName)throw Error('Explicit detached same-snapshot copy configuration required.');
  await assertDetached(configuration);
  const artifacts=await Promise.all(sides.map(side=>verifiedArtifact(side.artifactDirectory,shopId,side.databaseName)));
  if(artifacts[0].sqlSha256!==artifacts[1].sqlSha256)throw Error('Candidates were restored from different snapshots.');
  const connections=[];let report;
  try{
    for(let i=0;i<2;i++){
      const connection=await pools[i].getConnection();connections.push(connection);
      const [[db]]=await connection.query('SELECT DATABASE() AS name,VERSION() AS version');if(db.name!==sides[i].databaseName||!/^8\.0\./.test(db.version))throw Error('Unexpected candidate database.');
      const [[locked]]=await connection.execute('SELECT GET_LOCK(?,0) AS acquired',['badizo-rebuild:'+sides[i].databaseName]);if(Number(locked.acquired)!==1)throw Error('Candidate is being rebuilt or activated.');
    }
    await assertDetached(configuration);
    const sourceIdentities=await Promise.all(connections.map(connection=>sourceShopIdentity(connection,shopId)));
    const fingerprints=await Promise.all(connections.map(connection=>fingerprintBusiness(connection)));
    if(fingerprints[0].hash!==fingerprints[1].hash)throw Error('Candidate business records or schemas diverge; copy enrollment cannot merge them.');
    // A partial invoice must keep its CURRENT returned quantity and complete
    // shared return history as the new baseline. Never reset it to a paid bill.
    const partials=await Promise.all(connections.map(partialBaselines));
    if(canonical(partials[0])!==canonical(partials[1]))throw Error('Historical return baselines differ.');
    const baselineId=hash({shopId,sqlSha256:artifacts[0].sqlSha256,businessHash:fingerprints[0].hash});
    try{report=await json(reportPath);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(report){
      if(report.shopId!==shopId||report.baselineId!==baselineId||canonical(report.databases)!==canonical(sides.map(side=>side.databaseName)))throw Error('Candidate changed since enrollment preparation.');
      if(report.sourceShopIdentityVerified!==true||!Array.isArray(report.sourceShopIdentityEvidence)||report.sourceShopIdentityEvidence.length!==2||report.sourceShopIdentityEvidence.some(source=>source.shopId!==shopId||!/^[a-f0-9]{64}$/.test(source.baselineId||'')))throw Error('Original shop identity proof is absent from the preparation journal.');
      for(const archive of report.archives||[]){const raw=await fs.readFile(archive.file);if(crypto.createHash('sha256').update(raw).digest('hex')!==archive.sha256)throw Error('Retained pre-enrollment evidence changed.');}
    }else{
      const operationId=crypto.randomUUID();
      report={schemaVersion:1,operationId,shopId,baselineId,sqlSha256:artifacts[0].sqlSha256,businessFingerprint:fingerprints[0],databases:sides.map(side=>side.databaseName),state:'archiving',archives:[],prepared:[false,false],installationIds:['local-'+crypto.randomUUID(),'cloud-'+crypto.randomUUID()],activationIds:[crypto.randomUUID(),crypto.randomUUID()],syncEnabled:false,activated:false,sourceSelection:'explicit-same-snapshot-copy',sourceShopIdentityVerified:true,sourceShopIdentityEvidence:sourceIdentities,startedAt:new Date().toISOString()};
      // Archive BOTH original sync datasets durably before either is reset.
      for(let i=0;i<2;i++)report.archives.push(await archiveSync(connections[i],reportPath+'.'+operationId+'.'+i+'.sync.jsonl'));
      report.state='preparing';await atomic(reportPath,report);
    }
    if(report.archives.length!==2)throw Error('Both pre-enrollment evidence archives are required.');
    for(let i=0;i<2;i++){
      await assertDetached(configuration);const connection=connections[i];await connection.beginTransaction();
      try{
        if(!report.prepared[i]){
          const [existing]=await connection.execute('SELECT * FROM sync_enrollment WHERE singleton=1');
          if(existing.some(row=>row.installation_id===report.installationIds[i]&&Number(row.enabled)!==0))throw Error('Candidate was enabled outside this preparation.');
          for(const table of resetTables)await connection.query('DELETE FROM '+identifier(table));
          await connection.execute('INSERT INTO sync_enrollment (singleton,shop_id,installation_id,peer_installation_id,baseline_id,activation_id,contract_version,enabled) VALUES (1,?,?,?,?,?,1,0)',[shopId,report.installationIds[i],report.installationIds[1-i],baselineId,report.activationIds[i]]);
          for(const snapshot of partials[i])await createSelfMapping(connection,snapshot,shopId,report.installationIds[0]);
        }
        const [rows]=await connection.execute('SELECT * FROM sync_enrollment WHERE singleton=1');const row=rows[0];
        if(rows.length!==1||row.shop_id!==shopId||row.installation_id!==report.installationIds[i]||row.peer_installation_id!==report.installationIds[1-i]||row.baseline_id!==baselineId||row.activation_id!==report.activationIds[i]||Number(row.enabled)!==0)throw Error('Prepared candidate enrollment differs or was enabled externally.');
        await connection.commit();report.prepared[i]=true;await atomic(reportPath,report);
      }catch(error){await connection.rollback().catch(()=>{});throw error;}
    }
    const verified=await Promise.all(connections.map(connection=>fingerprintBusiness(connection)));
    if(verified.some(value=>value.hash!==fingerprints[0].hash))throw Error('Business records changed during candidate preparation.');
    report.state='prepared-disabled';report.partialInvoiceBaselines=partials[0].length;report.completedAt=new Date().toISOString();report.readyForProtectedEnrollment=true;report.requiresFinalSourceCheckpoint=true;report.originalHistoriesMerged=false;await atomic(reportPath,report);return report;
  }finally{for(let i=connections.length-1;i>=0;i--){try{await connections[i].execute('SELECT RELEASE_LOCK(?)',['badizo-rebuild:'+sides[i].databaseName]);}catch{}connections[i].release();}}
}
module.exports={fingerprintBusiness,prepareSameSnapshotEnrollment,verifiedArtifact,normalizeSchema,eligiblePartial,sourceShopIdentity};
