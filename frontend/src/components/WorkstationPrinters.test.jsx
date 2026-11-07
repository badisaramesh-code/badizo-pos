import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import WorkstationPrinters from './WorkstationPrinters';

let host, root;
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  delete window.badizoDesktop;
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

test('browser explains where receipts and labels print', async () => {
  await act(async () => root.render(<WorkstationPrinters />));
  expect(host.textContent).toContain('browser print dialog');
  expect(host.textContent).toContain('configured server printer share');
  expect(host.querySelector('button')).toBeNull();
});

test('desktop checks queues on demand and clears stale results on failure', async () => {
  const enumerate = jest.fn().mockResolvedValueOnce({ systemName: 'Counter-2', printers: [{ name: 'Receipt-2', isDefault: true }] })
    .mockRejectedValueOnce(Error('spooler unavailable'));
  window.badizoDesktop = { getBarcodePrinters: enumerate };
  await act(async () => root.render(<WorkstationPrinters />));
  expect(enumerate).not.toHaveBeenCalled();
  await act(async () => host.querySelector('button').click());
  expect(host.textContent).toContain('Counter-2');
  expect(host.textContent).toContain('Receipt-2 (Windows default)');
  await act(async () => host.querySelector('button').click());
  expect(host.textContent).not.toContain('Receipt-2');
  expect(host.querySelector('[role=alert]').textContent).toContain('Check the Print Spooler');
});
