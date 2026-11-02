const {createSyncReceiver}=require('./syncEventProtocol');
const {createRecoveryConflictExecution}=require('./recoveryConflictExecution');
const handlers={
  'pos.checkout.recorded':require('./checkoutSyncHandler').applyCheckout,
  'pos.invoice.returned':require('./invoiceReturnSyncHandler').applyReturn,
  'pos.invoice.cancelled':require('./invoiceCancellationSyncHandler').applyCancellation,
  'pos.product.fields.changed':require('./productSyncHandler').applyProductFields,
  'pos.product.changed':require('./productMasterSync').applyProductMaster,
  'pos.products.deleted':require('./productMasterSync').applyProductDeletion,
  'pos.recovery.product-resolved':require('./productConflictResolution').applyProductResolution,
  'pos.recovery.supplier-payment-matched':require('./financialCorrectionExecution').applyMatchedSupplierPayment,
  'pos.recovery.stock-deltas-reviewed':require('./financialCorrectionExecution').applyReviewedStockDeltas,
  'pos.stock.adjusted':require('./stockAdjustmentSync').applyStockAdjustment,
  'pos.purchase.changed':require('./purchaseSync').applyPurchase,
  'pos.supplier-payment.recorded':require('./supplierPaymentSync').applySupplierPayment
};
// Production enrollment supplies fixed identities, a protected review store,
// and permission checks. No default server startup enables this receiver.
async function emergencyLocalPriority(){
  if((process.env.BADIZO_NODE_ROLE||'local-server')!=='local-server')return false;
  const state=require('./recoveryRuntimeBinding').read();
  return state?.phase==='active'&&state.billingMode==='active'&&state.preferLocalConflicts===true;
}
function createPosSyncReceiver({pool,identity,reviewStore=null,localPriority=emergencyLocalPriority,retainReceived=false}){
  const receive=createSyncReceiver({pool,identity,handlers,reviewStore,retainReceived});
  const execution=reviewStore?createRecoveryConflictExecution({pool,store:reviewStore,identity,canApply:localPriority}):null;
  return async event=>{
    try{return await receive(event);}catch(error){
      if(!execution||!error.recoveryPlanId||await localPriority()!==true)throw error;
      let review=await reviewStore.read(error.recoveryPlanId);
      const conflicts=review.plan.entries.filter(entry=>entry.state==='conflict');
      if(conflicts.some(entry=>!entry.bulkEligible))throw error;
      if(conflicts.length)review=await reviewStore.select(review.plan.id,{expectedRevision:review.revision,side:'local',actor:'system:emergency-local',conflictIds:conflicts.map(entry=>entry.id)},()=>execution.assertMutable(review.plan.id));
      await execution.apply(review.plan.id,{expectedRevision:review.revision,expectedHeadHash:review.headHash,actor:'system:emergency-local'});
      return receive(event);
    }
  };
}
module.exports={createPosSyncReceiver,handlers};
