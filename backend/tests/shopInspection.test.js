const test=require('node:test');
const assert=require('node:assert/strict');
const {assessReplication}=require('../../tools/fleet/inspect-shop.cjs');
const eligible={version:'8.0.46',log_bin:'ON',binlog_format:'ROW',gtid_mode:'ON',server_id:'1'};
test('inspection never treats server settings alone as a ready sync connection',()=>{
  const result=assessReplication(eligible,[{engine:'InnoDB'}]);
  assert.equal(result.eligibleForFurtherValidation,true);
  assert.equal(result.readyForSync,false);
});
test('missing logging and nontransactional tables block incremental onboarding',()=>{
  assert.equal(assessReplication({},[]).eligibleForFurtherValidation,false);
  assert.equal(assessReplication(eligible,[{engine:'MyISAM'}]).eligibleForFurtherValidation,false);
  assert.equal(assessReplication({...eligible,log_bin:'OFF'},[]).eligibleForFurtherValidation,false);
});
