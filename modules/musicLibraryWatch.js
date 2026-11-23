// modules/musicLibraryWatch.js
// 曲库文件夹自动同步：记住加过的音乐文件夹；音乐窗口打开后在后台把这些文件夹和已有曲目所在的文件夹
// 对一遍磁盘（没动过的文件只看大小和修改时间，不重新读），有新增、删除、改了标签才把结果发给窗口；
// 窗口开着时监听这些文件夹，文件有变化 5 秒后再对一遍。
// 后台这几遍不发 scan-start / progress，窗口里不会冒出「正在扫描」。
// 只有加过的文件夹做完整同步（新歌加进来、磁盘上没了的移除）；从曲目推出来的文件夹（以前加的、
// 拖进来的单曲所在的）只更新改过标签的已有曲目，不加也不删：不会把「下载」里别的音频一股脑加进曲库，
// 也不会因为曲库文件还没存盘就误删刚拖进来的歌。
// 拔掉的移动硬盘、读不了的文件夹：跳过，不当成歌被删了。

const path = require('path');
const fs = require('fs');

const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a)$/i;
const MAX_WATCHED = 32;
const DEBOUNCE_MS = 5000;
const START_DELAY_MS = 4000;

const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
const isUnder = (child, parent) => {
    const c = norm(child), p = norm(parent);
    return c === p || c.startsWith(p + path.sep.toLowerCase()) || c.startsWith(p + '/') || c.startsWith(p + '\\');
};

// 一组文件夹去掉被别的文件夹包含的，保持原顺序
function collapseRoots(dirs) {
    const out = [];
    for (const d of dirs) {
        if (!d) continue;
        if (out.some((r) => isUnder(d, r))) continue;
        for (let i = out.length - 1; i >= 0; i--) if (isUnder(out[i], d)) out.splice(i, 1);
        out.push(d);
    }
    return out;
}

