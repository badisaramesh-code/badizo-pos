const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const mysql=require('mysql2/promise');
const {createSyncReceiver}=require('../../backend/services/syncEventProtocol');
const {applyCheckout}=require('../../backend/services/checkoutSyncHandler');
async function main(){
  assert.equal(process.env.DB_NAME,'badizo_cloud_validation');
  const targetConfig=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));assert.match(targetConfig.database,/^badizo_recovery_[a-z0-9]+$/);
  const source=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  const target=mysql.createPool({host:targetConfig.host,user:targetConfig.user,password:targetConfig.password,database:targetConfig.database,connectionLimit:2});
  const keys=['loyalty_enabled','loyalty_earn_sale_amount','loyalty_earn_points'];
  let settings=null;
  let child,log,originalProduct;
  try{
    [settings]=await source.query('SELECT setting_key,setting_value FROM app_settings WHERE setting_key IN (?,?,?)',keys);
    const password=crypto.randomBytes(24).toString('hex'),salt=crypto.randomBytes(16).toString('hex');
    const hash=salt+':'+crypto.pbkdf2Sync(password,salt,100000,64,'sha512').toString('hex');
    await source.execute("INSERT INTO users(username,password_hash,role,counter_no,is_active) VALUES('sync_customer_validation',?,'SERVER',1,1) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),is_active=1",[hash]);
    const [[product]]=await source.query('SELECT p.* FROM products p WHERE p.stock_qty>10 AND p.sale_price>=1 AND p.gst_percent=0 AND p.free_promo_enabled=0 AND NOT EXISTS (SELECT 1 FROM product_batches b WHERE b.barcode=p.barcode AND b.quantity_available>0) LIMIT 1');assert.ok(product);
    originalProduct=product;
    log=fs.openSync('/var/lib/badizo/validation-server.log','a',0o600);
    child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,BADIZO_DB_BOOTSTRAP:'false',BADIZO_SMS_ENABLED:'false',BADIZO_WHATSAPP_ENABLED:'false'},stdio:['ignore',log,log]});
    let ready=false;for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:5001/api/ready')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}assert.ok(ready);
    const login=await fetch('http://127.0.0.1:5001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'sync_customer_validation',password})});assert.equal(login.status,200);
    const {token}=await login.json();const headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
    // A deliberately synthetic test identity; notification transports are disabled.
    const phone='000'+String(crypto.randomInt(1000000,9999999));
    await target.execute('INSERT INTO customers(customer_name,phone,loyalty_points,total_spent,visit_count) VALUES (?,?,7,20,2)',['Receiver contact name',phone]);
    const [[targetBefore]]=await target.execute('SELECT * FROM customers WHERE phone=?',[phone]);
    let expectedPoints=7,expectedSpent=20;
    for(const enabled of [false,true]){
      for(const [key,value] of [['loyalty_enabled',enabled?'1':'0'],['loyalty_earn_sale_amount','1'],['loyalty_earn_points','1']])await source.execute('INSERT INTO app_settings(setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',[key,value]);
      const price=enabled?10.50:10.49,total=Math.round(price);
      await source.execute('UPDATE products SET sale_price=? WHERE barcode=?',[price,product.barcode]);
      const body={counter_no:1,customer_name:'SOURCE TEST NAME',customer_phone:phone,items:[{barcode:product.barcode,product_name:product.product_name,quantity:1,sale_price:price,gst_percent:0,hsn_code:''}],sub_total:price,gst_total:0,grand_total:price,payment_mode:'Cash',payment_status:'Paid',cash_received:total,change_returned:0,billing_tier:'RETAIL',tax_type:'LOCAL',checkout_request_id:crypto.randomUUID()};
      const response=await fetch('http://127.0.0.1:5001/api/billing/checkout',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200);const invoice=await response.json();
      const [[row]]=await source.execute("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.invoice.invoice_no'))=?",[invoice.invoice_no]);assert.ok(row);
      const event=typeof row.event_json==='string'?JSON.parse(row.event_json):row.event_json;
      assert.equal(Number(event.payload.invoice.grand_total),total);assert.equal(event.payload.loyaltyTransactions.length,enabled?1:0);
      const receive=createSyncReceiver({pool:target,identity:{shopId:event.shopId,peerInstallationId:event.originInstallationId,localInstallationId:'validation-receiver'},handlers:{'pos.checkout.recorded':applyCheckout}});
      const failing=createSyncReceiver({pool:target,identity:{shopId:event.shopId,peerInstallationId:event.originInstallationId,localInstallationId:'validation-receiver'},handlers:{'pos.checkout.recorded':async(...args)=>{await applyCheckout(...args);throw Error('Injected failure after customer and stock writes');}}});
      await assert.rejects(failing(event),/Injected failure/);
      const [[rolledBack]]=await target.execute('SELECT loyalty_points,total_spent,visit_count FROM customers WHERE phone=?',[phone]);
      assert.equal(Number(rolledBack.loyalty_points),expectedPoints);assert.equal(Number(rolledBack.total_spent),expectedSpent);assert.equal(Number(rolledBack.visit_count),enabled?3:2);
      const [[receipt]]=await target.execute('SELECT COUNT(*) AS n FROM sync_inbox WHERE event_id=?',[event.eventId]);assert.equal(Number(receipt.n),0);
      const [[rejectedBill]]=await target.execute('SELECT COUNT(*) AS n FROM invoices WHERE invoice_no=?',[invoice.invoice_no]);assert.equal(Number(rejectedBill.n),0);
      assert.equal((await receive(event)).duplicate,false);assert.equal((await receive(event)).duplicate,true);
      expectedPoints+=enabled?total:0;expectedSpent+=total;
      const [[customer]]=await target.execute('SELECT * FROM customers WHERE phone=?',[phone]);
      assert.equal(Number(customer.loyalty_points),expectedPoints);assert.equal(Number(customer.total_spent),expectedSpent);assert.equal(Number(customer.visit_count),enabled?4:3);assert.equal(customer.customer_name,'Receiver contact name');
      const [earnings]=await target.execute('SELECT customer_id,points_delta FROM loyalty_transactions WHERE invoice_no=?',[invoice.invoice_no]);assert.equal(earnings.length,enabled?1:0);
      if(enabled){assert.equal(String(earnings[0].customer_id),String(targetBefore.id));assert.equal(Number(earnings[0].points_delta),total);}
    }
    console.log(JSON.stringify({realRoundedCheckout:true,roundDownAndUp:true,customerVisitWithoutLoyalty:true,earnedPointsMappedToReceiverCustomer:true,existingBalancesAddedNotOverwritten:true,customerAndInvoiceRollbackTogether:true,duplicateSafe:true,notificationsDisabled:true,productionModified:false}));
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;}
    if(log!==undefined)fs.closeSync(log);
    if(originalProduct)await source.execute('UPDATE products SET sale_price=? WHERE barcode=?',[originalProduct.sale_price,originalProduct.barcode]);
    for(const key of settings?keys:[]){const original=settings.find(row=>row.setting_key===key);if(original)await source.execute('INSERT INTO app_settings(setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',[key,original.setting_value]);else await source.execute('DELETE FROM app_settings WHERE setting_key=?',[key]);}
    await source.end();await target.end();
  }
}
main().catch(error=>{console.error('Isolated customer checkout drill failed: '+error.message);process.exitCode=1;});
