import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import OrdersView from './OrdersView';
import { fetchUpcomingSpecialOrders, fetchSpecialOrders, fetchSpecialOrderReceivables, lookupExactProduct, saveSpecialOrder, fetchSettings, fetchSpecialOrderDetails } from '../api/client';

jest.mock('../api/client', () => ({
  fetchUpcomingSpecialOrders: jest.fn(), fetchSpecialOrders: jest.fn(),
  fetchSpecialOrderReceivables: jest.fn(), lookupExactProduct: jest.fn(), saveSpecialOrder: jest.fn(),
  fetchSettings: jest.fn(), fetchSpecialOrderDetails: jest.fn()
}));

let container, root;
const barcodeInput = () => container.querySelector('[aria-label="Item 1 barcode"]');
const cellInput = column => container.querySelector(`tbody tr td:nth-child(${column}) input`);
async function scan(value) {
  await act(async () => Simulate.change(barcodeInput(), { target: { value } }));
  await act(async () => {
    Simulate.keyDown(barcodeInput(), { key: 'Enter', preventDefault: jest.fn() });
    jest.runOnlyPendingTimers();
  });
}
beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  jest.clearAllMocks();
  fetchUpcomingSpecialOrders.mockResolvedValue([]);
  fetchSpecialOrders.mockResolvedValue([]);
  fetchSpecialOrderReceivables.mockResolvedValue({ rows: [], summary: {} });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<OrdersView />));
  await act(async () => Simulate.click([...container.querySelectorAll('button')].find(el => el.textContent === 'New Order')));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  jest.useRealTimers(); delete global.IS_REACT_ACT_ENVIRONMENT;
  delete window.badizoDesktop;
});

test('barcode lookup fills name, sales rate and unit while preserving quantity and updating total', async () => {
  lookupExactProduct.mockResolvedValue({ product_name: 'TEST PRODUCT', unit_type: 'Kg', sale_price: 25, mrp: 30 });
  await act(async () => Simulate.change(cellInput(3), { target: { value: '20' } }));
  await act(async () => Simulate.change(barcodeInput(), { target: { value: 'TEST123' } }));
  await act(async () => jest.advanceTimersByTime(300));
  expect(lookupExactProduct).toHaveBeenCalledWith('TEST123');
  expect(cellInput(1).value).toBe('TEST PRODUCT');
  expect(cellInput(3).value).toBe('20');
  expect(cellInput(4).value).toBe('Kg');
  expect(cellInput(5).value).toBe('25');
  expect(container.textContent).toContain('500.00');
  expect(saveSpecialOrder).not.toHaveBeenCalled();
});

test('scanner Enter looks up product without saving and ignores an older response', async () => {
  let resolveOld;
  lookupExactProduct.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ product_name: 'NEW PRODUCT', unit_type: 'Nos', sale_price: 40 });
  await scan('OLD');
  await scan('NEW');
  await act(async () => resolveOld({ product_name: 'OLD PRODUCT', sale_price: 10 }));
  expect(cellInput(1).value).toBe('NEW PRODUCT');
  expect(cellInput(5).value).toBe('40');
  expect(saveSpecialOrder).not.toHaveBeenCalled();
});

test('unknown barcode keeps manual item entry available with a clear message', async () => {
  lookupExactProduct.mockResolvedValue(null);
  await scan('UNKNOWN');
  expect(container.textContent).toContain('Product not found for barcode UNKNOWN');
  await act(async () => Simulate.change(cellInput(5), { target: { value: '12' } }));
  expect(cellInput(5).value).toBe('12');
});

test('Del clears the last product and recalculates total', async () => {
  lookupExactProduct.mockResolvedValue({ product_name: 'REMOVE ME', sale_price: 69 });
  await scan('DELETE-TEST');
  await act(async () => Simulate.click([...container.querySelectorAll('button')].find(el => el.textContent === 'Del')));
  expect(cellInput(1).value).toBe('');
  expect(cellInput(5).value).toBe('');
  expect(barcodeInput().value).toBe('');
  expect(container.querySelector('.summary-band').textContent).toContain('0.00');
});

