// Ponte mínima e segura entre a interface (isolada) e o processo principal.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bid', {
  call: (name, body) => ipcRenderer.invoke('core', name, body),
  info: () => ipcRenderer.invoke('app-info'),
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current),
  openFolder: (dir) => ipcRenderer.invoke('open-folder', dir),
  showFile: (file) => ipcRenderer.invoke('show-file', file),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
});
