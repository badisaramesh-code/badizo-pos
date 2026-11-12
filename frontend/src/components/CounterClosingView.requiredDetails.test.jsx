import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import CounterClosingView from './CounterClosingView';
import * as api from '../api/client';

jest.mock('../api/client', () => ({
  fetchCounterHandover: jest.fn(), fetchCounterHandoverHistory: jest.fn(),
  searchClosingAccounts: jest.fn(), fetchSettings: jest.fn(), getStoredUser: jest.fn(), saveCounterHandover: jest.fn()
}));
jest.mock('xlsx', () => ({}));

const labels = ['UPI SALE', 'NUMBER'];
let container;
let root;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api.getStoredUser.mockReturnValue({ role: 'COUNTER', counter_no: 1 });
  api.fetchSettings.mockResolvedValue({});
  api.fetchCounterHandover.mockResolvedValue({ snapshot: {} });
  api.fetchCounterHandoverHistory.mockResolvedValue({ rows: [] });
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
  expect(details().slice(0, 2).map((input) => input.value)).toEqual(labels);
  expect(details().slice(0, 2).every((input) => input.readOnly)).toBe(true);
  expect(details().slice(2).every((input) => input.value === '' && !input.readOnly)).toBe(true);
  const firstRow = details()[0].closest('tr');
  await act(async () => Simulate.change(firstRow.querySelector('.handover-remarks-input'), { target: { value: 'remark' } }));
  await act(async () => Simulate.click(firstRow.querySelector('button')));
  expect(details()[0].value).toBe('UPI SALE');
  expect(firstRow.querySelector('.handover-remarks-input').value).toBe('');
  await act(async () => Simulate.click(button('Cash In')));
  expect(details()[2].value).toBe('Cash Incoming');
  await act(async () => Simulate.click(button('Reset Rows From Sales')));
  expect(details().slice(0, 2).map((input) => input.value)).toEqual(labels);
  expect(details()[2].value).toBe('');
});

test('loading saved entries preserves matching amounts and all custom rows', async () => {
  api.fetchCounterHandover.mockResolvedValue({ snapshot: {}, sheet: { entries: [
    { details: 'upi sale', direction: 'DR', amount: 123, remarks: 'saved' },
    ...Array.from({ length: 29 }, (_, index) => ({ details: `Custom ${index}`, direction: 'CR', amount: index + 1 }))
  ] } });
  await act(async () => root.render(<CounterClosingView />));
  expect(details().slice(0, 2).map((input) => input.value)).toEqual(labels);
  expect(details()[0].closest('tr').querySelector('.handover-dr-input').value).toBe('123');
  expect(details().slice(2).map((input) => input.value)).toEqual(Array.from({ length: 29 }, (_, index) => `Custom ${index}`));
});

test('saved PURCHASE through XXX entries remain editable with their amounts', async () => {
  const savedLabels = ['PURCHASE', 'RETURN', 'LESS', 'TRANSPORT', 'HAMALI', 'SADARA', 'SALARIES', 'HF STAFF', 'XXX'];
  api.fetchCounterHandover.mockResolvedValue({ snapshot: {}, sheet: { entries:
    savedLabels.map((details, index) => ({ details, direction: 'CR', amount: index + 1 }))
  } });
  await act(async () => root.render(<CounterClosingView />));
  expect(details().slice(2, 11).map(input => input.value)).toEqual(savedLabels);
  expect(details().slice(2).every(input => !input.readOnly)).toBe(true);
  expect([...details()[2].closest('tr').querySelectorAll('.amount-field')].at(-1).value).toBe('1');
});

test('server users return to their last selected handover date and counter', async () => {
  api.getStoredUser.mockReturnValue({ role: 'SERVER' });
  api.fetchSettings.mockResolvedValue({ counter_count: 6 });
  window.sessionStorage.clear();
  await act(async () => root.render(<CounterClosingView />));
  await act(async () => Simulate.change(container.querySelector('select.select'), { target: { value: '2' } }));
  await act(async () => Simulate.change(container.querySelector('input[type="date"]'), { target: { value: '2026-10-16' } }));
  await act(async () => root.unmount());
  root = createRoot(container);
  api.fetchCounterHandover.mockClear();
  await act(async () => root.render(<CounterClosingView />));
  expect(container.querySelector('select.select').value).toBe('2');
  expect(container.querySelector('input[type="date"]').value).toBe('2026-10-16');
  expect(api.fetchCounterHandover).toHaveBeenCalledWith('2026-10-16', 2);
});

test.each(['COUNTER', 'ADMIN', 'SERVER'])('%s sees the appropriate screen and print totals', async role => {
  api.getStoredUser.mockReturnValue({ role, counter_no: 1 });
  api.fetchCounterHandover.mockResolvedValue({ snapshot: { counter_sales: 87654, all_counter_sales: 98765 } });
  await act(async () => root.render(<CounterClosingView />));
  expect(Boolean(container.querySelector('.handover-sales-strip'))).toBe(role !== 'COUNTER');
  expect(container.querySelector('.handover-print-sheet').textContent.includes('98765')).toBe(role !== 'COUNTER');
});

test('row three suggests canonical accounts after three letters and saves the chosen customer', async () => {
  jest.useFakeTimers();
  try {
    api.searchClosingAccounts.mockResolvedValue([
      { kind: 'HISTORY', name: 'Lankapalli' }
    ]);
    api.saveCounterHandover.mockResolvedValue({ sheet_no: 'TEST' });
    await act(async () => root.render(<CounterClosingView />));
    const input = details()[2];
    const type = value => act(async () => Simulate.change(input, { target: { value } }));
    await type('la');
    await act(async () => jest.advanceTimersByTime(200));
    expect(api.searchClosingAccounts).not.toHaveBeenCalled();
    await type('lankapally');
    await act(async () => jest.advanceTimersByTime(200));
    expect(api.searchClosingAccounts).toHaveBeenCalledWith('lankapally', false);
    expect(container.querySelector('[role=listbox]').textContent).toContain('Previous day-sheet name');
    await act(async () => Simulate.click([...container.querySelectorAll('[role=option]')].find(option => option.textContent.includes('Use as customer'))));
    expect(input.value).toBe('Lankapalli');
    const dr = input.closest('tr').querySelector('.handover-dr-input');
    await act(async () => Simulate.focus(dr));
    await act(async () => Simulate.change(dr, { target: { value: '125' } }));
    const save = [...container.querySelectorAll('button')].find(item => /save/i.test(item.textContent));
    await act(async () => Simulate.click(save));
    expect(api.saveCounterHandover.mock.calls[0][0].entries).toContainEqual(expect.objectContaining({
      details: 'Lankapalli', entry_type: 'CLOSING_CUSTOMER', direction: 'DR', amount: '125'
    }));
  } finally {
    jest.useRealTimers();
  }
});
