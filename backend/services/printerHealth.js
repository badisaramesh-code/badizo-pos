const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function queueState(printer) {
  const driver = String(printer.DriverName || '');
  if (/Microsoft Print To PDF|Microsoft XPS Document Writer|Send To Microsoft OneNote|OneNote \(Desktop\)|^Fax$/i.test(driver)) return 'virtual';
  const status = String(printer.PrinterStatus ?? '').trim();
  if (printer.WorkOffline || /offline|error|paused|paper|unavailable|notavailable|intervention|jam|dooropen/i.test(status)) return 'attention';
  if (/^(normal|idle|printing|processing|busy|0)$/i.test(status)) return 'ready';
  return 'unknown';
}

async function readPrinterHealth({ platform = process.platform, execute = run } = {}) {
  if (platform !== 'win32') return { ok: false, state: 'unavailable', note: 'Server printer checks require Windows.', printers: [] };
  try {
    const command = "$ErrorActionPreference='Stop'; Get-Printer | Select-Object Name,DriverName,PortName,@{Name='PrinterStatus';Expression={[string]$_.PrinterStatus}},WorkOffline,Default,Shared,ShareName | ConvertTo-Json -Depth 3";
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 8000 });
    const value = JSON.parse(String(stdout || '').trim() || '[]');
    const printers = (Array.isArray(value) ? value : [value]).filter(printer => printer?.Name)
      .map(printer => ({ ...printer, healthState: queueState(printer) }));
    const physical = printers.filter(printer => printer.healthState !== 'virtual');
    const state = physical.some(printer => printer.healthState === 'attention') ? 'attention' :
      physical.length && physical.every(printer => printer.healthState === 'ready') ? 'ready' : 'unknown';
    let note = 'Check the selected queue in Windows Printers & scanners.';
    if (state === 'ready') note = 'Windows reports these server queues available. Use a test receipt or label to confirm paper output.';
    else if (state === 'attention') note = 'Check the affected queue for paused jobs, offline mode, or missing paper.';
    else if (!physical.length) note = 'Install or share the receipt or label printer on this server if it handles printing.';
    return { ok: state === 'ready', state, note, printers };
  } catch {
    return { ok: false, state: 'unavailable', note: 'Printer inventory is unavailable. Check Windows Print Spooler and the POS service account permissions.', printers: [] };
  }
}

module.exports = { readPrinterHealth };
