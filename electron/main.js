const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, shell } = require('electron');

const DEFAULT_APP_URL = 'http://localhost:3000';

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
    kiosk: Boolean(config.kiosk),
    devTools: Boolean(config.devTools)
  };
}

function showStartupError(error, appUrl) {
  dialog.showErrorBox(
    'Badizo POS could not open',
    `Unable to open ${appUrl}.\n\nStart the Badizo server/frontend first, then reopen the app.\n\n${error.message || error}`
  );
}

function createWindow() {
  const config = getConfig();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Badizo POS',
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

  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
    if (config.devTools) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (_event, _errorCode, errorDescription) => {
    showStartupError(new Error(errorDescription), config.appUrl);
  });

  win.loadURL(config.appUrl).catch((error) => showStartupError(error, config.appUrl));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
