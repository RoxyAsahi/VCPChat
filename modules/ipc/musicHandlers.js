// modules/ipc/musicHandlers.js

const electron = require('electron');
const { ipcMain, BrowserWindow, dialog } = electron;
const path = require('path');
const fs = require('fs-extra');
const { scanFolder, SUPPORTED_FORMATS } = require('../musicLibraryScanner');
const lyricFetcher = require('../lyricFetcher'); // Import the new lyric fetcher
const webdavManager = require('../webdavManager'); // WebDAV support
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');
const audioEngineEndpoint = require('../services/audioEngineEndpoint');
const musicGrooveBus = require('../services/musicGrooveBus');
const { findTrack } = require('../musicTrackMatch');
const windowBounds = require('../musicWindowBounds');
const { createDesktopLyrics } = require('./musicDesktopLyrics');
const { formatCurrentLyrics } = require('../lyrics/lyricsMarkdown');
const { randomUUID } = require('crypto');
let fetch;

let musicWindow = null;
let musicCapsuleState = { open: false, title: '', trackKey: '', playing: false };
let musicInfoInjectionEnabled = true;
let settingsManager = null;

// 音乐窗口有两套页面：新版 Musicmodules/，和上游原版 Musicmodules-legacy/（原样保留，可随时切回）。
// 用哪套看设置里的 musicLegacyUI；两套共用同一个主进程、预加载和音频引擎。
const MUSIC_PAGES = {
    current: path.join(__dirname, '..', '..', 'Musicmodules', 'music.html'),
    legacy: path.join(__dirname, '..', '..', 'Musicmodules-legacy', 'music.html')
};
async function readLegacyUISetting() {
    try { return (await settingsManager?.readSettings())?.musicLegacyUI === true; } catch (e) { return false; }
}
async function musicPageFile() {
    return (await readLegacyUISetting()) ? MUSIC_PAGES.legacy : MUSIC_PAGES.current;
}
const getMusicCapsuleSnapshot = () => ({ ...musicCapsuleState, musicInfoInjectionEnabled });
function publishMusicCapsule() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('music-capsule-state', getMusicCapsuleSnapshot());
    }
}
let currentSongInfo = null; // 保持这个变量，用于可能的UI状态同步
let mainWindow = null; // To be initialized
let openChildWindows = []; // To be initialized
let MUSIC_PLAYLIST_FILE;
let MUSIC_COVER_CACHE_DIR;
let MUSIC_WINDOW_BOUNDS_FILE;
let LYRIC_DIR;
let startAudioEngine; // To hold the function from main.js
let stopAudioEngine; // To hold the function from main.js
let musicWindowPromise = null; // To handle concurrent window creation requests
let pendingPlaybackForNewWindow = null; // 用于在新窗口创建时传递待播放曲目及可选演出模式
let ipcHandlersRegistered = false;
let desktopLyrics = null; // 桌面歌词条（musicDesktopLyrics.js），注册 IPC 时创建
const MUSIC_CRASH_LIMIT = 3;
const MUSIC_CRASH_WINDOW_MS = 60 * 1000;

function restoreMusicWindowBounds(limits) {
    if (!MUSIC_WINDOW_BOUNDS_FILE) return null;
    const saved = windowBounds.readSavedBounds(MUSIC_WINDOW_BOUNDS_FILE);
    if (!saved) return null;
    let workAreas = [];
    try {
        workAreas = (electron.screen?.getAllDisplays?.() || []).map((d) => d.workArea);
    } catch (_) { /* 屏幕信息拿不到就用默认位置 */ }
    return windowBounds.restoreBounds(saved, workAreas, limits);
}

