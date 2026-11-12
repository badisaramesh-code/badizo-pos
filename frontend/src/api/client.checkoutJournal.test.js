jest.mock('axios', () => ({ create: jest.fn(() => ({
  defaults: { baseURL: 'http://localhost:5000/api' }, post: jest.fn(), get: jest.fn(),
  interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } }
})) }));

let client, api;
const payload = { checkout_request_id: 'checkout-journal-123', counter_no: 1, items: [{ barcode: 'A', quantity: 1 }] };
const state = { cart: payload.items, checkoutRequestId: payload.checkout_request_id };
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  const previous = process.env.REACT_APP_CHECKOUT_RECOVERY_ENABLED;
  process.env.REACT_APP_CHECKOUT_RECOVERY_ENABLED = 'true';
  jest.isolateModules(() => {
    client = require('./client');
    const axios = require('axios');
    api = axios.create.mock.results[axios.create.mock.results.length - 1].value;
  });
  if (previous === undefined) delete process.env.REACT_APP_CHECKOUT_RECOVERY_ENABLED;
  else process.env.REACT_APP_CHECKOUT_RECOVERY_ENABLED = previous;
});

test.each(['PRICE_CHANGED', 'INVALID_PAYMENT', 'INVALID_BILL_LINE', 'INVALID_BILL_TOTAL'])('confirmed %s rollback permits correcting the bill', async code => {
  const error = { response: { status: code === 'PRICE_CHANGED' ? 409 : 400, data: { code } } };
  api.post.mockRejectedValueOnce(error).mockResolvedValueOnce({ data: { invoice_no: 'saved' } });
  await expect(client.checkout(payload, state)).rejects.toBe(error);
  expect(client.pendingCheckout(1)).toBeNull();
  await expect(client.checkout({ ...payload, items: [{ barcode: 'A', quantity: 2 }] }, state)).resolves.toEqual({ invoice_no: 'saved' });
});

test('confirmed rejection after timeout retry releases the pending bill', async () => {
  const error = { response: { status: 409, data: { code: 'PRICE_CHANGED' } } };
  api.post.mockRejectedValueOnce({ code: 'ECONNABORTED' }).mockRejectedValueOnce(error);
  await expect(client.checkout(payload, state)).rejects.toBe(error);
  expect(client.pendingCheckout(1)).toBeNull();
});

test('failed journal removal keeps original bill and reports storage failure', async () => {
  api.post.mockRejectedValue({ response: { status: 409, data: { code: 'PRICE_CHANGED' } } });
  const original = Storage.prototype.removeItem;
  const spy = jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(function(key) {
    if (key.startsWith('badizo_checkout_pending_v1:')) throw Error('Storage unavailable');
    return original.call(this, key);
  });
  try {
    await expect(client.checkout(payload, state)).rejects.toMatchObject({ message: 'Storage unavailable', checkoutJournalError: true });
    expect(client.pendingCheckout(1).payload).toEqual(payload);
  } finally { spy.mockRestore(); }
});

test.each([
  { code: 'ECONNABORTED' },
  { response: { status: 409, data: { code: 'CHECKOUT_ALREADY_SAVED' } } },
  { response: { status: 503, data: { code: 'DATABASE_UNAVAILABLE' } } }
])('uncertain outcomes retain the original bill and prevent changed retries', async error => {
  api.post.mockRejectedValue(error);
  await expect(client.checkout(payload, state)).rejects.toBe(error);
  expect(client.pendingCheckout(1).payload).toEqual(payload);
  const calls = api.post.mock.calls.length;
  await expect(client.checkout({ ...payload, items: [] }, state)).rejects.toThrow('unresolved');
  expect(api.post).toHaveBeenCalledTimes(calls);
});

test('Clear Cart retains uncertain journal and releases only server-confirmed outcomes',async()=>{
 api.post.mockRejectedValueOnce(new Error('offline'));await expect(client.checkout(payload,state)).rejects.toThrow('offline');
 api.post.mockRejectedValueOnce(new Error('offline'));await expect(client.abandonPendingCheckout(1)).rejects.toThrow('offline');expect(client.pendingCheckout(1)).not.toBeNull();
 api.post.mockResolvedValueOnce({data:{status:'ABANDONED'}});await expect(client.abandonPendingCheckout(1)).resolves.toEqual({status:'ABANDONED'});expect(client.pendingCheckout(1)).toBeNull();
});

test('server-confirmed abandoned checkout rejection releases recovery journal',async()=>{api.post.mockRejectedValueOnce({response:{status:409,data:{code:'CHECKOUT_ABANDONED'}}});await expect(client.checkout(payload,state)).rejects.toBeDefined();expect(client.pendingCheckout(1)).toBeNull();});

test('parked checkout retries the ORIGINAL ID and does not disturb a different active bill',async()=>{api.post.mockRejectedValueOnce(new Error('offline'));await expect(client.checkout(payload,state)).rejects.toThrow('offline');client.parkPendingCheckout(1);expect(client.pendingCheckout(1)).toBeNull();api.post.mockRejectedValueOnce(new Error('offline'));await expect(client.resolveParkedCheckout(1,payload.checkout_request_id)).rejects.toThrow('offline');expect(client.parkedCheckouts(1)[0].resolution).toBeUndefined();api.post.mockResolvedValueOnce({data:{invoice_no:'ORIGINAL-1'}});const result=await client.resolveParkedCheckout(1,payload.checkout_request_id);expect(result.invoice_no).toBe('ORIGINAL-1');expect(api.post.mock.calls.at(-1)[1].checkout_request_id).toBe(payload.checkout_request_id);expect(client.parkedCheckouts(1)[0].resolution.status).toBe('SAVED');const calls=api.post.mock.calls.length;await client.resolveParkedCheckout(1,payload.checkout_request_id);expect(api.post.mock.calls.length).toBe(calls);});

test('handover sync reports parked IDs from a previous cashier without deleting their record',async()=>{const key='badizo_checkout_pending_v1:previous-cashier:1:parked';const raw=JSON.stringify([{server:'http://localhost:5000/api',payload:{checkout_request_id:'previous-cashier-123',counter_no:1,grand_total:'100.00'},savedState:{cart:[]}}]);localStorage.setItem(key,raw);api.post.mockResolvedValueOnce({data:{success:true}});await client.syncCheckoutReviews(1);expect(api.post).toHaveBeenLastCalledWith('/billing/checkout/reviews',{rows:[{checkout_request_id:'previous-cashier-123',counter_no:1,grand_total:'100.00'}]},{timeout:4000});expect(localStorage.getItem(key)).toBe(raw);});

test('counter recognises an admin-released pending bill without getting stuck',async()=>{api.post.mockRejectedValueOnce(new Error('offline'));await expect(client.checkout(payload,state)).rejects.toThrow('offline');client.parkPendingCheckout(1);api.post.mockRejectedValueOnce({response:{status:409,data:{code:'CHECKOUT_ABANDONED'}}});expect((await client.resolveParkedCheckout(1,payload.checkout_request_id)).status).toBe('ABANDONED');expect(client.parkedCheckouts(1)[0].resolution.status).toBe('ABANDONED');});
