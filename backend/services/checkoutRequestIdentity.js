const crypto=require('node:crypto');
const {canonical}=require('./syncEventProtocol');
const enabled=env=>env.BADIZO_CHECKOUT_REQUEST_GUARD==='true';
function fingerprint(body,user){
  if(!body||!user?.username)throw Error('Authenticated checkout intent required.');
  const {checkout_request_id,...intent}=body;
  return crypto.createHash('sha256').update(canonical({intent,actor:String(user.username),role:String(user.role),counter:user.counter_no??null})).digest('hex');
}
function mismatch(){const error=Error('Checkout identity differs or cannot be verified. Recover the original bill before retrying.');error.status=409;return error;}
async function verify(connection,requestId,hash,invoiceNo,env=process.env){
  if(!enabled(env))return;
  const [rows]=await connection.execute('SELECT intent_hash,invoice_no FROM sync_checkout_requests WHERE request_id=?',[requestId]);
  if(rows.length!==1||rows[0].intent_hash!==hash||rows[0].invoice_no!==invoiceNo)throw mismatch();
}
async function record(connection,requestId,hash,invoiceNo,env=process.env){
  if(!enabled(env))return;
  if(!requestId||!/^[a-f0-9]{64}$/.test(hash||''))throw mismatch();
  await connection.execute('INSERT INTO sync_checkout_requests (request_id,intent_hash,invoice_no) VALUES (?,?,?)',[requestId,hash,invoiceNo]);
}
module.exports={enabled,fingerprint,verify,record,mismatch};
