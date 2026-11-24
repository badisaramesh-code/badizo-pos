import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import LocalAccountsView from './LocalAccountsView';
import { deleteLocalLedger, fetchLocalAccounts } from '../api/client';

jest.mock('../api/client', () => ({ deleteLocalLedger: jest.fn(), fetchLocalAccounts: jest.fn() }));
jest.mock('xlsx', () => ({}));
jest.mock('jspdf', () => ({ jsPDF: jest.fn() }));
jest.mock('jspdf-autotable', () => jest.fn());

test('switching scopes clears the previous entry in both directions and preserves dates', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  fetchLocalAccounts.mockResolvedValue({ rows: [], ledgers: [] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LocalAccountsView />));
    const dates = () => [...container.querySelectorAll('input[type="date"]')].map(input => input.value);
    const originalDates = dates();
    for (const label of ['Non-Local', 'Local']) {
      await act(async () => {
        Simulate.change(container.querySelector('#local-account-name-input'), { target: { value: 'OLD ACCOUNT' } });
        Simulate.change(container.querySelector('#local-entry-details'), { target: { value: 'Old details' } });
      });
      await act(async () => Simulate.click([...container.querySelectorAll('.local-scope-tabs button')].find(button => button.textContent === label)));
      expect(container.querySelector('#local-account-name-input').value).toBe('');
      expect(container.querySelector('#local-entry-details').value).toBe('');
      expect(dates()).toEqual(originalDates);
      expect(container.querySelector('.local-entry-grid button').textContent).toBe('Add Entry');
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('deletes the confirmed Non-Local ledger through the in-app dialog', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  fetchLocalAccounts.mockImplementation(async ({ scope }) => ({
    rows: [],
    ledgers: scope === 'NON_LOCAL' ? [{ name: '320', entries: 1 }] : [],
  }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LocalAccountsView />));
    const dialog = container.querySelector('dialog');
    dialog.showModal = () => dialog.setAttribute('open', '');
    dialog.close = () => dialog.removeAttribute('open');
    await act(async () => Simulate.click(container.querySelector('.local-scope-tabs button:last-child')));
    await act(async () => Simulate.click(container.querySelector('.local-ledger-name-scroll button:last-child')));
    await act(async () => Simulate.click(container.querySelector('.local-date-filter .local-ledger-delete-button')));
    expect(dialog.hasAttribute('open')).toBe(true);

    await act(async () => {
      Simulate.change(dialog.querySelector('input'), { target: { value: '321' } });
    });
    await act(async () => Simulate.submit(dialog.querySelector('form')));
    expect(deleteLocalLedger).not.toHaveBeenCalled();
    expect(dialog.querySelector('[role="alert"]').textContent).toBe('Ledger name did not match.');

    deleteLocalLedger.mockRejectedValueOnce({ response: { data: { error: 'Server error' } } });
    await act(async () => {
      Simulate.change(dialog.querySelector('input'), { target: { value: '320' } });
    });
    await act(async () => Simulate.submit(dialog.querySelector('form')));
    expect(deleteLocalLedger).toHaveBeenCalledWith({ account_scope: 'NON_LOCAL', account_name: '320' });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.querySelector('[role="alert"]').textContent).toBe('Server error');

    deleteLocalLedger.mockResolvedValueOnce({ deleted_entries: 1, deleted_diary_records: 0 });
    fetchLocalAccounts.mockResolvedValueOnce({ rows: [], ledgers: [] });
    await act(async () => Simulate.submit(dialog.querySelector('form')));
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(container.querySelector('.local-ledger-name-scroll').textContent).toBe('Day Book (All)');
    expect(container.querySelector('.form-success').textContent).toContain('320 ledger deleted');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
