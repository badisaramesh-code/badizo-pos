const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('badizoDesktop', {
  printThermalHtml(payload) {
    return ipcRenderer.invoke('badizo:print-thermal-html', payload);
  },
  printHtml(payload) {
    return ipcRenderer.invoke('badizo:print-html', payload);
  }
});
