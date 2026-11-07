const fs=require('node:fs/promises'),crypto=require('node:crypto'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {applyCheckout}=require('../../backend/services/checkoutSyncHandler');
async function main(){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation');
  const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const source=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  const target=mysql.createPool({host:config.host,user:config.user,password:config.password,database:config.database,connectionLimit:2});
  try{
    const [[row]]=await source.query("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))='pos.checkout.recorded' ORDER BY sequence_no DESC LIMIT 1");assert.ok(row);
    const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
    const item=event.payload.items[0];assert.equal(event.payload.items.length,1);
    const [[before]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[item.barcode]);
    const receive=createSyncReceiver({pool:target,identity:{shopId:event.shopId,peerInstallationId:event.originInstallationId,localInstallationId:'validation-receiver'},handlers:{'pos.checkout.recorded':applyCheckout}});
    assert.equal((await receive(event)).duplicate,false);assert.equal((await receive(event)).duplicate,true);
    const [[invoice]]=await target.execute('SELECT grand_total FROM invoices WHERE invoice_no=?',[event.payload.invoice.invoice_no]);assert.equal(Number(invoice.grand_total),Number(event.payload.invoice.grand_total));
    const [[payments]]=await target.execute('SELECT COUNT(*) AS n,SUM(amount) AS paid FROM invoice_payments WHERE invoice_no=?',[event.payload.invoice.invoice_no]);assert.equal(Number(payments.n),event.payload.payments.length);assert.equal(Number(payments.paid),Number(invoice.grand_total));
    const [[lines]]=await target.execute('SELECT COUNT(*) AS n FROM invoice_items WHERE invoice_no=?',[event.payload.invoice.invoice_no]);assert.equal(Number(lines.n),event.payload.items.length);
    const [[after]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[item.barcode]);assert.equal(Number(after.stock_qty),Number(before.stock_qty)-Number(item.quantity));
    const collision={...event,eventId:crypto.randomUUID()};await assert.rejects(receive(collision));
    const [[receipt]]=await target.execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[collision.eventId]);assert.equal(Number(receipt.n),0);
    console.log(JSON.stringify({actualCapturedCheckoutApplied:true,invoiceAndPaymentStored:true,stockDeductedOnce:true,duplicateAcknowledged:true,invoiceCollisionRolledBack:true,productionModified:false}));
  }finally{await source.end();await target.end();}
}
main().catch(error=>{console.error('Isolated checkout application failed: '+error.message);process.exitCode=1;});
