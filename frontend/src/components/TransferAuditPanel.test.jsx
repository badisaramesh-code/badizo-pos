import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import TransferAuditPanel from './TransferAuditPanel';
import api, { fetchCloudSyncSettings } from '../api/client';
jest.mock('../api/client', () => ({ __esModule:true, default:{get:jest.fn()}, fetchCloudSyncSettings:jest.fn() }));
let root, container;
beforeEach(() => { global.IS_REACT_ACT_ENVIRONMENT=true; container=document.createElement('div'); document.body.appendChild(container); root=createRoot(container); fetchCloudSyncSettings.mockResolvedValue({service:{ready:true,state:'Paused'}}); });
afterEach(async () => { await act(async()=>root.unmount()); container.remove(); delete global.IS_REACT_ACT_ENVIRONMENT; });
test('paused optional history preserves current backup and sync status', async () => {
 api.get.mockResolvedValue({data:{historyEnabled:false,retentionDays:7,warnings:[],rows:[{job:'Daily backup',status:'Backup job succeeded',at:new Date().toISOString()}]}});
 await act(async()=>root.render(<TransferAuditPanel/>));
 expect(container.textContent).toContain('Backup job succeeded'); expect(container.textContent).toContain('Optional transfer history is paused'); expect(container.textContent).toContain('Paused');
 expect(container.querySelector('[aria-expanded]')).toBeNull();
});
test('enabled history advertises seven days', async () => {
 api.get.mockResolvedValue({data:{historyEnabled:true,retentionDays:7,warnings:[],rows:[]}});
 await act(async()=>root.render(<TransferAuditPanel/>));
 expect(container.querySelector('[aria-expanded]').textContent).toBe('View 7-day audit history');
});
