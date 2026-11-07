// Synthetic MySQL acceptance for disabled same-snapshot enrollment and an
// already partially returned invoice. Only TWO EMPTY copytest databases.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {prepareSameSnapshotEnrollment}=require('../../backend/services/recoveryBaselineEnrollment');
const {captureInvoiceLifecycle}=require('../../backend/services/checkoutSyncCapture');
const {createPosSyncReceiver}=require('../../backend/services/posSyncReceiver');
async function main(){
  const c=JSON.parse(await fs.readFile(process.argv[2],'utf8'));assert.ok(path.isAbsolute(c.directory));assert.equal(c.sides.length,2);assert.notEqual(c.sides[0].database,c.sides[1].database);
  for(const side of c.sides){assert.match(side.database,/^badizo_recovery_copytest[a-z0-9]{2,20}$/);assert.ok(['localhost','127.0.0.1'].includes(side.host));}
  const pools=c.sides.map(side=>mysql.createPool({...side,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:4}));
  try{
    for(const pool of pools){const [[row]]=await pool.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE()');assert.equal(Number(row.n),0,'only empty validation databases are allowed');}
    const statements=[
      'CREATE TABLE products (barcode VARCHAR(120) PRIMARY KEY,product_name VARCHAR(255),sale_price DECIMAL(10,2),stock_qty DECIMAL(10,2),updated_at TIMESTAMP NULL) ENGINE=InnoDB',
      'CREATE TABLE invoices (id BIGINT UNSIGNED PRIMARY KEY,invoice_no VARCHAR(50) UNIQUE,invoice_status VARCHAR(30),grand_total DECIMAL(10,2),exchange_total DECIMAL(10,2),exchange_items_json TEXT NULL,loyalty_redeemed_points INT,loyalty_redeemed_amount DECIMAL(10,2)) ENGINE=InnoDB',
      'CREATE TABLE invoice_items (id BIGINT UNSIGNED PRIMARY KEY,invoice_no VARCHAR(50),barcode VARCHAR(120),product_name VARCHAR(255),quantity DECIMAL(10,2),sale_price DECIMAL(10,2),gst_percent DECIMAL(10,2),returned_qty DECIMAL(10,2),is_free_bonus BOOLEAN,free_offer_id BIGINT NULL) ENGINE=InnoDB',
      'CREATE TABLE invoice_payments (id BIGINT UNSIGNED PRIMARY KEY,invoice_no VARCHAR(50),payment_mode VARCHAR(20),amount DECIMAL(10,2)) ENGINE=InnoDB',
      'CREATE TABLE invoice_item_batches (id BIGINT UNSIGNED PRIMARY KEY,invoice_no VARCHAR(50),invoice_item_id BIGINT,barcode VARCHAR(120),batch_no VARCHAR(80),expiry_date DATE NULL,quantity DECIMAL(10,2),returned_qty DECIMAL(10,2)) ENGINE=InnoDB',
      'CREATE TABLE loyalty_transactions (id BIGINT UNSIGNED PRIMARY KEY,invoice_no VARCHAR(50)) ENGINE=InnoDB',
      'CREATE TABLE sales_returns (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,return_no VARCHAR(50) UNIQUE,invoice_no VARCHAR(50),reason VARCHAR(255),refund_mode VARCHAR(20),taxable_total DECIMAL(10,2),gst_total DECIMAL(10,2),refund_total DECIMAL(10,2)) ENGINE=InnoDB',
      'CREATE TABLE sales_return_items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,return_no VARCHAR(50),invoice_item_id BIGINT,barcode VARCHAR(120),product_name VARCHAR(255),quantity DECIMAL(10,2),sale_price DECIMAL(10,2),gst_percent DECIMAL(10,2),taxable_amount DECIMAL(10,2),gst_amount DECIMAL(10,2),refund_amount DECIMAL(10,2)) ENGINE=InnoDB',
      'CREATE TABLE users (id BIGINT UNSIGNED PRIMARY KEY,username VARCHAR(100)) ENGINE=InnoDB',
      "INSERT INTO products VALUES ('P','ISOLATED PARTIAL',10,10,NULL)",
      "INSERT INTO invoices VALUES (1,'HIST/1','PARTIALLY_RETURNED',30,0,NULL,0,0)",
      "INSERT INTO invoice_items VALUES (1,'HIST/1','P','ISOLATED PARTIAL',3,10,0,1,0,NULL)",
      "INSERT INTO invoice_payments VALUES (1,'HIST/1','Cash',30)",
      "INSERT INTO sales_returns VALUES (1,'RET/BEFORE','HIST/1','prior return','Cash',10,0,10)",
      "INSERT INTO sales_return_items VALUES (1,'RET/BEFORE',1,'P','ISOLATED PARTIAL',1,10,0,10,0,10)"
    ];
    const manifest=JSON.parse(await fs.readFile(path.resolve(__dirname,'../../database/migrations/sync-release.json'),'utf8'));
    for(const migration of manifest.migrations){const raw=await fs.readFile(path.resolve(__dirname,'../../database/migrations',migration.file),'utf8');statements.push(...raw.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean));}
    const requestId=crypto.randomUUID();
    statements.push("INSERT INTO sync_checkout_requests (request_id,intent_hash,invoice_no,recorded_at) VALUES ('"+requestId+"','"+'a'.repeat(64)+"','HIST/1','2026-01-01 00:00:00')");
    statements.push("INSERT INTO sync_enrollment (singleton,shop_id,installation_id,peer_installation_id,baseline_id,activation_id,contract_version,enabled,enrolled_at) VALUES (1,'HFM001','source-cloud','source-local','"+'c'.repeat(64)+"','77d0a4e9-3cf9-4fc3-9356-bb1c11470bd8',1,1,'2026-01-01 00:00:00')");
    const sql=statements.join(';\n')+';\n',sqlSha256=crypto.createHash('sha256').update(sql).digest('hex');
    const configuration={shopId:'HFM001',confirmation:'COPY VERIFIED SNAPSHOT; PRESERVE ORIGINAL DATABASES',sides:[]};await fs.mkdir(c.directory,{recursive:true,mode:0o700});
    for(let i=0;i<2;i++){
      for(const statement of statements)await pools[i].query(statement);
      const artifactDirectory=path.join(c.directory,'artifact'+i),originalRuntimeBinding=path.join(c.directory,i+'-original-binding.json');await fs.mkdir(artifactDirectory,{mode:0o700});
      await fs.writeFile(path.join(artifactDirectory,'database.sql'),sql,{flag:'wx',mode:0o600});
      await fs.writeFile(path.join(artifactDirectory,'manifest.json'),JSON.stringify({shopId:'HFM001',integrityVerified:true,sqlSha256,sqlBytes:Buffer.byteLength(sql)}),{flag:'wx',mode:0o600});
      await fs.writeFile(path.join(artifactDirectory,'restore-result.json'),JSON.stringify({shopId:'HFM001',database:c.sides[i].database,stagedRestoreVerified:true,activated:false,sqlSha256}),{flag:'wx',mode:0o600});
      await fs.writeFile(originalRuntimeBinding,JSON.stringify({shopId:'HFM001',database:{database:i?'isolated_original_cloud':'isolated_original_local'}}),{flag:'wx',mode:0o600});
      configuration.sides.push({databaseName:c.sides[i].database,artifactDirectory,originalRuntimeBinding});
    }
    const args={pools,configuration,reportPath:path.join(c.directory,'copy-report.json')};
    const report=await prepareSameSnapshotEnrollment(args);assert.equal(report.state,'prepared-disabled');assert.equal(report.partialInvoiceBaselines,1);assert.equal(report.syncEnabled,false);assert.equal(report.sourceShopIdentityVerified,true);
    for(const pool of pools){const [[row]]=await pool.execute('SELECT enabled FROM sync_enrollment WHERE singleton=1');assert.equal(Number(row.enabled),0);const [[proof]]=await pool.execute('SELECT request_id FROM sync_checkout_requests WHERE invoice_no=?',['HIST/1']);assert.equal(proof.request_id,requestId);}
    const again=await prepareSameSnapshotEnrollment(args);assert.deepEqual(again.installationIds,report.installationIds);
    async function returnOn(index,returnNo){
      const connection=await pools[index].getConnection();
      try{
        await connection.beginTransaction();
        await connection.execute('UPDATE invoice_items SET returned_qty=returned_qty+1 WHERE id=1');
        await connection.execute('UPDATE products SET stock_qty=stock_qty+1 WHERE barcode=?',['P']);
        await connection.execute("UPDATE invoices SET invoice_status=? WHERE invoice_no='HIST/1'",[index?'RETURNED':'PARTIALLY_RETURNED']);
        await connection.execute("INSERT INTO sales_returns (return_no,invoice_no,reason,refund_mode,taxable_total,gst_total,refund_total) VALUES (?,'HIST/1','isolated subsequent return','Cash',10,0,10)",[returnNo]);
        await connection.execute("INSERT INTO sales_return_items (return_no,invoice_item_id,barcode,product_name,quantity,sale_price,gst_percent,taxable_amount,gst_amount,refund_amount) VALUES (?,1,'P','ISOLATED PARTIAL',1,10,0,10,0,10)",[returnNo]);
        const eventId=await captureInvoiceLifecycle(connection,'HIST/1',{kind:'return',returnNo},{BADIZO_SYNC_CHECKOUT_CAPTURE:'true',BADIZO_SHOP_ID:'HFM001',BADIZO_INSTALLATION_ID:report.installationIds[index],BADIZO_SYNC_PEER_INSTALLATION_ID:report.installationIds[1-index]});
        await connection.commit();const [[row]]=await pools[index].execute('SELECT event_json FROM sync_outbox WHERE event_id=?',[eventId]);return typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
      }catch(error){await connection.rollback();throw error;}finally{connection.release();}
    }
    for(let i=0;i<2;i++){
      const event=await returnOn(i,'RET/AFTER'+i),receive=createPosSyncReceiver({pool:pools[1-i],identity:{shopId:'HFM001',localInstallationId:report.installationIds[1-i],peerInstallationId:report.installationIds[i]},retainReceived:true});
      assert.equal((await receive(event)).committed,true);assert.equal((await receive(event)).duplicate,true);
    }
    for(const pool of pools){const [[row]]=await pool.query("SELECT invoice_status FROM invoices WHERE invoice_no='HIST/1'");assert.equal(row.invoice_status,'RETURNED');const [[stock]]=await pool.query("SELECT stock_qty FROM products WHERE barcode='P'");assert.equal(stock.stock_qty,'12.00');}
    await assert.rejects(prepareSameSnapshotEnrollment(args),/changed since enrollment preparation|diverge/);
    console.log(JSON.stringify({identicalSnapshotVerified:true,disabledFreshEnrollment:true,checkoutRetryProofPreserved:true,partialReturnBaselinePreserved:true,bothDirectionLaterReturns:true,duplicateReturnsDoNotAddStock:true,newerBusinessChangesBlockReset:true,productionModified:false}));
  }finally{await Promise.all(pools.map(pool=>pool.end()));}
}
main().catch(error=>{console.error('Isolated copy preparation validation failed: '+error.message);process.exitCode=1;});
