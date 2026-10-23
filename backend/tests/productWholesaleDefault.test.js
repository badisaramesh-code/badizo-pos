const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let queries = [];
require.cache[require.resolve('../config/db')] = {
  exports: { query: async (sql, params) => { queries.push({ sql, params }); return /SELECT/i.test(sql.trim().split(/\s/)[0]) ? [[]] : [{ affectedRows: 1 }]; } }
};
require.cache[require.resolve('../services/auditService')] = { exports: { writeAuditLog: async () => {} } };
const router = require('../routes/products');
const save = router.stack.find((layer) => layer.route?.path === '/save').route.stack.at(-1).handle;

for (const wholesale of [undefined, null, '', '  ', '2750.00', '0']) {
  test(`product save uses retail only for an omitted wholesale price (${JSON.stringify(wholesale)})`, async () => {
    queries = [];
    const body = { barcode:'TEST-WHOLESALE', product_code:'TEST-WHOLESALE', product_name:'TEST PRODUCT', hsn_code:'08021200', gst_percent:5, unit_type:'Kg', purchase_unit_type:'LOOSE', purchase_unit_size:1, mrp:3000, purchase_price:2500, sale_price:'2900.00', stock_qty:0, min_stock_alert:10, wholesale_price:wholesale };
    const response = { statusCode:200, status(code) { this.statusCode=code; return this; }, json(data) { this.body=data; return this; } };
    await save({ body, user:{username:'server'} }, response);
    assert.equal(response.statusCode,200,JSON.stringify(response.body));
    const write = queries.find((query) => /INSERT INTO products/.test(query.sql));
    assert.ok(write);
    assert.equal(write.params[12],2900);
    assert.equal(write.params[13],String(wholesale ?? '').trim() === '' ? 2900 : Number(wholesale));
  });
}

test('product form defaults blank wholesale to current retail and retains an explicit wholesale price', () => {
  const component = fs.readFileSync(path.join(__dirname,'../../frontend/src/components/InventoryDashboardView.jsx'),'utf8');
  const source = component.slice(component.indexOf('  function normalizedProductForm('),component.indexOf('  function validateProductForm('));
  const context = { dateInputValue: value=>value, joinPackMeasure:()=>'' };
  vm.runInNewContext(source,context);
  assert.equal(context.normalizedProductForm({sale_price:'2900.00',wholesale_price:''}).wholesale_price,'2900.00');
  assert.equal(context.normalizedProductForm({sale_price:'2950.00',wholesale_price:'  '}).wholesale_price,'2950.00');
  assert.equal(context.normalizedProductForm({sale_price:'2900.00',wholesale_price:'2750.00'}).wholesale_price,'2750.00');
});

test('editing a product replaces its old wholesale default, follows retail, and honours a fresh manual override', () => {
  const component = fs.readFileSync(path.join(__dirname,'../../frontend/src/components/InventoryDashboardView.jsx'),'utf8');
  let form;
  const context = {
    setForm: value => { form = typeof value === 'function' ? value(form) : value; },
    productStockUnit: ()=>'Gm', productPackMeasure: ()=>'', splitPackMeasure: ()=>({quantity:'',unit:''}),
    dateInputValue:value=>value, setActiveProductSection(){}, PRODUCT_SECTIONS:{FORM:'FORM'}, focusBarcodeField(){}, window:{scrollTo(){}},
    calculateDiscountFromPrice:(mrp,price,type)=>type==='PERCENT'?(Number(mrp)-Number(price))/Number(mrp)*100:Number(mrp)-Number(price),
    calculatePriceFromDiscount:(mrp,discount,type)=>type==='PERCENT'?Number(mrp)*(1-Number(discount)/100):Number(mrp)-Number(discount)
  };
  const edit = component.slice(component.indexOf('  function editProduct('),component.indexOf('  async function handleSubmit('));
  const update = component.slice(component.indexOf('  function updateField('),component.indexOf('  function formatProductAmounts('));
  vm.runInNewContext(edit + update,context);
  const product={barcode:'89100277',sale_price:150,wholesale_price:140,mrp:150,discount_type:'VALUE'};
  context.editProduct(product);
  assert.equal(form.wholesale_price,'150');
  assert.equal(form.wholesale_price_overridden,false);
  context.updateField('sale_price','160');
  assert.equal(form.wholesale_price,'160');
  context.updateField('wholesale_price','145');
  context.updateField('sale_price','170');
  assert.equal(form.wholesale_price,'145');
  assert.equal(form.wholesale_price_overridden,true);
  context.updateField('wholesale_price','');
  assert.equal(form.wholesale_price,'170');
  context.updateField('discount_value','10');
  assert.equal(form.sale_price,140);
  assert.equal(form.wholesale_price,140);
  context.editProduct(product);
  assert.equal(form.wholesale_price,'150');
  assert.equal(form.wholesale_price_overridden,false);
});
