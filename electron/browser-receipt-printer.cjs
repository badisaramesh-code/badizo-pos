// Start on the Windows counter PC: node browser-receipt-printer.cjs "Windows receipt queue"
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { print, getPrinters } = require('pdf-to-printer');

const address = '127.0.0.1';
const maxBytes = 6 * 1024 * 1024;
const pointsPerMm = 72 / 25.4;

async function receiptPdf(png) {
  if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid receipt image');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const heightMm = 72 * height / width;
  if (width < 300 || width > 800 || height < 1 || heightMm > 3276 || width * height > 18000000) {
    throw new Error('Receipt dimensions exceed the supported roll');
  }
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(png);
  const page = pdf.addPage([80 * pointsPerMm, heightMm * pointsPerMm]);
  page.drawImage(image, { x: 4 * pointsPerMm, y: 0, width: 72 * pointsPerMm, height: page.getHeight() });
  return pdf.save();
}

const defaultOrigins = ['http://127.0.0.1:5000', 'http://localhost:5000'];

function normalizeOrigin(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Enter a POS web address.');
  return url.origin;
}

async function start(initialPrinter, options = {}) {
  const port = options.port || 17493;
  const helperOrigin = 'http://' + address + ':' + port;
  const configFile = options.configFile || path.join(process.env.LOCALAPPDATA || os.homedir(), 'BadizoReceiptPrinter', 'settings.json');
  let settings = { printer: initialPrinter || '', origins: initialPrinter ? defaultOrigins : [] };
  try { settings = JSON.parse(await fs.readFile(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let busy = false;
  let saving = false;
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== address + ':' + port) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && ['/', '/setup.js'].includes(req.url)) {
      const script = req.url === '/setup.js';
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      try {
        const body = await fs.readFile(path.join(__dirname, script ? 'receipt-setup.js' : 'receipt-setup.html'));
        res.writeHead(200, { 'Content-Type': script ? 'text/javascript' : 'text/html; charset=utf-8' }).end(body);
      } catch { res.writeHead(500).end(); }
      return;
    }
    if (req.url === '/settings') {
      try {
        if (req.method === 'GET' && req.headers['x-badizo-setup'] === '1') {
          const printers = (await getPrinters()).map(p => p.name);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...settings, printers }));
          return;
        }
        if (req.method !== 'POST' || origin !== helperOrigin || req.headers['content-type'] !== 'application/json') {
          res.writeHead(403).end(); return;
        }
        if (saving) { res.writeHead(409).end('Setup is busy. Try again.'); return; }
        saving = true;
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 16000) throw Error('Too many addresses.');
          }
          const input = JSON.parse(body);
          if (!(await getPrinters()).some(p => p.name === input.printer)) throw Error('Select an installed printer.');
          const next = { printer: input.printer, origins: [...new Set(input.origins.map(normalizeOrigin))] };
          await fs.mkdir(path.dirname(configFile), { recursive: true });
          await fs.writeFile(configFile + '.tmp', JSON.stringify(next));
          await fs.rename(configFile + '.tmp', configFile);
          settings = next;
          res.writeHead(200).end('Saved');
        } finally { saving = false; }
      } catch (err) { res.writeHead(400).end(err.message); }
      return;
    }
    // The setup window relays LAN jobs and must supply the shop origin for each job.
    const caller = origin === helperOrigin ? req.headers['x-badizo-pos-origin'] : origin;
    if (!settings.printer || !settings.origins.includes(caller) || req.url !== '/receipt') {
      res.writeHead(403).end(); return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    const printer = settings.printer;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' }).end(); return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ service: 'badizo-receipt', printer })); return;
    }
    if (req.method !== 'POST' || req.headers['content-type'] !== 'image/png') { res.writeHead(415).end(); return; }
    if (busy) { res.writeHead(409).end('Printer is busy.'); return; }
    busy = true;
    let dir;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > maxBytes) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      let pdf;
      try { pdf = await receiptPdf(Buffer.concat(chunks)); }
      catch { res.writeHead(422).end('Receipt could not be rendered.'); return; }
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'badizo-counter-print-'));
      const file = path.join(dir, 'receipt.pdf');
      await fs.writeFile(file, pdf);
      await print(file, { printer, scale: 'noscale', silent: true, orientation: 'portrait', paperSize: 'Roll Paper 80 x 3276 mm' });
      res.writeHead(200).end('Sent to printer');
    } catch (err) {
      console.error('Receipt print failed:', err.message);
      if (!res.headersSent) res.writeHead(500).end('Check the printer queue.');
    } finally {
      busy = false;
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  server.requestTimeout = 20000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, address, resolve); });
  return server;
}

if (require.main === module) start(process.argv[2]).catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { receiptPdf, start };
