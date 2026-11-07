const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const backend = process.cwd();
const mysql = require(path.join(backend, 'node_modules/mysql2/promise'));
async function main() {
  assert.equal(process.env.DB_NAME, 'badizo_cloud_validation');
  const db = await mysql.createConnection({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const password = crypto.randomBytes(24).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = `${salt}:${crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')}`;
  await db.query("INSERT INTO users(username,password_hash,role,counter_no,is_active) VALUES('cloudtest',?,'COUNTER',1,1) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),is_active=1", [hash]);
  const [[product]] = await db.query('SELECT barcode,product_name,sale_price,gst_percent,hsn_code,stock_qty FROM products WHERE stock_qty>10 AND sale_price>=1 AND MOD(sale_price,1)=0 AND gst_percent=0 LIMIT 1');
  assert.ok(product, 'A validation product must be available');
  const out = fs.openSync('/var/lib/badizo/validation-server.log', 'a', 0o600);
  const child = spawn(process.execPath, ['server.js'], { cwd: backend, env: { ...process.env, BADIZO_DB_BOOTSTRAP:'false' }, stdio: ['ignore',out,out] });
  try {
    let ready = false;
    for(let i=0;i<40;i++){try{const r=await fetch('http://127.0.0.1:5001/api/ready');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
    assert.ok(ready, 'Validation API did not become ready');
    const login=await fetch('http://127.0.0.1:5001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'cloudtest',password})});
    assert.equal(login.status,200);const session=await login.json();
    const headers={Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'};
    const lookup=await fetch(`http://127.0.0.1:5001/api/products?search=${encodeURIComponent(product.barcode)}`,{headers});
    assert.equal(lookup.status,200);const found=await lookup.json();
    assert.ok(JSON.stringify(found).includes(product.barcode),'Barcode lookup failed');
    const body={counter_no:1,customer_name:'CLOUD INSTALLATION TEST - VALIDATION DATABASE ONLY',customer_phone:'',items:[{...product,quantity:1,sale_price:Number(product.sale_price),gst_percent:Number(product.gst_percent)}],sub_total:Number(product.sale_price),gst_total:0,grand_total:Number(product.sale_price),payment_mode:'Cash',payment_status:'Paid',cash_received:Number(product.sale_price),change_returned:0,billing_tier:'RETAIL',tax_type:'LOCAL',checkout_request_id:crypto.randomUUID()};
    const checkout=await fetch('http://127.0.0.1:5001/api/billing/checkout',{method:'POST',headers,body:JSON.stringify(body)});const result=await checkout.json();
    if(checkout.status!==200) throw new Error(`Validation checkout failed: ${JSON.stringify(result)}`);
    assert.match(result.invoice_no,/^CL\//);
    const replay=await fetch('http://127.0.0.1:5001/api/billing/checkout',{method:'POST',headers,body:JSON.stringify(body)});const duplicate=await replay.json();
    assert.equal(duplicate.invoice_no,result.invoice_no);assert.equal(duplicate.duplicate_prevented,true);
    const [[invoice]]=await db.query('SELECT COUNT(*) AS n FROM invoices WHERE checkout_request_id=?',[body.checkout_request_id]);assert.equal(Number(invoice.n),1);
    const [events] = await db.query("SELECT event_json FROM sync_outbox WHERE JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.payload.invoice.invoice_no'))=?",[result.invoice_no]);
    assert.equal(events.length,1,'Exactly one queued event for a retried checkout');
    const captured=typeof events[0].event_json==='string'?JSON.parse(events[0].event_json):events[0].event_json;
    assert.equal(captured.type,'pos.checkout.recorded');assert.equal(captured.payload.items.length,1);assert.ok(captured.payload.payments.length>0);
    console.log(JSON.stringify({actualCheckoutCaptured:true,duplicateCheckoutCapturedOnce:true,itemsAndPaymentsCaptured:true,database:'validation-only'}));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGTERM'); await exited; }
    fs.closeSync(out); await db.end();
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

