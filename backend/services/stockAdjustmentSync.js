const crypto=require('node:crypto');
const {enqueue}=require('./syncOutbox');
function quantity(value){
  const text=String(value);
  if(!/^-?\d{1,10}(\.\d{1,2})?$/.test(text))throw Error('Invalid stock quantity.');
  const negative=text.startsWith('-'),[whole,fraction='']=text.replace(/^-/,'').split('.');
  const amount=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  return negative?-amount:amount;
}
function format(value){const sign=value<0n?'-':'';const absolute=value<0n?-value:value;return sign+(absolute/100n)+'.'+String(absolute%100n).padStart(2,'0');}
async function captureStockAdjustment(connection,id,env=process.env){
  if(env.BADIZO_SYNC_STOCK_CAPTURE!=='true')return null;
  if(!/^[1-9][0-9]{0,18}$/.test(String(id)))throw Error('Invalid stock adjustment identity.');
  const [rows]=await connection.query({sql:'SELECT * FROM stock_adjustments WHERE id=?',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true},[id]);
  if(rows.length!==1)throw Error('Stock adjustment record missing.');
  const identity={shopId:env.BADIZO_SHOP_ID,localInstallationId:env.BADIZO_INSTALLATION_ID,peerInstallationId:env.BADIZO_SYNC_PEER_INSTALLATION_ID};
  const event={eventId:crypto.randomUUID(),shopId:identity.shopId,originInstallationId:identity.localInstallationId,type:'pos.stock.adjusted',schemaVersion:1,payload:{adjustment:JSON.parse(JSON.stringify(rows[0]))}};
  await enqueue(connection,event,identity);return event.eventId;
}
async function applyStockAdjustment(connection,payload,context){
  const row=payload?.adjustment;
  if(!context?.shopId||!context.originInstallationId||!payload||Object.keys(payload).join(',')!=='adjustment'||!row
    ||Object.keys(row).sort().join(',')!=='adjustment_qty,barcode,created_at,created_by,id,new_qty,note,old_qty,product_name,reason'
    ||!/^[1-9][0-9]{0,18}$/.test(String(row.id))||typeof row.barcode!=='string'||!row.barcode||row.barcode.length>120
    ||!['DAMAGE','EXPIRY','WASTAGE','THEFT','STOCK_AUDIT','OTHER'].includes(row.reason)
    ||typeof row.product_name!=='string'||row.product_name.length>255||typeof row.created_by!=='string'||row.created_by.length>100
    ||typeof row.note!=='string'||row.note.length>255||typeof row.created_at!=='string'
    ||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(row.created_at))throw Error('Invalid stock adjustment event.');
  const delta=quantity(row.adjustment_qty),before=quantity(row.old_qty),after=quantity(row.new_qty);
  if(delta===0n||after<0n||before+delta!==after)throw Error('Stock adjustment quantities do not reconcile.');
  const [products]=await connection.execute('SELECT stock_qty FROM products WHERE barcode=? FOR UPDATE',[row.barcode]);
  if(products.length!==1)throw Error('Stock adjustment product missing or ambiguous.');
  const [batches]=await connection.execute('SELECT id FROM product_batches WHERE barcode=? LIMIT 1 FOR UPDATE',[row.barcode]);
  if(batches.length)throw Error('Batch stock adjustment requires reconciliation.');
  const current=quantity(products[0].stock_qty),next=current+delta;
  if(row.reason==='STOCK_AUDIT'&&current!==before)throw Error('Stock audit conflicts with receiving stock; review required.');
  if(next<0n||next>999999999999n)throw Error('Receiving stock requires reconciliation.');
  // Source record identity is separate from delivery identity: a reissued UUID
  // must not apply the same physical adjustment for a second time.
  await connection.execute('INSERT INTO sync_stock_adjustment_map (shop_id,origin_installation_id,source_adjustment_id,source_json) VALUES (?,?,?,?)',[context.shopId,context.originInstallationId,String(row.id),JSON.stringify(row)]);
  const [result]=await connection.execute('INSERT INTO stock_adjustments (barcode,product_name,old_qty,adjustment_qty,new_qty,reason,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',[row.barcode,row.product_name,format(current),format(delta),format(next),row.reason,row.note,row.created_by,row.created_at]);
  await connection.execute('UPDATE sync_stock_adjustment_map SET target_adjustment_id=? WHERE shop_id=? AND origin_installation_id=? AND source_adjustment_id=?',[result.insertId,context.shopId,context.originInstallationId,String(row.id)]);
  await connection.execute('UPDATE products SET stock_qty=?,updated_at=CURRENT_TIMESTAMP WHERE barcode=?',[format(next),row.barcode]);
}
module.exports={captureStockAdjustment,applyStockAdjustment,quantity,format};
