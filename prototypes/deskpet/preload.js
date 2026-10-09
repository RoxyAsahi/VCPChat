const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskpet', {
  onCursor: (fn) => ipcRenderer.on('deskpet:cursor', (_e, p) => fn(p)),
  setHit: (hit) => ipcRenderer.send('deskpet:hit', !!hit),
  setModelBounds: (rect) => ipcRenderer.send('deskpet:model-bounds', rect),
  dragStart: (origin) => ipcRenderer.send('deskpet:drag-start', origin),
  dragEnd: () => ipcRenderer.send('deskpet:drag-end'),
  ready: (info) => ipcRenderer.send('deskpet:ready', info),
  status: (s) => ipcRenderer.invoke('deskpet:status', s),
});
