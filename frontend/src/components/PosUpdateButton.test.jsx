import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import PosUpdateButton from './PosUpdateButton';
import api from '../api/client';

jest.mock('../api/client', () => ({get:jest.fn(), post:jest.fn()}));
beforeEach(()=>{global.IS_REACT_ACT_ENVIRONMENT=true;});
afterEach(()=>{delete global.IS_REACT_ACT_ENVIRONMENT;});

test('requests the displayed version and reopens only after the server reports that version running', async () => {
  jest.useFakeTimers();
  const target = 'a'.repeat(40);
  const original = 'b'.repeat(40);
  let status = {target, runningCommit:original, actions:['update']};
  api.get.mockImplementation(async () => ({data:status}));
  api.post.mockResolvedValue({});
  const confirm = jest.spyOn(window,'confirm').mockReturnValue(true);
  const reopenUpdatedPos = jest.fn().mockResolvedValue(true);
  window.badizoDesktop = {reopenUpdatedPos};
  const element = document.createElement('div');
  const root = createRoot(element);
  try {
    await act(async () => root.render(<PosUpdateButton/>));
    expect(element.textContent).toContain('Update Version');expect(element.textContent).toContain('Available');
    await act(async () => element.querySelector('button').click());
    expect(api.post).toHaveBeenCalledWith('/shop-maintenance',{action:'update',target});
    status = {...status, job:{target,action:'update',state:'succeeded'}};
    await act(async () => jest.advanceTimersByTime(5000));
    expect(reopenUpdatedPos).not.toHaveBeenCalled();
    status = {...status, runningCommit:target};
    await act(async () => jest.advanceTimersByTime(5000));
    expect(reopenUpdatedPos).toHaveBeenCalledTimes(1);
    expect(element.querySelector('button').textContent).toContain('Update Version');
  } finally {
    await act(async () => root.unmount());
    delete window.badizoDesktop;
    confirm.mockRestore();
    sessionStorage.clear();
    jest.useRealTimers();
  }
});


test.each([{configured:false},{configured:true,runningCommit:'a'.repeat(40),target:'a'.repeat(40),actions:['update']}])('always shows Update Version and opens maintenance without pretending to install',async status=>{
 api.get.mockResolvedValue({data:status});api.post.mockClear();const open=jest.fn();const element=document.createElement('div'),root=createRoot(element);
 try{await act(async()=>root.render(<PosUpdateButton onOpenMaintenance={open}/>));expect(element.textContent).toContain('Update Version');await act(async()=>element.querySelector('button').click());expect(open).toHaveBeenCalledTimes(1);expect(api.post).not.toHaveBeenCalled();}
 finally{await act(async()=>root.unmount());sessionStorage.clear();}
});
