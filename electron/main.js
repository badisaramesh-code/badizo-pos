const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const express = require('express');
const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const { print: printPdf } = require('pdf-to-printer');

const DEFAULT_APP_URL = 'http://localhost:5000';
const DEFAULT_API_URL = 'http://localhost:5000/api/health';
const DEFAULT_BACKEND_PORT = 5000;
const DEFAULT_FRONTEND_PORT = 5000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 9000;
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
  const configuredAppUrl = process.env.BADIZO_APP_URL || config.appUrl || DEFAULT_APP_URL;
  const configuredApiHealthUrl = process.env.BADIZO_API_HEALTH_URL || config.apiHealthUrl || DEFAULT_API_URL;
  const loginFromUrl = getLoginParamsFromUrl(configuredAppUrl);
  const appHost = getUrlHost(configuredAppUrl);
  const apiHost = getUrlHost(configuredApiHealthUrl);
  const usesRemoteServer = isRemoteHost(appHost) || isRemoteHost(apiHost);
  return {
    appUrl: configuredAppUrl,
    apiHealthUrl: configuredApiHealthUrl,
    backendPort: Number(process.env.BADIZO_BACKEND_PORT || config.backendPort || DEFAULT_BACKEND_PORT),
    frontendPort: Number(process.env.BADIZO_FRONTEND_PORT || config.frontendPort || DEFAULT_FRONTEND_PORT),
    startBackend: usesRemoteServer ? false : config.startBackend !== false,
    startFrontend: usesRemoteServer ? false : config.startFrontend !== false,
    serverHosts: parseServerHosts(process.env.BADIZO_SERVER_HOSTS || config.serverHosts || config.serverHost || ''),
    discoveryEnabled: config.discoveryEnabled !== false,
    discoveryTimeoutMs: Number(config.discoveryTimeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS),
    loginMode: ['server', 'admin', 'counter', 'all'].includes(String(config.loginMode || '').toLowerCase())
      ? String(config.loginMode).toLowerCase()
      : loginFromUrl.loginMode,
    loginUser: String(config.loginUser || loginFromUrl.loginUser || '').trim().toLowerCase(),
    kiosk: Boolean(config.kiosk),
    devTools: Boolean(config.devTools)
  };
}

function getLoginParamsFromUrl(appUrl) {
  try {
    const url = new URL(appUrl);
    const loginMode = String(url.searchParams.get('loginMode') || '').trim().toLowerCase();
    return {
      loginMode: ['server', 'admin', 'counter', 'all'].includes(loginMode) ? loginMode : '',
      loginUser: String(url.searchParams.get('loginUser') || '').trim().toLowerCase()
    };
  } catch (_err) {
    return { loginMode: '', loginUser: '' };
  }
}

function parseServerHosts(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return values.map((host) => String(host || '').trim()).filter(Boolean);
}

function withLoginParams(appUrl, loginMode, loginUser) {
  if (!loginMode && !loginUser) return appUrl;
  try {
    const url = new URL(appUrl);
    if (loginMode) url.searchParams.set('loginMode', loginMode);
    if (loginUser) url.searchParams.set('loginUser', loginUser);
    return url.toString();
  } catch (_err) {
    const params = [];
    if (loginMode) params.push(`loginMode=${encodeURIComponent(loginMode)}`);
    if (loginUser) params.push(`loginUser=${encodeURIComponent(loginUser)}`);
    const separator = String(appUrl || '').includes('?') ? '&' : '?';
    return `${appUrl}${separator}${params.join('&')}`;
  }
}

function resolveResourcePath(...parts) {
  const packagedPath = process.resourcesPath ? path.join(process.resourcesPath, ...parts) : '';
  if (packagedPath && fs.existsSync(packagedPath)) return packagedPath;
  return path.join(__dirname, '..', ...parts);
}

function resolveFrontendBuildPath() {
  const candidates = [
    resolveResourcePath('frontend'),
    resolveResourcePath('frontend', 'build')
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html'))) || candidates[1];
}

async function isReachable(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    return response.ok;
  } catch (_err) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function getUrlHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_err) {
    return '';
  }
}

function getUrlPort(url, fallback) {
  try {
    return Number(new URL(url).port || fallback);
  } catch (_err) {
    return fallback;
  }
}

function getLocalHosts() {
  const hosts = new Set(['localhost', '127.0.0.1', '::1', os.hostname().toLowerCase()]);
  const interfaces = os.networkInterfaces();
  Object.values(interfaces).flat().filter(Boolean).forEach((item) => {
    if (item.address) hosts.add(String(item.address).toLowerCase());
  });
  return hosts;
}

function isRemoteHost(host) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  if (!normalizedHost) return false;
  return !getLocalHosts().has(normalizedHost);
}

function isLoopbackHost(host) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(normalizedHost);
}

