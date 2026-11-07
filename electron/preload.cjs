'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('oped', {
  loadLibrary: () => ipcRenderer.invoke('library:load'),
  saveLibrary: (library) => ipcRenderer.invoke('library:save', library),
  addSeries: () => ipcRenderer.invoke('dialog:addSeries'),
  addFiles: (seriesId) => ipcRenderer.invoke('dialog:addFiles', seriesId),
  analyze: (files) => ipcRenderer.invoke('analyze:start', files),
  prepareMedia: (file) => ipcRenderer.invoke('media:prepare', file),
  reveal: (file) => ipcRenderer.invoke('shell:reveal', file),
  cacheInfo: () => ipcRenderer.invoke('app:cacheInfo'),
  clearCache: () => ipcRenderer.invoke('app:clearCache'),
  onAnalyzeProgress: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('analyze:progress', handler)
    return () => ipcRenderer.removeListener('analyze:progress', handler)
  },
  mediaUrl: (file) => `media://local/${encodeURIComponent(file)}`,
  runBatch: (args = []) => ipcRenderer.invoke('batch:run', args),
  onBatchLog: (callback) => {
    const handler = (_event, text) => callback(text)
    ipcRenderer.on('batch:log', handler)
    return () => ipcRenderer.removeListener('batch:log', handler)
  },
})