// --- Singleton Music Window Creation Function ---
function createOrFocusMusicWindow() {
    if (musicWindowPromise) {
        console.log('[Music] Window creation already in progress, returning existing promise.');
        return musicWindowPromise;
    }

    musicWindowPromise = new Promise(async (resolve, reject) => {
        let readyHandler = null;
        let timeoutId = null;

        let isSettled = false;

        const cleanupWindowCreationWaiters = () => {
            if (readyHandler) {
                ipcMain.removeListener('music-renderer-ready', readyHandler);
                readyHandler = null;
            }
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        const resolveWindowCreation = (win) => {
            if (isSettled) return;
            isSettled = true;
            cleanupWindowCreationWaiters();
            musicWindowPromise = null;
            resolve(win);
        };

        const rejectWindowCreation = (error) => {
            if (isSettled) return;
            isSettled = true;
            cleanupWindowCreationWaiters();
            musicWindowPromise = null;
            pendingPlaybackForNewWindow = null; // 窗口创建失败或夭折，及时清理暂存请求避免脏残留
            reject(error);
        };
        try {
            // Always wait for the engine to be ready before creating/focusing the window.
            // Thanks to pre-warming in main.js, this should be very fast.
            if (typeof startAudioEngine === 'function') {
                await startAudioEngine();
            } else {
                throw new Error("startAudioEngine function not provided.");
            }
        } catch (error) {
            // 引擎起不来时照常打开窗口，由窗口顶部的提示说明原因（见 music-get-audio-engine-endpoint），
            // 而不是让用户对着时长 0:00 猜。下次打开窗口会再尝试启动。
            console.error('[Music] Failed to ensure audio engine is ready:', error);
            if (audioEngineEndpoint.getStatus().state !== 'failed') {
                audioEngineEndpoint.markFailed(error?.message || '音频引擎没有启动');
            }
        }

        if (musicWindow && !musicWindow.isDestroyed()) {
            console.log('[Music] Music window already exists. Focusing it.');
            if (!musicWindow.isVisible()) {
                musicWindow.show();
            }
            musicWindow.focus();
            resolveWindowCreation(musicWindow);
            return;
        }

        console.log('[Music] Creating new music window instance.');
        // 回到上次关窗时的位置和大小；那块屏不在了或窗口跑到屏幕外，就用默认位置居中
        const restored = restoreMusicWindowBounds({ minWidth: 420, minHeight: 600 });
        musicWindow = new BrowserWindow({
            width: restored?.width || 1280,
            height: restored?.height || 700,
            ...(restored ? { x: restored.x, y: restored.y } : {}),
            minWidth: 420,
            minHeight: 600,
            title: '音乐播放器',
            frame: false, // 移除原生窗口框架
            ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
            modal: false,
            webPreferences: {
                preload: resolveProjectPreload(path.join(__dirname, '..', '..'), PRELOAD_ROLES.UTILITY),
                sandbox: false, // preloads/* 需要 require 本地模块，见 preloads/README.md
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true
            },
            icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
            show: false
        });

        musicWindow.loadFile(await musicPageFile());
        windowService.attachWindow(WINDOW_APP_IDS.MUSIC, musicWindow);

        openChildWindows.push(musicWindow);
        musicWindow.setMenu(null);

        musicWindow.once('ready-to-show', () => {
            if (restored?.maximized) musicWindow.maximize();
            musicWindow.show();
            musicCapsuleState = { ...musicCapsuleState, open: true };
            publishMusicCapsule();
        });

        // Wait for the renderer to signal that it's ready
        readyHandler = (event) => {
            if (musicWindow && !musicWindow.isDestroyed() && event.sender === musicWindow.webContents) {
                console.log('[Music] Received "music-renderer-ready" signal. Resolving promise.');
                desktopLyrics?.musicReady();
                // pendingPlaybackForNewWindow 由前端通过 music-get-pending-track 主动拉取
                // 不在这里发送，避免时序问题
                resolveWindowCreation(musicWindow);
            }
        };

        // Add a timeout to prevent hanging forever if the renderer fails to signal
        timeoutId = setTimeout(() => {
            console.error('[Music] Timeout waiting for "music-renderer-ready" signal.');
            // We resolve anyway to allow the command to proceed, or we could reject.
            // Resolving might lead to other errors, but it's better than a permanent hang.
            resolveWindowCreation(musicWindow);
        }, 10000); // 10 second timeout

        ipcMain.on('music-renderer-ready', readyHandler);

        musicWindow.on('close', (event) => {
            if (MUSIC_WINDOW_BOUNDS_FILE) windowBounds.writeSavedBounds(MUSIC_WINDOW_BOUNDS_FILE, musicWindow);
            if (process.platform === 'darwin' && !require('electron').app.isQuitting) {
                event.preventDefault();
                musicWindow.hide();
            }
        });

        musicWindow.on('closed', () => {
            console.log('[Music] Music window closed. Stopping playback.');
            // 若窗口在 ready 之前就被用户强行关闭，立即 reject 挂起的 Promise，避免调用方永久超时死锁
            if (!isSettled) {
                console.warn('[Music] Music window closed before renderer signal was received. Rejecting creation promise.');
                rejectWindowCreation(new Error('Music window was closed before initialization completed.'));
            } else {
                cleanupWindowCreationWaiters();
                musicWindowPromise = null;
            }

            // We don't stop the engine when the music window closes anymore,
            // as it's managed by the main app lifecycle now (pre-warmed).
            // We just stop the playback.
            audioEngineApi('/stop').catch(err => console.error("[Music] Failed to send stop command on close:", err));

            desktopLyrics?.musicClosed();
            openChildWindows = openChildWindows.filter(win => win !== musicWindow);
            musicWindow = null;
            currentSongInfo = null; // 清理歌曲信息
            musicCapsuleState = { open: false, title: '', trackKey: '', playing: false };
            publishMusicCapsule();
            musicGrooveBus.publish({ playing: false });
            pendingPlaybackForNewWindow = null; // 清理未消费的待播放请求
        });

        // 从资源管理器把歌曲或图片拖进窗口时，Chromium 默认会跳转去打开那个文件，整个播放器被换掉、
        // 播放状态全丢。音乐窗口只该停在自己的页面上。
        musicWindow.webContents.on('will-navigate', (event, url) => {
            if (!/\/Musicmodules\/music\.html(?:[?#]|$)/.test(String(url).replace(/\\/g, '/'))) event.preventDefault();
        });

        musicWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            console.error(`[Music] Music window failed to load: ${errorDescription} (code: ${errorCode})`);
            rejectWindowCreation(new Error(`Music window failed to load: ${errorDescription}`));
        });

        // 页面进程崩了（显卡驱动重置、内存不够）：窗口没有系统边框，标题栏和按钮都在页面里，
        // 崩了以后关不掉、也停不了，引擎却还在放。先暂停，再把页面重新载入，它会回到上次的歌和进度。
        // 一分钟里崩到第 4 次就不再重来，直接关窗口（关窗口会停播），免得页面本身有问题时无限崩溃。
        const crashedWindow = musicWindow;
        let crashTimes = [];
        crashedWindow.webContents.on('render-process-gone', (_event, details) => {
            const reason = details?.reason || 'unknown';
            console.error(`[Music] Music window renderer gone: ${reason}`);
            if (reason === 'clean-exit' || crashedWindow.isDestroyed()) return;
            audioEngineApi('/pause', 'POST').catch(() => {});
            musicCapsuleState = { ...musicCapsuleState, playing: false };
            publishMusicCapsule();
            musicGrooveBus.publish({ playing: false });
            const now = Date.now();
            crashTimes = crashTimes.filter((at) => now - at < MUSIC_CRASH_WINDOW_MS).concat(now);
            if (crashTimes.length > MUSIC_CRASH_LIMIT) {
                crashedWindow.close();
                return;
            }
            setTimeout(() => { if (!crashedWindow.isDestroyed()) crashedWindow.reload(); }, 250);
        });
    });

    return musicWindowPromise;
}

// 无缝切到下一首时不走 music-load，「当前播放」注入会一直报上一首。
// 窗口每次换歌都会发胶囊状态，按它的路径跟上；新窗口顺带给出歌手和专辑，旧窗口只给路径时从曲库里查。
async function followTrackChange(state) {
    const trackPath = typeof state?.trackKey === 'string' ? state.trackKey : '';
    if (!trackPath || currentSongInfo?.path === trackPath) return;
    let info = null;
    if (typeof state.artist === 'string' || typeof state.album === 'string') {
        info = { title: state.title, artist: state.artist, album: state.album };
    } else {
        const track = (await readPlaylistFile()).find(t => t && t.path === trackPath);
        info = track ? { title: track.title, artist: track.artist, album: track.album } : { title: state.title };
    }
    if (!musicWindow || musicCapsuleState.trackKey !== trackPath) return; // 查曲库期间又换了歌或窗口关了
    currentSongInfo = {
        title: String(info.title || '').slice(0, 512) || '未知标题',
        artist: String(info.artist || '').slice(0, 512) || '未知艺术家',
        album: String(info.album || '').slice(0, 512) || '未知专辑',
        path: trackPath
    };
}

// 扫一个文件夹（或几首单曲），把进度和结果发回发起的窗口。只给 filePaths 时 folderPath 为空：
// 窗口收到后只加不删（不会把「没扫到」的歌当成被删了）。
// 同一个窗口正在扫的文件夹：扫描途中再选一次同一个文件夹（或连着拖两次）不再从头读第二遍，
// 两遍并行时 CPU 和硬盘占双份，结束时还会连着整理、保存两次曲库。
const runningFolderScans = new Map();
function runLibraryScan(event, options = {}) {
    const folderPath = options.folderPath || null;
    if (!folderPath) return scanLibrary(event, options);
    const key = `${event.sender?.id ?? ''}|${path.resolve(folderPath).replace(/[\\/]+$/, '').toLowerCase()}`;
    const running = runningFolderScans.get(key);
    if (running) return running;
    const scan = scanLibrary(event, options).finally(() => runningFolderScans.delete(key));
    runningFolderScans.set(key, scan);
    return scan;
}

async function scanLibrary(event, { folderPath = null, filePaths } = {}) {
    const sendToRequester = (channel, payload) => {
        if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send(channel, payload);
        }
    };

    // 窗口在扫描中途关掉就停下，不替一个已经不在的窗口把整个文件夹读完。
    const abort = new AbortController();
    const onGone = () => abort.abort();
    event.sender.once('destroyed', onGone);

    try {
        // 上次保存的歌单里带着文件大小和修改时间；没动过的文件不用再读一遍。
        const knownTracks = await readPlaylistFile();
        const scanned = await scanFolder({
            folderPath,
            filePaths,
            coverCachePath: MUSIC_COVER_CACHE_DIR,
            knownTracks,
            signal: abort.signal,
            onStart: (info) => sendToRequester('music-scan-start', info),
            onProgress: (info) => sendToRequester('music-scan-progress', info),
            onBatch: (tracks) => sendToRequester('music-scan-batch', { tracks, folderPath })
        });
        console.log(`[Music] Scan of ${folderPath || `${filePaths?.length || 0} files`}: ${scanned.stats.total} files, ${scanned.stats.parsed} read, ${scanned.stats.reused} unchanged, ${scanned.stats.failed} failed, ${scanned.stats.elapsedMs} ms`);
        if (!scanned.stats.aborted) {
            sendToRequester('music-scan-complete', {
                tracks: scanned.tracks, folderPath,
                stats: { total: scanned.stats.total, failed: scanned.stats.failed }
            });
        }
    } catch (err) {
        console.error("Error during music scan:", err);
        sendToRequester('music-scan-complete', { tracks: [], folderPath, failed: true, error: err?.message || String(err) });
    } finally {
        if (!event.sender.isDestroyed()) event.sender.removeListener('destroyed', onGone);
    }
}

// --- Playlist file helpers ---
async function readPlaylistFile() {
    try {
        if (await fs.pathExists(MUSIC_PLAYLIST_FILE)) {
            const playlist = await fs.readJson(MUSIC_PLAYLIST_FILE);
            return Array.isArray(playlist) ? playlist : [];
        }
    } catch (error) {
        console.error('Error reading music playlist:', error);
    }
    return [];
}

// 要把一份非空的列表写成空列表时，先把原文件复制成 .bak（只留最近一份）。
async function backupBeforeEmptying(file) {
    try {
        const current = await fs.readJson(file);
        if (Array.isArray(current) && current.length > 0) await fs.copy(file, `${file}.bak`, { overwrite: true });
    } catch (_) { /* 没有原文件或读不出来就不备份 */ }
}

// 先写临时文件再改名：写到一半退出或断电不会留下半截歌单。同一个文件的保存排队进行，
// 排队期间又来的保存只留最后一份。歌单本身不缩进，几千首歌时少写一半字节。
const jsonWriteQueues = new Map();
function writeJsonAtomic(file, data, options = {}) {
    let queue = jsonWriteQueues.get(file);
    if (!queue) {
        queue = { running: false, next: null };
        jsonWriteQueues.set(file, queue);
    }
    const run = async (job) => {
        queue.running = true;
        try {
            const temp = `${file}.${process.pid}.tmp`;
            await fs.writeFile(temp, JSON.stringify(job.data, null, options.spaces || 0));
            await fs.move(temp, file, { overwrite: true });
            job.waiters.forEach((w) => w.resolve());
        } catch (error) {
            job.waiters.forEach((w) => w.reject(error));
        } finally {
            queue.running = false;
            const next = queue.next;
            queue.next = null;
            if (next) run(next);
            else jsonWriteQueues.delete(file);
        }
    };
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (!queue.running) run({ data, waiters: [waiter] });
        else if (queue.next) { queue.next.data = data; queue.next.waiters.push(waiter); }
        else queue.next = { data, waiters: [waiter] };
    });
}

