import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import BackupUploadRecovery from './BackupUploadRecovery';
import api, { getStoredUser } from '../api/client';
jest.mock('../api/client', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() }, getStoredUser: jest.fn() }));
let container, root;
const status = () => ({ configured: true, nodeRole: 'cloud-standby', generation: 2, billingMode: 'standby', phase: 'active',
  supervisorOnline: true, canReplace: true, maxUploadBytes: 1024 * 1024, job: null });
const button = text => [...container.querySelectorAll('button')].find(value => value.textContent === text);
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true; jest.useFakeTimers(); sessionStorage.clear();
  getStoredUser.mockReturnValue({ role: 'SERVER' }); api.get.mockResolvedValue({ data: status() }); api.post.mockReset();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.clearAllMocks(); jest.useRealTimers(); delete global.IS_REACT_ACT_ENVIRONMENT; });
test('counters and admins do not expose or request upload recovery', async () => {
  for (const role of ['COUNTER', 'ADMIN']) {
    getStoredUser.mockReturnValue({ role }); await act(async () => root.render(<BackupUploadRecovery />));
    expect(container.textContent).toBe('');
  }
  expect(api.get).not.toHaveBeenCalled();
});
test.each(['local-server','cloud-standby'])('%s uses the explicit upload and guarded activation workflow', async nodeRole => {
  api.get.mockResolvedValue({data:{...status(),nodeRole}});
  await act(async () => root.render(<BackupUploadRecovery />));
  const file = new File(['-- dump'], 'badizo_daily.sql', { type: 'application/sql' });
  await act(async () => Simulate.change(container.querySelector('input[type=file]'), { target: { files: [file] } }));
  api.post.mockResolvedValueOnce({ data: { id: 'upload-id', filename: file.name, state: 'uploaded' } });
  await act(async () => Simulate.click(button('Upload backup')));
  expect(api.post.mock.calls[0][0]).toBe('/backup-recovery/uploads');
  expect(api.post.mock.calls[0][1]).toBe(file);
  expect(api.post.mock.calls[0][2].headers['Content-Type']).toBe('application/octet-stream');
  const recover = button('Recover and start '+(nodeRole==='local-server'?'local':'cloud')+' billing'); expect(recover.disabled).toBe(true);
  for (const checkbox of container.querySelectorAll('input[type=checkbox]')) await act(async () => Simulate.change(checkbox, { target: { checked: true } }));
  expect(recover.disabled).toBe(false);
  api.post.mockResolvedValueOnce({ data: { id: 'operation-id', state: 'queued' } });
  await act(async () => Simulate.click(recover));
  expect(api.post.mock.calls[1].slice(0,2)).toMatchObject(['/backup-recovery/recover', {
    uploadId: 'upload-id', expectedGeneration: 2, peerBillingStopped: true, backupAgeAccepted: true,
    confirmation: 'REPLACE WITH UPLOADED BACKUP AND START BILLING'
  }]);
});
test('active cloud refuses replacement', async () => {
  api.get.mockResolvedValue({ data: { ...status(), canReplace: false, billingMode: 'active' } });
  await act(async () => root.render(<BackupUploadRecovery />));
  expect(container.querySelector('input[type=file]').disabled).toBe(true);
  expect(button('Upload backup').disabled).toBe(true);
});
test('a paused recovered cloud still refuses old-backup replacement until reviewed re-baseline',async()=>{
  api.get.mockResolvedValue({data:{...status(),generation:4,billingMode:'standby',canReplace:false,canUpload:false,requiresReviewedRebaseline:true}});
  await act(async()=>root.render(<BackupUploadRecovery/>));
  expect(button('Upload backup').disabled).toBe(true);
  expect(container.textContent).toContain('Pausing billing does not allow another backup to overwrite it');
});
