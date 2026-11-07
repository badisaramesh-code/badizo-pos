const test=require('node:test'),assert=require('node:assert/strict');
const {createSyncDatabasePool}=require('../services/syncDatabasePool');

test('sync uses a separate bounded pool and applies short lock waits before any work',async()=>{
  let options,released=0;const calls=[];
  const connection={query:async sql=>{calls.push(sql);return [[{ok:true}]];},release:()=>released++,destroy(){throw Error('Unexpected destroy');}};
  const pool=createSyncDatabasePool({env:{DB_NAME:'isolated_sync_test'},createPool:value=>{options=value;return {getConnection:async()=>connection};}});
  assert.equal(options.database,'isolated_sync_test');assert.equal(options.connectionLimit,4);assert.equal(options.queueLimit,8);
  await pool.query('SELECT 1');
  assert.deepEqual(calls,['SET SESSION innodb_lock_wait_timeout = 2, lock_wait_timeout = 2','SELECT 1']);assert.equal(released,1);
});

test('failed lock-wait initialization destroys connection; failed operation returns its slot',async()=>{
  let destroyed=0,released=0,failInit=true;
  const connection={query:async()=>{if(failInit)throw Error('setup failed');},execute:async()=>{throw Error('operation failed');},release:()=>released++,destroy:()=>destroyed++};
  const pool=createSyncDatabasePool({createPool:()=>({getConnection:async()=>connection})});
  await assert.rejects(pool.execute('INSERT test'),/setup failed/);assert.equal(destroyed,1);assert.equal(released,0);
  failInit=false;await assert.rejects(pool.execute('INSERT test'),/operation failed/);assert.equal(released,1);
});