// --- Audio Engine API Helper ---
// 引擎卡住或已经退出时，没有超时的请求会一直挂着，渲染端的播放/暂停/加载也就永远等不到结果。
// 状态查询是高频轮询，给短超时；分析类接口本身耗时长，单独放宽。
function audioEngineTimeoutMs(endpoint) {
    if (endpoint === '/state') return 3000;
    if (/scan|loudness|load_ir|devices|configure/.test(endpoint)) return 60000;
    return 8000;
}

async function audioEngineApi(endpoint, method = 'POST', body = null) {
    // The check for engine readiness is now handled in createOrFocusMusicWindow,
    // so we can remove the promise check from here, simplifying this function.
    const timeoutMs = audioEngineTimeoutMs(endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        if (!fetch) throw new Error('node-fetch module is not available yet.');

        const url = `${audioEngineEndpoint.getBaseUrl()}${endpoint}`;
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
        };
        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Audio engine request failed with status ${response.status}: ${errorText}`);
        }

        return await response.json();
    } catch (error) {
        if (error?.name === 'AbortError') {
            error = new Error(`音频引擎 ${Math.round(timeoutMs / 1000)} 秒内没有响应（${endpoint}）`);
        }
        console.error(`[Music] Error calling Audio Engine API endpoint '${endpoint}':`, error.message);
        if (musicWindow && !musicWindow.isDestroyed()) {
            musicWindow.webContents.send('audio-engine-error', { message: error.message });
        }
        return { status: 'error', message: error.message };
    } finally {
        clearTimeout(timer);
    }
}


// 从当前渲染端读取，兼容 gapless 切歌、手动换词以及 LRC/逐字歌词。
// 不创建窗口、不联网、不依赖可能滞后的 currentSongInfo。
async function getCurrentLyrics() {
    const win = musicWindow;
    let snapshot = null;
    if (win && !win.isDestroyed()) {
        snapshot = await new Promise((resolve, reject) => {
            const requestId = randomUUID();
            const cleanup = () => {
                clearTimeout(timer);
                ipcMain.removeListener('music-current-lyrics-response', onResponse);
                win.removeListener('closed', onClosed);
            };
            const onClosed = () => { cleanup(); resolve(null); };
            const onResponse = (event, payload) => {
                if (event.sender !== win.webContents || payload?.requestId !== requestId) return;
                cleanup();
                resolve(payload.snapshot);
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('读取当前歌词超时，请稍后重试。'));
            }, 5000);
            ipcMain.on('music-current-lyrics-response', onResponse);
            win.once('closed', onClosed);
            try {
                win.webContents.send('music-current-lyrics-request', { requestId });
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    }
    return {
        status: 'success',
        result: { content: [{ type: 'text', text: formatCurrentLyrics(snapshot) }] }
    };
}

// --- Music Control Handler (Legacy, for distributed server) ---
// 这个函数统一通过前端 renderer 来控制播放，避免竞态问题
async function handleMusicControl(args) {
    const { command, target, stageMode } = args;
    const supportedStageModes = new Set([
        'luminous',
        'partita',
        'cadenza',
        'tempera',
        'sonnet',
        'diorama',
        'fume',
        'tunnel',
        'kowloon',
        'inkdraft',
        'fogpane',
        'lumiere',
        'hanabi',
        'clockwork',
        'starborn'
    ]);
    const normalizedStageMode = typeof stageMode === 'string' && stageMode.trim()
        ? stageMode.trim().toLowerCase()
        : null;

    if (normalizedStageMode && !supportedStageModes.has(normalizedStageMode)) {
        return { status: 'error', message: `Unknown music stage mode: ${stageMode}` };
    }

    console.log(`[MusicControl] Received command: ${command}, Target: ${target}, Stage mode: ${normalizedStageMode || 'regular'}`);

    // 窗口正在创建时，暂停/切歌/读歌词等消息发过去会落空：先等它就绪（失败也照常往下走）。
    const isPlayWithTarget = String(command || '').toLowerCase() === 'play' && target;
    if (musicWindowPromise && !isPlayWithTarget) {
        try { await musicWindowPromise; } catch (_) { /* 按窗口不在处理 */ }
    }

    switch (command.toLowerCase()) {
        case 'getcurrentlyrics':
            return getCurrentLyrics();
        case 'play':
            if (target) {
                // 从播放列表中找到目标曲目
                const playlist = await readPlaylistFile();
                const track = findTrack(playlist, target);
                if (!track) {
                    return { status: 'error', message: `Track '${target}' not found.` };
                }

                const playbackRequest = {
                    track,
                    stageMode: normalizedStageMode
                };

                // 窗口开着且已就绪：直接交给它。窗口还在创建（页面脚本可能还没跑，消息会丢）
                // 或者没开：放进 pending，等窗口就绪；它若在这之前已经取过 pending，就绪后再直接发。
                if (!musicWindowPromise && musicWindow && !musicWindow.isDestroyed()) {
                    console.log('[MusicControl] Window exists, sending music-set-track to renderer.');
                    musicWindow.webContents.send('music-set-track', playbackRequest);
                    if (!musicWindow.isVisible()) {
                        musicWindow.show();
                    }
                    musicWindow.focus();
                    return { status: 'success', message: `Playing: ${track.title}` };
                }
                console.log('[MusicControl] Window not ready, storing pending playback request.');
                pendingPlaybackForNewWindow = playbackRequest;
                try {
                    await createOrFocusMusicWindow();
                    if (pendingPlaybackForNewWindow === playbackRequest && musicWindow && !musicWindow.isDestroyed()) {
                        pendingPlaybackForNewWindow = null;
                        musicWindow.webContents.send('music-set-track', playbackRequest);
                    }
                    return { status: 'success', message: `Playing: ${track.title}` };
                } catch (createErr) {
                    console.error('[MusicControl] Failed to create music window for playback:', createErr);
                    if (pendingPlaybackForNewWindow === playbackRequest) pendingPlaybackForNewWindow = null;
                    return { status: 'error', message: `Music window creation aborted or failed: ${createErr.message}` };
                }
            } else {
                // 无目标，简单恢复播放
                if (musicWindow && !musicWindow.isDestroyed()) {
                    musicWindow.webContents.send('music-control', 'play');
                    return { status: 'success', message: 'Resumed playback.' };
                }
                return audioEngineApi('/play', 'POST');
            }
        case 'pause':
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('music-control', 'pause');
                return { status: 'success', message: 'Paused.' };
            }
            return audioEngineApi('/pause', 'POST');
        case 'stop':
            // 窗口开着时绕过它直接停引擎，界面会一直以为还在放；交给窗口暂停。
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('music-control', 'pause');
                return { status: 'success', message: 'Stopped.' };
            }
            return audioEngineApi('/stop', 'POST');
        case 'next':
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('music-control', 'next');
                return { status: 'success', message: 'Next track.' };
            }
            return { status: 'error', message: 'Music window not available.' };
        case 'previous':
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('music-control', 'previous');
                return { status: 'success', message: 'Previous track.' };
            }
            return { status: 'error', message: 'Music window not available.' };
        default:
            return { status: 'error', message: `Unknown command: ${command}` };
    }
}

function initialize(options) {
    console.error('[Music] ========== INITIALIZE CALLED ==========');
    console.log('[Music] initialize called');
    mainWindow = options.mainWindow;
    openChildWindows = options.openChildWindows;
    startAudioEngine = options.startAudioEngine; // Receive the start function
    stopAudioEngine = options.stopAudioEngine; // Receive the stop function
    const APP_DATA_ROOT_IN_PROJECT = options.APP_DATA_ROOT_IN_PROJECT;
    MUSIC_PLAYLIST_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'songlist.json');
    MUSIC_COVER_CACHE_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'MusicCoverCache');
    MUSIC_WINDOW_BOUNDS_FILE = path.join(APP_DATA_ROOT_IN_PROJECT, 'music-window-bounds.json');
    LYRIC_DIR = path.join(APP_DATA_ROOT_IN_PROJECT, 'lyric');

    if (ipcHandlersRegistered) {
        console.log('[Music] IPC handlers already registered, skipping duplicate registration.');
        return;
    }

    settingsManager = options.settingsManager;
    const applyInjectionSetting = settings => {
        musicInfoInjectionEnabled = settings?.musicInfoInjectionEnabled !== false;
        publishMusicCapsule();
    };
    settingsManager?.on('settings-updated', applyInjectionSetting);
    settingsManager?.on('settings-external-updated', payload => applyInjectionSetting(payload?.settings));

    const registerIpcHandlers = () => {
        console.log('[Music] registerIpcHandlers called');
        desktopLyrics = createDesktopLyrics({
            ipcMain,
            getMusicWindow: () => musicWindow,
            stateFile: path.join(APP_DATA_ROOT_IN_PROJECT, 'music-desktop-lyrics.json'),
            projectRoot: path.join(__dirname, '..', '..')
        });
        ipcMain.on('open-music-window', async () => {
            try {
                await createOrFocusMusicWindow();
            } catch (error) {
                console.error("[Music] Failed to open or focus music window from IPC:", error);
            }
        });

        // 新版 / 旧版（原版）界面切换：存进设置，音乐窗口开着就当场换成另一套页面
        ipcMain.handle('music-get-legacy-ui', () => readLegacyUISetting());
        ipcMain.handle('music-set-legacy-ui', async (event, enabled) => {
            if (!settingsManager) throw new Error('设置管理器未初始化。');
            const legacy = enabled === true;
            const result = await settingsManager.updateSettings(current => ({ ...current, musicLegacyUI: legacy }));
            if (!result.success) throw new Error(result.error || '保存界面设置失败。');
            if (musicWindow && !musicWindow.isDestroyed() && event.sender === musicWindow.webContents) {
                // 原版界面不送歌词，桌面歌词条先收起（开关不变），回到新版时再打开
                if (legacy) desktopLyrics?.musicClosed();
                setImmediate(() => {
                    if (!musicWindow || musicWindow.isDestroyed()) return;
                    musicWindow.loadFile(legacy ? MUSIC_PAGES.legacy : MUSIC_PAGES.current);
                    if (!legacy) musicWindow.webContents.once('did-finish-load', () => desktopLyrics?.musicReady());
                });
            }
            return legacy;
        });

        // --- 前端初始化时拉取待播放请求（解决新窗口点歌竞态问题）---
        ipcMain.handle('music-capsule-get-state', async () => {
            if (settingsManager) applyInjectionSetting(await settingsManager.readSettings());
            return getMusicCapsuleSnapshot();
        });
        ipcMain.handle('music-info-injection-toggle', async event => {
            if (!mainWindow || event.sender !== mainWindow.webContents) {
                throw new Error('仅主聊天窗口可以切换音乐信息注入。');
            }
            if (!settingsManager) throw new Error('设置管理器未初始化。');
            const result = await settingsManager.updateSettings(current => ({
                ...current,
                musicInfoInjectionEnabled: current.musicInfoInjectionEnabled === false
            }));
            if (!result.success) throw new Error(result.error || '保存音乐信息注入状态失败。');
            applyInjectionSetting(result.settings);
            return getMusicCapsuleSnapshot();
        });
        ipcMain.on('music-groove-publish', (event, payload) => {
            if (!musicWindow || musicWindow.isDestroyed() || event.sender !== musicWindow.webContents) return;
            musicGrooveBus.publish(payload);
        });
        ipcMain.on('music-capsule-publish', (event, state) => {
            if (!musicWindow || musicWindow.isDestroyed() || event.sender !== musicWindow.webContents) return;
            musicCapsuleState = {
                open: true,
                title: typeof state?.title === 'string' ? state.title.slice(0, 512) : '',
                trackKey: typeof state?.trackKey === 'string' ? state.trackKey.slice(0, 4096) : '',
                playing: state?.playing === true
            };
            publishMusicCapsule();
            if (!musicCapsuleState.playing) musicGrooveBus.publish({ playing: false });
            followTrackChange(state).catch(() => {});
        });
        ipcMain.on('music-capsule-command', (event, command) => {
            if (!mainWindow || event.sender !== mainWindow.webContents) return;
            if (!['previous', 'next', 'play', 'pause'].includes(command)) return;
            if (musicWindow && !musicWindow.isDestroyed()) musicWindow.webContents.send('music-control', command);
        });

        ipcMain.handle('music-get-audio-engine-endpoint', () => audioEngineEndpoint.getEndpoint());

        audioEngineEndpoint.onStatus((endpoint) => {
            if (musicWindow && !musicWindow.isDestroyed()) {
                musicWindow.webContents.send('audio-engine-status', endpoint);
            }
        });

        ipcMain.handle('music-get-pending-track', () => {
            const playbackRequest = pendingPlaybackForNewWindow;
            pendingPlaybackForNewWindow = null; // 取出后清空，只消费一次
            if (playbackRequest?.track) {
                console.log(
                    '[Music] Pending playback request consumed by renderer:',
                    playbackRequest.track.title,
                    playbackRequest.stageMode || 'regular'
                );
            }
            return playbackRequest; // 返回 null 或 { track, stageMode }
        });

        ipcMain.handle('music-load', async (event, track) => {
            if (track && track.path) {
                currentSongInfo = {
                    title: track.title || '未知标题',
                    artist: track.artist || '未知艺术家',
                    album: track.album || '未知专辑',
                    path: track.path
                };
                
                // 检查是否是 WebDAV 远程曲目
                if (track.isRemote || track.path.startsWith('http://') || track.path.startsWith('https://')) {
                    // 按 serverId 取账号；没有或服务器已删时，按地址落在哪台服务器下面（路径边界、最长前缀）。
                    // 原来按纯前缀取第一台：同一台 NAS 上 /dav 和 /dav2 两个服务器时会拿错账号。
                    const creds = webdavManager.credentialsForTrack?.({ serverId: track.serverId, path: track.path });
                    if (creds?.username && creds?.password) {
                        return await webdavManager.configureAndLoad({
                            url: track.path,
                            username: creds.username,
                            password: creds.password
                        });
                    }
                    if (track.serverId) {
                        // 服务器已删：交给 configureAndLoad 给出明确的提示
                        return await webdavManager.configureAndLoad({ url: track.path, serverId: track.serverId });
                    }
                }
                
                // 本地文件或无法匹配的远程文件
                return audioEngineApi('/load', 'POST', { path: track.path });
            }
            return { status: 'error', message: 'Invalid track data provided.' };
        });

        ipcMain.handle('music-play', () => {
            // 只有在有歌曲信息时才真正播放
            if (currentSongInfo) {
                return audioEngineApi('/play', 'POST');
            }
            return { status: 'error', message: 'No song loaded to play.' };
        });

        ipcMain.handle('music-pause', () => {
            return audioEngineApi('/pause', 'POST');
        });

        ipcMain.handle('music-seek', (event, positionSeconds) => {
            return audioEngineApi('/seek', 'POST', { position: positionSeconds });
        });

        ipcMain.handle('music-get-state', async () => {
            return await audioEngineApi('/state', 'GET');
        });

        ipcMain.handle('music-set-volume', (event, volume) => {
            return audioEngineApi('/volume', 'POST', { volume });
        });

        // --- New handlers for WASAPI and device selection ---
        ipcMain.handle('music-get-devices', async (event, options = {}) => {
            const refresh = options.refresh ? '?refresh=true' : '';
            return await audioEngineApi(`/devices${refresh}`, 'GET');
        });

        ipcMain.handle('music-configure-output', (event, { device_id, exclusive }) => {
            return audioEngineApi('/configure_output', 'POST', { device_id, exclusive });
        });

        // --- New handler for EQ ---
        ipcMain.handle('music-set-eq', (event, { bands, enabled }) => {
            return audioEngineApi('/set_eq', 'POST', { bands, enabled });
        });

        // --- New handler for Upsampling ---
        ipcMain.handle('music-configure-upsampling', (event, { target_samplerate }) => {
            return audioEngineApi('/configure_upsampling', 'POST', { target_samplerate });
        });

        // --- Resampling Settings Handler ---
        ipcMain.handle('music-configure-resampling', (event, { quality, use_cache, preemptive_resample }) => {
            return audioEngineApi('/configure_resampling', 'POST', { quality, use_cache, preemptive_resample });
        });

        ipcMain.handle('music-set-eq-type', (event, { type, fir_taps }) => {
            return audioEngineApi('/set_eq_type', 'POST', { type, fir_taps });
        });

        ipcMain.handle('music-configure-optimizations', (event, data) => {
            return audioEngineApi('/configure_optimizations', 'POST', data);
        });

        // --- Loudness Normalization Handlers ---
        ipcMain.handle('music-configure-normalization', async (event, data) => {
            console.log('[Music] configure_normalization request:', JSON.stringify(data));
            const result = await audioEngineApi('/configure_normalization', 'POST', data);
            console.log('[Music] configure_normalization response:', JSON.stringify(result));
            return result;
        });

        ipcMain.handle('music-get-loudness-info', async () => {
            return await audioEngineApi('/loudness_info', 'GET');
        });

        ipcMain.handle('music-scan-loudness', (event, { path }) => {
            return audioEngineApi('/scan_loudness', 'POST', { path });
        });

        ipcMain.handle('music-scan-loudness-background', (event, { path, store }) => {
            return audioEngineApi('/scan_loudness_background', 'POST', { path, store });
        });

        // --- Saturation Effect Handlers ---
        ipcMain.handle('music-get-saturation', async () => {
            return await audioEngineApi('/saturation', 'GET');
        });

        ipcMain.handle('music-set-saturation', (event, data) => {
            return audioEngineApi('/set_saturation', 'POST', data);
        });

        // --- Crossfeed Handlers ---
        ipcMain.handle('music-get-crossfeed', async () => {
            return await audioEngineApi('/crossfeed', 'GET');
        });

        ipcMain.handle('music-set-crossfeed', (event, data) => {
            return audioEngineApi('/set_crossfeed', 'POST', data);
        });

        // --- Dynamic Loudness Handlers ---
        ipcMain.handle('music-get-dynamic-loudness', async () => {
            return await audioEngineApi('/dynamic_loudness', 'GET');
        });

        ipcMain.handle('music-set-dynamic-loudness', (event, data) => {
            return audioEngineApi('/set_dynamic_loudness', 'POST', data);
        });

        // --- Noise Shaper Handlers ---
        ipcMain.handle('music-get-noise-shaper-curve', async () => {
            return await audioEngineApi('/noise_shaper_curve', 'GET');
        });

        ipcMain.handle('music-set-noise-shaper-curve', (event, { curve }) => {
            return audioEngineApi('/set_noise_shaper_curve', 'POST', { curve });
        });

        ipcMain.handle('music-configure-output-bits', (event, { bits }) => {
            return audioEngineApi('/configure_output_bits', 'POST', { bits });
        });

        // --- IR Status Handler ---
        ipcMain.handle('music-get-ir-status', async () => {
            return await audioEngineApi('/ir_status', 'GET');
        });
        
        // --- Settings Persistence ---
        ipcMain.handle('music-get-settings', async () => {
            return await audioEngineApi('/settings', 'GET');
        });

        ipcMain.handle('music-save-settings', (event, data) => {
            return audioEngineApi('/save_settings', 'POST', data);
        });

        // --- Gapless Playback Handlers ---
        ipcMain.handle('music-queue-next', (event, { path, username, password, serverId }) => {
            // 远程曲目预载要带上它所在服务器的账号；不然引擎用的是上一次配置的那台，换台就预载失败。
            if (!username && !password) {
                const creds = webdavManager.credentialsForTrack?.({ serverId, path });
                if (creds?.username && creds?.password) ({ username, password } = creds);
            }
            return audioEngineApi('/queue_next', 'POST', { path, username, password });
        });

        ipcMain.handle('music-cancel-preload', () => {
            return audioEngineApi('/cancel_preload', 'POST');
        });

        // --- FIR IR Convolver Handlers ---
        ipcMain.handle('music-load-ir', (event, { path }) => {
            return audioEngineApi('/load_ir', 'POST', { path });
        });

        ipcMain.handle('music-unload-ir', () => {
            return audioEngineApi('/unload_ir', 'POST');
        });

        // --- IR Presets Handling ---
        ipcMain.handle('music-list-ir-presets', async () => {
            const irPresetDir = path.join(__dirname, '..', '..', 'audio_engine', 'IRPreset');
            if (!(await fs.pathExists(irPresetDir))) return [];
            try {
                const files = await fs.readdir(irPresetDir);
                const audioExtensions = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.ape']);
                return files
                    .filter(file => audioExtensions.has(path.extname(file).toLowerCase()))
                    .map(file => path.parse(file).name);
            } catch (err) {
                console.error('[Music] Failed to list IR presets:', err);
                return [];
            }
        });

        ipcMain.handle('music-get-ir-preset-path', async (event, presetName) => {
            const irPresetDir = path.join(__dirname, '..', '..', 'audio_engine', 'IRPreset');
            if (!(await fs.pathExists(irPresetDir))) return null;
            try {
                const files = await fs.readdir(irPresetDir);
                const audioExtensions = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a', '.ape']);
                const match = files.find(file => {
                    const p = path.parse(file);
                    return p.name === presetName && audioExtensions.has(p.ext.toLowerCase());
                });
                return match ? path.join(irPresetDir, match) : null;
            } catch (err) {
                console.error('[Music] Failed to get IR preset path:', err);
                return null;
            }
        });

        // --- IR File Selection Dialog ---
        ipcMain.handle('select-ir-file', async () => {
            const result = await dialog.showOpenDialog(musicWindow || mainWindow, {
                title: '选择脉冲响应文件 (IR)',
                filters: [
                    { name: '音频文件', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a', 'ape'] },
                    { name: 'WAV', extensions: ['wav'] },
                    { name: 'FLAC', extensions: ['flac'] },
                    { name: '所有文件', extensions: ['*'] }
                ],
                properties: ['openFile']
            });
            if (result.canceled || result.filePaths.length === 0) return null;
            return result.filePaths[0];
        });

        ipcMain.handle('music-add-folder', async (event) => {
            const result = await dialog.showOpenDialog(mainWindow, {
                properties: ['openDirectory']
            });

            if (result.canceled || result.filePaths.length === 0) {
                return;
            }

            await runLibraryScan(event, { folderPath: result.filePaths[0] });
        });

        // 拖进窗口的文件和文件夹：文件夹整个扫，单曲只读这几首。路径来自渲染端，逐个确认是本地的目录或音频文件。
        ipcMain.handle('music-add-paths', async (event, paths) => {
            if (!Array.isArray(paths)) return { added: 0 };
            const folders = [];
            const files = [];
            for (const raw of paths.slice(0, 2000)) {
                if (typeof raw !== 'string' || !path.isAbsolute(raw)) continue;
                const stat = await fs.stat(raw).catch(() => null);
                if (stat?.isDirectory()) folders.push(raw);
                else if (stat?.isFile() && SUPPORTED_FORMATS.has(path.extname(raw).toLowerCase())) files.push(raw);
            }
            for (const folderPath of folders) await runLibraryScan(event, { folderPath });
            if (files.length) await runLibraryScan(event, { filePaths: files });
            return { folders: folders.length, files: files.length };
        });

        ipcMain.handle('get-music-playlist', () => readPlaylistFile());

        ipcMain.handle('save-music-playlist', async (event, playlist) => {
            try {
                // 不是数组就不写：写进去之后下次读出来是空曲库。
                if (!Array.isArray(playlist)) throw new TypeError('playlist must be an array');
                // 一份非空曲库被清空时先留个备份：曲库读取失败后界面以空列表存盘，整个曲库就没了。
                if (playlist.length === 0) await backupBeforeEmptying(MUSIC_PLAYLIST_FILE);
                await writeJsonAtomic(MUSIC_PLAYLIST_FILE, playlist);
                return { success: true };
            } catch (error) {
                console.error('Error saving music playlist:', error);
                return { success: false, error: error.message };
            }
        });

        // 自定义歌单持久化
        const CUSTOM_PLAYLISTS_FILE = path.join(path.dirname(MUSIC_PLAYLIST_FILE), 'custom_playlists.json');

        ipcMain.handle('get-custom-playlists', async () => {
            try {
                if (await fs.pathExists(CUSTOM_PLAYLISTS_FILE)) {
                    const playlists = await fs.readJson(CUSTOM_PLAYLISTS_FILE);
                    return Array.isArray(playlists) ? playlists : [];
                }
                return [];
            } catch (error) {
                console.error('[Music] Error reading custom playlists:', error);
                return [];
            }
        });

        ipcMain.handle('save-custom-playlists', async (event, playlists) => {
            try {
                if (!Array.isArray(playlists)) throw new TypeError('playlists must be an array');
                if (playlists.length === 0) await backupBeforeEmptying(CUSTOM_PLAYLISTS_FILE);
                await writeJsonAtomic(CUSTOM_PLAYLISTS_FILE, playlists, { spaces: 2 });
                return { success: true };
            } catch (error) {
                console.error('[Music] Error saving custom playlists:', error);
                return { success: false, error: error.message };
            }
        });

        // --- 跨窗口音乐控制命令（桌面/分布式 → 音乐窗口）：高瞻远瞩智能路由 ---
        ipcMain.on('music-remote-command', async (event, command) => {
            try {
                // 1. 若命令携带目标曲目（支持对象形式或 play:曲目名 前缀），走权威 handleMusicControl 模糊匹配点播
                if (typeof command === 'object' && command && command.target) {
                    console.log(`[Music] Remote track targeted play: ${command.target}`);
                    await handleMusicControl({ command: 'play', target: command.target });
                    return;
                }
                if (typeof command === 'string' && command.startsWith('play:')) {
                    const target = command.substring(5).trim();
                    console.log(`[Music] Remote track targeted play by prefix: ${target}`);
                    await handleMusicControl({ command: 'play', target });
                    return;
                }

                // 2. 基础播控命令（next/previous/play/pause）：窗口存在则直通转发
                if (musicWindow && !musicWindow.isDestroyed()) {
                    console.log(`[Music] Forwarding remote command to music window: ${command}`);
                    musicWindow.webContents.send('music-control', command);
                } else {
                    // 窗口不存在时自动唤醒并延迟派发
                    console.log(`[Music] Music window offline for command '${command}', auto-spawning window...`);
                    await createOrFocusMusicWindow();
                    setTimeout(() => {
                        if (musicWindow && !musicWindow.isDestroyed()) {
                            musicWindow.webContents.send('music-control', command);
                        }
                    }, 600);
                }
            } catch (err) {
                console.error('[Music] Error in music-remote-command handler:', err);
            }
        });

        ipcMain.handle('music-share-track', async (event, filePath) => {
            // 聊天附件只收本地文件：远程（WebDAV）曲目和已经不在磁盘上的文件在这里就说清楚，
            // 不然要到聊天窗口里才弹一个看不懂的「附加失败」。
            if (typeof filePath !== 'string' || /^https?:\/\//i.test(filePath)) {
                return { success: false, message: '远程曲目不能作为附件分享' };
            }
            if (!(await fs.pathExists(filePath))) {
                return { success: false, message: '这首歌的文件已经不在原来的位置了' };
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                console.log(`[Music] Forwarding shared file to renderer: ${filePath}`);
                mainWindow.webContents.send('add-file-to-input', filePath);
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
                return { success: true };
            }
            return { success: false, message: '主窗口没有打开' };
        });

        ipcMain.handle('music-get-lyrics', async (event, { artist, title, rawObject }) => {
            if (!title) return null;

            const sanitize = (str) => (str || '').replace(/[\\/:"*?<>|]/g, '_').trim();
            const sanitizedTitle = sanitize(title);
            const sanitizedArtist = artist ? sanitize(artist) : '';

            // Check JSON first if rawObject requested or available
            const possibleJsonPaths = [];
            if (sanitizedArtist) {
                possibleJsonPaths.push(path.join(LYRIC_DIR, `${sanitizedArtist} - ${sanitizedTitle}.json`));
            } else {
                possibleJsonPaths.push(path.join(LYRIC_DIR, `${sanitizedTitle}.json`));
            }

            for (const jsonPath of possibleJsonPaths) {
                try {
                    if (await fs.pathExists(jsonPath)) {
                        const data = await fs.readJson(jsonPath);
                        return data;
                    }
                } catch (err) {
                    console.warn(`[Music] Error reading JSON lyric cache ${jsonPath}:`, err.message);
                }
            }

            // Fallback to LRC text cache
            const possibleLrcPaths = [];
            if (sanitizedArtist) {
                possibleLrcPaths.push(path.join(LYRIC_DIR, `${sanitizedArtist} - ${sanitizedTitle}.lrc`));
            } else {
                possibleLrcPaths.push(path.join(LYRIC_DIR, `${sanitizedTitle}.lrc`));
            }

            for (const lrcPath of possibleLrcPaths) {
                try {
                    if (await fs.pathExists(lrcPath)) {
                        // 自己放进歌词目录的 .lrc 常是 GBK 或带 BOM 的 UTF-8/UTF-16
                        return require('../lyrics/decodeLyricText').decodeLyricText(await fs.readFile(lrcPath));
                    }
                } catch (error) {
                    console.error(`[Music] Error reading lyric file ${lrcPath}:`, error);
                }
            }

            return null;
        });

        ipcMain.handle('music-fetch-lyrics', async (event, { artist, title, duration, durationMs, album, rawObject }) => {
            if (!title) return null;
            console.log(`[Music] IPC: Received request to fetch lyrics for "${title}" by "${artist}"`);
            try {
                await fs.ensureDir(LYRIC_DIR);
                const result = await lyricFetcher.fetchAndSaveLyrics(artist, title, LYRIC_DIR, {
                    duration,
                    durationMs,
                    album,
                    rawObject: rawObject !== undefined ? rawObject : true
                });
                return result;
            } catch (error) {
                console.error(`[Music] Error fetching lyrics via IPC for "${title}":`, error);
                return null;
            }
        });

        ipcMain.handle('music-search-lyrics-candidates', async (event, options = {}) => {
            const title = typeof options.title === 'string' ? options.title.trim() : '';
            if (!title) return { success: false, message: '缺少歌曲标题', candidates: [] };

            try {
                const candidates = await lyricFetcher.searchLyricsCandidates({
                    title,
                    artist: typeof options.artist === 'string' ? options.artist.trim() : '',
                    album: typeof options.album === 'string' ? options.album.trim() : '',
                    durationMs: Number.isFinite(Number(options.durationMs))
                        ? Math.max(0, Number(options.durationMs))
                        : 0
                });
                return { success: true, candidates };
            } catch (error) {
                console.error(`[Music] Error searching lyric candidates for "${title}":`, error);
                return { success: false, message: error.message || '搜索歌词失败', candidates: [] };
            }
        });

        ipcMain.handle('music-apply-lyrics-candidate', async (event, options = {}) => {
            const title = typeof options.title === 'string' ? options.title.trim() : '';
            const candidateKey = typeof options.candidateKey === 'string' ? options.candidateKey : '';
            if (!title || !candidateKey) {
                return { success: false, message: '缺少歌曲或歌词候选信息' };
            }

            try {
                return await lyricFetcher.saveSelectedLyrics({
                    candidateKey,
                    title,
                    artist: typeof options.artist === 'string' ? options.artist.trim() : '',
                    lyricDir: LYRIC_DIR
                });
            } catch (error) {
                console.error(`[Music] Error applying lyric candidate for "${title}":`, error);
                return { success: false, message: error.message || '覆盖歌词失败' };
            }
        });

        // ============ WebDAV IPC Handlers ============
        // 前端直接传递完整凭据 {url, username, password, path}

        ipcMain.handle('webdav-add-server', (event, config) => {
            return webdavManager.addServer(config);
        });

        ipcMain.handle('webdav-remove-server', (event, { id }) => {
            webdavManager.removeServer(id);
            return { ok: true };
        });

        ipcMain.handle('webdav-list-servers', () => {
            return webdavManager.listServers();
        });

        // 前端传递: { url, username, password }
        ipcMain.handle('webdav-test-connection', async (event, config) => {
            return await webdavManager.testConnection(config);
        });

        // 前端传递: { serverId?, url, username?, password?, path }
        ipcMain.handle('webdav-list-directory', async (event, config) => {
            // 如果提供了 serverId，从后端获取完整凭据
            if (config.serverId) {
                const serverCreds = webdavManager.getServerCredentials(config.serverId);
                if (serverCreds) {
                    config.url = serverCreds.url;
                    config.username = serverCreds.username;
                    config.password = serverCreds.password;
                }
            }
            return await webdavManager.listDirectory(config);
        });

        // 前端传递: { serverId?, url, username?, password?, path? }
        ipcMain.handle('webdav-scan-audio', async (event, config) => {
            console.log('[Music] webdav-scan-audio called with config:', { serverId: config.serverId, url: config.url });
            // 如果提供了 serverId，从后端获取完整凭据
            if (config.serverId) {
                const serverCreds = webdavManager.getServerCredentials(config.serverId);
                console.log('[Music] serverCreds found:', !!serverCreds, 'hasPassword:', !!(serverCreds?.password));
                if (serverCreds) {
                    config.url = serverCreds.url;
                    config.username = serverCreds.username;
                    config.password = serverCreds.password;
                }
            }
            const results = await webdavManager.scanAudioFiles(config, (count) => {
                if (musicWindow && !musicWindow.isDestroyed()) {
                    musicWindow.webContents.send('webdav-scan-progress', { count });
                }
            });
            console.log('[Music] scanAudioFiles returned:', results?.status, 'tracks:', results?.tracks?.length);
            return results;
        });

        // 前端传递: { url, serverId?, remotePath? }
        ipcMain.handle('webdav-get-file-url', (event, config) => {
            return webdavManager.getFileUrl(config);
        });

        // 获取服务器完整凭据（包含密码）
        ipcMain.handle('webdav-get-server-credentials', (event, { serverId }) => {
            return webdavManager.getServerCredentials(serverId);
        });

        // Load a WebDAV file: 前端传递 { url, serverId?, username?, password?, trackMeta? }
        // 如果提供 serverId，则从后端获取完整凭据（包含密码）
        ipcMain.handle('webdav-load-track', async (event, config) => {
            if (!config.url) return { status: 'error', message: 'No URL provided' };
            
            // 如果提供了 serverId，从后端获取完整凭据
            if (config.serverId && !config.password) {
                const serverCreds = webdavManager.getServerCredentials(config.serverId);
                if (serverCreds) {
                    config.username = serverCreds.username;
                    config.password = serverCreds.password;
                }
            }
            
            currentSongInfo = {
                title: config.trackMeta?.title || config.url.split('/').pop().split('?')[0],
                artist: config.trackMeta?.artist || '未知艺术家',
                album: config.trackMeta?.album || '未知专辑',
            };
            return await webdavManager.configureAndLoad(config);
        });
    };

    // 使用动态导入，并在成功后注册所有IPC处理器
    // 先注册 IPC 处理器，再异步加载 node-fetch
    console.error('[Music] About to call registerIpcHandlers...');
    registerIpcHandlers();
    ipcHandlersRegistered = true;
    console.error('[Music] IPC handlers registered.');
    console.log('[Music] IPC handlers registered.');
    
    import('node-fetch').then(module => {
        fetch = module.default;
        console.log('[Music] node-fetch loaded successfully.');
    }).catch(err => {
        console.error('[Music] Failed to load node-fetch:', err);
    });
}

module.exports = {
    initialize,
    handleMusicControl,
    createOrFocusMusicWindow,
    getMusicWindow: () => musicWindow,
    getMusicState: () => ({ musicWindow, currentSongInfo })
};