// 已有曲目所在的文件夹（本机文件），按曲目数从多到少
function inferredDirs(tracks) {
    const count = new Map();
    for (const t of tracks || []) {
        const p = t && t.path;
        if (typeof p !== 'string' || /^https?:\/\//i.test(p) || t.isRemote) continue;
        const d = path.dirname(p);
        const k = norm(d);
        const had = count.get(k);
        if (had) had.n++; else count.set(k, { dir: d, n: 1 });
    }
    return [...count.values()].sort((a, b) => b.n - a.n).map((e) => e.dir);
}

// 这次扫到的和上次存的比，有没有变化（新增、删除、文件改过）
function changedSince(known, scanned, root) {
    const before = new Map();
    for (const t of known || []) if (t && typeof t.path === 'string' && isUnder(t.path, root)) before.set(t.path, t);
    const after = scanned || [];
    if (after.length !== before.size) return true;
    for (const t of after) {
        const k = before.get(t.path);
        if (!k) return true;
        if (Number(k.size) !== Number(t.size) || Math.abs((Number(k.mtimeMs) || 0) - (Number(t.mtimeMs) || 0)) > 1) return true;
    }
    return false;
}

function createLibraryWatch({
    scan,                 // (folderPath, signal) => Promise<{ tracks, stats }>
    readKnown,            // () => Promise<track[]>
    readFolders,          // () => Promise<string[]>
    writeFolders,         // (folders) => Promise<void>
    send,                 // (channel, payload) => void
    exists = (dir) => fs.promises.stat(dir).then((s) => s.isDirectory(), () => false),
    watch = (dir, cb) => fs.watch(dir, { recursive: true }, cb),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = console
} = {}) {
    let watchers = [];
    let queue = [];
    let running = false;
    let generation = 0;
    let abort = null;
    const timers = new Map();

    const rememberFolder = async (dir) => {
        if (!dir) return;
        try {
            const list = (await readFolders()) || [];
            if (list.some((d) => norm(d) === norm(dir))) return;
            await writeFolders(collapseRoots([...list, dir]));
        } catch (e) { log.warn?.('[MusicWatch] remember folder failed:', e?.message || e); }
    };

    // 加过的文件夹在前；推出来的文件夹去掉被加过的文件夹包含的，也去掉包含加过的文件夹的（太宽）
    const roots = async () => {
        const remembered = collapseRoots((await readFolders().catch(() => [])) || []);
        const known = (await readKnown().catch(() => [])) || [];
        const inferred = collapseRoots(inferredDirs(known))
            .filter((d) => !remembered.some((r) => isUnder(d, r) || isUnder(r, d)));
        return { list: [...remembered, ...inferred], remembered, known };
    };
    let rememberedNow = [];

    const runQueue = async (gen) => {
        if (running) return;
        running = true;
        try {
            while (queue.length && gen === generation) {
                const root = queue.shift();
                if (!(await exists(root))) continue; // 拔掉的盘、改名的文件夹：不动
                const known = (await readKnown().catch(() => [])) || [];
                abort = new AbortController();
                let result;
                try { result = await scan(root, abort.signal); } catch (e) { log.warn?.('[MusicWatch] scan failed:', root, e?.message || e); continue; }
                if (gen !== generation || !result || result.stats?.aborted) continue;
                let tracks = result.tracks || [];
                const full = rememberedNow.some((r) => norm(r) === norm(root));
                if (!full) {
                    const byPath = new Map(known.map((t) => [t && t.path, t]));
                    tracks = tracks.filter((t) => {
                        const k = byPath.get(t.path);
                        return k && (Number(k.size) !== Number(t.size) || Math.abs((Number(k.mtimeMs) || 0) - (Number(t.mtimeMs) || 0)) > 1);
                    });
                    if (!tracks.length) continue;
                } else if (!changedSince(known, tracks, root)) continue;
                log.log?.(`[MusicWatch] ${root} changed on disk, syncing ${tracks.length} tracks (${full ? 'full' : 'update only'})`);
                // folderPath 为空时窗口只加、只更新，不删
                send('music-scan-complete', { tracks, folderPath: full ? root : null, stats: { total: result.stats?.total || 0, failed: result.stats?.failed || 0 }, background: true });
            }
        } finally {
            running = false;
            abort = null;
        }
    };

    const enqueue = (root) => {
        if (!queue.some((r) => norm(r) === norm(root))) queue.push(root);
        runQueue(generation).catch(() => {});
    };

    const start = () => {
        stop();
        const gen = ++generation;
        const t = setTimer(async () => {
            timers.delete('start');
            if (gen !== generation) return;
            const { list, remembered } = await roots();
            if (gen !== generation) return;
            rememberedNow = remembered;
            list.forEach(enqueue);
            for (const root of list.slice(0, MAX_WATCHED)) {
                if (!(await exists(root)) || gen !== generation) continue;
                try {
                    const w = watch(root, (_type, file) => {
                        const f = String(file || '');
                        // 文件夹本身的变化（拷进来一整张专辑）也算；别的文件（封面、歌词）不管
                        if (f && path.extname(f) && !AUDIO_EXT.test(f)) return;
                        clearTimer(timers.get(root));
                        timers.set(root, setTimer(() => { timers.delete(root); if (gen === generation) enqueue(root); }, DEBOUNCE_MS));
                    });
                    w.on?.('error', () => { try { w.close(); } catch (e) { /* 已关 */ } });
                    watchers.push(w);
                } catch (e) { log.warn?.('[MusicWatch] watch failed:', root, e?.message || e); }
            }
        }, START_DELAY_MS);
        timers.set('start', t);
    };

    function stop() {
        generation++;
        queue = [];
        abort?.abort();
        for (const t of timers.values()) clearTimer(t);
        timers.clear();
        for (const w of watchers) { try { w.close(); } catch (e) { /* 已关 */ } }
        watchers = [];
    }

    const rememberAndSync = async (dir) => {
        await rememberFolder(dir);
        if (!rememberedNow.some((r) => norm(r) === norm(dir))) rememberedNow = collapseRoots([...rememberedNow, dir]);
    };
    return { start, stop, rememberFolder: rememberAndSync, rescanNow: () => roots().then(({ list, remembered }) => { rememberedNow = remembered; list.forEach(enqueue); }) };
}

module.exports = { createLibraryWatch, collapseRoots, inferredDirs, changedSince };
