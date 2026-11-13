'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../services/checkoutAuditPolicy');
test('disabled optional audit produces no event writes and no history query',async()=>{
 const connection={query:async()=>{throw Error('Optional audit must stay dormant');}};
 assert.deepEqual(policy.state({}),{enabled:false,retentionDays:7});
 assert.deepEqual(await policy.record(connection,{},{ }),{skipped:true});
 assert.deepEqual(await policy.history(connection,'checkout-id',{}),[]);
});
test('enabled history is bounded to seven days and a maximum of 200 rows',async()=>{
 let query;const connection={query:async(sql,args)=>{query={sql,args};return [[{actor:'server'}]];}};
 const result=await policy.history(connection,'checkout-history-123',{BADIZO_CHECKOUT_AUDIT_ENABLED:'true'});
 assert.match(query.sql,/created_at>=CURRENT_TIMESTAMP-INTERVAL 7 DAY/);assert.match(query.sql,/LIMIT 200/);
 assert.deepEqual(query.args,['checkout-history-123']);assert.equal(result[0].actor,'server');
});
test('cleanup deletes only optional event rows in bounded batches',async()=>{
 let query;const connection={query:async sql=>{query=sql;return [{affectedRows:999}];}};
 assert.equal(await policy.prune(connection),999);
 assert.equal(query,'DELETE FROM checkout_recovery_events WHERE created_at<CURRENT_TIMESTAMP-INTERVAL 7 DAY ORDER BY created_at LIMIT 1000');
 await assert.rejects(policy.prune(connection,{limit:10000}));
});
