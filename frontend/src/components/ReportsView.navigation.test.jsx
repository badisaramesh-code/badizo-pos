import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import ReportsView from './ReportsView';
import * as api from '../api/client';

jest.mock('../api/client', () => ({
  fetchGstHsnReport: jest.fn(),
  fetchSettings: jest.fn(),
  fetchFinancialYears: jest.fn(),
  fetchDailySalesReport: jest.fn(),
  fetchMonthlySalesReport: jest.fn(),
  fetchStockReport: jest.fn()
}));
jest.mock('xlsx', () => ({}));

let container;
let root;

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api.fetchGstHsnReport.mockResolvedValue({ rows: [{ hsn_code: '0000', product_name: 'Saved HSN product', quantity: 3, gross: 225 }] });
  api.fetchSettings.mockResolvedValue({});
  api.fetchFinancialYears.mockResolvedValue({ years: [] });
  api.fetchDailySalesReport.mockResolvedValue({ rows: [], totals: {} });
  api.fetchMonthlySalesReport.mockResolvedValue({ rows: [{ sale_month: '2026-08', bill_count: 3, total: 120 }] });
  api.fetchStockReport.mockResolvedValue([{ barcode: '123', product_name: 'Saved stock product', stock_qty: 5 }]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.clearAllMocks();
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

async function showReports(isActive) {
  await act(async () => root.render(<ReportsView isActive={isActive} />));
}

async function click(element) {
  await act(async () => Simulate.click(element));
}

test.each([
  ['GST HSN Summary', 'Saved HSN product'],
  ['Monthly Sales', '2026-08'],
  ['Stock Report', 'Saved stock product']
])('retains %s, filters and results after leaving and returning', async (title, result) => {
  await showReports(true);
  const search = container.querySelector('input[placeholder="Invoice no / phone / walk-in customer name"]');
  const from = container.querySelector('input[type="date"]');
  await act(async () => {
    Simulate.change(search, { target: { value: 'saved search' } });
    Simulate.change(from, { target: { value: '2026-08-01' } });
  });
  await click([...container.querySelectorAll('.report-select-card')].find((button) => button.querySelector('strong').textContent === title));
  await click(container.querySelector('.report-selector-actions .primary-button'));
  expect(container.querySelector('[role="dialog"]').textContent).toContain(result);

  await showReports(false);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await showReports(true);
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog.getAttribute('aria-label')).toBe(`${title} report view`);
  expect(dialog.textContent).toContain(result);
  expect(search.value).toBe('saved search');
  expect(from.value).toBe('2026-08-01');

  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await showReports(false);
  await showReports(true);
  expect(container.querySelector('[role="dialog"]')).toBeNull();

  await click(container.querySelector('.report-selector-actions .primary-button'));
  await click(container.querySelector('.report-view-sticky-toolbar .close-action-button'));
  await showReports(false);
  await showReports(true);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});