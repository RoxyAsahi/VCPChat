// modules/ipc/musicLibraryFolders.js
//
// 曲库文件夹：记住用户加过的音乐文件夹，之后文件夹里加歌、删歌、改标签，曲库自己跟上，不用再手动「添加文件夹」。
// - 打开音乐窗口后过几秒，把每个文件夹静默对一遍（没变的文件只 stat 不重读，几千首也很快）；
// - 音乐窗口开着时盯着这些文件夹（fs.watch 递归），有音频文件变动就攒几秒再对那一个文件夹；
// - 结果走 `music-library-sync`，不走 music-scan-*：不弹扫描进度，界面只在真有增删时提示一句。
// 拔掉的移动硬盘、暂时打不开的文件夹直接跳过，不会把里面的歌当成被删了。
// 记录存在 music-library-folders.json：[{ path, addedAt }]。

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');

const FIRST_SYNC_DELAY = 4000;
const WATCH_SETTLE = 4000;
const AUDIO = /\.(mp3|flac|wav|ogg|m4a|aac|opus|wv|ape|alac|aiff?|dsf|dff|wma)$/i;

const safeHome = () => { try { return require('os').homedir(); } catch (_) { return ''; } };
const keyOf = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// 从已有曲库推一个「音乐根目录」：同一个盘上所有歌的最深公共上级。太浅（盘符根）就不要。
function inferRoots(trackPaths, home = safeHome()) {
    const byDrive = new Map();
    for (const raw of trackPaths || []) {
        // 盘符路径（D:\…）、/开头的路径才算本地；网址（WebDAV）和相对路径不算。不依赖当前系统的 path 规则，测试在哪都一样
        if (typeof raw !== 'string' || !(/^[a-z]:[\\/]/i.test(raw) || raw.startsWith('/'))) continue;
        const parts = raw.replace(/\\/g, '/').split('/');
        parts.pop(); // 文件名
        const drive = parts[0].toLowerCase();
        const prev = byDrive.get(drive);
        if (!prev) { byDrive.set(drive, { parts, sep: raw.includes('\\') ? '\\' : '/' }); continue; }
        let i = 0;
        while (i < prev.parts.length && i < parts.length && prev.parts[i].toLowerCase() === parts[i].toLowerCase()) i++;
        prev.parts = prev.parts.slice(0, i);
    }
    const roots = [];
    for (const { parts, sep } of byDrive.values()) {
        const depth = parts.filter(Boolean).length;
        if (depth < 2) continue; // 「D:」「/home」这种太大，不替用户盯
        const root = parts.join(sep);
        // 用户目录本身或它的上级（歌散在「下载」「音乐」好几处时会推到这里）也太大
        const hk = keyOf(home);
        if (hk && (hk === keyOf(root) || hk.startsWith(keyOf(root) + '/'))) continue;
        roots.push(root);
    }
    return roots;
}

