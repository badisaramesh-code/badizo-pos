// A queued request is not a completed transfer. Only confirmed completion fills the bar.
export function cloudSyncProgress(status, requesting, refreshError) {
  if (refreshError) return { label: 'Status unavailable', detail: 'Reconnecting automatically. Sync completion cannot be confirmed yet.', value: 0 };
  if (requesting) return { label: 'Queuing sync…', detail: 'Waiting for the server to accept your request.' };
  if (!status?.service?.ready) return { label: 'Sync unavailable', detail: 'Check the cloud connection setup.', value: 0 };
  if (status.transfersPaused) return { label: 'Sync paused', detail: 'Pending changes are kept. Any batch already in progress can finish.', value: 0 };
  const phase = status.service.state;
  if (phase === 'retrying') return { label: 'Needs attention — retrying', detail: 'Sync has not completed. Pending changes are retained for retry.', value: 0 };
  if (phase === 'running' || phase === 'pending') return { label: 'Syncing…', detail: 'Exchanging pending changes. You can continue billing.' };
  if (phase === 'waiting') return { label: 'Waiting to sync…', detail: 'The server is busy. Sync has not completed yet.' };
  if (status.manualPending) return { label: 'Sync queued…', detail: 'The server will start the update shortly.' };
  if (status.lastSuccessAt && ['idle', 'paused'].includes(phase)) return { label: 'Last sync completed', detail: 'The server confirmed the last sync finished. New changes may still need the next sync.', value: 1 };
  return { label: 'Ready to sync', detail: 'No completed sync has been confirmed yet.', value: 0 };
}
