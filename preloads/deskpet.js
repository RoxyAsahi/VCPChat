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
    const listener = (_event, options) => callback({ toggle: options?.toggle === true });
    ipcRenderer.on('deskpet:open-input', listener);
    return () => ipcRenderer.removeListener('deskpet:open-input', listener);
}

function onVisibility(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, visible) => callback(!!visible);
    ipcRenderer.on('deskpet:visibility', listener);
    return () => ipcRenderer.removeListener('deskpet:visibility', listener);
}

// 大小、免打扰这些设置变了（主进程推过来）
function onPrefs(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, prefs) => callback(prefs);
    ipcRenderer.on('deskpet:prefs', listener);
    return () => ipcRenderer.removeListener('deskpet:prefs', listener);
}

function onProactive(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('deskpet:proactive', listener);
    return () => ipcRenderer.removeListener('deskpet:proactive', listener);
}

// 持续心情：主进程广播给所有窗口，页面按自己的 agentId 过滤
function onMood(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent-mood-changed', listener);
    return () => ipcRenderer.removeListener('agent-mood-changed', listener);
}

contextBridge.exposeInMainWorld('deskPetAPI', Object.freeze({
    getAssets: () => ipcRenderer.invoke('deskpet:get-assets'),
    getMood: () => ipcRenderer.invoke('deskpet:get-mood'),
    onMood,
    getPrefs: () => ipcRenderer.invoke('deskpet:get-prefs'),
    onPrefs,
    wheelResize: deltaY => ipcRenderer.send('deskpet:wheel-resize', Number(deltaY) || 0),
    touched: () => ipcRenderer.send('deskpet:touched'),
    send: text => ipcRenderer.invoke('deskpet:send', String(text || '')),
    onStream,
    onCursor,
    onOpenInput,
    onVisibility,
    onProactive,
    setHit: hit => ipcRenderer.send('deskpet:hit', !!hit),
    setInteractive: on => ipcRenderer.send('deskpet:set-interactive', !!on),
    setContentBounds: rect => ipcRenderer.send('deskpet:content-bounds', rect),
    dragStart: origin => ipcRenderer.send('deskpet:drag-start', origin),
    dragEnd: () => ipcRenderer.send('deskpet:drag-end'),
    openContextMenu: () => ipcRenderer.send('deskpet:context-menu'),
    openMainWindow: () => ipcRenderer.send('deskpet:open-main'),
    openTopic: topicId => ipcRenderer.send('deskpet:open-topic', String(topicId || '')),
}));