test('saving automatically exports the saved order as an estimate PDF, with print and re-save actions', async () => {
  lookupExactProduct.mockResolvedValue({ product_name: 'SAVED PRODUCT', sale_price: 69 });
  fetchSettings.mockResolvedValue({ shop_name: 'TEST SHOP', address: 'Test Address' });
  saveSpecialOrder.mockResolvedValue({ order_no: 'SO-TEST', total_amount: 69, paid_amount: 0, balance_due: 69 });
  window.badizoDesktop = { saveA4PdfHtml: jest.fn().mockResolvedValue({ ok: true, filePath: 'test.pdf' }) };
  await scan('SAVE-TEST');
  await act(async () => Simulate.submit(container.querySelector('form')));
  expect(window.badizoDesktop.saveA4PdfHtml).toHaveBeenCalledWith(expect.objectContaining({
    filename: 'BADIZO-SO-TEST-ORDER-ESTIMATE', html: expect.stringContaining('SAVED PRODUCT')
  }));
  const html = window.badizoDesktop.saveA4PdfHtml.mock.calls[0][0].html;
  expect(html).toContain('ORDER ESTIMATE');
  expect(html).toContain('TEST SHOP');
  expect(html).toContain('69.00');
  expect(container.textContent).toContain('Save PDF');
  expect(container.textContent).toContain('Print Estimate');
  expect(container.textContent).toContain('Ready to print or share on WhatsApp');
  const printWindow = { document: { write: jest.fn(), close: jest.fn(), readyState: 'complete' }, focus: jest.fn(), print: jest.fn(), close: jest.fn() };
  const openSpy = jest.spyOn(window, 'open').mockReturnValue(printWindow);
  try {
    await act(async () => Simulate.click([...container.querySelectorAll('button')].find(el => el.textContent === 'Print Estimate')));
    expect(printWindow.document.write).toHaveBeenCalledWith(expect.stringContaining('SO-TEST'));
    expect(printWindow.print).toHaveBeenCalled();
  } finally { openSpy.mockRestore(); }
});

test('PDF failure preserves the saved order and allows PDF retry', async () => {
  lookupExactProduct.mockResolvedValue({ product_name: 'SAVED PRODUCT', sale_price: 69 });
  fetchSettings.mockResolvedValue({ shop_name: 'TEST SHOP' });
  saveSpecialOrder.mockResolvedValue({ order_no: 'SO-RETRY', total_amount: 69, paid_amount: 0, balance_due: 69 });
  window.badizoDesktop = { saveA4PdfHtml: jest.fn().mockRejectedValueOnce(new Error('Printer unavailable')).mockResolvedValueOnce({ ok: true }) };
  await scan('RETRY-TEST');
  await act(async () => Simulate.submit(container.querySelector('form')));
  expect(container.textContent).toContain('Order remains saved. Printer unavailable');
  await act(async () => Simulate.click([...container.querySelectorAll('button')].find(el => el.textContent === 'Save PDF')));
  expect(saveSpecialOrder).toHaveBeenCalledTimes(1);
  expect(window.badizoDesktop.saveA4PdfHtml).toHaveBeenCalledTimes(2);
});

test('deleting one product from a saved order updates the total and persists only remaining products', async () => {
  // Open through the list to exercise saved-order editing rather than a new form.
  const details = { order: { order_no: 'SO-EDIT', total_amount: 100, paid_amount: 10, balance_due: 90 },
    items: [{ item_name: 'FIRST', quantity: 1, estimated_rate: 40 }, { item_name: 'SECOND', quantity: 1, estimated_rate: 60 }] };
  fetchSpecialOrderDetails.mockResolvedValue(details);
  fetchSpecialOrders.mockResolvedValue([details.order]);
  await act(async () => Simulate.click([...container.querySelectorAll('button')].find(el => el.textContent === 'All Orders')));
  await act(async () => Simulate.submit(container.querySelector('form')));
  await act(async () => Simulate.click([...container.querySelectorAll('button')].find(el => el.textContent === 'Open')));
  await act(async () => Simulate.click([...container.querySelectorAll('button')].find(el => el.textContent === 'Del')));
  expect(container.querySelector('.summary-band').textContent).toContain('60.00');
  expect(container.querySelector('.summary-band').textContent).toContain('50.00');
  saveSpecialOrder.mockResolvedValue({ order_no: 'SO-EDIT', total_amount: 60, paid_amount: 10, balance_due: 50 });
  await act(async () => Simulate.submit(container.querySelector('form')));
  expect(saveSpecialOrder.mock.calls[0][0].items.map(item => item.item_name)).toEqual(['SECOND']);
});
