// One active checkout plus preserved parked checkouts per counter. Never infer a failed commit from a
// timeout, or silently move an unresolved request to another server.
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,ordered(value[key])])):value;
export function createCheckoutJournal(storage,key){
  function read(){
    const raw=storage.getItem(key);if(!raw)return null;
    const row=JSON.parse(raw);
    if(row.schemaVersion!==1||!row.payload?.checkout_request_id||!row.server||!row.savedState)throw Error('The pending bill record needs inspection before another sale.');
    return row;
  }
  function prepare({server,payload,savedState}){
    const current=read();
    if(current){
      if(current.server!==server)throw Error('This counter has an unresolved bill on another server. Check that bill before switching.');
      if(JSON.stringify(ordered(current.payload))!==JSON.stringify(ordered(payload)))throw Error('An earlier bill is unresolved. Reload to recover its original details before making another sale.');
      return current;
    }
    const row={schemaVersion:1,server,payload,savedState,createdAt:new Date().toISOString()};
    const serialized=JSON.stringify(row);storage.setItem(key,serialized);
    if(storage.getItem(key)!==serialized)throw Error('Cannot safely save the pending bill on this counter.');
    return row;
  }
  function clear(server,id){
    const row=read();if(!row)return;
    if(row.server!==server||row.payload.checkout_request_id!==id)throw Error('Pending bill identity changed; it has not been cleared.');
    storage.removeItem(key);
  }
  const parkedKey=key+':parked';
  function parked(){const rows=JSON.parse(storage.getItem(parkedKey)||'[]');if(!Array.isArray(rows)||rows.some(r=>!r.payload?.checkout_request_id||!r.server||!r.savedState))throw Error('Pending bill list needs inspection.');return rows;}
  function saveParked(rows){const raw=JSON.stringify(rows);storage.setItem(parkedKey,raw);if(storage.getItem(parkedKey)!==raw)throw Error('Cannot safely preserve the pending bill.');}
  function park(){const row=read();if(!row)return null;const rows=parked();if(!rows.some(r=>r.server===row.server&&r.payload.checkout_request_id===row.payload.checkout_request_id))rows.push({...row,parkedAt:new Date().toISOString()});saveParked(rows);clear(row.server,row.payload.checkout_request_id);return row;}
  function resolveParked(server,id,resolution){const rows=parked();const row=rows.find(r=>r.server===server&&r.payload.checkout_request_id===id);if(!row)throw Error('Pending bill was not found.');row.resolution={...resolution,checkedAt:new Date().toISOString()};saveParked(rows);}
  return {read,prepare,clear,parked,park,resolveParked};
}
