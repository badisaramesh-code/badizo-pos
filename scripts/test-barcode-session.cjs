const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/src/components/BarcodeStickersView.jsx'), 'utf8');
const key = 'badizo_barcode_printer_selections';
const saved = new Map([[key, JSON.stringify({ label: 'Existing printer' })]]);
function session(profile) {
  const ctx = { BARCODE_PRINTER_SELECTIONS_KEY: key, window: { localStorage: { getItem: k => saved.get(k) || null } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function loadBarcodePrinterSelections('), source.indexOf('function displayNumber(')), ctx);
  return ctx.loadBarcodePrinterSelections(`${key}:${profile}`);
}
test('printer preferences survive a new session and preserve existing selections', () => {
  assert.equal(session('SERVER:server').label, 'Existing printer');
  saved.set(`${key}:SERVER:server`, JSON.stringify({ label: 'Server printer' }));
  saved.set(`${key}:ADMIN:admin1`, JSON.stringify({ label: 'Admin1 printer' }));
  assert.equal(session('SERVER:server').label, 'Server printer');
  assert.equal(session('ADMIN:admin1').label, 'Admin1 printer');
  assert.equal(session('SERVER:server').label, 'Server printer');
});
for (const server of [true, false]) test(`${server ? 'Server' : 'Admin1'} printing retains its route and saves the successful printer`, async () => {
  const calls = [];
  const storageKey = `${key}:${server ? 'SERVER:server' : 'ADMIN:admin1'}`;
  const ctx = { useServerPrinter: server, printerStorageKey: storageKey, printerSelections: {}, form: { barcode: '123', product_name: 'Sample', mrp: 1, sale_price: 1 }, selectedPrinterName: server ? 'Server printer' : 'Admin1 printer', templateName: 'label', moneyTwoDecimals: String,
    window: { localStorage: { setItem: (k, v) => saved.set(k, v) }, badizoDesktop: { getBarcodePrinters: async () => { calls.push('inventory'); return { printers: [{ name: 'Admin1 printer' }] }; }, printBarcodePrn: async () => { calls.push('local'); return {}; } }, setTimeout() {} },
    generateBarcodePrn: async () => { calls.push('generate'); return { prn: 'PRINT 1,1', output_name: 'sample.prn' }; }, printBarcodePrn: async () => { calls.push('server'); return {}; },
    setErrorMessage: m => { if (m) throw Error(m); }, setStatusMessage() {}, setIsPrinting() {}, setPrn() {}, setOutputInfo() {}, setActivePrintJob() {}, setSuggestions() {}, setForm() {}, setLocalPrinters() {}, setPrinterSelections() {}, stickerCountRef: {} };
  vm.createContext(ctx);
  await vm.runInContext(source.slice(source.indexOf('  async function generatePrn('), source.indexOf('  async function cancelActivePrint(')) + '\ngeneratePrn({sendToPrinter:true})', ctx);
  assert.deepEqual(calls, server ? ['generate', 'server'] : ['inventory', 'generate', 'local']);
  assert.equal(session(server ? 'SERVER:server' : 'ADMIN:admin1').label, ctx.selectedPrinterName);
});
