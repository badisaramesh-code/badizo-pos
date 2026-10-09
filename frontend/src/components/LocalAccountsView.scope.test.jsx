import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import LocalAccountsView from './LocalAccountsView';
import { fetchLocalAccounts } from '../api/client';

jest.mock('../api/client', () => ({ fetchLocalAccounts: jest.fn() }));
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
