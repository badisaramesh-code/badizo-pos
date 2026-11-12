const {createHash}=require('node:crypto');
function validId(value){const id=String(value||'');if(!/^[A-Za-z0-9_-]{12,64}$/.test(id))throw Object.assign(new Error('A valid checkout request ID is required.'),{statusCode:400});return id;}
const lockName=id=>'checkout:'+createHash('sha256').update(id).digest('hex').slice(0,54);
async function ensureSchema(c){
 await c.query(`CREATE TABLE IF NOT EXISTS abandoned_checkouts(checkout_request_id VARCHAR(64) PRIMARY KEY,abandoned_by VARCHAR(100) NOT NULL,abandoned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
 await c.query(`CREATE TABLE IF NOT EXISTS parked_checkout_reviews(checkout_request_id VARCHAR(64) PRIMARY KEY,counter_no INT NOT NULL,reported_by VARCHAR(100) NOT NULL,grand_total DECIMAL(12,2) NOT NULL,reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
 await c.query(`CREATE TABLE IF NOT EXISTS checkout_recovery_events(id BIGINT AUTO_INCREMENT PRIMARY KEY,checkout_request_id VARCHAR(64) NOT NULL,actor VARCHAR(100) NOT NULL,action VARCHAR(20) NOT NULL,outcome VARCHAR(20) NOT NULL,invoice_no VARCHAR(100) NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_checkout_event(checkout_request_id,id)) ENGINE=InnoDB`);
}
async function acquire(c,id){id=validId(id);const [rows]=await c.query('SELECT GET_LOCK(?,5) AS acquired',[lockName(id)]);if(Number(rows[0]?.acquired)!==1)throw Object.assign(new Error('This bill is still processing. Wait a few seconds and check again.'),{statusCode:409,code:'CHECKOUT_BUSY'});return lockName(id);}
async function release(c,name){if(name)await c.query('SELECT RELEASE_LOCK(?)',[name]).catch(()=>{});}
async function assertNotAbandoned(c,id){const [rows]=await c.query('SELECT checkout_request_id FROM abandoned_checkouts WHERE checkout_request_id=?',[id]);if(rows.length)throw Object.assign(new Error('This bill was confirmed unsaved and released. Start a new bill.'),{code:'CHECKOUT_ABANDONED',statusCode:409});}
async function review(pool,id,actor,releaseUnsaved){
 id=validId(id);const c=await pool.getConnection();let lock,begun=false;
 try{
  lock=await acquire(c,id);await c.beginTransaction();begun=true;
  const [saved]=await c.query('SELECT invoice_no,grand_total,invoice_status FROM invoices WHERE checkout_request_id=? LIMIT 1',[id]);let result;
  if(saved.length)result={status:'SAVED',invoice_no:saved[0].invoice_no,grand_total:saved[0].grand_total,invoice_status:saved[0].invoice_status};
  else{const [cancelled]=await c.query('SELECT checkout_request_id FROM abandoned_checkouts WHERE checkout_request_id=?',[id]);if(releaseUnsaved){await c.query('INSERT IGNORE INTO abandoned_checkouts(checkout_request_id,abandoned_by) VALUES(?,?)',[id,actor]);result={status:'ABANDONED'};}else result={status:cancelled.length?'ABANDONED':'UNSAVED'};}
  await c.query('INSERT INTO checkout_recovery_events(checkout_request_id,actor,action,outcome,invoice_no) VALUES(?,?,?,?,?)',[id,actor,releaseUnsaved?'RELEASE':'CHECK',result.status,result.invoice_no||null]);
  await c.commit();begun=false;return result;
 }catch(error){if(begun)await c.rollback().catch(()=>{});await c.query('INSERT INTO checkout_recovery_events(checkout_request_id,actor,action,outcome) VALUES(?,?,?,?)',[id,actor,releaseUnsaved?'RELEASE':'CHECK',error.code==='CHECKOUT_BUSY'?'BUSY':'FAILED']).catch(()=>{});throw error;}
 finally{await release(c,lock);c.release();}
}
const abandon=(pool,id,actor)=>review(pool,id,actor,true);
const inspect=(pool,id,actor)=>review(pool,id,actor,false);
module.exports={ensureSchema,acquire,release,assertNotAbandoned,abandon,inspect};
