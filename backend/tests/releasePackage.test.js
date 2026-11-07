const test=require('node:test');
const assert=require('node:assert/strict');
const {forbidden}=require('../../tools/fleet/package-release.cjs');
test('release packaging blocks credentials and operational data',()=>{
  for(const file of ['backend/.env','backend/.env.production','backend/keys/shop.pem','backend/backups/a.sql','backend/logs/access.txt','backend/local.sqlite']) assert.equal(forbidden(file),true,file);
  for(const file of ['backend/server.js','backend/routes/backup.js','backend/config/db.js','frontend/package-lock.json']) assert.equal(forbidden(file),false,file);
});
