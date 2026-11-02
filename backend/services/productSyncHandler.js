const permitted=new Set(['product_name','sale_price']);
function normalize(field,value){
  if(field==='product_name'){
    if(typeof value!=='string' || !value.trim() || value.length>255)throw Error('Invalid product name.');
    return value;
  }
  if(field==='sale_price'){
    const input=String(value);
    if(!/^\d{1,8}(\.\d{1,2})?$/.test(input))throw Error('Invalid product price.');
    const [whole,fraction='']=input.split('.');
    return String(Number(whole))+'.'+fraction.padEnd(2,'0');
  }
  throw Error('Product field is not eligible for automatic update.');
}
// An allowlisted receiver handler. Its connection belongs to the receiver's
// transaction, so both updates and sync receipt commit/roll back together.
// Barcode is the explicit product identity; numeric IDs are never copied.
async function applyProductFields(connection,payload){
  if(!payload || Object.keys(payload).some(key=>!['barcode','changes'].includes(key))
    || typeof payload.barcode!=='string' || !payload.barcode || payload.barcode.length>120
    || !Array.isArray(payload.changes) || !payload.changes.length || payload.changes.length>2)throw Error('Invalid product change.');
  const seen=new Set();
  const changes=payload.changes.map(change=>{
    if(!change || Object.keys(change).some(key=>!['field','before','after'].includes(key)) || !permitted.has(change.field) || seen.has(change.field))throw Error('Invalid or duplicate product field.');
    seen.add(change.field);
    return {field:change.field,before:normalize(change.field,change.before),after:normalize(change.field,change.after)};
  });
  const [rows]=await connection.execute('SELECT product_name,sale_price FROM products WHERE barcode=? FOR UPDATE',[payload.barcode]);
  if(rows.length!==1)throw Error('Product identity is missing or ambiguous.');
  for(const change of changes)if(normalize(change.field,rows[0][change.field])!==change.before)throw Error('Product changed since review; resolve the new conflict.');
  const assignments=changes.map(change=>'`'+change.field+'`=?').join(',');
  await connection.execute('UPDATE products SET '+assignments+' WHERE barcode=?',[...changes.map(change=>change.after),payload.barcode]);
}
module.exports={applyProductFields,normalize};
