const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),mysql=require('mysql2/promise');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {applyCheckout,insert}=require('../../backend/services/checkoutSyncHandler');
const {applyReturn}=require('../../backend/services/invoiceReturnSyncHandler');
const {applyCancellation}=require('../../backend/services/invoiceCancellationSyncHandler');
async function main(){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation');
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));assert.match(config.database,/^badizo_recovery_[a-z0-9]+$/);
  const source=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  const target=mysql.createPool({host:config.host,user:config.user,password:config.password,database:config.database,connectionLimit:3});let child,log;
  try{
    const barcode='SYNCBATCH'+crypto.randomBytes(8).toString('hex').toUpperCase();
    const [[template]]=await source.query({sql:'SELECT * FROM products LIMIT 1',dateStrings:true});
    const product={...JSON.parse(JSON.stringify(template)),barcode,product_code:barcode,product_name:'ISOLATED BATCH VALIDATION',sale_price:10,wholesale_price:10,mrp:10,purchase_price:5,gst_percent:0,stock_qty:20,free_promo_enabled:0};
    for(const db of [source,target])await db.execute('INSERT INTO products (product_code,barcode,product_name,sale_price,wholesale_price,mrp,purchase_price,gst_percent,stock_qty,free_promo_enabled) VALUES (?,?,?,10,10,10,5,0,20,0)',[barcode,barcode,product.product_name]);
    for(const db of [source,target])for(const batch of [['A','2027-12-31',3],['B','2028-12-31',5]])await db.execute('INSERT INTO product_batches(barcode,batch_no,expiry_date,purchase_price,mrp,quantity_received,quantity_available) VALUES (?,?,?,5,10,?,?)',[barcode,batch[0],batch[1],batch[2],batch[2]]);
    const password=crypto.randomBytes(24).toString('hex'),salt=crypto.randomBytes(16).toString('hex');
    await source.execute("INSERT INTO users(username,password_hash,role,counter_no,is_active) VALUES('batch_sync_validation',?,'SERVER',1,1) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),is_active=1",[salt+':'+crypto.pbkdf2Sync(password,salt,100000,64,'sha512').toString('hex')]);
    log=fs.openSync('/var/lib/badizo/validation-server.log','a',0o600);
    child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,BADIZO_DB_BOOTSTRAP:'false',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false'},stdio:['ignore',log,log]});
    let ready=false;for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:5001/api/ready')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}assert.ok(ready);
    const login=await fetch('http://127.0.0.1:5001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'batch_sync_validation',password})});assert.equal(login.status,200);const {token}=await login.json();
    const headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
    async function post(path,body){const response=await fetch('http://127.0.0.1:5001/api/billing/'+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();}
    async function transfer(invoiceNo,type){
      const [[row]]=await source.execute("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))=? AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.invoice.invoice_no'))=? ORDER BY sequence_no DESC LIMIT 1",[type,invoiceNo]);assert.ok(row);
      const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;assert.equal(event.payload.batchAllocations.length,2);
      const receive=createSyncReceiver({pool:target,identity:{shopId:event.shopId,peerInstallationId:event.originInstallationId,localInstallationId:'validation-receiver'},handlers:{'pos.checkout.recorded':applyCheckout,'pos.invoice.returned':applyReturn,'pos.invoice.cancelled':applyCancellation}});
      assert.equal((await receive(event)).duplicate,false);assert.equal((await receive(event)).duplicate,true);
      const [[a]]=await source.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);const [[b]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(String(a.stock_qty),String(b.stock_qty));
      const [sa]=await source.query('SELECT batch_no,quantity_available FROM product_batches WHERE barcode=? ORDER BY batch_no',[barcode]);const [ta]=await target.query('SELECT batch_no,quantity_available FROM product_batches WHERE barcode=? ORDER BY batch_no',[barcode]);assert.deepEqual(JSON.parse(JSON.stringify(sa)),JSON.parse(JSON.stringify(ta)));
    }
    const body={counter_no:1,customer_name:'BATCH TEST',customer_phone:'',items:[{barcode,product_name:product.product_name,quantity:4,sale_price:10,gst_percent:0}],sub_total:40,gst_total:0,grand_total:40,payment_mode:'Cash',cash_received:40,change_returned:0,billing_tier:'RETAIL',tax_type:'LOCAL'};
    const bill=await post('checkout',{...body,checkout_request_id:crypto.randomUUID()});await transfer(bill.invoice_no,'pos.checkout.recorded');
    const [[line]]=await source.execute('SELECT id FROM invoice_items WHERE invoice_no=?',[bill.invoice_no]);
    for(let i=0;i<2;i++){await post('return',{invoice_no:bill.invoice_no,reason:'BATCH VALIDATION',refund_mode:'Cash',items:[{invoice_item_id:line.id,quantity:2}]});await transfer(bill.invoice_no,'pos.invoice.returned');}
    const cancelled=await post('checkout',{...body,checkout_request_id:crypto.randomUUID()});await transfer(cancelled.invoice_no,'pos.checkout.recorded');
    await post('invoice/void',{invoice_no:cancelled.invoice_no,reason:'BATCH VALIDATION'});await transfer(cancelled.invoice_no,'pos.invoice.cancelled');
    const [[final]]=await target.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(Number(final.stock_qty),20);
    console.log(JSON.stringify({realBatchCheckout:true,partialAndFullReturns:true,cancellation:true,batchAndTotalStockMatchAfterEachOperation:true,duplicateSafe:true,productionModified:false}));
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}if(log!==undefined)fs.closeSync(log);await source.end();await target.end();}
}
main().catch(error=>{console.error('Isolated batch lifecycle drill failed: '+error.message);process.exitCode=1;});
