import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import BooksView from './BooksView';
import { fetchAccountingBooks, updateNamedLedgerEntry, saveNamedLedgerEntry } from '../api/client';

jest.mock('../api/client', () => ({
  fetchAccountingBooks: jest.fn(), updateNamedLedgerEntry: jest.fn(),
  saveNamedLedgerEntry: jest.fn()
}));
jest.mock('xlsx', () => ({}));
jest.mock('../utils/ledgerPdf', () => ({ saveLedgerPdf: jest.fn() }));

test('editing a manual ledger row sends changed fields to the update API and exits edit mode', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  fetchAccountingBooks.mockResolvedValue({ books: { namedLedgers: {
    title: 'Named Ledgers', accountNames: ['TEST ACCOUNT'],
    summary: { accounts: 1, entries: 1, dr: 0, cr: 100 },
    columns: ['Date', 'Account', 'Details', 'Remarks', 'DR Rs', 'CR Rs'],
    rows: [{ entryId: 7, isManual: true, Date: '2026-10-21', Account: 'TEST ACCOUNT',
      Details: 'Original', Remarks: '', 'DR Rs': 0, 'CR Rs': 100 }]
  } } });
  updateNamedLedgerEntry.mockResolvedValue({ success: true, entry_date: '2026-10-21' });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const button = (text) => [...container.querySelectorAll('button')].find(el => el.textContent === text);
  try {
    await act(async () => root.render(<BooksView />));
    await act(async () => Simulate.click([...container.querySelectorAll('.book-select-card')]
      .find(el => el.querySelector('strong').textContent === 'Named Ledgers')));
    await act(async () => Simulate.click(container.querySelector('.named-ledger-name-row')));
    await act(async () => Simulate.click(button('Edit')));
    await act(async () => {
      Simulate.change(container.querySelector('.named-ledger-details-field input'), { target: { value: 'Updated' } });
      Simulate.change(container.querySelector('input[placeholder="Credit"]'), { target: { value: '125' } });
    });
    await act(async () => Simulate.submit(container.querySelector('form.named-ledger-entry-row')));
    expect(updateNamedLedgerEntry).toHaveBeenCalledWith(7, {
      entry_date: '2026-10-21', account_name: 'TEST ACCOUNT', details: 'Updated',
      remarks: '', direction: 'CR', amount: 125
    });
    expect(saveNamedLedgerEntry).not.toHaveBeenCalled();
    expect(button('Add Entry')).toBeDefined();
    expect(container.textContent).toContain('TEST ACCOUNT ledger entry saved.');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  }
});
