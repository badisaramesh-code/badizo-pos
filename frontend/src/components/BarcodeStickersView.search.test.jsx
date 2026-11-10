import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import BarcodeStickersView from './BarcodeStickersView';
import { searchProducts, fetchSettings, lookupExactProduct } from '../api/client';

jest.mock('../api/client', () => ({
  searchProducts: jest.fn(), lookupExactProduct: jest.fn(), fetchSettings: jest.fn(), fetchBarcodeTemplate: jest.fn(),
  approveSensitiveBillingMode: jest.fn(), generateBarcodePrn: jest.fn(), printBarcodePrn: jest.fn()
}));

let container, root;
const product = { barcode: '979127', product_code: '979127', product_name: 'TEST PRODUCT', mrp: 60 };
const searchInput = () => container.querySelector('.barcode-live-search');
const loaded = () => container.textContent.includes('loaded for sticker.');
async function typeAndSearch(value) {
  await act(async () => Simulate.change(searchInput(), { target: { value } }));
  await act(async () => jest.advanceTimersByTime(120));
}
beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  jest.clearAllMocks();
  fetchSettings.mockResolvedValue({});
  searchProducts.mockResolvedValue([product]);
  lookupExactProduct.mockResolvedValue(null);
  Element.prototype.scrollIntoView = jest.fn();
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<BarcodeStickersView />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); jest.useRealTimers(); delete global.IS_REACT_ACT_ENVIRONMENT;
});

test('partial code Enter shows even a single match without loading it; click loads and hides results', async () => {
  await typeAndSearch('9791');
  await act(async () => Simulate.keyDown(searchInput(), { key: 'Enter' }));
  expect(loaded()).toBe(false);
  expect(container.querySelectorAll('tbody tr.selected-row')).toHaveLength(1);
  await act(async () => Simulate.click(container.querySelector('tbody tr.selected-row')));
  await act(async () => jest.advanceTimersByTime(200));
  expect(loaded()).toBe(true);
  expect(container.querySelectorAll('tbody tr.selected-row')).toHaveLength(0);
});

test('exact code Enter loads the product', async () => {
  await typeAndSearch('979127');
  await act(async () => Simulate.keyDown(searchInput(), { key: 'Enter' }));
  expect(loaded()).toBe(true);
});

test.each(['search', 'barcode'])('89300286 loads via exact lookup from the %s field', async (field) => {
  const exact = { ...product, barcode: '89300286', product_code: '89300286', product_name: 'BIRYANI AAKU 10.G' };
  lookupExactProduct.mockResolvedValue(exact);
  searchProducts.mockResolvedValue([]);
  const input = field === 'search' ? searchInput() : container.querySelector('.barcode-entry-form label input');
  await act(async () => Simulate.change(input, { target: { value: '89300286' } }));
  await act(async () => Simulate.keyDown(input, { key: 'Enter' }));
  expect(lookupExactProduct).toHaveBeenCalledWith('89300286');
  expect(container.textContent).toContain('BIRYANI AAKU 10.G loaded for sticker.');
  expect(container.querySelectorAll('tbody tr.selected-row')).toHaveLength(0);
});

test('arrow selection followed by Enter loads a partial match', async () => {
  await typeAndSearch('9791');
  await act(async () => Simulate.keyDown(searchInput(), { key: 'ArrowDown' }));
  await act(async () => Simulate.keyDown(searchInput(), { key: 'Enter' }));
  expect(loaded()).toBe(true);
});

test('a pending lookup cannot reopen results after a product is selected', async () => {
  await typeAndSearch('9791');
  let resolveSearch;
  searchProducts.mockImplementationOnce(() => new Promise(resolve => { resolveSearch = resolve; }));
  await act(async () => Simulate.keyDown(searchInput(), { key: 'Enter' }));
  await act(async () => Simulate.click(container.querySelector('tbody tr.selected-row')));
  await act(async () => resolveSearch([product]));
  await act(async () => jest.advanceTimersByTime(200));
  expect(loaded()).toBe(true);
  expect(container.querySelectorAll('tbody tr.selected-row')).toHaveLength(0);
});
