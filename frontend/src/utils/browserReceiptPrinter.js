const endpoint = 'http://127.0.0.1:17493/receipt';
const helperOrigin = new URL(endpoint).origin;
const preference = 'badizo-direct-receipt-printing';
let printerWindow;
let connectedPrinter;

export function connectBrowserPrinter(onReady) {
  const setup = helperOrigin + '/#' + new URLSearchParams({ pos: window.location.origin });
  printerWindow = window.open(setup, '_blank');
  connectedPrinter = '';
  if (!printerWindow) throw Error('Allow the printer setup window to open, then try again.');
  function receive(event) {
    if (event.origin !== helperOrigin || event.source !== printerWindow || event.data?.type !== 'badizo-printer-ready') return;
    connectedPrinter = event.data.printer;
    window.localStorage.setItem(preference, '1');
    onReady(connectedPrinter);
    window.removeEventListener('message', receive);
  }
  window.addEventListener('message', receive);
}

function sendThroughPrinterWindow(image) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(Error('Printer did not confirm the job.'));
    }, 60000);
    channel.port1.onmessage = ({ data }) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      if (data.printer) resolve(data.printer);
      else reject(Error(data.error || 'Printer did not confirm the job.'));
    };
    printerWindow.postMessage({ type: 'badizo-print-receipt', image }, helperOrigin, [channel.port2]);
  });
}

export async function printOnLocalReceiptPrinter(receipt) {
  const useWindow = connectedPrinter && printerWindow && !printerWindow.closed;
  const configured = window.localStorage.getItem(preference) === '1';
  if (!useWindow && !configured && !['localhost', '127.0.0.1'].includes(window.location.hostname)) return '';
  let device;
  if (!useWindow) try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(1200), cache: 'no-store' });
    if (!response.ok) throw Error('Receipt printer unavailable.');
    device = await response.json();
    if (device.service !== 'badizo-receipt' || !device.printer) return '';
  } catch {
    // Only the availability probe ran. The caller can safely open browser print.
    return '';
  }

  const { default: html2canvas } = await import('html2canvas');
  const canvas = await html2canvas(receipt, { scale: 203 / 96, backgroundColor: '#ffffff', logging: false,
    onclone(doc) {
      // A cloned iframe can inherit the short browser viewport. Keep every item in the raster.
      for (const node of [doc.documentElement, doc.body]) {
        node.style.setProperty('height', 'auto', 'important');
        node.style.setProperty('overflow', 'visible', 'important');
      }
    }
  });
  const image = await new Promise((resolve, reject) => canvas.toBlob(blob =>
    blob ? resolve(blob) : reject(new Error('Cannot render receipt')), 'image/png'));
  if (useWindow) return sendThroughPrinterWindow(image);
  const result = await fetch(endpoint, { method: 'POST', body: image, signal: AbortSignal.timeout(60000) });
  if (!result.ok) throw new Error('Printer did not confirm the job');
  return device.printer;
}
