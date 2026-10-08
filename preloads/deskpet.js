'use strict';

// 桌宠窗口专用 preload（DeskPetmodules/deskpet.html）。窗口开着沙箱，这里只用 electron。
const { contextBridge, ipcRenderer } = require('electron');

// 渠道名写成字面量，事件图能静态登记每个订阅。
function onFrame(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('deskpet:frame', listener);
    return () => ipcRenderer.removeListener('deskpet:frame', listener);
}

function onCursor(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('deskpet:cursor', listener);
    return () => ipcRenderer.removeListener('deskpet:cursor', listener);
}

contextBridge.exposeInMainWorld('deskPetAPI', Object.freeze({
    getAssets: () => ipcRenderer.invoke('deskpet:get-assets'),
    getFrame: () => ipcRenderer.invoke('deskpet:get-frame'),
    onFrame,
    onCursor,
    setHit: hit => ipcRenderer.send('deskpet:hit', !!hit),
    setContentBounds: rect => ipcRenderer.send('deskpet:content-bounds', rect),
    dragStart: origin => ipcRenderer.send('deskpet:drag-start', origin),
    dragEnd: () => ipcRenderer.send('deskpet:drag-end'),
    openContextMenu: () => ipcRenderer.send('deskpet:context-menu'),
}));
