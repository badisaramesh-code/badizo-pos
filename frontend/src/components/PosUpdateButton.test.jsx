import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import PosUpdateButton from './PosUpdateButton';
import api from '../api/client';

jest.mock('../api/client', () => ({get:jest.fn(), post:jest.fn()}));

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
    expect(element.textContent).toContain('Update available');
    await act(async () => element.querySelector('button').click());
    expect(api.post).toHaveBeenCalledWith('/shop-maintenance',{action:'update',target});
    status = {...status, job:{target,action:'update',state:'succeeded'}};
    await act(async () => jest.advanceTimersByTime(5000));
    expect(reopenUpdatedPos).not.toHaveBeenCalled();
    status = {...status, runningCommit:target};
    await act(async () => jest.advanceTimersByTime(5000));
    expect(reopenUpdatedPos).toHaveBeenCalledTimes(1);
    expect(element.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    delete window.badizoDesktop;
    confirm.mockRestore();
    sessionStorage.clear();
    jest.useRealTimers();
  }
});
