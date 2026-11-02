const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const repo=path.resolve(__dirname,'../..'), release=path.join(repo,'output/new-store-20260920');
const appRoot=path.join(release,'package/payload/app'), backend=path.join(appRoot,'backend');
const mysql=require(path.join(backend,'node_modules/mysql2/promise'));
const results=[]; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let db,http,control;
async function main(){
 control=await mysql.createConnection({host:'127.0.0.1',port:33360,user:'root',password:''});
 const password='QaOnly_'+require('crypto').randomBytes(16).toString('hex');
 await control.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?",[password]);
 await control.query('CREATE DATABASE badizo_release_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
 await control.query("CREATE USER 'badizo_app'@'localhost' IDENTIFIED BY ?",[password]);
 await control.query("GRANT ALL PRIVILEGES ON badizo_release_qa.* TO 'badizo_app'@'localhost'");
 Object.assign(process.env,{BADIZO_NEW_STORE:'true',MYSQLDUMP_PATH:path.join(release,'package/payload/mysql/bin/mysqldump.exe'),MYSQL_PATH:path.join(release,'package/payload/mysql/bin/mysql.exe'),DB_HOST:'127.0.0.1',DB_PORT:'33360',DB_USER:'badizo_app',DB_PASSWORD:password,DB_NAME:'badizo_release_qa',JWT_SECRET:'qa-only-secret-'+password,BACKUP_DIR:path.join(release,'qa/backups'),GOOGLE_DRIVE_BACKUP_ENABLED:'false',BADIZO_DISABLE_SCHEDULED_CLOUD_BACKUP:'true'});
 let ready=false;
 const log=console.log; console.log=(...args)=>{if(args.join(' ').includes('Database schema is ready.'))ready=true;log(...args)};
 db=require(path.join(backend,'config/db'));
 for(let i=0;i<120&&!ready;i++) await sleep(500);
 assert.ok(ready,'fresh schema initialization');
 results.push({check:'Fresh MySQL initialization and automatic schema creation',status:'PASS'});
 const {app}=require(path.join(backend,'server'));
 http=app.listen(0,'127.0.0.1'); await new Promise(r=>http.once('listening',r));
 const base='http://127.0.0.1:'+http.address().port;
 async function request(url,body,token,expected=200){
  const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const text=await response.text(); let value;try{value=JSON.parse(text)}catch{value=text}
  assert.equal(response.status,expected,url+' '+text.slice(0,180));
  results.push({check:(body?'POST ':'GET ')+url,status:'PASS',http:response.status});
  return value;
 }
 const tokens={};
 for(const username of ['server','admin','admin1','admin2','counter1','counter2','counter3','counter4','counter5','counter6','security','security1','security2']){
   const r=await request('/api/auth/login',{username,password:username==='server'?'server123':username.startsWith('counter')?username:'admin123',person_name:'QA Operator',system_no:username.startsWith('counter')?Number(username.slice(7)):undefined,counter_no:1});
   assert.ok(r.token,username+' token'); tokens[username]=r.token;
 }
 const token=tokens.server;
 const [[blank]]=await db.query("SELECT setting_value FROM app_settings WHERE setting_key='bank_account_no'");assert.equal(blank.setting_value,'');
 results.push({check:'New-store bank/GST identity is cleared',status:'PASS'});
 const users=await request('/api/users',null,token), qaAdmin=users.find(u=>u.username==='admin2');
 await request('/api/users',{...qaAdmin,password:'QaChangedPassword123'},token);
 await request('/api/auth/login',{username:'admin2',password:'admin123'},null,401);
 await request('/api/auth/login',{username:'admin2',password:'QaChangedPassword123'},null);

 await request('/api/products',null,null,401);
 await request('/api/staff-payroll/staff',null,tokens.counter1,403);
 await request('/api/books/accounting',null,tokens.security,403);
 await request('/api/products/save',{barcode:'QA0001',product_code:'QA0001',product_name:'QA TEST PRODUCT',mrp:100,sale_price:100,purchase_price:50,wholesale_price:100,gst_percent:0,stock_qty:20,unit_type:'Nos',hsn_code:'1001',purchase_unit_type:'Loose',purchase_unit_size:1,min_stock_alert:2},token);
 const checkout={counter_no:2,customer_name:'QA ONLY',items:[{barcode:'QA0001',product_name:'QA TEST PRODUCT',quantity:1,sale_price:100,gst_percent:0,hsn_code:''}],sub_total:100,gst_total:0,grand_total:100,payment_mode:'Cash',cash_received:120,change_returned:20,transaction_type:'B2C',billing_tier:'RETAIL',tax_type:'LOCAL',checkout_request_id:'new-store-release-qa-0001'};
 const sale=await request('/api/billing/checkout',checkout,tokens.counter2);
 assert.ok(sale.invoice_no,'invoice number'); fs.writeFileSync(path.join(release,'qa/sample-invoice.json'),JSON.stringify(sale,null,2));
 const duplicate=await request('/api/billing/checkout',checkout,tokens.counter2);
 assert.equal(duplicate.invoice_no,sale.invoice_no);
 const [[counts]]=await db.query('SELECT COUNT(*) n FROM invoices');
 assert.equal(Number(counts.n),1);
 const [[stock]]=await db.query("SELECT stock_qty FROM products WHERE barcode='QA0001'");
 assert.equal(Number(stock.stock_qty),19);
 results.push({check:'Cash checkout, saved invoice, one stock deduction and duplicate retry idempotency',status:'PASS'});
 await request('/api/billing/invoice/details?invoice_no='+encodeURIComponent(sale.invoice_no),null,token);
 for(const route of [
 '/api/settings','/api/products','/api/products/expiry-dashboard','/api/products/reorder-suggestions','/api/products/import-history','/api/products/price-list/groups',
 '/api/inward/suppliers','/api/inward/supplier-dues','/api/inward/recent','/api/inward/pending','/api/inward/history','/api/inward/purchase-orders',
 '/api/books/summary','/api/books/day-book','/api/books/accounting',
 '/api/staff-payroll/staff','/api/staff-payroll/attendance','/api/staff-payroll/monthly-sheet',
 '/api/barcode/print-logs','/api/billing/hold/list',
 ...['financial-years','financial-archive','dashboard','daily-sales','daily-sales/export','reprints','counter-sale-slip','pos-sale-report','counter-handover','gst-hsn','product-sales','monthly-sales','stock','top-products','tax-summary','exchange-bills','gstr1','gstr2','gstr3','exceptions'].map(v=>'/api/reports/'+v)]){
   try{await request(route,null,token)}catch(e){results.push({check:route,status:'FAIL',error:e.message})}
 }
 for(const template of fs.readdirSync(path.join(appRoot,'barcode/templates'))){
   const prn=await request('/api/barcode/prn',{barcode:'QA0001',product_name:'QA TEST PRODUCT',mrp:100,sale_price:100,qty:'1',unit:'Nos',stickerCount:1,template_name:template},token);
   assert.ok(prn.prn.includes('PRINT'),template);
 }
 await request('/api/staff-payroll/staff',{staff_code:'QA-001',staff_name:'QA Employee',salary_type:'DAILY',daily_wage:500,hourly_wage:62.5},token);
 const [[staff]]=await db.query("SELECT id FROM staff_workers WHERE staff_code='QA-001'");
 const date=new Date().toLocaleDateString('en-CA'),month=date.slice(0,7);
 await request('/api/staff-payroll/attendance',{staff_id:staff.id,attendance_date:date,status:'PRESENT',overtime_hours:2},token);
 const salary=await request('/api/staff-payroll/salary-sheet',{staff_id:staff.id,salary_month:month,payment_status:'PAID',payment_mode:'Cash'},token);
 assert.equal(Number(salary.salary.net_salary),625);
 await request('/api/staff-payroll/salary-sheet',{staff_id:staff.id,salary_month:month,payment_status:'PAID',payment_mode:'Cash'},token);
 const [[ledger]]=await db.query("SELECT COUNT(*) n FROM counter_cash_ledger_entries WHERE source_type='STAFF_SALARY'");
 assert.equal(Number(ledger.n),1);
 results.push({check:'Staff + attendance + overtime + salary calculation (625) + one ledger posting on repeated save',status:'PASS'});

 // Validate delivered XLSX through the actual frontend conversion and import API.
 const XLSX=require(path.join(repo,'frontend/node_modules/xlsx'));
 const workbook=XLSX.readFile(path.join(repo,'outputs/01a0bd5d-f9db-73f3-b557-bdfd4dbfdc38/NEW_SKU_UPLOAD.xlsx'));
 assert.equal(workbook.SheetNames[0],'Upload');
 const blankRows=XLSX.utils.sheet_to_json(workbook.Sheets.Upload,{header:1,defval:''});
 assert.ok(blankRows.slice(1).every(r=>r.every(v=>v==='')),'template contains no importable samples');
 const source=fs.readFileSync(path.join(repo,'frontend/src/components/InventoryDashboardView.jsx'),'utf8');
 const helpers=source.slice(source.indexOf('const PRODUCT_API_IMPORT_HEADERS'),source.indexOf('function formatProductDate'))+'\n'+source.slice(source.indexOf('function normalizeHeaderName'),source.indexOf('function downloadProductExcelTemplate'));
 const convert=require('vm').runInNewContext(helpers+'; rowsToApiImportCsv');
 const headers=blankRows[0];
 const row=values=>headers.map(h=>values[h]??'');
 const rows=[headers,row({'Product Code':'000123','Barcode':'0000001234567','Description':'QA EXCEL SKU','HSN Code':'001234','Unit':'Nos','Product Qty / Measure':'1 Pc','Purchase Unit':'Loose','Stock Per Purchase Unit':1,'MRP':100,'Purchase Rate':50,'Sales Rate':90,'Wholesale Price':80,'Sales GST %':0,'Sales SGST %':0,'Sales CGST %':0,'Sales IGST %':0,'Inward Quantity':7,'Low Stock Alert':2}),row({'Product Code':'000124','Barcode':'0000001234568','Description':'QA LABEL SKU','Unit':'Nos','MRP':100,'Purchase Rate':50,'Sales Rate':90,'Sales GST %':0,'Inward Quantity':0})];
 const imported=await request('/api/products/import',{csv:convert(rows),fileName:'NEW_SKU_UPLOAD.xlsx'},token,202);
 let job;
 for(let i=0;i<60;i++){const [[v]]=await db.query('SELECT * FROM product_import_jobs WHERE id=?',[imported.importId]);job=v;if(['SUCCESS','FAILED','PARTIAL SUCCESS'].includes(v.status))break;await sleep(200)}
 assert.equal(job.status,'SUCCESS',JSON.stringify(job));
 const [[sku]]=await db.query("SELECT * FROM products WHERE barcode='0000001234567'");
 assert.equal(sku.product_code,'000123');assert.equal(sku.hsn_code,'001234');assert.equal(Number(sku.stock_qty),7);assert.equal(Number(sku.sale_price),90);
 results.push({check:'Delivered XLSX: blank upload sheet, leading-zero codes, real converter + asynchronous import + prices/stock',status:'PASS'});
 await request('/api/barcode/prn',{barcode:'0000001234568',product_name:'QA LABEL SKU',mrp:100,sale_price:90,qty:'1',unit:'Nos',stickerCount:1,template_name:fs.readdirSync(path.join(appRoot,'barcode/templates'))[0]},token);
 const [[labelSku]]=await db.query("SELECT stock_qty FROM products WHERE barcode='0000001234568'");assert.equal(Number(labelSku.stock_qty),1);
 results.push({check:'Excel zero opening stock + PRN adds exactly one label unit',status:'PASS'});
 const [[backupTime]]=await db.query("SELECT setting_value FROM app_settings WHERE setting_key='backup_daily_time'");assert.equal(backupTime.setting_value,'09:00');
 const fixture=path.join(release,'qa/backup-fixture-'+Date.now());fs.mkdirSync(path.join(fixture,'backend'),{recursive:true});fs.mkdirSync(path.join(fixture,'runtime'));
 fs.symlinkSync(path.join(backend,'node_modules'),path.join(fixture,'backend/node_modules'),'junction');
 fs.copyFileSync(path.join(release,'package/payload/runtime/node.exe'),path.join(fixture,'runtime/node.exe'));
 fs.copyFileSync(path.join(__dirname,'backup-dump.cjs'),path.join(fixture,'backup-dump.cjs'));
 for(const rel of ['barcode/templates','barcode/output','thermal'])if(fs.existsSync(path.join(appRoot,rel)))fs.cpSync(path.join(appRoot,rel),path.join(fixture,rel),{recursive:true});
 const fixtureEnv=['DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME','MYSQLDUMP_PATH'].map(k=>k+'='+JSON.stringify(process.env[k].split(String.fromCharCode(92)).join('/'))).join('\n');
 fs.writeFileSync(path.join(fixture,'backend/.env'),fixtureEnv);
 const cp=require('child_process'),ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
 function backupRun(force){return cp.spawnSync(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'backup-local.ps1'),'-InstallRoot',fixture,'-TestMode',...(force?['-Force']:[])],{encoding:'utf8',windowsHide:true,timeout:90000})}
 let br=backupRun(true);assert.equal(br.status,0,br.stdout+br.stderr);
 const backupMarker=JSON.parse(fs.readFileSync(path.join(fixture,'backups/last-local-backup.json'),'utf8').replace(/^\uFEFF/,''));
 assert.ok(fs.statSync(backupMarker.archive).size>1000);
 const zipList=cp.spawnSync(ps,['-NoProfile','-Command', "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('"+backupMarker.archive.replace(/'/g,"''")+"'); try {$z.Entries.FullName | ConvertTo-Json} finally {$z.Dispose()}"],{encoding:'utf8',windowsHide:true});
 assert.equal(zipList.status,0);assert.ok(zipList.stdout.includes('database.sql'));assert.ok(zipList.stdout.includes('.prn'));assert.ok(zipList.stdout.includes('thermal'));
 const count=fs.readdirSync(path.join(fixture,'backups')).filter(f=>f.endsWith('.zip')).length;br=backupRun(false);assert.equal(br.status,0,br.stderr);assert.equal(fs.readdirSync(path.join(fixture,'backups')).filter(f=>f.endsWith('.zip')).length,count);
 results.push({check:'09:00 setting; full local ZIP contains SQL + barcode PRN + thermal; same-day scheduled duplicate skipped',status:'PASS'});
 fs.writeFileSync(path.join(fixture,'backend/.env'),fixtureEnv.replace(/^MYSQLDUMP_PATH=.*$/m,'MYSQLDUMP_PATH=Z:/missing/mysqldump.exe'));
 br=backupRun(true);assert.notEqual(br.status,0);assert.equal(JSON.parse(fs.readFileSync(path.join(fixture,'backups/last-local-backup.json'),'utf8').replace(/^\uFEFF/,'')).archive,backupMarker.archive);
 assert.ok(fs.existsSync(path.join(fixture,'backups/backup-errors.log')));
 fs.writeFileSync(path.join(fixture,'backend/.env'),fixtureEnv);
 results.push({check:'Backup failure returns nonzero, records error and preserves last successful archive marker',status:'PASS'});

 const {bootstrapExisting}=require(path.join(__dirname,'database-existing.cjs'));
 const suffix=require('crypto').randomBytes(6).toString('hex');
 const isolatedSettings={dbName:'badizo_new_'+suffix,dbUser:'bz_'+suffix,appPassword:require('crypto').randomBytes(24).toString('hex'),installId:require('crypto').randomBytes(24).toString('hex')};
 await bootstrapExisting(mysql,isolatedSettings,{user:'root',password},33360);
 let existingApp=await mysql.createConnection({host:'127.0.0.1',port:33360,user:isolatedSettings.dbUser,password:isolatedSettings.appPassword,database:isolatedSettings.dbName});
 await existingApp.query('CREATE TABLE retry_sentinel (id INT PRIMARY KEY)');
 await existingApp.query('INSERT INTO retry_sentinel VALUES (42)');
 await existingApp.end();
 await bootstrapExisting(mysql,isolatedSettings,{user:'root',password},33360);
 await assert.rejects(()=>bootstrapExisting(mysql,{...isolatedSettings,installId:'wrong-owner'},{user:'root',password},33360),/ownership mismatch/);
 await assert.rejects(()=>bootstrapExisting(mysql,isolatedSettings,{user:'root',password:'wrong-test-password'},33360));
 const rootStillWorks=await mysql.createConnection({host:'127.0.0.1',port:33360,user:'root',password});
 const [[sentinel]]=await rootStillWorks.query('SELECT id FROM '+isolatedSettings.dbName+'.retry_sentinel');assert.equal(sentinel.id,42);
 const [[original]]=await rootStillWorks.query('SELECT COUNT(*) n FROM badizo_release_qa.invoices');assert.equal(Number(original.n),1);await rootStillWorks.end();
 results.push({check:'Existing MySQL 8.0 reuse: new separate DB/user, safe retry, wrong owner/password rejection, old data + root password preserved',status:'PASS'});
 const backupService=require(path.join(backend,'services/backupService'));
 const backup=await backupService.runDatabaseBackup();
 assert.ok(fs.statSync(backup.path).size>1000);
 await backupService.restoreDatabaseBackup(backup.file);
 const [[restored]]=await db.query('SELECT COUNT(*) n FROM invoices');assert.equal(Number(restored.n),1);
 results.push({check:'mysqldump backup + restore with limited database user on isolated DB',status:'PASS'});
 fs.writeFileSync(path.join(release,'qa/summary.json'),JSON.stringify({at:new Date().toISOString(),database:'isolated localhost:33360 / badizo_release_qa',results},null,2));
}
main().catch(e=>{results.push({check:'Integration run',status:'FAIL',error:e.stack});console.error(e.message)}).finally(async()=>{
 fs.writeFileSync(path.join(release,'qa/summary.json'),JSON.stringify({at:new Date().toISOString(),database:'isolated localhost:33360 / badizo_release_qa',results},null,2));
 if(http)http.close(); if(db)await db.end();
 if(control){try{await control.query('SHUTDOWN')}catch{} await control.end().catch(()=>{})}
 console.log(JSON.stringify({passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL')},null,2));
 process.exit(results.some(x=>x.status==='FAIL')?1:0);
});
