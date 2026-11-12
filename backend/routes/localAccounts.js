const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizeDate, parseMoney } = require('../utils/formatters');
router.use(authenticate, authorize('SERVER', 'ADMIN'));
// Diary settlements must be corrected through an auditable reversal, rather
// than editing one side of a payment independently in the manual ledger.
router.use(async(req,res,next)=>{
  try {
    if(req.method==='PUT' && /^\/\d+$/.test(req.path)) {
      const id=Number(req.path.slice(1));
      const [linked]=await db.query('SELECT id FROM local_payment_diary_payments WHERE payment_entry_id=? OR discount_entry_id=? OR reversal_payment_entry_id=? OR reversal_discount_entry_id=? LIMIT 1',[id,id,id,id]);
      if(linked.length)return res.status(409).json({error:'This entry belongs to Payment Diary. Reverse the payment in the diary to correct it.'});
    }
    if(req.method==='DELETE'&&req.path==='/ledger') {
      const [linked]=await db.query('SELECT id FROM local_payment_diary WHERE account_scope=? AND account_name=? LIMIT 1',[req.body.account_scope,req.body.old_name||req.body.account_name]);
      if(linked.length)return res.status(409).json({error:'This ledger has Payment Diary history. Its financial history must be retained.'});
    }
    next();
  } catch(error){next(error);}
});
const diaryService = require('../services/paymentDiary').createService(db);
const scopeOf = (v) => String(v || '').toUpperCase() === 'NON_LOCAL' ? 'NON_LOCAL' : 'LOCAL';
function clean(body) { const rawDate=String(body.entry_date||'').trim(),date=normalizeDate(rawDate,''); const row={scope:scopeOf(body.account_scope),date,name:String(body.account_name||'').trim().toUpperCase(),details:String(body.details||'').trim().toUpperCase(),remarks:String(body.remarks||'').trim(),dr:parseMoney(body.dr_amount),cr:parseMoney(body.cr_amount)}; if(!row.date) throw Object.assign(new Error('Enter a valid date.'),{statusCode:400}); const [year,month,day]=row.date.split('-').map(Number),check=new Date(Date.UTC(year,month-1,day)); if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day) throw Object.assign(new Error('Enter a valid date.'),{statusCode:400}); if(!row.name) throw Object.assign(new Error('Name is required.'),{statusCode:400}); if((row.dr>0&&row.cr>0)||(row.dr<=0&&row.cr<=0)) throw Object.assign(new Error('Enter amount in either DR Rs or CR Rs.'),{statusCode:400}); return row; }
router.get('/', async(req,res)=>{ const scope=scopeOf(req.query.scope),from=normalizeDate(req.query.from),to=normalizeDate(req.query.to); try { const [all]=await db.query(`SELECT id, DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date, account_name, details, remarks, is_cleared, dr_amount, cr_amount, created_by, created_at,
 EXISTS(SELECT 1 FROM local_payment_diary d
 WHERE d.create_request_id=CONCAT('ledger-entry-',local_account_entries.id)
 AND d.account_scope=local_account_entries.account_scope AND d.account_name=local_account_entries.account_name
 AND COALESCE((SELECT h.change_type FROM local_payment_diary_changes h WHERE h.diary_id=d.id AND h.change_type IN ('DELETE','RESTORE') ORDER BY h.id DESC LIMIT 1),'RESTORE')<>'DELETE') AS has_diary_reminder
 FROM local_account_entries WHERE account_scope=? AND entry_date<=? ORDER BY account_name, entry_date, id`,[scope,to]); const [profiles]=await db.query(`SELECT account_name, address_details, phone_number, gst_number FROM local_account_ledgers WHERE account_scope=?`,[scope]); const profileMap=new Map(profiles.map(p=>[String(p.account_name).toLocaleLowerCase(),p])); const running=new Map(),ledgerMap=new Map(),rows=[]; all.forEach(row=>{const key=String(row.account_name).toLocaleLowerCase(),balance=(running.get(key)||0)+Number(row.dr_amount||0)-Number(row.cr_amount||0);running.set(key,balance);if(!ledgerMap.has(key))ledgerMap.set(key,{name:row.account_name,entries:0,dr:0,cr:0,...(profileMap.get(key)||{})});const l=ledgerMap.get(key);l.entries++;l.dr+=Number(row.dr_amount||0);l.cr+=Number(row.cr_amount||0);l.balance=l.dr-l.cr;if(String(row.entry_date).slice(0,10)>=from)rows.push({...row,details:String(row.details||'').toUpperCase(),balance,balance_type:balance>=0?'DR':'CR'});}); profiles.forEach(p=>{const key=String(p.account_name).toLocaleLowerCase();if(!ledgerMap.has(key))ledgerMap.set(key,{name:p.account_name,entries:0,dr:0,cr:0,balance:0,...p});}); rows.sort((a,b)=>String(a.entry_date).localeCompare(String(b.entry_date))||Number(a.id)-Number(b.id)); const dr=rows.reduce((s,r)=>s+Number(r.dr_amount||0),0),cr=rows.reduce((s,r)=>s+Number(r.cr_amount||0),0);res.json({scope,from,to,rows,ledgers:[...ledgerMap.values()].sort((a,b)=>a.name.localeCompare(b.name)),totals:{dr,cr,balance:dr-cr}}); } catch(err){console.error('Local accounts load failed:',err.message);res.status(500).json({error:'Unable to load Local / Non-Local accounts.'});} });
