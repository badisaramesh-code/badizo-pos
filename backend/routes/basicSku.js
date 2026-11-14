'use strict';
const express=require('express');
const path=require('path');
const db=require('../config/db');
const {authenticate,authorize}=require('../middleware/auth');
const {writeAuditLog}=require('../services/auditService');
const {fields,clean,parseImport,missing,selectedIds}=require('../utils/basicSku');
const {beginProductCapture,finishProductCapture}=require('../services/productMasterSync');
const router=express.Router();
router.get('/page',(_req,res)=>res.sendFile(path.join(__dirname,'../public/basic-skus.html')));
router.get('/page.js',(_req,res)=>res.sendFile(path.join(__dirname,'../public/basic-skus.js')));
router.use(authenticate,authorize('SERVER','ADMIN'));
const decode=r=>({...r,...(typeof r.details==='string'?JSON.parse(r.details):r.details)});
function failure(res,e){return res.status(e.code==='ER_DUP_ENTRY'?409:400).json({error:e.code==='ER_DUP_ENTRY'?'A Product Code or barcode already exists. No rows in this operation were saved.':e.message});}
async function transaction(action){const c=await db.getConnection();try{await c.beginTransaction();const result=await action(c);await c.commit();return result;}catch(e){await c.rollback();throw e;}finally{c.release();}}
router.get('/',async(req,res)=>{try{
  const offset=Math.max(0,Math.min(1000000,parseInt(req.query.offset,10)||0));
  const search=String(req.query.search||'').slice(0,255);
  const status=req.query.status==='PUBLISHED'?'PUBLISHED':'DRAFT';
  const where='status = ? AND (LOCATE(?, product_code) > 0 OR LOCATE(?, product_name) > 0)';
  const args=[status,search,search];
  const [count]=await db.query(`SELECT COUNT(*) total FROM basic_sku_drafts WHERE ${where}`,args);
  const [rows]=await db.query(`SELECT * FROM basic_sku_drafts WHERE ${where} ORDER BY id LIMIT 100 OFFSET ?`,[...args,offset]);
  res.json({total:count[0].total,rows:rows.map(r=>{const p=decode(r);return {...p,details:undefined,missing:missing(p)};})});
}catch(e){failure(res,e);}});
router.post('/import',async(req,res)=>{try{
  const products=parseImport(req.body.csv);
  await transaction(async c=>{
    for(let i=0;i<products.length;i+=300){const batch=products.slice(i,i+300),codes=batch.map(p=>p.product_code),q=codes.map(()=>'?').join(',');
      const [existing]=await c.query(`SELECT product_code,barcode FROM products WHERE product_code IN (${q}) OR barcode IN (${q}) LIMIT 1`,[...codes,...codes]);
      if(existing.length)throw new Error(`Product already exists: ${existing[0].product_code||existing[0].barcode}. Draft import only adds new codes.`);
      await c.query('INSERT INTO basic_sku_drafts (product_code,product_name,details,created_by) VALUES ?',[batch.map(p=>[p.product_code,p.product_name,JSON.stringify(p),req.user.username])]);
    }
    await writeAuditLog({user:req.user,action:'BASIC_SKU_DRAFT_IMPORT',entityType:'PRODUCT_DRAFT',details:{rows:products.length},connection:c});
  });res.json({inserted:products.length});
}catch(e){failure(res,e);}});
router.post('/update',async(req,res)=>{try{
  const ids=selectedIds(req.body.ids),patch=req.body.patch;
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length)throw new Error('Choose fields to update.');
  if(Object.keys(patch).some(k=>!fields.includes(k)||k==='product_code'))throw new Error('Product Code cannot be changed here.');
  const updated=await transaction(async c=>{
    const [rows]=await c.query(`SELECT * FROM basic_sku_drafts WHERE id IN (${ids.map(()=>'?')}) ORDER BY id FOR UPDATE`,ids);
    if(rows.length!==ids.length||rows.some(r=>r.status!=='DRAFT'))throw new Error('Some selected rows are missing or already published. Refresh the page.');
    for(const row of rows){const p=clean({...decode(row),...patch});await c.query('UPDATE basic_sku_drafts SET product_name=?,details=? WHERE id=?',[p.product_name,JSON.stringify(p),row.id]);}
    await writeAuditLog({user:req.user,action:'BASIC_SKU_DRAFT_UPDATE',entityType:'PRODUCT_DRAFT',details:{ids,fields:Object.keys(patch)},connection:c});return rows.length;
  });res.json({updated});
}catch(e){failure(res,e);}});
router.post('/publish',async(req,res)=>{try{
  const ids=selectedIds(req.body.ids);
  const published=await transaction(async c=>{
    const [rows]=await c.query(`SELECT * FROM basic_sku_drafts WHERE id IN (${ids.map(()=>'?')}) ORDER BY id FOR UPDATE`,ids);
    if(rows.length!==ids.length||rows.some(r=>r.status!=='DRAFT'))throw new Error('Some selected rows are missing or already published. Refresh the page.');
    for(const row of rows){const p=clean(decode(row)),needed=missing(p);if(needed.length)throw new Error(`${p.product_code}: fill ${needed.join(', ')} before publishing.`);
      const capture=await beginProductCapture(c,'barcode=?',[p.product_code]);
      await c.query(`INSERT INTO products (product_code,barcode,product_name,unit_type,mrp,sale_price,gst_percent,sales_sgst_percent,sales_cgst_percent,sales_igst_percent,hsn_code,purchase_price,stock_qty,wholesale_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[p.product_code,p.product_code,p.product_name,p.unit_type,p.mrp,p.sale_price,p.gst_percent,p.gst_percent/2,p.gst_percent/2,p.gst_percent,p.hsn_code,p.purchase_price??0,p.stock_qty??0,p.wholesale_price??p.sale_price]);
      await finishProductCapture(c,capture);
      await c.query("UPDATE basic_sku_drafts SET status='PUBLISHED' WHERE id=?",[row.id]);
    }
    await writeAuditLog({user:req.user,action:'BASIC_SKU_PUBLISHED',entityType:'PRODUCT',details:{ids,count:rows.length},connection:c});return rows.length;
  });res.json({published});
}catch(e){failure(res,e);}});
module.exports=router;
