import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import LocalAccountsView from './LocalAccountsView';
import { fetchLocalAccounts, setLocalAccountEntryCleared, saveLocalAccountEntry } from '../api/client';

jest.mock('../api/client', () => ({ fetchLocalAccounts: jest.fn(), setLocalAccountEntryCleared: jest.fn(), saveLocalAccountEntry: jest.fn() }));
jest.mock('xlsx', () => ({}));
jest.mock('jspdf', () => ({ jsPDF: jest.fn() }));
jest.mock('jspdf-autotable', () => jest.fn());

test('typing does not reformat ledger rows; clear and edit actions still work', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, account_name: 'TEST',
    entry_date: '2026-11-04', details: 'LINE ' + i, dr_amount: 1, cr_amount: 0, balance: i + 1 }));
  fetchLocalAccounts.mockResolvedValue({ rows, ledgers: [{ name: 'TEST', balance: 100, entries: 100 }] });
  setLocalAccountEntryCleared.mockResolvedValue({ success: true });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const formatSpy = jest.spyOn(Intl.NumberFormat.prototype, 'format', 'get');
  const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = jest.fn();
  try {
    await act(async () => root.render(<LocalAccountsView />));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(100);
    formatSpy.mockClear();
    await act(async () => Simulate.change(container.querySelector('#local-entry-details'), { target: { value: 'FAST ENTRY' } }));
    // Only the three heading totals should format on a keystroke, regardless of row count.
    expect(formatSpy.mock.calls.length).toBeLessThanOrEqual(3);
    expect(container.querySelector('#local-entry-details').value).toBe('FAST ENTRY');
    await act(async () => Simulate.click(container.querySelector('.local-clear-check')));
    expect(setLocalAccountEntryCleared).toHaveBeenCalledWith(1, true);
    expect(container.querySelector('.local-clear-check').getAttribute('aria-pressed')).toBe('true');
    await act(async () => Simulate.click([...container.querySelectorAll('tbody button')].find(button => button.textContent === 'Edit')));
    expect(container.querySelector('#local-entry-details').value).toBe('LINE 0');
  } finally {
    await act(async () => root.unmount()); container.remove(); formatSpy.mockRestore();
    HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('large books render only one page, preserve full totals and search from the first character', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const rows = Array.from({ length: 2368 }, (_, i) => ({ id: i + 1, account_name: 'TEST LEDGER',
    entry_date: '2026-11-04', details: 'LINE ' + i, dr_amount: 1, cr_amount: 0, balance: i + 1 }));
  fetchLocalAccounts.mockResolvedValue({ rows, ledgers: [{ name: 'TEST LEDGER', balance: 2368, entries: 2368 }] });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LocalAccountsView />));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(68);
    expect(container.querySelector('.local-ledger-pagination').textContent).toContain('2301–2368 of 2368');
    expect(container.querySelector('.local-totals').textContent).toContain('2,368.00');
    await act(async () => Simulate.change(container.querySelector('#local-account-name-input'), { target: { value: 'T' } }));
    expect(container.querySelector('[role="listbox"]').textContent).toContain('TEST LEDGER');
    await act(async () => Simulate.click([...container.querySelectorAll('button')].find(button => button.textContent === 'Previous')));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(100);
    expect(container.querySelector('.local-ledger-pagination').textContent).toContain('2201–2300 of 2368');
    setLocalAccountEntryCleared.mockResolvedValue({ success: true });
    await act(async () => Simulate.click(container.querySelector('.local-clear-check')));
    expect(container.querySelector('.local-ledger-pagination').textContent).toContain('2201–2300 of 2368');
    let finishReload;
    fetchLocalAccounts.mockImplementationOnce(() => new Promise(resolve => { finishReload = resolve; }));
    saveLocalAccountEntry.mockClear();
    saveLocalAccountEntry.mockResolvedValue({ success: true, id: 2369 });
    await act(async () => {
      Simulate.submit(container.querySelector('.local-entry-grid'));
      Simulate.submit(container.querySelector('.local-entry-grid'));
    });
    expect(saveLocalAccountEntry).toHaveBeenCalledTimes(1);
    await act(async () => finishReload({ rows, ledgers: [{ name: 'TEST LEDGER', balance: 2368, entries: 2368 }] }));
  } finally {
    await act(async () => root.unmount()); container.remove();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
