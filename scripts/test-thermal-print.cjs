const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const source = main.slice(main.indexOf('function clampNumber('), main.indexOf("ipcMain.handle('badizo:print-thermal-html'"));

function workstation(printPdf) {
  const options = [], deleted = [], closed = [];
  class FakeWindow {
    constructor() {
      this.webContents = {
        executeJavaScript: async () => 480,
        getPrintersAsync: async () => [{ name: 'Front receipt', isDefault: true }],
        printToPDF: async value => { options.push(value); return Buffer.from('mock'); }
      };
    }
    async loadURL() {}
    isDestroyed() { return false; }
    destroy() { closed.push(true); }
  }
  const context = vm.createContext({
    BrowserWindow: FakeWindow, printPdf, logMessage() {}, path, randomUUID: require('node:crypto').randomUUID,
    app: { getPath: () => 'debug' }, os: { tmpdir: () => 'temp' },
    fs: { mkdirSync() {}, writeFileSync() {}, unlink: filename => deleted.push(filename) }
  });
  vm.runInContext(source, context);
  return { print: context.printThermalHtml, options, deleted, closed };
}
test('concurrent receipts use separate PDFs, default Windows queue and measured paper dimensions', async () => {
  const jobs = [];
  const desktop = workstation(async (file, options) => jobs.push({ file, options }));
  await Promise.all([58, 80].map(widthMm => desktop.print({ html: '<p>sale</p>', widthMm })));
  assert.equal(new Set(jobs.map(job => job.file)).size, 2);
  assert.equal(jobs.every(job => job.options.printer === 'Front receipt'), true);
  assert.deepEqual(desktop.options.map(item => item.pageSize.width).sort(), [58000, 80000]);
  assert.ok(desktop.options.every(item => item.pageSize.height === 127000));
  assert.equal(desktop.closed.length, 2);
  assert.equal(desktop.deleted.length, 2);
});
test('spool failure surfaces and removes temporary file and print window', async () => {
  const desktop = workstation(async () => { throw Error('spool unavailable'); });
  await assert.rejects(desktop.print({ html: '<p>sale</p>', widthMm: 80 }), /spool unavailable/);
  assert.equal(desktop.closed.length, 1);
  assert.equal(desktop.deleted.length, 1);
});
