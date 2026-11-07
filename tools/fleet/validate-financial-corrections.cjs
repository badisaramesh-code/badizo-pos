// Imported by the isolated enrolled-runtime drill. Never accepts production
// database names; source fixture writes are synthetic and deliberately model
// two disconnected nodes before owner correction through real HTTP routes.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {captureSupplierPayment}=require('../../backend/services/supplierPaymentSync');
const {captureStockAdjustment}=require('../../backend/services/stockAdjustmentSync');
async function runFinancialCorrectionDrill({pools,request,deliver,identities}){
  assert.equal(pools.length,2);assert.equal(identities.length,2);
  for(const pool of pools){const [[db]]=await pool.query('SELECT DATABASE() AS name');assert.match(db.name,/^badizo_recovery_[a-z0-9]+$/);}
  const env=i=>({BADIZO_SHOP_ID:identities[i].shopId,BADIZO_INSTALLATION_ID:identities[i].localInstallationId,BADIZO_SYNC_PEER_INSTALLATION_ID:identities[i].peerInstallationId,BADIZO_SYNC_PURCHASE_CAPTURE:'true',BADIZO_SYNC_STOCK_CAPTURE:'true'});
  async function latest(i,type,field,value){const [rows]=await pools[i].execute("SELECT event_json FROM sync_outbox WHERE origin_installation_id=? AND JSON_UNQUOTE(JSON_EXTRACT(event_json,'$.type'))=? AND JSON_UNQUOTE(JSON_EXTRACT(event_json,?))=? ORDER BY sequence_no DESC LIMIT 1",[identities[i].localInstallationId,type,field,String(value)]);assert.equal(rows.length,1);return typeof rows[0].event_json==='string'?JSON.parse(rows[0].event_json):rows[0].event_json;}
  async function findCase(event){const list=await request(0,'recovery-cases'),found=list.cases.find(item=>item.eventId===event.eventId);assert.ok(found);return request(0,'recovery-cases/'+found.id);}
  async function delivered(i,event,status=200){const result=await deliver(i,event);assert.equal(result.status,status);return result.body;}
  const inward='FC-'+crypto.randomBytes(10).toString('hex'),payments=[];
  for(let i=0;i<2;i++){
    const c=await pools[i].getConnection();try{
      await c.beginTransaction();
      await c.execute("INSERT INTO inward_entries (inward_no,supplier_name,supplier_gstin,grand_total,paid_amount,due_amount,payment_status,posting_status) VALUES (?,'ISOLATED CORRECTION SUPPLIER','',100,0,100,'DUE','POSTED')",[inward]);
      const [payment]=await c.execute("INSERT INTO supplier_payments (inward_no,supplier_name,supplier_gstin,payment_date,amount,payment_mode,reference_no,notes,created_by) VALUES (?,'ISOLATED CORRECTION SUPPLIER','','2026-11-02',70,'Bank Transfer',?,'Isolated duplicate physical payment','isolated-owner')",[inward,inward]);
      await c.execute("UPDATE inward_entries SET paid_amount=70,due_amount=30,payment_status='PARTIAL' WHERE inward_no=?",[inward]);
      await captureSupplierPayment(c,{inward_no:inward,grand_total:'100.00',paid_amount:'0.00',due_amount:'100.00'},payment.insertId,env(i));
      await c.commit();payments.push(payment.insertId);
    }catch(error){await c.rollback();throw error;}finally{c.release();}
  }
  const localPayment=await latest(0,'pos.supplier-payment.recorded','$.payload.payment.id',payments[0]),cloudPayment=await latest(1,'pos.supplier-payment.recorded','$.payload.payment.id',payments[1]);
  await delivered(0,cloudPayment,409);
  const paymentCase=await findCase(cloudPayment);assert.ok(paymentCase.paymentMatch.candidates.some(row=>String(row.id)===String(payments[0])));
  const matched=await request(0,'recovery-cases/'+paymentCase.id+'/match-payment',{expectedRevision:paymentCase.revision,targetPaymentId:String(payments[0]),note:'Verified the isolated bank statement: one physical payment was entered on both nodes.',confirmation:'THESE ARE THE SAME PHYSICAL PAYMENT'});assert.equal(matched.status,'resolved');
  const paymentResolution=await latest(0,'pos.recovery.supplier-payment-matched','$.payload.incomingEvent.eventId',cloudPayment.eventId);
  await delivered(1,paymentResolution);assert.equal((await delivered(1,paymentResolution)).duplicate,true);
  assert.equal((await delivered(1,localPayment)).duplicate,true);assert.equal((await delivered(0,cloudPayment)).duplicate,true);
  for(const pool of pools){const [[balance]]=await pool.execute('SELECT paid_amount,due_amount FROM inward_entries WHERE inward_no=?',[inward]);assert.equal(Number(balance.paid_amount),70);assert.equal(Number(balance.due_amount),30);const [[count]]=await pool.execute('SELECT COUNT(*) AS n FROM supplier_payments WHERE inward_no=?',[inward]);assert.equal(Number(count.n),1);}
  const barcode='FCSTOCK'+crypto.randomBytes(10).toString('hex'),audits=[];
  for(let i=0;i<2;i++){
    const delta=i?3:5,c=await pools[i].getConnection();try{
      await c.beginTransaction();await c.execute("INSERT INTO products (barcode,product_name,stock_qty) VALUES (?,'ISOLATED AUDIT CORRECTION',?)",[barcode,100+delta]);
      const [adjustment]=await c.execute("INSERT INTO stock_adjustments (barcode,product_name,old_qty,adjustment_qty,new_qty,reason,note,created_by) VALUES (?,'ISOLATED AUDIT CORRECTION',100,?,?,'STOCK_AUDIT','Verified independent isolated physical adjustment','isolated-owner')",[barcode,delta,100+delta]);
      await captureStockAdjustment(c,adjustment.insertId,env(i));await c.commit();audits.push(adjustment.insertId);
    }catch(error){await c.rollback();throw error;}finally{c.release();}
  }
  const localAudit=await latest(0,'pos.stock.adjusted','$.payload.adjustment.id',audits[0]),cloudAudit=await latest(1,'pos.stock.adjusted','$.payload.adjustment.id',audits[1]);
  await delivered(0,cloudAudit,409);let stockCase=await findCase(cloudAudit);
  assert.deepEqual(stockCase.stockCorrection.localAudits.map(row=>row.eventId),[localAudit.eventId]);
  const body={expectedRevision:stockCase.revision,expectedStock:'104.00',expectedLocalAuditIds:[localAudit.eventId],note:'Verified independent adjustments against the isolated stock-count sheets on both nodes.',confirmation:'APPLY THE VERIFIED STOCK DIFFERENCE'};
  const stale=await request(0,'recovery-cases/'+stockCase.id+'/accept-stock-delta',body);assert.equal(stale.status,'needs-correction');
  const [[unchanged]]=await pools[0].execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(Number(unchanged.stock_qty),105);
  stockCase=await findCase(cloudAudit);
  const accepted=await request(0,'recovery-cases/'+stockCase.id+'/accept-stock-delta',{...body,expectedRevision:stockCase.revision,expectedStock:'105.00'});assert.equal(accepted.status,'resolved');
  const stockResolution=await latest(0,'pos.recovery.stock-deltas-reviewed','$.payload.incomingEvent.eventId',cloudAudit.eventId);
  await delivered(1,stockResolution);assert.equal((await delivered(1,stockResolution)).duplicate,true);
  assert.equal((await delivered(1,localAudit)).duplicate,true);assert.equal((await delivered(0,cloudAudit)).duplicate,true);
  for(const pool of pools){const [[stock]]=await pool.execute('SELECT stock_qty FROM products WHERE barcode=?',[barcode]);assert.equal(Number(stock.stock_qty),108);const [[count]]=await pool.execute('SELECT COUNT(*) AS n FROM stock_adjustments WHERE barcode=?',[barcode]);assert.equal(Number(count.n),2);}
  return {duplicateSupplierPaymentMatched:true,twoSidedAuditDeltasConverged:true,staleStockReviewRejected:true,duplicateCorrectionDeliverySafe:true};
}
module.exports={runFinancialCorrectionDrill};
