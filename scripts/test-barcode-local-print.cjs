const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');

const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const handlerSource = main.slice(main.indexOf("ipcMain.handle('badizo:get-barcode-printers'"), main.indexOf("ipcMain.handle('badizo:cancel-barcode-print'"));

function desktop(printerNames) {
  const handlers = new Map();
  const scripts = [];
  const writes = [];
  const context = {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    os: { hostname: () => 'ADMIN1', tmpdir: () => 'C:\\Temp' },
    path: path.win32,
    fs: { writeFileSync: (...args) => writes.push(args), unlinkSync() {} },
    process: { pid: 4321 }, Buffer, logMessage() {},
    startBarcodeQueueSafetyMonitor: () => ({ kill() {} }),
    execFileAsync: async (_file, args) => {
      scripts.push(Buffer.from(args.at(-1), 'base64').toString('utf16le'));
      return { stdout: '73\r\n' };
    }
  };
  vm.runInNewContext(handlerSource, context);
  const event = { sender: { getPrintersAsync: async () => printerNames.map((name) => ({ name, displayName: name })) } };
  return { handlers, event, scripts, writes };
}

test('Windows inventory returns actual workstation and printer names', async () => {
  const app = desktop(['TSC TE244 (Copy 1)']);
  const result = await app.handlers.get('badizo:get-barcode-printers')(app.event);
  assert.equal(result.systemName, 'ADMIN1');
  assert.equal(result.printers[0].name, 'TSC TE244 (Copy 1)');
});

test('missing configured printer fails before any spool or file write', async () => {
  const app = desktop(['TSC TE244 (Copy 1)']);
  await assert.rejects(app.handlers.get('badizo:print-barcode-prn')(app.event, { prn: 'PRINT 1,1', shareName: 'TSC TE244' }), /not installed on ADMIN1/);
  assert.equal(app.scripts.length, 0);
  assert.equal(app.writes.length, 0);
});

test('RAW print targets exact installed queue, supports quotes and parentheses, and parses in PowerShell', async () => {
  const printerName = "TSC TE244 (Admin's printer)";
  const app = desktop([printerName, 'TSC Server Printer']);
  const result = await app.handlers.get('badizo:print-barcode-prn')(app.event, { prn: 'CLS\r\nPRINT 1,1', shareName: printerName });
  assert.equal(result.raw_job_id, 73);
  assert.equal(result.printer_name, printerName);
  const script = app.scripts[0];
  assert.ok(script.includes("$printerName='TSC TE244 (Admin''s printer)'"));
  assert.ok(script.includes('[BadizoRaw]::Send($printerName,'));
  assert.ok(!script.includes('Get-Printer'));
  assert.ok(!script.includes('TSC Server Printer'));
  if (process.platform === 'win32') {
    const encoded = Buffer.from(script, 'utf8').toString('base64');
    const parse = `$code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($code,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {Write-Error $_.Message}; exit 1}`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parse, 'utf16le').toString('base64')], { windowsHide: true });
  }
});
