'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {legacyInvoicePolicy}=require('../services/legacyInvoicePolicy');
function service(env={}) {
  const deps={'../config/db':{},'../utils/formatters':{normalizeCounterNo:x=>x},'./financialYearService':{getFinancialYear:()=> '26-27'},'./runtimePolicy':{invoicePrefix:()=> 'BZ'},'./legacyInvoicePolicy':{legacyInvoicePolicy:()=>legacyInvoicePolicy(env)},'./recoveryInvoiceNumbers':{escapeLike:require('../services/recoveryInvoiceNumbers').escapeLike}};
  const context={module:{exports:{}},require(name){if(!(name in deps))throw Error(name);return deps[name];}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../services/invoiceNumberService'),'utf8'),context);return context.module.exports;
}
test('default invoice format remains unchanged; legacy format is opt-in',()=>{
  assert.equal(service().formatInvoiceNo('26-27',2,42),'BZ/26-27/C02/000042');
  assert.equal(service({BADIZO_LEGACY_INVOICE_PREFIX:'TEST'}).formatInvoiceNo('26-27',2,42),'TEST/26-27/042');
});
test('legacy numbering cannot override cloud or recovered invoice namespaces',()=>{
  const env={BADIZO_LEGACY_INVOICE_PREFIX:'TEST'};
  assert.equal(legacyInvoicePolicy({...env,BADIZO_NODE_ROLE:'cloud-active'}),null);
  assert.equal(legacyInvoicePolicy({...env,BADIZO_RECOVERY_INVOICE_EPOCH:'recovery'}),null);
  assert.throws(()=>legacyInvoicePolicy({...env,BADIZO_LEGACY_INVOICE_START_NUMBER:'800'}),/financial year/);
  assert.throws(()=>legacyInvoicePolicy({BADIZO_LEGACY_INVOICE_PREFIX:'bad/%'}),/prefix/);
});
test('legacy allocation preserves max of sequence, existing invoices and configured year minimum',async()=>{
  for(const [sequence,invoice,expected] of [[20,30,800],[900,30,900],[20,950,951]]) {
    const s=service({BADIZO_LEGACY_INVOICE_PREFIX:'TEST',BADIZO_LEGACY_INVOICE_START_YEAR:'26-27',BADIZO_LEGACY_INVOICE_START_NUMBER:'800'});let saved;
    const c={async query(sql,args){if(sql.includes('MAX(next_number)'))return [[{next_number:sequence}]];if(sql.includes('MAX(CAST')){assert.deepEqual(Array.from(args),['BZ/26-27/C%/%','TEST/26-27/%']);return [[{sequence_no:invoice}]];}saved=args[1];return [[]];}};
    await s.ensureSequenceRow(c,'26-27');assert.equal(saved,expected);
  }
});
