import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import BillingTerminalView from './BillingTerminalView';
import PrintableInvoice from './PrintableInvoice';
import * as api from '../api/client';

jest.mock('../api/client', () => ({ ...jest.createMockFromModule('../api/client'), checkoutRecoveryEnabled: true }));
jest.mock('./PrintableInvoice', () => jest.fn(() => null));
jest.mock('./PrintableQuotation', () => () => null);
jest.mock('../utils/saleReportPdf', () => ({ saveSaleReportPdf: jest.fn() }));
jest.mock('../utils/browserReceiptPrinter', () => ({ connectBrowserPrinter: jest.fn(), printOnLocalReceiptPrinter: jest.fn() }));

let container, root;
const conflict = { response: { status: 409, data: { code: 'PRICE_CHANGED', error: 'Rate updated' } } };
const completeButton = () => [...container.querySelectorAll('button')].find(el => el.textContent === 'Complete Sale');

async function mount({ paymentMode = 'Cash', received = '200' } = {}) {
  localStorage.setItem('badizo_pos_active_draft', JSON.stringify({
    username: 'counter1', counterNo: 1, systemNo: 1, invoiceNo: 'UNSAVED', billingMode: 'RETAIL_LOCAL',
    cart: [{ barcode: 'COLGATE', product_name: 'Colgate', sale_price: 100, mrp: 150, quantity: 1, gst_percent: 18 }],
    paymentMode, paymentConfirmed: true, customerPhone: 'NO',
    checkoutRequestId: 'old-request-123456', cashReceived: received
  }));
  await act(async () => root.render(<BillingTerminalView isActive />));
}

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  localStorage.clear();
  for (const value of Object.values(api)) if (jest.isMockFunction(value)) value.mockReset().mockResolvedValue([]);
  api.getStoredUser.mockReturnValue({ username: 'counter1', role: 'COUNTER', counter_no: 1, system_no: 1 });
  api.pendingCheckout.mockReturnValue(null);
  api.fetchSettings.mockResolvedValue({ loyalty_enabled: false });
  api.fetchNextInvoice.mockResolvedValue({ invoice_no: 'NEXT' });
  api.fetchInvoiceDetails.mockRejectedValue({ response: { status: 404 } });
  api.pingBackendHealth.mockResolvedValue(true);
  PrintableInvoice.mockClear();
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
  jest.useRealTimers();
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

test.each([70, 120])('server rate change to %s automatically retries cash and prints the new rate', async price => {
  api.checkout.mockRejectedValueOnce(conflict).mockResolvedValueOnce({ invoice_no: 'SAVED', free_items: [] });
  api.lookupExactProduct.mockResolvedValue({ barcode: 'COLGATE', sale_price: price, mrp: 150 });
  await mount();
  await act(async () => Simulate.click(completeButton()));
  expect(api.checkout).toHaveBeenCalledTimes(2);
  const [oldPayload] = api.checkout.mock.calls[0];
  const [newPayload] = api.checkout.mock.calls[1];
  expect(newPayload.grand_total).toBe(price.toFixed(2));
  expect(newPayload.items[0].sale_price).toBe(price);
  expect(newPayload.checkout_request_id).not.toBe(oldPayload.checkout_request_id);
  expect(newPayload.change_returned).toBe((200 - price).toFixed(2));
  const invoice = PrintableInvoice.mock.calls.map(([props]) => props.invoice).find(value => value.invoiceNo === 'SAVED');
  expect(invoice.items[0].unitPrice).toBe(price);
  expect(invoice.totals.grand).toBe(price);
  expect(invoice.changeReturned).toBe(200 - price);
});

test('increased rate with insufficient cash updates the cart and asks for the balance without another POST', async () => {
  api.checkout.mockRejectedValueOnce(conflict);
  api.lookupExactProduct.mockResolvedValue({ barcode: 'COLGATE', sale_price: 120, mrp: 150 });
  await mount({ received: '100' });
  await act(async () => Simulate.click(completeButton()));
  expect(api.checkout).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Cash received must be equal to or greater than the bill total.');
  expect(container.textContent).toContain('120.00');
  expect(api.pendingCheckout()).toBeNull();
});

test('UPI rate changes update the bill and require confirmation of the revised payment', async () => {
  api.checkout.mockRejectedValueOnce(conflict);
  api.lookupExactProduct.mockResolvedValue({ barcode: 'COLGATE', sale_price: 70, mrp: 150 });
  await mount({ paymentMode: 'UPI' });
  await act(async () => Simulate.click(completeButton()));
  expect(api.checkout).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Rates updated from the server. Check the revised total');
  const confirmation = [...container.querySelectorAll('input[type="checkbox"]')].find(el => el.parentElement.textContent.includes('Payment received on UPI'));
  expect(confirmation.checked).toBe(false);
  expect(container.textContent).toContain('70.00');
});

