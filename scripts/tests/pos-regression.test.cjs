const test = require('node:test');
const assert = require('node:assert/strict');
const { select } = require('../pos-regression.cjs');
const suites = ['printerHealth', 'billingReliability', 'productLookup', 'reportApproval', 'newArea'].map(name => 'backend/tests/' + name + '.test.js');
test('printer edits select printer coverage and include uncategorized suites', () => {
  assert.deepEqual(select(['backend/services/printerHealth.js'], suites), [suites[4], suites[0]]);
});
test('a shared database change broadens a targeted run to every suite', () => {
  assert.deepEqual(select(['frontend/src/Barcode.jsx', 'backend/config/db.js'], suites), suites);
});
test('product changes also exercise billing', () => {
  assert.ok(select(['backend/routes/products.js'], suites).includes(suites[1]));
});
test('documentation alone has no runtime checks', () => {
  assert.deepEqual(select(['docs/README.md'], suites), []);
});
