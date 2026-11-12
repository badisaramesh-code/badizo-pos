import {createCheckoutJournal} from './checkoutJournal';
function fixture(){const map=new Map();return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};}
const request={server:'https://local/api',payload:{checkout_request_id:'request-123456',counter_no:1,items:[{barcode:'A',quantity:1}],grand_total:'10.00'},savedState:{cart:[{barcode:'A',quantity:1}],checkoutRequestId:'request-123456'}};
test('an unresolved bill survives browser component reload and retries identically',()=>{
  const storage=fixture();createCheckoutJournal(storage,'counter').prepare(request);
  const restarted=createCheckoutJournal(storage,'counter');expect(restarted.read().payload).toEqual(request.payload);expect(restarted.prepare(request).payload).toEqual(request.payload);
  restarted.clear(request.server,request.payload.checkout_request_id);expect(restarted.read()).toBeNull();
});
test('changing server, request identity or bill details never replaces an unresolved bill',()=>{
  const journal=createCheckoutJournal(fixture(),'counter');journal.prepare(request);
  for(const next of [{...request,server:'https://cloud/api'},{...request,payload:{...request.payload,checkout_request_id:'different-request'}},{...request,payload:{...request.payload,items:[{barcode:'B',quantity:1}]}}])expect(()=>journal.prepare(next)).toThrow();
  expect(()=>journal.clear(request.server,'different-request')).toThrow();expect(journal.read().payload).toEqual(request.payload);
});
test('storage failure is raised before a request may be sent',()=>{
  const storage=fixture();storage.setItem=()=>{throw Error('disk full')};expect(()=>createCheckoutJournal(storage,'counter').prepare(request)).toThrow('disk full');
});

test('parking preserves original request and allows a different active checkout',()=>{const memory=new Map();const storage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};const journal=createCheckoutJournal(storage,'test-park');const a={server:'server-A',payload:{checkout_request_id:'customer-a-123'},savedState:{cart:['A']}};journal.prepare(a);journal.park();expect(journal.read()).toBeNull();expect(journal.parked()[0].payload.checkout_request_id).toBe('customer-a-123');journal.prepare({...a,payload:{checkout_request_id:'customer-b-123'},savedState:{cart:['B']}});expect(journal.read().payload.checkout_request_id).toBe('customer-b-123');journal.resolveParked('server-A','customer-a-123',{status:'SAVED',invoice_no:'INV-A'});expect(journal.parked()[0].resolution.invoice_no).toBe('INV-A');expect(journal.read().payload.checkout_request_id).toBe('customer-b-123');});
test('parking failure never discards the active recovery record',()=>{const memory=new Map();const storage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>{if(k.endsWith(':parked'))throw Error('Storage full');memory.set(k,v)},removeItem:k=>memory.delete(k)};const j=createCheckoutJournal(storage,'test-full');j.prepare({server:'S',payload:{checkout_request_id:'customer-a-123'},savedState:{cart:['A']}});expect(()=>j.park()).toThrow('Storage full');expect(j.read().payload.checkout_request_id).toBe('customer-a-123');});
