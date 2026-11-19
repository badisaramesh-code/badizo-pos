'use strict';
const fields = ['product_code','product_name','unit_type','mrp','sale_price','gst_percent','hsn_code','purchase_price','stock_qty','wholesale_price'];
const aliases = { 'product code':'product_code','product name':'product_name',unit:'unit_type',mrp:'mrp','sale price':'sale_price','gst %':'gst_percent',gst:'gst_percent','hsn code':'hsn_code','purchase price':'purchase_price',stock:'stock_qty','wholesale price':'wholesale_price' };
function csvRows(text) {
  const rows=[]; let row=[],value='',quoted=false,closed=false;
  text=String(text).replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) { if(c==='"') {if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c; continue; }
    if(c==='"'&&!value&&!closed) quoted=true;
    else if(c===','||c==='\n'||c==='\r') {
      row.push(value);value='';closed=false;
      if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(x=>x.trim()))rows.push(row);row=[];}
    } else {if(closed)throw new Error('Unexpected text after a quoted CSV cell.');value+=c;}
  }
  if(quoted)throw new Error('CSV has an unclosed quote.');
  row.push(value);if(row.some(x=>x.trim()))rows.push(row);return rows;
}
function clean(input) {
  const out={};
  for(const k of fields) {
    const raw=input[k];
    if(['mrp','sale_price','gst_percent','purchase_price','stock_qty','wholesale_price'].includes(k)) {
      if(raw===null||raw===undefined||String(raw).trim()==='')out[k]=null;
      else {if(!/^\d+(\.\d{1,2})?$/.test(String(raw).trim()))throw new Error(`${k}: enter a non-negative number with up to 2 decimals.`);out[k]=Number(raw);if(!Number.isFinite(out[k])||out[k]>99999999.99)throw new Error(`${k} is too large.`);}
    }else out[k]=String(raw??'').trim();
  }
  if(!out.product_code||out.product_code.length>60)throw new Error('Product Code must contain 1–60 characters.');
  if(!out.product_name||out.product_name.length>255)throw new Error('Product Name must contain 1–255 characters.');
  if(out.unit_type.length>30)throw new Error('Unit is too long.');
  if(out.hsn_code.length>20)throw new Error('HSN is too long.');
  if(!(out.mrp>0)||!(out.sale_price>0)||out.sale_price>out.mrp)throw new Error('MRP and Sale Price must be positive, with Sale Price no higher than MRP.');
  if(out.gst_percent!==null&&out.gst_percent>100)throw new Error('GST must be between 0 and 100.');
  return out;
}
function parseImport(text) {
  const rows=csvRows(text);if(rows.length<2||rows.length>30001)throw new Error('CSV must contain 1–30,000 product rows.');
  const headers=rows.shift().map(h=>aliases[h.trim().toLowerCase()]||h.trim().toLowerCase());
  for(const h of ['product_code','product_name','unit_type','mrp','sale_price'])if(!headers.includes(h))throw new Error(`Missing column: ${h}`);
  if(new Set(headers).size!==headers.length)throw new Error('Duplicate CSV column headers.');
  const seen=new Set();
  return rows.map((r,i)=>{try{
    if(r.length!==headers.length)throw new Error('Column count does not match header.');
    const p=clean(Object.fromEntries(headers.map((h,j)=>[h,r[j]])));
    const key=p.product_code.toLowerCase();if(seen.has(key))throw new Error(`Duplicate Product Code ${p.product_code}`);seen.add(key);return p;
  }catch(e){throw new Error(`Row ${i+2}: ${e.message}`);}});
}
function missing(p) {return [p.gst_percent===null?'GST':null,!p.hsn_code?'HSN':null,!p.unit_type?'Unit':null].filter(Boolean);}
function selectedIds(ids) {if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(x=>!Number.isSafeInteger(x)||x<1)||new Set(ids).size!==ids.length)throw new Error('Select 1–500 distinct rows.');return [...ids].sort((a,b)=>a-b);}
module.exports={fields,clean,parseImport,missing,selectedIds};
