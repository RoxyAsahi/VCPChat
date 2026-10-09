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
    // submit：设置页预览里输入的话，由桌宠直接发出去
    const listener = (_event, options) => callback({ toggle: options?.toggle === true, submit: typeof options?.submit === 'string' ? options.submit : '' });
    ipcRenderer.on('deskpet:open-input', listener);
    return () => ipcRenderer.removeListener('deskpet:open-input', listener);
}

// 设置页改了 Live2D 表情映射（{ profile, emotion }）
function onProfile(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('deskpet:profile', listener);
    return () => ipcRenderer.removeListener('deskpet:profile', listener);
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

// 点的新话题已经被删掉了
function onTopicMissing(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('deskpet:topic-missing', listener);
    return () => ipcRenderer.removeListener('deskpet:topic-missing', listener);
}

contextBridge.exposeInMainWorld('deskPetAPI', Object.freeze({
    getAssets: () => ipcRenderer.invoke('deskpet:get-assets'),
    getPrefs: () => ipcRenderer.invoke('deskpet:get-prefs'),
    onPrefs,
    wheelResize: deltaY => ipcRenderer.send('deskpet:wheel-resize', Number(deltaY) || 0),
    touched: () => ipcRenderer.send('deskpet:touched'),
    getMood: () => ipcRenderer.invoke('deskpet:get-mood'),
    onMood,
    send: (text, options) => ipcRenderer.invoke('deskpet:send', String(text || ''), { newTopic: options?.newTopic === true }),
    onStream,
    onCursor,
    onOpenInput,
    onVisibility,
    onProfile,
    onPlayTtsAudio,
    onStopTtsAudio,
    voiceBegin: messageId => ipcRenderer.invoke('deskpet:voice-begin', String(messageId || '')),
    voiceSay: payload => ipcRenderer.send('deskpet:voice-say', payload),
    voiceEnd: payload => ipcRenderer.send('deskpet:voice-end', payload),
    onProactive,
    onTopicMissing,
    setHit: hit => ipcRenderer.send('deskpet:hit', !!hit),
    setInteractive: on => ipcRenderer.send('deskpet:set-interactive', !!on),
    setContentBounds: rect => ipcRenderer.send('deskpet:content-bounds', rect),
    reportFigure: report => ipcRenderer.send('deskpet:figure', { outfit: String(report?.outfit || ''), aspect: Number(report?.aspect) }),
    dragStart: origin => ipcRenderer.send('deskpet:drag-start', origin),
    // figure：角色在窗口里的包围盒，主进程据此贴边；free：按着 Alt 松手，不贴
    dragEnd: (report) => {
        const f = report?.figure;
        const figure = f ? { x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height) } : null;
        ipcRenderer.send('deskpet:drag-end', { figure, free: report?.free === true });
    },
    openContextMenu: () => ipcRenderer.send('deskpet:context-menu'),
    openMainWindow: () => ipcRenderer.send('deskpet:open-main'),
    openTopic: topicId => ipcRenderer.send('deskpet:open-topic', String(topicId || '')),
    // 页面准备好了（输入框能用了）
    pageReady: () => ipcRenderer.send('deskpet:page-ready'),
    pageFailed: message => ipcRenderer.send('deskpet:page-failed', String(message || '').slice(0, 300)),
    // 设置页快照：离屏预览画好了，报上角色的包围盒
    previewReady: report => ipcRenderer.send('deskpet:preview-ready', {
        bounds: report?.bounds ? { x: Number(report.bounds.x), y: Number(report.bounds.y), width: Number(report.bounds.width), height: Number(report.bounds.height) } : null,
        aspect: Number(report?.aspect) || null,
        // 哪一次渲染：离屏窗口一套接一套地用，超时后上一套迟到的报告不能截成下一套的图
        job: new URLSearchParams(location.search).get('job'),
    }),
    // 语音输入：和主窗口共用本地 SenseVoice（全局设置 → 语音设置里安装）
    sttStatus: () => ipcRenderer.invoke('local-stt:status'),
    transcribe: (wav, language) => ipcRenderer.invoke('local-stt:transcribe', { wav, language: String(language || 'auto') }),
}));
