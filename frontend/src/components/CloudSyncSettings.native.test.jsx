import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import CloudSyncSettings from './CloudSyncSettings';
import api, { fetchCloudSyncSettings, saveCloudSyncSettings, requestCloudSyncNow, getStoredUser } from '../api/client';
jest.mock('../api/client', () => ({ __esModule: true, default: { post: jest.fn() }, fetchCloudSyncSettings: jest.fn(), saveCloudSyncSettings: jest.fn(), requestCloudSyncNow: jest.fn(), getStoredUser: jest.fn() }));
let root, container;
const status = () => ({ editable: true, nodeRole: 'local-server', config: { enabled: true, frequency: 'daily', dailyTime: '08:30', timezone: 'Asia/Kolkata' }, service: { ready: true, state: 'idle', engine: 'mysql-replication', direction: 'upload' }, transfersPaused: false, lastSuccessAt: null, nextRunAt: '2026-11-14T03:00:00Z', message: 'Daily sync ready' });
const button = text => [...container.querySelectorAll('button')].find(el => el.textContent === text);
beforeEach(() => { global.IS_REACT_ACT_ENVIRONMENT = true; jest.useFakeTimers(); getStoredUser.mockReturnValue({ role: 'SERVER' }); fetchCloudSyncSettings.mockResolvedValue(status()); saveCloudSyncSettings.mockResolvedValue(status()); requestCloudSyncNow.mockResolvedValue({ ...status(), manualPending: true }); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.clearAllMocks(); jest.useRealTimers(); delete global.IS_REACT_ACT_ENVIRONMENT; });
test('native sync keeps daily time and Update Cloud Now without offering hourly or continuous', async () => {
  await act(async () => root.render(<CloudSyncSettings />));
  expect(container.querySelector('input[type=time]').value).toBe('08:30'); expect(container.querySelector('select')).toBeNull(); expect(container.textContent).toContain('Daily background sync');
  await act(async () => Simulate.click(button('Update Cloud Now'))); expect(requestCloudSyncNow).toHaveBeenCalledTimes(1); expect(container.querySelector('progress').getAttribute('value')).toBeNull();
});
test('pause remains a request until actual replica thread stop is confirmed', async () => {
  api.post.mockResolvedValue({ data: { ...status(), transfersPaused: true, service: { ...status().service, state: 'running' } } });
  await act(async () => root.render(<CloudSyncSettings />)); await act(async () => Simulate.click(button('Pause Cloud Sync')));
  expect(api.post).toHaveBeenCalledWith('/cloud-sync/pause', { paused: true }); expect(container.textContent).toContain('Pausing cloud sync'); expect(container.querySelector('progress').getAttribute('value')).toBe('0'); expect(button('Resume Cloud Sync')).toBeTruthy();
});
test('admin can pause and change daily time but cannot enable or manually start replication', async () => {
  getStoredUser.mockReturnValue({ role: 'ADMIN' }); await act(async () => root.render(<CloudSyncSettings />));
  expect(button('Pause Cloud Sync').disabled).toBe(false); expect(container.querySelector('input[type=time]').disabled).toBe(false); expect(container.querySelector('input[type=checkbox]').disabled).toBe(true); expect(button('Update Cloud Now').disabled).toBe(true);
});
test('pause is still available when cloud status is unavailable', async () => {
  fetchCloudSyncSettings.mockResolvedValue({ ...status(), service: { ...status().service, ready: false, state: 'not-configured' } }); await act(async () => root.render(<CloudSyncSettings />));
  expect(button('Pause Cloud Sync').disabled).toBe(false); expect(button('Update Cloud Now').disabled).toBe(true); expect(container.querySelector('progress').getAttribute('value')).toBe('0');
});
test('legacy event sync retains hourly and existing controls', async () => {
  fetchCloudSyncSettings.mockResolvedValue({ ...status(), config: { ...status().config, frequency: 'hourly' }, service: { ready: true, state: 'idle', direction: 'upload' } }); await act(async () => root.render(<CloudSyncSettings />));
  expect(container.querySelector('select').value).toBe('hourly'); expect(container.textContent).toContain('Hourly sync runs'); expect(container.textContent).not.toContain('Daily background sync');
});
