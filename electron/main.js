const fs = require('fs');
const path = require('path');
const Module = require('module');
const express = require('express');
const { app, BrowserWindow, dialog, shell } = require('electron');

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
    kiosk: Boolean(config.kiosk),
    devTools: Boolean(config.devTools)
  };
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
  logMessage(`Creating window for ${config.appUrl}`);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Badizo',
    backgroundColor: '#f7f8fb',
    show: false,
    autoHideMenuBar: true,
    kiosk: config.kiosk,
    webPreferences: {
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
    showStartupError(new Error(errorDescription), config.appUrl);
  });

  mainWindow.loadURL(config.appUrl).catch((error) => {
    logMessage(`loadURL failed: ${error.message || error}`);
    showStartupError(error, config.appUrl);
  });
}

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
