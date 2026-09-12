const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('benchPing', () => ipcRenderer.invoke('ping'))
