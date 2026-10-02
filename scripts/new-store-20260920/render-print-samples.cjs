const fs=require('fs'),path=require('path'),Module=require('module');
const root=path.resolve(__dirname,'../..'),src=path.join(root,'frontend/src');
const babel=require(path.join(root,'frontend/node_modules/@babel/core'));
const presets=[path.join(root,'frontend/node_modules/@babel/preset-env'),path.join(root,'frontend/node_modules/@babel/preset-react')];
const original=Module._extensions['.js'];
function load(m,f){if(f.startsWith(src)){m._compile(babel.transformSync(fs.readFileSync(f,'utf8'),{filename:f,presets,babelrc:false,configFile:false}).code,f)}else original(m,f)}
Module._extensions['.jsx']=load;Module._extensions['.js']=load;
const React=require(path.join(root,'frontend/node_modules/react'));
const {renderToStaticMarkup}=require(path.join(root,'frontend/node_modules/react-dom/server'));
const PrintableInvoice=require(path.join(src,'components/PrintableInvoice.jsx')).default;
const css=fs.readFileSync(path.join(src,'styles.css'),'utf8');
const invoice={shop:{shop_name:'QA SAMPLE - NOT A LIVE SALE',address:'Test store only',gst_number:'',phone:'',bank_name:'',bank_account_no:''},invoiceNo:'QA-2026-0001',counterNo:2,counterLabel:'S2/Counter2',date:'20/09/2026',time:'12:00 PM',taxType:'LOCAL',transactionType:'B2C',billingTier:'RETAIL',paymentMode:'Cash',cashReceived:120,changeReturned:20,customerName:'QA TEST',items:[{barcode:'QA0001',product_name:'QA TEST PRODUCT',quantity:1,unitPrice:100,sale_price:100,mrp:100,gst_percent:0,hsn_code:'1001',lineTotal:100}],totals:{sub:100,gst:0,grand:100,saleGrand:100,totalCgst:0,totalSgst:0,totalIgst:0}};
const out=path.join(root,'output/new-store-20260920/qa');
for(const [name,mode,count] of [['a4-short','A4',1],['a4-long','A4',65],['thermal-80','Thermal',1]]){
 const inv={...invoice,items:Array.from({length:count},(_,i)=>({...invoice.items[0],barcode:'QA'+String(i+1).padStart(4,'0')})),totals:{...invoice.totals,sub:100*count,grand:100*count,saleGrand:100*count},cashReceived:100*count,changeReturned:0};
 const html=renderToStaticMarkup(React.createElement(PrintableInvoice,{invoice:inv,mode}));
 if(html.includes('363305001255')||html.includes('Hyper Fresh Mart'))throw Error('Old-store information in sample');
 const cls=mode==='A4'?'printing-a4':'printing-thermal';
 const override=mode==='A4'?'@page{size:A4 portrait;margin:0}html,body{width:210mm!important;margin:0!important;padding:0!important;background:white!important}.print-host-a4{display:block!important;width:190mm!important;margin:0 auto!important;visibility:visible!important}.print-host-a4 *{visibility:visible!important}': '@page{size:80mm 250mm;margin:0}html,body{width:80mm!important;margin:0!important;padding:0!important;background:white!important}.print-host-thermal{display:block!important;visibility:visible!important}.print-host-thermal *{visibility:visible!important}';
 fs.writeFileSync(path.join(out,name+'.html'),'<!doctype html><html class="'+cls+'"><head><meta charset="utf-8"><style>'+css+'\n'+override+'</style></head><body><div class="print-host-'+(mode==='A4'?'a4':'thermal')+'">'+html+'</div></body></html>');
}
console.log('Real invoice components rendered to QA HTML.');
