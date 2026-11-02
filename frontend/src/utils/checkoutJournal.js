// One unresolved checkout per counter. Never infer a failed commit from a
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
  return {read,prepare,clear};
}
