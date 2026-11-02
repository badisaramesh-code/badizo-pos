const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {loadManifest,statements,definition}=require('../services/syncSchemaInstaller');
test('release pins every optional sync table and only permits additive infrastructure',async()=>{
  const {migrations}=await loadManifest(path.resolve(__dirname,'../../database/migrations'));
  assert.equal(migrations.flatMap(m=>m.steps).length,11);
  for(const sql of ['DROP TABLE invoices;','ALTER TABLE products ADD COLUMN x INT;','CREATE TABLE invoices (id INT) ENGINE=InnoDB;'])assert.throws(()=>statements(sql));
});
test('schema verification ignores only table name, temporary marker and next sequence',()=>{
  assert.equal(definition({ddl:'CREATE TEMPORARY TABLE `probe` (id int) ENGINE=InnoDB'}),definition({ddl:'CREATE TABLE `sync_outbox` (id int) ENGINE=InnoDB AUTO_INCREMENT=55'}));
  assert.notEqual(definition({ddl:'CREATE TABLE `a` (id bigint) ENGINE=InnoDB'}),definition({ddl:'CREATE TABLE `b` (id int) ENGINE=InnoDB'}));
});
