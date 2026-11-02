const crypto=require('node:crypto');
const {enqueue}=require('./syncOutbox');
// Opt-in journal capture, not a complete business-event replay handler.
// Must execute before checkout commits, using its transaction connection.
async function captureInvoice(connection,invoiceNo,change,env,baseline=null){
  if(env.BADIZO_SYNC_CHECKOUT_CAPTURE!=='true')return null;
  const identity={shopId:env.BADIZO_SHOP_ID,localInstallationId:env.BADIZO_INSTALLATION_ID,peerInstallationId:env.BADIZO_SYNC_PEER_INSTALLATION_ID};
  async function rows(table){
    const [result]=await connection.query({sql:`SELECT * FROM ${table} WHERE invoice_no=? ORDER BY id`,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},[invoiceNo]);
    // Normalize driver RowDataPacket objects before canonical JSON validation.
    return JSON.parse(JSON.stringify(result));
  }
  const invoices=await rows('invoices');
  if(invoices.length!==1)throw Error('Checkout sync capture requires one committed-intent invoice.');
  let payload={invoice:invoices[0],items:await rows('invoice_items'),payments:await rows('invoice_payments'),batchAllocations:await rows('invoice_item_batches'),loyaltyTransactions:await rows('loyalty_transactions')};
  if(change.kind!=='checkout'){
    payload.change=change;
    payload.returns=await rows('sales_returns');
    const [returnItems]=await connection.query({sql:'SELECT i.* FROM sales_return_items i JOIN sales_returns r ON r.return_no=i.return_no WHERE r.invoice_no=? ORDER BY i.id',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},[invoiceNo]);
    payload.returnItems=JSON.parse(JSON.stringify(returnItems));
    if(change.kind==='return' && !payload.returns.some(row=>row.return_no===change.returnNo))throw Error('Return capture is missing its return record.');
    if(change.kind==='void' && payload.invoice.invoice_status!=='CANCELLED')throw Error('Cancellation capture requires cancelled invoice state.');
    payload=await require('./invoiceOriginIdentity').normalizeLifecycle(connection,payload,identity);
    if(baseline)payload.checkoutBaseline=baseline;
  }
  const types={checkout:'pos.checkout.recorded',void:'pos.invoice.cancelled',return:'pos.invoice.returned'};
  const event={eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:types[change.kind],schemaVersion:1,payload};
  await enqueue(connection,event,identity);
  return event.eventId;
}
function captureCheckout(connection,invoiceNo,env=process.env){return captureInvoice(connection,invoiceNo,{kind:'checkout'},env);}
function captureInvoiceLifecycle(connection,invoiceNo,change,env=process.env,baseline=null){
  if(env.BADIZO_SYNC_CHECKOUT_CAPTURE!=='true')return Promise.resolve(null);
  if(!change || !['void','return'].includes(change.kind) || (change.kind==='return' && (typeof change.returnNo!=='string' || !change.returnNo)))throw Error('Invalid invoice lifecycle event.');
  return captureInvoice(connection,invoiceNo,change,env,baseline);
}
module.exports={captureCheckout,captureInvoiceLifecycle};