function buildUrl(host, port, pathname = '/') {
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostname}:${port}${pathname}`;
}

function getLocalSubnetCandidates() {
  const candidates = [];
  const interfaces = os.networkInterfaces();
  Object.values(interfaces).flat().filter(Boolean).forEach((item) => {
    if (item.family !== 'IPv4' || item.internal) return;
    if (/^(127|169\.254)\./.test(item.address)) return;
    const parts = item.address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return;
    for (let last = 1; last <= 254; last += 1) {
      if (last === parts[3]) continue;
      candidates.push(`${parts[0]}.${parts[1]}.${parts[2]}.${last}`);
    }
  });
  return [...new Set(candidates)];
}

async function findReachableHealthUrl(urls, timeoutMs) {
  for (const url of urls) {
    logMessage(`Trying Badizo health ${url}`);
    if (await isReachable(url, Math.min(1800, timeoutMs))) return url;
  }
  return '';
}

async function scanSubnetForHealth(port, timeoutMs) {
  const hosts = getLocalSubnetCandidates();
  const startedAt = Date.now();
  const concurrency = 48;
  let cursor = 0;
  let found = '';

  async function worker() {
    while (!found && cursor < hosts.length && Date.now() - startedAt < timeoutMs) {
      const host = hosts[cursor];
      cursor += 1;
      const healthUrl = buildUrl(host, port, '/api/health');
      if (await isReachable(healthUrl, 550)) {
        found = healthUrl;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}

async function resolveRemoteServer(config) {
  if (config.startFrontend !== false) return config;

  const apiHost = getUrlHost(config.apiHealthUrl);
  const appHost = getUrlHost(config.appUrl);
  const healthPort = getUrlPort(config.apiHealthUrl, config.backendPort);
  const clientOnlyMode = config.startBackend === false && config.startFrontend === false;
  const hosts = [
    ...config.serverHosts,
    appHost,
    apiHost,
    'badizo-server.local',
    'badizo-server',
    'BADIZO-SERVER',
    'server',
    'SERVER'
  ].filter((host) => {
    if (!host) return false;
    return !clientOnlyMode || !isLoopbackHost(host);
  });

  const healthUrls = [
    ...(!clientOnlyMode || !isLoopbackHost(apiHost) ? [config.apiHealthUrl] : []),
    ...[...new Set(hosts)].map((host) => buildUrl(host, healthPort, '/api/health'))
  ];

  const discoveryTimeoutMs = Number.isFinite(config.discoveryTimeoutMs)
    ? Math.max(3000, config.discoveryTimeoutMs)
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
  let healthUrl = await findReachableHealthUrl([...new Set(healthUrls)], discoveryTimeoutMs);
  if (!healthUrl && config.discoveryEnabled) {
    logMessage('Configured Badizo server was not reachable; scanning local LAN.');
    healthUrl = await scanSubnetForHealth(healthPort, discoveryTimeoutMs);
  }

  if (!healthUrl) {
    throw new Error(`Badizo server was not found on this LAN. Checked saved config, common server names, and port ${healthPort}. Make sure the server computer is on, backend is running, and firewall allows port 5000.`);
  }

  const host = getUrlHost(healthUrl);
  const appCandidates = [buildUrl(host, healthPort, '/')];
  const appUrl = await findReachableHealthUrl(appCandidates, 2500) || appCandidates[0];
  logMessage(`Resolved Badizo server appUrl=${appUrl} healthUrl=${healthUrl}`);

  return {
    ...config,
    appUrl,
    apiHealthUrl: healthUrl
  };
}

async function waitForUrl(url, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isReachable(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function ensureRemoteFrontendReachable(config) {
  if (config.startFrontend !== false) return;
  logMessage(`Checking remote frontend before load ${config.appUrl}`);
  if (await waitForUrl(config.appUrl, 8000)) return;
  throw new Error(`Badizo frontend is not reachable at ${config.appUrl}. Backend was found at ${config.apiHealthUrl}, so check the server frontend build and firewall port 5000.`);
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

  const frontendPath = resolveFrontendBuildPath();
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
  const message = error.message || String(error);
  dialog.showErrorBox(
    'Badizo could not open',
    `Unable to open ${appUrl}.\n\n${message}\n\nIf this is a counter/admin computer, start Badizo on the server computer first. The app will auto-find the server when port 5000 is reachable on the LAN. If this is the server computer, check MySQL and restart START_BADIZO_SERVER.bat.`
  );
}

function createWindow(config) {
  const appUrl = withLoginParams(config.appUrl, config.loginMode, config.loginUser);
  logMessage(`Creating window for ${appUrl}`);
  const iconPath = resolveResourcePath('assets', 'badizo.ico');
  const { workAreaSize } = screen.getPrimaryDisplay();
  const windowWidth = Math.min(1400, Math.max(980, workAreaSize.width));
  const windowHeight = Math.min(900, Math.max(680, workAreaSize.height));

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: Math.min(980, workAreaSize.width),
    minHeight: Math.min(660, workAreaSize.height),
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
    mainWindow.webContents.setZoomFactor(1);
    mainWindow.maximize();
    mainWindow.show();
    if (config.devTools) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.setZoomFactor(1);
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
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
    const printOptions = { ...basePrintOptions, paperSize: longRollPaperSize };

    try {
      logMessage(`Thermal PDF spool options: ${JSON.stringify({ ...printOptions, printer: printOptions.printer || '(default)' })}`);
      try {
        await printPdf(pdfPath, printOptions);
      } catch (error) {
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
  let config = getConfig();
  logMessage('App ready');
  try {
    config = await resolveRemoteServer(config);
    await startLocalServices(config);
    await ensureRemoteFrontendReachable(config);
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
