import React, { useEffect, useState } from 'react';
import { fetchCloudRuntimeStatus } from '../api/client';

export default function CloudStatusBanner() {
  const [runtime, setRuntime] = useState(null);
  useEffect(() => {
    if (process.env.REACT_APP_BADIZO_CLOUD_BUILD !== 'true') return undefined;
    let mounted = true;
    const refresh = () => fetchCloudRuntimeStatus().then(value => { if (mounted) setRuntime(value); }).catch(() => { if (mounted) setRuntime(null); });
    refresh();
    const timer = window.setInterval(refresh, 30000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  if (process.env.REACT_APP_BADIZO_CLOUD_BUILD !== 'true') return null;
  const active = runtime?.ok && runtime.nodeRole === 'cloud-active';
  const standby = runtime?.ok && runtime.nodeRole === 'cloud-standby';
  return <div role="status" style={{ padding: '10px 18px', background: active ? '#fff0cc' : '#e7f2ef', color: '#153c32', borderBottom: '1px solid #91b5a8', fontWeight: 600 }}>
    {standby ? 'Cloud standby — sales are blocked. The local shop server remains primary.' : active ? 'Cloud billing active — keep local billing and incoming sync stopped.' : 'Cloud status is not verified. Check the server connection before billing.'}
  </div>;
}
