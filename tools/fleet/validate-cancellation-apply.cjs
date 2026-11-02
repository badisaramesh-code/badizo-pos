const fs=require('node:fs/promises'),crypto=require('node:crypto'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {applyCheckout}=require('../../backend/services/checkoutSyncHandler');
const {applyCancellation}=require('../../backend/services/invoiceCancellationSyncHandler');
async function main(){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation');
  const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const source=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  const target=mysql.createPool({host:config.host,user:config.user,password:config.password,database:config.database,connectionLimit:2});
  try{
    const [[row]]=await source.query("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.invoice.cancelled' ORDER BY sequence_no DESC LIMIT 1");assert.ok(row);
    const cancel=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
    const [[checkoutRow]]=await source.execute("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.checkout.recorded' AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.invoice.invoice_no'))=?",[cancel.payload.invoice.invoice_no]);
    const checkout=typeof checkoutRow.event_json==='string'?JSON.parse(checkoutRow.event_json):checkoutRow.event_json;
    const receive=createSyncReceiver({pool:target,identity:{shopId:cancel.shopId,peerInstallationId:cancel.originInstallationId,localInstallationId:'validation-receiver'},handlers:{'pos.checkout.recorded':applyCheckout,'pos.invoice.cancelled':applyCancellation}});
    const barcode=checkout.payload.items[0].barcode;
    const [[before]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);
    await assert.rejects(receive(cancel),/waiting for its originating checkout/);
    assert.equal((await receive(checkout)).duplicate,false);
    const altered=structuredClone(cancel);altered.eventId=crypto.randomUUID();altered.payload.items[0].quantity='999';
    await assert.rejects(receive(altered),/differs from the captured checkout/);
    const [[invalidReceipt]]=await target.execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[altered.eventId]);assert.equal(Number(invalidReceipt.n),0);
    assert.equal((await receive(cancel)).duplicate,false);assert.equal((await receive(cancel)).duplicate,true);
    const [[invoice]]=await target.execute('SELECT invoice_status,cancel_reason FROM invoices WHERE invoice_no=?',[cancel.payload.invoice.invoice_no]);assert.equal(invoice.invoice_status,'CANCELLED');assert.equal(invoice.cancel_reason,cancel.payload.invoice.cancel_reason);
    const [[after]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(Number(after.stock_qty),Number(before.stock_qty));
    const reissued={...cancel,eventId:crypto.randomUUID()};await assert.rejects(receive(reissued),/Target invoice changed/);
    const [[receipt]]=await target.execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[reissued.eventId]);assert.equal(Number(receipt.n),0);
    const [[map]]=await target.execute('SELECT COUNT(*) AS n FROM sync_invoice_item_map WHERE source_invoice_no=?',[checkout.payload.invoice.invoice_no]);assert.equal(Number(map.n),checkout.payload.items.length);
    console.log(JSON.stringify({realCheckoutAndCancellationApplied:true,dependencyRetry:true,alteredCancellationRejected:true,stockRestoredOnce:true,duplicateSafe:true,reissuedActionRolledBack:true,lineIdentitiesMapped:true,productionModified:false}));
  }finally{await source.end();await target.end();}
}
main().catch(error=>{console.error('Isolated cancellation application failed: '+error.message);process.exitCode=1;});