test('an uncertain checkout does not fetch new prices or change its request identity', async () => {
  api.checkout.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout' });
  await mount();
  await act(async () => Simulate.click(completeButton()));
  expect(api.checkout).toHaveBeenCalledTimes(1);
  expect(api.lookupExactProduct).not.toHaveBeenCalled();
  expect(api.checkout.mock.calls[0][0].checkout_request_id).toBe('old-request-123456');
  expect(container.textContent).toContain('timeout');
});

test('failed price refresh retains the cart and re-enables Complete Sale', async () => {
  api.checkout.mockRejectedValueOnce(conflict);
  api.lookupExactProduct.mockRejectedValueOnce(new Error('Rate service unavailable'));
  await mount();
  await act(async () => Simulate.click(completeButton()));
  expect(api.checkout).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('Rate service unavailable');
  expect(container.textContent).toContain('Colgate');
  expect(completeButton().disabled).toBe(false);
});

test('cashier edits made during a rate lookup are not overwritten or submitted automatically', async () => {
  let finishLookup;
  api.checkout.mockRejectedValueOnce(conflict);
  api.lookupExactProduct.mockImplementationOnce(() => new Promise(resolve => { finishLookup = resolve; }));
  await mount();
  await act(async () => Simulate.click(completeButton()));
  const quantity = container.querySelector('tbody tr td:nth-child(7) input');
  await act(async () => Simulate.change(quantity, { target: { value: '2' } }));
  await act(async () => finishLookup({ barcode: 'COLGATE', sale_price: 70, mrp: 150 }));
  expect(api.checkout).toHaveBeenCalledTimes(1);
  expect(quantity.value).toBe('2');
  expect(container.textContent).toContain('The bill changed while rates were checked');
});

test('continuously changing prices stop after two automatic retries and keep the updated bill usable', async () => {
  api.checkout.mockRejectedValue(conflict);
  api.lookupExactProduct.mockResolvedValue({ barcode: 'COLGATE', sale_price: 90, mrp: 150 });
  await mount();
  await act(async () => Simulate.click(completeButton()));
  expect(api.checkout).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain('Rates updated again. Review the revised total');
  expect(completeButton().disabled).toBe(false);
});

test.each(['DRAFT','ABANDONED','SAVED'])('Clear Cart releases a confirmed %s cart without creating a sale',async status=>{api.abandonPendingCheckout.mockResolvedValue({status,invoice_no:'SAVED-123'});await mount();await act(async()=>Simulate.click([...container.querySelectorAll('button')].find(b=>b.textContent==='Clear Cart')));expect(api.abandonPendingCheckout).toHaveBeenCalledWith(1);expect(api.checkout).not.toHaveBeenCalled();expect(container.querySelector('tbody tr td:nth-child(7) input')).toBeNull();expect(container.textContent).toContain(status==='SAVED'?'already saved as SAVED-123':'Cart cleared.');});
test('Clear Cart retains the cart if the server cannot resolve the pending bill',async()=>{api.abandonPendingCheckout.mockRejectedValue(new Error('Server unavailable'));await mount();await act(async()=>Simulate.click([...container.querySelectorAll('button')].find(b=>b.textContent==='Clear Cart')));expect(container.querySelector('tbody tr td:nth-child(7) input')).not.toBeNull();expect(container.textContent).toContain('Server unavailable');expect(api.checkout).not.toHaveBeenCalled();});

test('Continue with Next Customer parks an unresolved bill before opening a fresh cart',async()=>{api.parkPendingCheckout.mockReturnValue({payload:{checkout_request_id:'OLD-123'}});api.parkedCheckouts.mockReturnValue([{server:'S',payload:{checkout_request_id:'OLD-123',grand_total:'100'},savedState:{customerName:'Customer A'}}]);await mount();await act(async()=>Simulate.click([...container.querySelectorAll('button')].find(b=>b.textContent==='Continue with Next Customer')));expect(api.parkPendingCheckout).toHaveBeenCalledWith(1);expect(api.checkout).not.toHaveBeenCalled();expect(container.querySelector('tbody tr td:nth-child(7) input')).toBeNull();expect(container.textContent).toContain('Pending Bills: 1');expect(container.textContent).toContain('Finish / Recover Original');});

test('recovering Customer A preserves the current Customer B cart',async()=>{api.parkedCheckouts.mockReturnValue([{server:'S',payload:{checkout_request_id:'CUSTOMER-A-123',grand_total:'100'},savedState:{customerName:'Customer A'}}]);api.resolveParkedCheckout.mockResolvedValue({status:'SAVED',invoice_no:'INVOICE-A'});await mount();await act(async()=>Simulate.click([...container.querySelectorAll('button')].find(b=>b.textContent==='Finish / Recover Original')));expect(api.resolveParkedCheckout).toHaveBeenCalledWith(1,'CUSTOMER-A-123',{cancelUnsaved:false});expect(container.querySelector('tbody tr td:nth-child(7) input')).not.toBeNull();expect(api.checkout).not.toHaveBeenCalled();expect(container.textContent).toContain('Reprint INVOICE-A');});
