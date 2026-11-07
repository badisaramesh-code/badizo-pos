import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import RecoveryControl from './RecoveryControl';
import api, { getStoredUser } from '../api/client';

jest.mock('../api/client', () => ({
  __esModule: true, default: { get: jest.fn(), post: jest.fn() }, getStoredUser: jest.fn()
}));

let root, node, status, statusAvailable, sync;
const button = text => [...node.querySelectorAll('button')].find(element => element.textContent === text);
const render = () => act(async () => { root.render(<RecoveryControl />); });
const click = name => act(async () => { button(name).click(); });
const poll = () => act(async () => { jest.advanceTimersByTime(3000); });

beforeEach(() => {
  jest.useFakeTimers();
  global.IS_REACT_ACT_ENVIRONMENT = true;
  statusAvailable = true;
  sync = null;
  status = { nodeRole: 'local-server', supervisorOnline: true, billingMode: 'standby', generation: 5,
    operation: { id: 'op-1', kind: 'use-cloud', state: 'synchronizing' } };
  getStoredUser.mockReturnValue({ role: 'SERVER' });
  api.get.mockImplementation(async url => {
    if (url === '/ready') return { data: { sync } };
    if (url === '/staged-restore') return { data: { job: null } };
    if (!statusAvailable) throw Error('disconnected');
    return { data: { ...status, operation: { ...status.operation } } };
  });
  api.post.mockImplementation(async () => { status.operation.stopRequested = true; return { status: 202 }; });
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  jest.clearAllMocks();
  jest.useRealTimers();
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

test('owner confirms exact switch, then sees stop requested and actual observed modes', async () => {
  await render();
  expect(button('Emergency local billing').disabled).toBe(true);
  await click('Recover interrupted switch');
  expect(api.post).not.toHaveBeenCalled();
  await click('Confirm');
  expect(api.post).toHaveBeenCalledWith('/recovery-control/recover-switch', {
    operationId: 'op-1', confirmation: 'STOP INTERRUPTED SWITCH'
  });
  expect(node.textContent).toContain('Stop requested');
  expect(button('Recover interrupted switch')).toBeUndefined();
  status.operation = { ...status.operation, state: 'failed', failureCode: 'activation-unconfirmed',
    observedModes: { local: 'standby', cloud: 'unknown' } };
  await poll();
  expect(node.textContent).toContain('local standby, cloud unknown');
  expect(node.textContent).toContain('first stop all counters on the other server');
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('replacement operation invalidates an open owner confirmation', async () => {
  await render();
  await click('Recover interrupted switch');
  status.operation.id = 'new-operation';
  await poll();
  expect(button('Confirm').disabled).toBe(true);
  await click('Confirm');
  expect(api.post).not.toHaveBeenCalled();
});

test('lost status closes confirmation and blocks actions until the server responds', async () => {
  await render();
  await click('Recover interrupted switch');
  statusAvailable = false;
  await poll();
  expect(button('Confirm')).toBeUndefined();
  expect(button('Recover interrupted switch').disabled).toBe(true);
  expect(node.textContent).toContain('Last reported billing');
  statusAvailable = true;
  await poll();
  expect(button('Recover interrupted switch').disabled).toBe(false);
});

test.each(['finalizing', 'complete', 'failed', 'rolled-back'])('no stop for %s operation', async stage => {
  status.operation.state = stage;
  await render();
  expect(button('Recover interrupted switch')).toBeUndefined();
});

test('degraded local readiness explains continued billing and paused cloud updates', async () => {
  sync = { ready: false, reason: 'capture-gap-requires-baseline' };
  await render();
  expect(node.textContent).toContain('Local billing can continue');
  expect(node.textContent).toContain('Cloud updates are paused');
});

test('cloud and counter users cannot stop a local switch', async () => {
  status.nodeRole = 'cloud-active';
  await render();
  expect(button('Recover interrupted switch')).toBeUndefined();
  getStoredUser.mockReturnValue({ role: 'COUNTER' });
  await render();
  expect(node.textContent).toBe('');
});
