import { isConfirmedPriceChange, refreshCheckoutPrices } from './checkoutPriceRefresh';
import { calculateSaleAmounts } from './saleAmounts';

test.each([70, 120])('refreshes a scanned Colgate price from 100 to %s without losing quantity', async price => {
  const cart = [{ barcode: 'COLGATE', product_name: 'Colgate', sale_price: 100, quantity: 2, gst_percent: 18 }];
  const lookup = jest.fn().mockResolvedValue({ barcode: 'COLGATE', sale_price: price, mrp: 150, qty_3_price: null });
  const refreshed = await refreshCheckoutPrices(cart, lookup);
  expect(refreshed[0]).toMatchObject({ sale_price: price, quantity: 2, gst_percent: 18, qty_3_price: null });
  expect(calculateSaleAmounts(refreshed, item => item.sale_price).saleGrand).toBe(price * 2);
  expect(cart[0].sale_price).toBe(100);
  expect(lookup).toHaveBeenCalledWith('COLGATE');
});

test('refreshes all lines, retail, wholesale and quantity slabs, including removing a slab', async () => {
  const cart = [
    { barcode: 'A', quantity: 1, sale_price: 100, wholesale_price: 90, qty_3_price: 80 },
    { barcode: 'A', quantity: 3, sale_price: 100, wholesale_price: 90, qty_3_price: 80 },
    { barcode: 'B', quantity: 1, sale_price: 50 }
  ];
  const lookup = jest.fn(barcode => Promise.resolve(barcode === 'A'
    ? { barcode, sale_price: 110, wholesale_price: 95, qty_3_price: null, qty_6_price: 85, qty_12_price: 75 }
    : { barcode, sale_price: 45 }));
  const refreshed = await refreshCheckoutPrices(cart, lookup);
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(refreshed[0]).toMatchObject({ sale_price: 110, wholesale_price: 95, qty_3_price: null, qty_6_price: 85, qty_12_price: 75 });
  expect(refreshed[1].quantity).toBe(3);
  expect(refreshed[2].sale_price).toBe(45);
});

test.each([null, { barcode: 'OTHER', sale_price: 25 }])('missing or different products do not silently replace a scanned line', async product => {
  const cart = [{ barcode: 'A', sale_price: 100, quantity: 1 }];
  await expect(refreshCheckoutPrices(cart, jest.fn().mockResolvedValue(product))).rejects.toThrow('Unable to refresh');
  expect(cart).toEqual([{ barcode: 'A', sale_price: 100, quantity: 1 }]);
});

test('a failed rate lookup leaves the original bill intact', async () => {
  const cart = [{ barcode: 'A', sale_price: 100, quantity: 1 }];
  await expect(refreshCheckoutPrices(cart, () => Promise.reject(new Error('Network error')))).rejects.toThrow('Network error');
  expect(cart[0].sale_price).toBe(100);
});

test('only an explicit rolled-back price conflict permits changing checkout intent', () => {
  const rejected = { response: { status: 409, data: { code: 'PRICE_CHANGED' } } };
  expect(isConfirmedPriceChange(rejected)).toBe(true);
  for (const error of [{ code: 'ECONNABORTED' }, { response: { status: 500 } },
    { response: { status: 409, data: { code: 'CHECKOUT_ALREADY_SAVED' } } },
    { ...rejected, checkoutJournalError: true }]) expect(isConfirmedPriceChange(error)).toBe(false);
});
