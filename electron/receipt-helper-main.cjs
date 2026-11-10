const { app, shell, dialog } = require('electron');
const { start } = require('./browser-receipt-printer.cjs');

const setup = 'http://127.0.0.1:17493/';
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, args) => {
    if (!args.includes('--background')) shell.openExternal(setup);
  });
  app.whenReady().then(async () => {
    await start();
    if (!process.argv.includes('--background')) await shell.openExternal(setup);
  }).catch(err => {
    if (!process.argv.includes('--background')) dialog.showErrorBox('Badizo receipt printer', err.message);
    app.quit();
  });
}
