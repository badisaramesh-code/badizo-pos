const crypto=require('node:crypto');
const {enqueue}=require('./syncOutbox');
// Opt-in journal capture, not a complete business-event replay handler.
// Must execute before checkout commits, using its transaction connection.
async function captureCheckout(connection,invoiceNo,env=process.env){
  if(env.BADIZO_SYNC_CHECKOUT_CAPTURE!=='true')return null;
  const identity={shopId:env.BADIZO_SHOP_ID,localInstallationId:env.BADIZO_INSTALLATION_ID,peerInstallationId:env.BADIZO_SYNC_PEER_INSTALLATION_ID};
  async function rows(table){
    const [result]=await connection.query({sql:`SELECT * FROM ${table} WHERE invoice_no=? ORDER BY id`,dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},[invoiceNo]);
    // Normalize driver RowDataPacket objects before canonical JSON validation.
    return JSON.parse(JSON.stringify(result));
  }
  const invoices=await rows('invoices');
  if(invoices.length!==1)throw Error('Checkout sync capture requires one committed-intent invoice.');
  const payload={invoice:invoices[0],items:await rows('invoice_items'),payments:await rows('invoice_payments'),batchAllocations:await rows('invoice_item_batches'),loyaltyTransactions:await rows('loyalty_transactions')};
  const event={eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.checkout.recorded',schemaVersion:1,payload};
  await enqueue(connection,event,identity);
  return event.eventId;
}
module.exports={captureCheckout};
