const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {sharedStateFile}=require('../services/recoveryControlFiles');
const root=path.resolve('policy-fixture'),c={gid:123,bindingPath:path.join(root,'private','binding.json'),directory:path.join(root,'control'),uploadDirectory:path.join(root,'uploads')};
test('root supervisor sharing includes only exact POS-readable status artifacts',()=>{
 for(const f of [c.bindingPath,path.join(c.directory,'heartbeat.json'),path.join(c.directory,'operation.json'),path.join(c.uploadDirectory,'activation-history.json'),path.join(c.uploadDirectory,'01234567-0123-0123-0123-0123456789ab','upload.json')])assert.equal(sharedStateFile(f,c),true);
 for(const f of [path.join(c.directory,'rollback-binding.json'),path.join(root,'private','fence.json'),path.join(c.uploadDirectory,'01234567-0123-0123-0123-0123456789ab','restore-config.json'),path.join(c.uploadDirectory,'01234567-0123-0123-0123-0123456789ab','previous-binding.json'),path.join(c.uploadDirectory,'not-an-id','upload.json'),path.join(root,'slot.json')])assert.equal(sharedStateFile(f,c),false);
 assert.throws(()=>sharedStateFile(c.bindingPath,{...c,gid:-1}));
});
