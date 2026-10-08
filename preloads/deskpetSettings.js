'use strict';

// 桌宠设置窗口专用 preload（DeskPetmodules/settings.html）。窗口开着沙箱，这里只用 electron。
const { contextBridge, ipcRenderer } = require('electron');

function onChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('deskpet-settings:changed', listener);
    return () => ipcRenderer.removeListener('deskpet-settings:changed', listener);
}

contextBridge.exposeInMainWorld('deskPetSettingsAPI', Object.freeze({
    get: () => ipcRenderer.invoke('deskpet-settings:get'),
    update: patch => ipcRenderer.invoke('deskpet-settings:update', patch),
    setShortcut: (actionId, accelerator) => ipcRenderer.invoke('deskpet-settings:set-shortcut', String(actionId || ''), String(accelerator ?? '')),
    resetShortcuts: () => ipcRenderer.invoke('deskpet-settings:reset-shortcuts'),
    pauseShortcuts: paused => ipcRenderer.invoke('deskpet-settings:pause-shortcuts', !!paused),
    setScale: (agentId, scale) => ipcRenderer.invoke('deskpet-settings:set-scale', String(agentId || ''), Number(scale)),
    setOutfit: (agentId, outfitId) => ipcRenderer.invoke('deskpet-settings:set-outfit', String(agentId || ''), String(outfitId || '')),
    onChanged,
}));
