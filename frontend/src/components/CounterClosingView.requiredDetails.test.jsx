import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import CounterClosingView from './CounterClosingView';
import * as api from '../api/client';

jest.mock('../api/client', () => ({
  fetchCounterHandover: jest.fn(), fetchCounterHandoverHistory: jest.fn(),
  fetchSettings: jest.fn(), getStoredUser: jest.fn(), saveCounterHandover: jest.fn()
}));
jest.mock('xlsx', () => ({}));

const labels = ['UPI SALE', 'NUMBER', 'PURCHASE', 'RETURN', 'LESS', 'TRANSPORT', 'HAMALI', 'SADARA', 'SALARIES', 'HF STAFF', 'XXX'];
let container;
let root;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api.getStoredUser.mockReturnValue({ role: 'COUNTER', counter_no: 1 });
  api.fetchSettings.mockResolvedValue({});
  api.fetchCounterHandover.mockResolvedValue({ snapshot: {} });
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
const details = () => [...container.querySelectorAll('.handover-details-input')];
const button = (text) => [...container.querySelectorAll('button')].find((item) => item.textContent === text);

test('required details survive Clear and Reset; Cash In uses a custom row', async () => {
  await act(async () => root.render(<CounterClosingView />));
  expect(details().slice(0, 11).map((input) => input.value)).toEqual(labels);
  expect(details().slice(0, 11).every((input) => input.readOnly)).toBe(true);
  const firstRow = details()[0].closest('tr');
  await act(async () => Simulate.change(firstRow.querySelector('.handover-remarks-input'), { target: { value: 'remark' } }));
  await act(async () => Simulate.click(firstRow.querySelector('button')));
  expect(details()[0].value).toBe('UPI SALE');
  expect(firstRow.querySelector('.handover-remarks-input').value).toBe('');
  await act(async () => Simulate.click(button('Cash In')));
  expect(details()[11].value).toBe('Cash Incoming');
  await act(async () => Simulate.click(button('Reset Rows From Sales')));
  expect(details().slice(0, 11).map((input) => input.value)).toEqual(labels);
  expect(details()[11].value).toBe('');
});

test('loading saved entries preserves matching amounts and all custom rows', async () => {
  api.fetchCounterHandover.mockResolvedValue({ snapshot: {}, sheet: { entries: [
    { details: 'upi sale', direction: 'DR', amount: 123, remarks: 'saved' },
    ...Array.from({ length: 29 }, (_, index) => ({ details: `Custom ${index}`, direction: 'CR', amount: index + 1 }))
  ] } });
  await act(async () => root.render(<CounterClosingView />));
  expect(details().slice(0, 11).map((input) => input.value)).toEqual(labels);
  expect(details()[0].closest('tr').querySelector('.handover-dr-input').value).toBe('123');
  expect(details().slice(11).map((input) => input.value)).toEqual(Array.from({ length: 29 }, (_, index) => `Custom ${index}`));
});
