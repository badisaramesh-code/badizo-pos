const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readPrinterHealth } = require('../services/printerHealth');

function inspect(printers) {
  return readPrinterHealth({ platform: 'win32', execute: async () => ({ stdout: JSON.stringify(printers) }) });
}

test('a virtual printer or unknown queue does not confirm receipt or label availability', async () => {
  const report = await inspect([{ Name: 'PDF', DriverName: 'Microsoft Print To PDF', PrinterStatus: 'Normal' },
    { Name: 'TSC', PrinterStatus: 'Unknown' }]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.printers.map(queue => queue.healthState), ['virtual', 'unknown']);
});
test('an offline queue is visible even when another server printer is ready', async () => {
  const report = await inspect([{ Name: 'Receipt', PrinterStatus: 0 }, { Name: 'TSC', PrinterStatus: 'Offline' }]);
  assert.equal(report.state, 'attention');
  assert.deepEqual(report.printers.map(queue => queue.healthState), ['ready', 'attention']);
});
test('single-object Windows output, empty inventory, permission errors and Linux are distinguished', async () => {
  assert.equal((await inspect({ Name: 'TSC', PrinterStatus: 'Normal' })).ok, true);
  assert.equal((await inspect([])).state, 'unknown');
  const denied = await readPrinterHealth({ platform: 'win32', execute: async () => { throw Error('private information'); } });
  assert.equal(denied.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(denied), /private information/);
  assert.equal((await readPrinterHealth({ platform: 'linux' })).state, 'unavailable');
});
