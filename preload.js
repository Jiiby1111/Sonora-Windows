const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  notify: (message, type) => ipcRenderer.send('app-notify', message, type),
  revealFile: (filePath) => ipcRenderer.send('app-reveal', filePath),
  readAudioFile: (filePath) => ipcRenderer.invoke('read-audio-file', filePath)
});