const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('badizoDesktop', {
  getServerConnection() {
    return ipcRenderer.invoke('badizo:get-server-connection');
  },
  onServerConnectionChanged(callback) {
    const listener = (_event, connection) => callback(connection);
    ipcRenderer.on('badizo:server-connection-changed', listener);
    return () => ipcRenderer.removeListener('badizo:server-connection-changed', listener);
  },
  getBarcodePrinters() {
    return ipcRenderer.invoke('badizo:get-barcode-printers');
  },
  printThermalHtml(payload) {
    return ipcRenderer.invoke('badizo:print-thermal-html', payload);
  },
  printHtml(payload) {
    return ipcRenderer.invoke('badizo:print-html', payload);
  },
  printBarcodePrn(payload) {
    return ipcRenderer.invoke('badizo:print-barcode-prn', payload);
  },
  cancelBarcodePrint(payload) {
    return ipcRenderer.invoke('badizo:cancel-barcode-print', payload);
  },
  saveA4PdfHtml(payload) {
    return ipcRenderer.invoke('badizo:save-a4-pdf-html', payload);
  }
});
