const test = require('node:test');
const assert = require('node:assert/strict');
const { validateShop, validateFleet, deploymentPlan } = require('../../tools/fleet/shop-config.cjs');
const example = require('../../tools/fleet/shops.example.json')[0];
test('fleet onboarding cannot enable transfers or reuse identities', () => {
  assert.throws(() => validateShop({...example, sync:{...example.sync,enabled:true}}));
  assert.throws(() => validateFleet([example,example]));
  assert.throws(() => validateFleet([example,{...example,shopId:'HFM002'}]));
  assert.throws(() => validateShop({...example,cloudInstallationId:example.localInstallationId}));
});
test('configuration rejects secrets, path injection and unverified MySQL versions', () => {
  assert.throws(() => validateShop({...example,password:'secret'}));
  assert.throws(() => validateShop({...example,shopId:'../HFM001'}));
  assert.throws(() => validateShop({...example,mysqlVersion:'9.7.0'}));
});
test('plan stays read only and gives each shop a distinct state directory', () => {
  const plan=deploymentPlan(example);
  assert.equal(plan.productionChangesApplied,false);
  assert.equal(plan.cloudRole,'cloud-standby');
  assert.notEqual(plan.cloudStateDirectory,deploymentPlan({...example,shopId:'HFM002'}).cloudStateDirectory);
});