async function saveEntry(req,res,editing=false) {
 let c;
 try {
  const r=clean(req.body), rawDays=String(req.body.credit_days??'').trim();
  if(rawDays && (!/^\d+$/.test(rawDays)||Number(rawDays)>3650)) throw Object.assign(new Error('Days must be a whole number between 0 and 3650.'),{statusCode:400});
  c=await db.getConnection();await c.beginTransaction();
  let id=Number(req.params.id);
  if(editing){
   const [rows]=await c.query('SELECT id FROM local_account_entries WHERE id=? FOR UPDATE',[id]);
   if(!rows.length)throw Object.assign(new Error('Entry not found.'),{statusCode:404});
   const [linked]=await c.query('SELECT id FROM local_payment_diary WHERE create_request_id=?',['ledger-entry-'+id]);
   if(linked.length)throw Object.assign(new Error('This bill is linked to Payment Diary. Manage its reminder and payments in Payment Diary.'),{statusCode:409});
   await c.query('UPDATE local_account_entries SET account_scope=?,entry_date=?,account_name=?,details=?,remarks=?,dr_amount=?,cr_amount=? WHERE id=?',[r.scope,r.date,r.name,r.details,r.remarks,r.dr,r.cr,id]);
  }else{
   const [saved]=await c.query('INSERT INTO local_account_entries (account_scope,entry_date,account_name,details,remarks,dr_amount,cr_amount,created_by) VALUES(?,?,?,?,?,?,?,?)',[r.scope,r.date,r.name,r.details,r.remarks,r.dr,r.cr,req.user.username]);id=saved.insertId;
  }
  if(rawDays){
   const due=new Date(r.date+'T00:00:00Z');due.setUTCDate(due.getUTCDate()+Number(rawDays));
   await diaryService.add({account_scope:r.scope,account_name:r.name,bill_no:'LEDGER-'+id,bill_date:r.date,due_date:due.toISOString().slice(0,10),amount:(r.cr||r.dr).toFixed(2),notes:[r.details,r.remarks].filter(Boolean).join(' | ').slice(0,500),request_id:'ledger-entry-'+id},req.user.username,c);
  }
  await c.commit();res.json({success:true,id,diary_posted:Boolean(rawDays)});
 }catch(err){if(c)await c.rollback().catch(()=>{});const status=err.statusCode||err.status||500;res.status(status).json({error:status<500?err.message:'Unable to save account entry.'});}
 finally{if(c)c.release();}
}
router.post('/',(req,res)=>saveEntry(req,res));
router.put('/:id',(req,res)=>saveEntry(req,res,true));
router.put('/:id/cleared',async(req,res)=>{try{const id=Number(req.params.id),isCleared=req.body?.is_cleared?1:0;if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'Invalid entry.'});const[s]=await db.query(`UPDATE local_account_entries SET is_cleared=? WHERE id=?`,[isCleared,id]);if(!s.affectedRows)return res.status(404).json({error:'Entry not found.'});res.json({success:true,is_cleared:isCleared});}catch(err){res.status(500).json({error:'Unable to update cleared status.'});}});
router.delete('/ledger',async(req,res)=>{const connection=await db.getConnection();try{const scope=scopeOf(req.body?.account_scope),name=String(req.body?.account_name||'').trim().toUpperCase();if(!name)return res.status(400).json({error:'Ledger name is required.'});await connection.beginTransaction();const[entries]=await connection.query(`DELETE FROM local_account_entries WHERE account_scope=? AND account_name=?`,[scope,name]);const[profile]=await connection.query(`DELETE FROM local_account_ledgers WHERE account_scope=? AND account_name=?`,[scope,name]);if(!entries.affectedRows&&!profile.affectedRows){await connection.rollback();return res.status(404).json({error:'Ledger not found.'});}await connection.commit();res.json({success:true,deleted_entries:entries.affectedRows});}catch(err){try{await connection.rollback();}catch(_rollbackError){}console.error('Ledger delete failed:',err.message);res.status(500).json({error:'Unable to delete ledger.'});}finally{connection.release();}});
router.put('/ledger/profile',async(req,res)=>{try{const scope=scopeOf(req.body.account_scope),name=String(req.body.account_name||'').trim().toUpperCase();if(!name)return res.status(400).json({error:'Ledger name is required.'});await db.query(`INSERT INTO local_account_ledgers (account_scope,account_name,address_details,phone_number,gst_number,created_by) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE address_details=VALUES(address_details),phone_number=VALUES(phone_number),gst_number=VALUES(gst_number),updated_at=CURRENT_TIMESTAMP`,[scope,name,String(req.body.address_details||'').trim(),String(req.body.phone_number||'').trim(),String(req.body.gst_number||'').trim().toUpperCase(),req.user.username]);res.json({success:true});}catch(err){res.status(500).json({error:'Unable to save ledger heading details.'});}});
router.put('/ledger/name',async(req,res)=>{const connection=await db.getConnection();try{const scope=scopeOf(req.body.account_scope),oldName=String(req.body.old_name||'').trim().toUpperCase(),newName=String(req.body.new_name||'').trim().toUpperCase();if(!oldName||!newName)return res.status(400).json({error:'Old and new ledger names are required.'});if(newName.length>180)return res.status(400).json({error:'Ledger name must be 180 characters or fewer.'});if(oldName===newName)return res.json({success:true,name:newName});await connection.beginTransaction();const[oldEntries]=await connection.query(`SELECT id FROM local_account_entries WHERE account_scope=? AND account_name=? LIMIT 1 FOR UPDATE`,[scope,oldName]);const[oldProfiles]=await connection.query(`SELECT id FROM local_account_ledgers WHERE account_scope=? AND account_name=? LIMIT 1 FOR UPDATE`,[scope,oldName]);if(!oldEntries.length&&!oldProfiles.length){await connection.rollback();return res.status(404).json({error:'Ledger not found.'});}const[targetEntries]=await connection.query(`SELECT id FROM local_account_entries WHERE account_scope=? AND account_name=? LIMIT 1 FOR UPDATE`,[scope,newName]);const[targetProfiles]=await connection.query(`SELECT id FROM local_account_ledgers WHERE account_scope=? AND account_name=? LIMIT 1 FOR UPDATE`,[scope,newName]);if(targetEntries.length||targetProfiles.length){await connection.rollback();return res.status(409).json({error:'A ledger with this name already exists.'});}await connection.query(`UPDATE local_account_entries SET account_name=? WHERE account_scope=? AND account_name=?`,[newName,scope,oldName]);await connection.query(`UPDATE local_account_ledgers SET account_name=? WHERE account_scope=? AND account_name=?`,[newName,scope,oldName]);await connection.query(`UPDATE local_payment_diary SET account_name=? WHERE account_scope=? AND account_name=?`,[newName,scope,oldName]);await connection.commit();res.json({success:true,name:newName});}catch(err){try{await connection.rollback();}catch(_rollbackError){}console.error('Ledger rename failed:',err.message);res.status(500).json({error:'Unable to rename ledger.'});}finally{connection.release();}});
module.exports=router;