function createLibraryFolders({ ipcMain, getMusicWindow, stateFile, scan, readPlaylist, watch = fs.watch, now = () => Date.now() }) {
    let folders = null;     // [{ path, addedAt }]
    let watchers = new Map();
    let timers = new Map();
    let running = Promise.resolve();
    let firstTimer = null;

    const musicWin = () => {
        const w = getMusicWindow();
        return w && !w.isDestroyed() ? w : null;
    };
    const send = (channel, payload) => musicWin()?.webContents.send(channel, payload);

    const load = async () => {
        if (folders) return folders;
        try {
            const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
            folders = Array.isArray(raw) ? raw.filter((f) => f && typeof f.path === 'string') : [];
        } catch (_) {
            folders = null;
        }
        if (!folders) {
            // 第一次用：按现有曲库推出音乐根目录记下来，老用户不用重新加
            const roots = inferRoots((await readPlaylist().catch(() => [])).map((t) => t && t.path));
            folders = roots.map((p) => ({ path: p, addedAt: now(), inferred: true }));
            await save();
        }
        return folders;
    };
    const save = async () => {
        try { await fsp.writeFile(stateFile, JSON.stringify(folders || [])); } catch (e) { console.error('[Music] 曲库文件夹没存上:', e.message); }
    };
    const exists = async (p) => { try { return (await fsp.stat(p)).isDirectory(); } catch (_) { return false; } };
    const list = async () => Promise.all((await load()).map(async (f) => ({ path: f.path, addedAt: f.addedAt, inferred: f.inferred === true, online: await exists(f.path) })));

    // 一个文件夹对一遍；排队，同一时间只扫一个
    const syncOne = (folderPath, reason) => {
        running = running.then(async () => {
            if (!musicWin() || !(await exists(folderPath))) return;
            try {
                const result = await scan(folderPath);
                if (result && !result.aborted) send('music-library-sync', { folderPath, tracks: result.tracks, reason });
            } catch (e) {
                console.error('[Music] 曲库同步失败:', folderPath, e.message);
            }
        });
        return running;
    };
    const syncAll = async (reason) => {
        for (const f of await load()) syncOne(f.path, reason);
        return running;
    };

    const unwatchAll = () => {
        for (const w of watchers.values()) { try { w.close(); } catch (_) { /* 已关 */ } }
        watchers = new Map();
        for (const t of timers.values()) clearTimeout(t);
        timers = new Map();
    };
    const watchOne = (folderPath) => {
        const k = keyOf(folderPath);
        if (watchers.has(k)) return;
        try {
            const w = watch(folderPath, { recursive: true, persistent: false }, (_type, file) => {
                if (file && !AUDIO.test(String(file)) && path.extname(String(file))) return; // 封面、歌词之类不管；没扩展名的可能是文件夹
                clearTimeout(timers.get(k));
                timers.set(k, setTimeout(() => { timers.delete(k); syncOne(folderPath, 'watch'); }, WATCH_SETTLE));
            });
            w.on?.('error', () => { try { w.close(); } catch (_) { /* 同上 */ } watchers.delete(k); });
            watchers.set(k, w);
        } catch (e) {
            console.warn('[Music] 盯不了这个文件夹（之后打开播放器时仍会对一遍）:', folderPath, e.message);
        }
    };

    const remember = async (folderPath) => {
        if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) return false;
        const list0 = await load();
        const k = keyOf(folderPath);
        // 已经在某个记住的文件夹里面：不用再记；新文件夹包住了旧的：旧的换成新的
        if (list0.some((f) => k === keyOf(f.path) || k.startsWith(keyOf(f.path) + '/'))) return false;
        folders = list0.filter((f) => !keyOf(f.path).startsWith(k + '/'));
        folders.push({ path: folderPath, addedAt: now() });
        await save();
        if (musicWin()) watchOne(folderPath);
        send('music-library-folders-changed', await list());
        return true;
    };

    ipcMain.handle('music-library-folders-get', () => list());
    ipcMain.handle('music-library-folders-remove', async (event, folderPath) => {
        if (!musicWin() || event.sender !== musicWin().webContents) throw new Error('只有音乐窗口能改曲库文件夹。');
        const k = keyOf(folderPath);
        folders = (await load()).filter((f) => keyOf(f.path) !== k);
        await save();
        const w = watchers.get(k);
        if (w) { try { w.close(); } catch (_) { /* 已关 */ } watchers.delete(k); }
        const out = await list();
        send('music-library-folders-changed', out);
        return out;
    });
    ipcMain.handle('music-library-folders-sync', async (event) => {
        if (!musicWin() || event.sender !== musicWin().webContents) throw new Error('只有音乐窗口能同步曲库。');
        await syncAll('manual');
        return list();
    });

    return {
        remember,
        list,
        syncAll,
        // 音乐窗口就绪：过几秒对一遍，然后开始盯
        async musicReady() {
            clearTimeout(firstTimer);
            const fl = await load();
            fl.forEach((f) => watchOne(f.path));
            firstTimer = setTimeout(() => { firstTimer = null; syncAll('open'); }, FIRST_SYNC_DELAY);
        },
        musicClosed() {
            clearTimeout(firstTimer);
            firstTimer = null;
            unwatchAll();
        },
        _watching: () => [...watchers.keys()]
    };
}

module.exports = { createLibraryFolders, inferRoots, keyOf };
