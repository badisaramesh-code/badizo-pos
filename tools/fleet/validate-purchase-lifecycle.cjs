const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),mysql=require('mysql2/promise');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {applyCheckout,insert}=require('../../backend/services/checkoutSyncHandler');
const {applyReturn}=require('../../backend/services/invoiceReturnSyncHandler');
const {applyCancellation}=require('../../backend/services/invoiceCancellationSyncHandler');
const {applyPurchase}=require('../../backend/services/purchaseSync');
async function main(){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation');
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const source=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  const target=mysql.createPool({host:config.host,user:config.user,password:config.password,database:config.database,connectionLimit:3});let child,log;
  try{
    const barcode='SYNCBATCH'+crypto.randomBytes(8).toString('hex').toUpperCase();
    const product={product_name:'ISOLATED PURCHASE VALIDATION'};
    const password=crypto.randomBytes(24).toString('hex'),salt=crypto.randomBytes(16).toString('hex');
    await source.execute("INSERT INTO users(username,password_hash,role,counter_no,is_active) VALUES('batch_sync_validation',?,'SERVER',1,1) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),is_active=1",[salt+':'+crypto.pbkdf2Sync(password,salt,100000,64,'sha512').toString('hex')]);
    log=fs.openSync('/var/lib/badizo/validation-server.log','a',0o600);
    child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,BADIZO_DB_BOOTSTRAP:'false',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false'},stdio:['ignore',log,log]});
    let ready=false;for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:5001/api/ready')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}assert.ok(ready);
    const login=await fetch('http://127.0.0.1:5001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'batch_sync_validation',password})});assert.equal(login.status,200);const {token}=await login.json();
    const headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
    async function post(path,body){const response=await fetch('http://127.0.0.1:5001/api/'+(path==='purchase'?'inward':'billing/'+path),{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();}
    let checkedBatchFailure=false;
    async function transfer(invoiceNo,type){
      const [[row]]=await source.execute("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))=? AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.invoice.invoice_no'))=? ORDER BY sequence_no DESC LIMIT 1",[type,invoiceNo]);assert.ok(row);
      const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;assert.equal(event.payload.batchAllocations.length,2);
      const receive=createSyncReceiver({pool:target,identity:{shopId:event.shopId,peerInstallationId:event.originInstallationId,localInstallationId:'validation-receiver'},handlers:{'pos.checkout.recorded':applyCheckout,'pos.invoice.returned':applyReturn,'pos.invoice.cancelled':applyCancellation}});
      if(type==='pos.checkout.recorded'&&!checkedBatchFailure){
        const [beforeBatches]=await target.execute('SELECT batch_no,quantity_available FROM product_batches WHERE barcode=? ORDER BY batch_no',[barcode]);
        await target.execute("UPDATE product_batches SET quantity_available=0 WHERE barcode=? AND batch_no='B'",[barcode]);
        try{
          await assert.rejects(receive(event),/Insufficient receiving batch stock/);
          const [[receipt]]=await target.execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[event.eventId]);assert.equal(Number(receipt.n),0);
          const [[invoice]]=await target.execute('SELECT COUNT(*) AS n FROM invoices WHERE invoice_no=?',[invoiceNo]);assert.equal(Number(invoice.n),0);
          const [[firstBatch]]=await target.execute("SELECT quantity_available FROM product_batches WHERE barcode=? AND batch_no='A'",[barcode]);assert.equal(String(firstBatch.quantity_available),String(beforeBatches.find(row=>row.batch_no==='A').quantity_available));
        }finally{await target.execute("UPDATE product_batches SET quantity_available=? WHERE barcode=? AND batch_no='B'",[beforeBatches.find(row=>row.batch_no==='B').quantity_available,barcode]);}
        checkedBatchFailure=true;
      }
      assert.equal((await receive(event)).duplicate,false);assert.equal((await receive(event)).duplicate,true);
      const [[a]]=await source.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);const [[b]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(String(a.stock_qty),String(b.stock_qty));
      const [sa]=await source.query('SELECT batch_no,quantity_available FROM product_batches WHERE barcode=? ORDER BY batch_no',[barcode]);const [ta]=await target.query('SELECT batch_no,quantity_available FROM product_batches WHERE barcode=? ORDER BY batch_no',[barcode]);assert.deepEqual(JSON.parse(JSON.stringify(sa)),JSON.parse(JSON.stringify(ta)));
    }
    async function purchase(posting_status,lines,replaceId=null,extra={}){
      const saved=await post('purchase',{supplier:{name:'ISOLATED TEST SUPPLIER',invoice_no:crypto.randomUUID()},posting_status,payment_mode:'Credit',lines,...(replaceId?{replace_inward_id:replaceId}:{}),...extra});
      assert.match(saved.inward_no,/^CLINW\//);
      const [[row]]=await source.execute("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.purchase.changed' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.inwardNo'))=? ORDER BY sequence_no DESC LIMIT 1",[saved.inward_no]);assert.ok(row);
      const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
      const identity={shopId:event.shopId,peerInstallationId:event.originInstallationId,localInstallationId:'validation-receiver'};
      const receive=createSyncReceiver({pool:target,identity,handlers:{'pos.purchase.changed':applyPurchase}});
      const fail=createSyncReceiver({pool:target,identity,handlers:{'pos.purchase.changed':async(...args)=>{await applyPurchase(...args);throw Error('Injected purchase failure');}}});
      await assert.rejects(fail(event),/Injected purchase failure/);
      const [[rejected]]=await target.execute('SELECT COUNT(*) AS n FROM inward_entries WHERE inward_no=?',[saved.inward_no]);assert.equal(Number(rejected.n),replaceId?1:0);
      assert.equal((await receive(event)).duplicate,false);assert.equal((await receive(event)).duplicate,true);
      const [[entry]]=await target.execute('SELECT grand_total,total_qty,posting_status FROM inward_entries WHERE inward_no=?',[saved.inward_no]);assert.equal(Number(entry.grand_total),Number(Number(saved.grand_total).toFixed(2)));assert.equal(Number(entry.total_qty),Number(saved.total_qty));assert.equal(entry.posting_status,posting_status);
      return saved;
    }
    const purchaseLines=[{barcode,product_name:product.product_name,price:10,qty:3,mrp:10,batch_no:'A',expiry_date:'2027-12-31'},{barcode,product_name:product.product_name,price:10,qty:17,mrp:10,batch_no:'B',expiry_date:'2028-12-31'}];
    const draft=await purchase('DRAFT',purchaseLines);await purchase('DRAFT',[{...purchaseLines[0],qty:4}],draft.id);await purchase('POSTED',purchaseLines);
    const body={counter_no:1,customer_name:'BATCH TEST',customer_phone:'',items:[{barcode,product_name:product.product_name,quantity:4,sale_price:10,gst_percent:0}],sub_total:40,gst_total:0,grand_total:40,payment_mode:'Cash',cash_received:40,change_returned:0,billing_tier:'RETAIL',tax_type:'LOCAL'};
    const bill=await post('checkout',{...body,checkout_request_id:crypto.randomUUID()});await transfer(bill.invoice_no,'pos.checkout.recorded');
    const [[line]]=await source.execute('SELECT id FROM invoice_items WHERE invoice_no=?',[bill.invoice_no]);
    for(let i=0;i<2;i++){await post('return',{invoice_no:bill.invoice_no,reason:'BATCH VALIDATION',refund_mode:'Cash',items:[{invoice_item_id:line.id,quantity:2}]});await transfer(bill.invoice_no,'pos.invoice.returned');}
    const cancelled=await post('checkout',{...body,checkout_request_id:crypto.randomUUID()});await transfer(cancelled.invoice_no,'pos.checkout.recorded');
    await post('invoice/void',{invoice_no:cancelled.invoice_no,reason:'BATCH VALIDATION'});await transfer(cancelled.invoice_no,'pos.invoice.cancelled');
    const [[final]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(Number(final.stock_qty),20);
    await purchase('POSTED',[{...purchaseLines[0],qty:1,free_qty:1,stock_conversion_factor:2}]);
    const [[replenished]]=await target.execute('SELECT stock_qty,purchase_price FROM products WHERE barcode=?',[barcode]);assert.equal(Number(replenished.stock_qty),24);assert.equal(Number(replenished.purchase_price),5);
    const [[batch]]=await target.execute("SELECT quantity_received,quantity_available FROM product_batches WHERE barcode=? AND batch_no='A'",[barcode]);assert.equal(Number(batch.quantity_received),7);assert.equal(Number(batch.quantity_available),7);
    const removable=await purchase('POSTED',[{...purchaseLines[0],batch_no:'DELETE-TEST',qty:2}]);
    await purchase('POSTED',[{...purchaseLines[0],batch_no:'DELETE-TEST',qty:3}],removable.id);
    const removed=await fetch('http://127.0.0.1:5001/api/inward/'+removable.id,{method:'DELETE',headers});assert.equal(removed.status,200);
    const [[deletedEventRow]]=await source.execute("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.purchase.changed' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.inwardNo'))=? ORDER BY sequence_no DESC LIMIT 1",[removable.inward_no]);
    const deleted=typeof deletedEventRow.event_json==='string'?JSON.parse(deletedEventRow.event_json):deletedEventRow.event_json;
    const receiver=createSyncReceiver({pool:target,identity:{shopId:deleted.shopId,peerInstallationId:deleted.originInstallationId,localInstallationId:'validation-receiver'},handlers:{'pos.purchase.changed':applyPurchase}});
    await target.execute("UPDATE product_batches SET quantity_available=quantity_available-1 WHERE barcode=? AND batch_no='DELETE-TEST'",[barcode]);
    await assert.rejects(receiver(deleted),/was sold or changed/);
    await target.execute("UPDATE product_batches SET quantity_available=quantity_available+1 WHERE barcode=? AND batch_no='DELETE-TEST'",[barcode]);
    assert.equal((await receiver(deleted)).duplicate,false);assert.equal((await receiver(deleted)).duplicate,true);
    const [[remaining]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(Number(remaining.stock_qty),24);
    await purchase('POSTED',[{...purchaseLines[0],batch_no:'DRAFT-POST',qty:1}],null,{source_draft_id:draft.id,pending_lines:[{...purchaseLines[0],qty:3}]});
    const [[pendingDraft]]=await target.execute('SELECT item_count,grand_total FROM inward_entries WHERE inward_no=?',[draft.inward_no]);assert.equal(Number(pendingDraft.item_count),1);assert.equal(Number(pendingDraft.grand_total),30);
    await purchase('POSTED',[{...purchaseLines[0],batch_no:'DRAFT-POST',qty:3}],null,{source_draft_id:draft.id});
    const [[draftCount]]=await target.execute('SELECT COUNT(*) AS n FROM inward_entries WHERE inward_no=?',[draft.inward_no]);assert.equal(Number(draftCount.n),0);
    const [[completeStock]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(Number(completeStock.stock_qty),28);
    const taxBarcode='SYNCTAX'+crypto.randomBytes(8).toString('hex').toUpperCase();
    const taxed=await purchase('POSTED',['TAX-A','TAX-B'].map(batch_no=>({barcode:taxBarcode,product_name:'ISOLATED GST ROUNDING TEST',price:0.1,qty:1,mrp:1,gst_percent:5,batch_no,expiry_date:'2028-12-31'})));
    const [[taxAmounts]]=await target.execute('SELECT SUM(total_amount) AS total FROM inward_items WHERE inward_no=?',[taxed.inward_no]);assert.equal(Number(taxAmounts.total),0.22);assert.equal(Number(Number(taxed.grand_total).toFixed(2)),0.21);
    console.log(JSON.stringify({realDraftAndPostedPurchase:true,draftAndPostedReplacement:true,partialAndCompleteDraftPosting:true,newProductAndBatchesCreated:true,stockConversionAndFreeQuantity:true,existingBatchReplenished:true,realBatchCheckout:true,partialAndFullReturns:true,cancellation:true,purchaseDeletion:true,receiverSaleBlocksDeletion:true,purchaseRollbackVerified:true,partialBatchFailureRollsBackInvoiceAndStock:true,sourceGstRoundingPreserved:true,duplicateSafe:true,productionModified:false}));
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}if(log!==undefined)fs.closeSync(log);await source.end();await target.end();}
}
main().catch(error=>{console.error('Isolated purchase lifecycle drill failed: '+error.message);process.exitCode=1;});
