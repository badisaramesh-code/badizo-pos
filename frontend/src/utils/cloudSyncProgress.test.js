import { cloudSyncProgress } from './cloudSyncProgress';

const state = (phase, overrides = {}) => ({ service: { ready: true, state: phase }, lastSuccessAt: '2026-11-02T10:00:00Z', ...overrides });
test('old success never fills the bar during queued, active, waiting or failed work', () => {
  for (const phase of ['running', 'pending', 'waiting', 'retrying']) {
    expect(cloudSyncProgress(state(phase), false, '').value).not.toBe(1);
  }
  expect(cloudSyncProgress(state('idle', { manualPending: true }), false, '').label).toBe('Sync queued…');
  expect(cloudSyncProgress(state('running', { manualPending: true }), false, '').label).toBe('Syncing…');
});
test('confirmed completion remains visible with automatic scheduling paused', () => {
  expect(cloudSyncProgress(state('paused'), false, '').value).toBe(1);
  expect(cloudSyncProgress(state('paused', { lastSuccessAt: null }), false, '').value).toBe(0);
});
test('unavailable or stale status cannot claim completion', () => {
  expect(cloudSyncProgress(state('idle'), false, 'offline').value).toBe(0);
  expect(cloudSyncProgress({ service: { ready: false } }, false, '').value).toBe(0);
  expect(cloudSyncProgress(state('idle'), true, '').value).toBeUndefined();
});
