'use strict';

// 桌宠窗口专用 preload（DeskPetmodules/deskpet.html）。窗口开着沙箱，这里只用 electron。
const { contextBridge, ipcRenderer } = require('electron');

// 渠道名写成字面量，事件图能静态登记每个订阅。
function onStream(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('deskpet:stream', listener);
    return () => ipcRenderer.removeListener('deskpet:stream', listener);
}

function onCursor(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('deskpet:cursor', listener);
    return () => ipcRenderer.removeListener('deskpet:cursor', listener);
}

function onOpenInput(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('deskpet:open-input', listener);
    return () => ipcRenderer.removeListener('deskpet:open-input', listener);
}

function onVisibility(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, visible) => callback(!!visible);
    ipcRenderer.on('deskpet:visibility', listener);
    return () => ipcRenderer.removeListener('deskpet:visibility', listener);
}

// 朗读：主进程的 TTS 把音频块直接发到这个窗口（和主窗口同样的渠道名）。
function onPlayTtsAudio(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('play-tts-audio', listener);
    return () => ipcRenderer.removeListener('play-tts-audio', listener);
}

function onStopTtsAudio(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('stop-tts-audio', listener);
    return () => ipcRenderer.removeListener('stop-tts-audio', listener);
}

contextBridge.exposeInMainWorld('deskPetAPI', Object.freeze({
    getAssets: () => ipcRenderer.invoke('deskpet:get-assets'),
    send: text => ipcRenderer.invoke('deskpet:send', String(text || '')),
    onStream,
    onCursor,
    onOpenInput,
    onVisibility,
    onPlayTtsAudio,
    onStopTtsAudio,
    voiceBegin: messageId => ipcRenderer.invoke('deskpet:voice-begin', String(messageId || '')),
    voiceSay: payload => ipcRenderer.send('deskpet:voice-say', payload),
    voiceEnd: payload => ipcRenderer.send('deskpet:voice-end', payload),
    setHit: hit => ipcRenderer.send('deskpet:hit', !!hit),
    setInteractive: on => ipcRenderer.send('deskpet:set-interactive', !!on),
    setContentBounds: rect => ipcRenderer.send('deskpet:content-bounds', rect),
    dragStart: origin => ipcRenderer.send('deskpet:drag-start', origin),
    dragEnd: () => ipcRenderer.send('deskpet:drag-end'),
    openContextMenu: () => ipcRenderer.send('deskpet:context-menu'),
    openMainWindow: () => ipcRenderer.send('deskpet:open-main'),
}));
