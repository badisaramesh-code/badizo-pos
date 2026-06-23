const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const express = require('express');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { print: printPdf } = require('pdf-to-printer');

const DEFAULT_APP_URL = 'http://localhost:3000';
const DEFAULT_API_URL = 'http://localhost:5000/api/health';
const DEFAULT_BACKEND_PORT = 5000;
const DEFAULT_FRONTEND_PORT = 3000;
const servers = [];
let mainWindow = null;

function logMessage(message) {
  try {
    const logPath = path.join(app.getPath('userData'), 'badizo-desktop.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch (_err) {
    // Logging is best-effort only.
  }
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function getConfig() {
  const configPaths = [
    path.join(app.getPath('userData'), 'app-config.json'),
    path.join(process.cwd(), 'app-config.json'),
    path.join(__dirname, 'app-config.json'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app-config.json') : ''
  ];

  const config = configPaths.map(readJsonIfExists).find(Boolean) || {};
  return {
    appUrl: process.env.BADIZO_APP_URL || config.appUrl || DEFAULT_APP_URL,
    apiHealthUrl: process.env.BADIZO_API_HEALTH_URL || config.apiHealthUrl || DEFAULT_API_URL,
    backendPort: Number(process.env.BADIZO_BACKEND_PORT || config.backendPort || DEFAULT_BACKEND_PORT),
    frontendPort: Number(process.env.BADIZO_FRONTEND_PORT || config.frontendPort || DEFAULT_FRONTEND_PORT),
    startBackend: config.startBackend !== false,
    startFrontend: config.startFrontend !== false,
    loginMode: ['server', 'admin', 'counter', 'all'].includes(String(config.loginMode || '').toLowerCase())
      ? String(config.loginMode).toLowerCase()
      : '',
    kiosk: Boolean(config.kiosk),
    devTools: Boolean(config.devTools)
  };
}

function withLoginMode(appUrl, loginMode) {
  if (!loginMode) return appUrl;
  try {
    const url = new URL(appUrl);
    url.searchParams.set('loginMode', loginMode);
    return url.toString();
  } catch (_err) {
    const separator = String(appUrl || '').includes('?') ? '&' : '?';
    return `${appUrl}${separator}loginMode=${encodeURIComponent(loginMode)}`;
  }
}

function resolveResourcePath(...parts) {
  const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, ...parts) : '';
  if (packagedPath && fs.existsSync(packagedPath)) return packagedPath;
  return path.join(__dirname, '..', ...parts);
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    return response.ok;
  } catch (_err) {
    return false;
  }
}

async function waitForUrl(url, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isReachable(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function startBackendIfNeeded(config) {
  logMessage(`Checking backend ${config.apiHealthUrl}`);
  if (!config.startBackend || await isReachable(config.apiHealthUrl)) return;

  const backendPath = resolveResourcePath('backend', 'server.js');
  if (!fs.existsSync(backendPath)) {
    throw new Error(`Backend server file was not found: ${backendPath}`);
  }

  const electronNodeModules = path.join(__dirname, 'node_modules');
  process.env.NODE_PATH = [process.env.NODE_PATH, electronNodeModules].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  process.env.PORT = String(config.backendPort);

  const backend = require(backendPath);
  if (!backend?.startServer) {
    throw new Error('Backend server did not expose startServer().');
  }

  const server = await backend.startServer(config.backendPort);
  servers.push(server);
  logMessage(`Started backend on ${config.backendPort}`);

  if (!await waitForUrl(config.apiHealthUrl)) {
    throw new Error(`Backend did not become ready at ${config.apiHealthUrl}`);
  }
}

async function startFrontendIfNeeded(config) {
  logMessage(`Checking frontend ${config.appUrl}`);
  if (!config.startFrontend || await isReachable(config.appUrl)) return;

  const frontendPath = resolveResourcePath('frontend');
  const indexPath = path.join(frontendPath, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Frontend build was not found: ${frontendPath}. Run npm run build in frontend before packaging.`);
  }

  const frontendApp = express();
  frontendApp.use(express.static(frontendPath));
  frontendApp.get('*', (_req, res) => res.sendFile(indexPath));

  const server = await new Promise((resolve, reject) => {
    const staticServer = frontendApp.listen(config.frontendPort, () => resolve(staticServer));
    staticServer.on('error', reject);
  });
  servers.push(server);
  logMessage(`Started frontend on ${config.frontendPort}`);

  if (!await waitForUrl(config.appUrl)) {
    throw new Error(`Frontend did not become ready at ${config.appUrl}`);
  }
}

async function startLocalServices(config) {
  await startBackendIfNeeded(config);
  await startFrontendIfNeeded(config);
}

function showStartupError(error, appUrl) {
  dialog.showErrorBox(
    'Badizo could not open',
    `Unable to open ${appUrl}.\n\nCheck that MySQL is running and the Badizo database settings are correct.\n\n${error.message || error}`
  );
}

function createWindow(config) {
  const appUrl = withLoginMode(config.appUrl, config.loginMode);
  logMessage(`Creating window for ${appUrl}`);
  const iconPath = resolveResourcePath('assets', 'badizo.ico');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Badizo',
    icon: iconPath,
    backgroundColor: '#f7f8fb',
    show: false,
    autoHideMenuBar: true,
    kiosk: config.kiosk,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once('ready-to-show', () => {
    logMessage('Window ready to show');
    mainWindow.maximize();
    mainWindow.show();
    if (config.devTools) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => {
    logMessage('Window closed');
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, _errorCode, errorDescription) => {
    logMessage(`Window failed load: ${errorDescription}`);
    showStartupError(new Error(errorDescription), appUrl);
  });

  mainWindow.loadURL(appUrl).catch((error) => {
    logMessage(`loadURL failed: ${error.message || error}`);
    showStartupError(error, appUrl);
  });
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

async function printThermalHtml({ html, widthMm, heightMm, printerName, feedMarginMm }) {
  if (!html || typeof html !== 'string') {
    throw new Error('Thermal print HTML is empty.');
  }

  const receiptWidthMm = clampNumber(widthMm, 80, 40, 100);
  const requestedHeightMm = Number.isFinite(Number(heightMm))
    ? clampNumber(heightMm, 0, 40, 3276)
    : 0;
  const extraFeedMm = Number.isFinite(Number(feedMarginMm))
    ? clampNumber(feedMarginMm, 0, 0, 30)
    : 0;
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await printWindow.webContents.executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true');
    await printWindow.webContents.executeJavaScript(`
      Promise.all(Array.from(document.images || []).map((image) => {
        if (image.complete) return true;
        return new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
      })).then(() => true)
    `);

    const measuredHeightPx = await printWindow.webContents.executeJavaScript(`
      (() => {
        const receipt = document.querySelector('.thermal-paper, .counter-sale-slip, .handover-print-sheet');
        const values = [
          receipt?.scrollHeight || 0,
          receipt?.offsetHeight || 0,
          receipt?.getBoundingClientRect?.().height || 0,
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0
        ];
        return Math.ceil(Math.max(...values.filter((value) => Number.isFinite(value))));
      })()
    `);
    const measuredHeightMm = Math.ceil((measuredHeightPx * 25.4) / 96) + extraFeedMm;
    const effectiveHeightMm = clampNumber(Math.max(requestedHeightMm, measuredHeightMm, 40), 80, 40, 3276);
    const finalPageCss = `
      @page { size: ${receiptWidthMm}mm ${effectiveHeightMm}mm; margin: 0; }
      html, body {
        width: ${receiptWidthMm}mm !important;
        min-width: ${receiptWidthMm}mm !important;
        max-width: ${receiptWidthMm}mm !important;
        height: auto !important;
        min-height: 0 !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
      }
    `;
    await printWindow.webContents.executeJavaScript(`
      (() => {
        const style = document.createElement('style');
        style.setAttribute('data-badizo-final-page', 'true');
        style.textContent = ${JSON.stringify(finalPageCss)};
        document.head.appendChild(style);
        return true;
      })()
    `);

    const printers = await printWindow.webContents.getPrintersAsync();
    const selectedPrinter = printerName
      || printers.find((printer) => printer.isDefault)?.name
      || printers.find((printer) => /EPSON.*TM|TM-T82|Receipt/i.test(printer.name))?.name
      || '';

    logMessage(`Thermal HTML PDF print: printer=${selectedPrinter || '(default)'} widthMm=${receiptWidthMm} heightMm=${effectiveHeightMm} measuredPx=${measuredHeightPx}`);

    const pdf = await printWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      marginsType: 1,
      pageSize: {
        width: Math.ceil(receiptWidthMm * 1000),
        height: Math.ceil(effectiveHeightMm * 1000)
      }
    });

    const outputDir = path.join(os.tmpdir(), 'badizo-thermal-print');
    fs.mkdirSync(outputDir, { recursive: true });
    const pdfPath = path.join(outputDir, `receipt-${Date.now()}.pdf`);
    fs.writeFileSync(pdfPath, pdf);
    const debugDir = path.join(app.getPath('userData'), 'thermal-debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const debugPdfPath = path.join(debugDir, 'last-receipt.pdf');
    const debugHtmlPath = path.join(debugDir, 'last-receipt.html');
    fs.writeFileSync(debugPdfPath, pdf);
    fs.writeFileSync(debugHtmlPath, html, 'utf8');
    logMessage(`Thermal debug PDF saved: ${debugPdfPath}`);

    const basePrintOptions = {
      printer: selectedPrinter || undefined,
      scale: 'noscale',
      silent: true,
      orientation: 'portrait'
    };
    const longRollPaperSize = receiptWidthMm >= 76 ? 'Roll Paper 80 x 3276 mm' : 'Roll Paper 58 x 3276 mm';
    const shouldUseLongRoll = effectiveHeightMm > 297;
    const printOptions = shouldUseLongRoll
      ? { ...basePrintOptions, paperSize: longRollPaperSize }
      : basePrintOptions;

    try {
      logMessage(`Thermal PDF spool options: ${JSON.stringify({ ...printOptions, printer: printOptions.printer || '(default)' })}`);
      try {
        await printPdf(pdfPath, printOptions);
      } catch (error) {
        if (!shouldUseLongRoll) throw error;
        logMessage(`Thermal PDF print with ${longRollPaperSize} failed, retrying without explicit paperSize: ${error.message || error}`);
        await printPdf(pdfPath, basePrintOptions);
      }
    } finally {
      fs.unlink(pdfPath, () => {});
    }

    return { ok: true, printerName: selectedPrinter || null, widthMm: receiptWidthMm, heightMm: effectiveHeightMm, method: 'pdf-to-printer' };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

ipcMain.handle('badizo:print-thermal-html', async (_event, payload) => {
  return printThermalHtml(payload || {});
});

async function printHtml({ html, mode, widthMm, heightMm, printerName, silent }) {
  if (!html || typeof html !== 'string') {
    throw new Error('Print HTML is empty.');
  }

  const normalizedMode = mode === 'Thermal' ? 'Thermal' : 'A4';
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await printWindow.webContents.executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true');

    const printers = await printWindow.webContents.getPrintersAsync();
    const selectedPrinter = printerName
      || printers.find((printer) => printer.isDefault)?.name
      || '';

    const options = {
      silent: Boolean(silent),
      printBackground: true,
      deviceName: selectedPrinter || undefined,
      margins: { marginType: 'none' },
      pageSize: normalizedMode === 'A4'
        ? 'A4'
        : {
          width: Math.ceil(clampNumber(widthMm, 80, 40, 100) * 1000),
          height: Math.ceil(clampNumber(heightMm, 297, 40, 3276) * 1000)
        }
    };

    logMessage(`Native HTML print: mode=${normalizedMode} printer=${selectedPrinter || '(dialog/default)'}`);
    const result = await new Promise((resolve, reject) => {
      printWindow.webContents.print(options, (success, failureReason) => {
        if (success) resolve({ ok: true });
        else reject(new Error(failureReason || 'Print was cancelled or failed.'));
      });
    });

    return { ...result, printerName: selectedPrinter || null, method: 'electron-print' };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

ipcMain.handle('badizo:print-html', async (_event, payload) => {
  return printHtml(payload || {});
});

app.whenReady().then(async () => {
  const config = getConfig();
  logMessage('App ready');
  try {
    await startLocalServices(config);
    createWindow(config);
  } catch (err) {
    logMessage(`Startup error: ${err.stack || err.message || err}`);
    showStartupError(err, config.appUrl);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  servers.forEach((server) => server.close());
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(getConfig());
});
