// Musicmodules/music-stats-view.js
// 听歌统计（命令面板「听歌统计」，或 Ctrl+K 输入 tongji）：
//   听了多久、几次、几天，一天里几点听得最多，最常听的歌 / 歌手 / 专辑。可切近 7 天、近 30 天、近一年、全部。
// 数据全来自 music-stats.js（本机记录，不上传）。点歌直接放，点歌手、专辑跳到目录里那一组。
// 外观沿用音乐窗口自己的对话框（.dialog-overlay > .dialog.glass-panel），打开合上的液体动作由流体套件接管。
(function (global) {
    'use strict';

    const RANGES = [[7, '近 7 天'], [30, '近 30 天'], [365, '近一年'], [0, '全部']];
    const RANGE_KEY = 'musicStatsRange';
    const TOP = 5;

    const norm = (s) => String(s || '').trim().toLowerCase();
    const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    const firstArtist = (t) => String((t && t.artist) || '').split(/\s*(?:\/|,|，|、|&|;|feat\.?|ft\.)\s*/)[0].trim();

    // 秒 → 「3 小时 12 分」「45 分」「不到 1 分」
    const formatDuration = (sec) => {
        const m = Math.floor((Number(sec) || 0) / 60);
        if (m < 1) return '不到 1 分';
        const h = Math.floor(m / 60);
        return h ? `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分`;
    };
    const hourName = (h) => {
        const part = h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
        const n = h < 5 ? h : h % 12 === 0 ? 12 : h % 12;
        return `${part} ${n} 点`;
    };

    // 把 summary 里按次数排的歌合成歌手、专辑榜（纯函数，测试用）
    function rank(summary, library) {
        const byPath = new Map((library || []).map((t, i) => [normPath(t && t.path), i]));
        const songs = [];
        const artists = new Map();
        const albums = new Map();
        for (const row of summary.tracks || []) {
            const index = byPath.get(normPath(row.path));
            if (index === undefined) continue;
            const t = library[index];
            songs.push({ index, track: t, plays: row.plays });
            const a = firstArtist(t);
            if (a) {
                const k = norm(a);
                const had = artists.get(k) || { name: a, plays: 0, index };
                had.plays += row.plays;
                artists.set(k, had);
            }
            if (t.album) {
                const k = norm(t.album) + '\n' + norm(a);
                const had = albums.get(k) || { name: t.album, artist: a, plays: 0, index };
                had.plays += row.plays;
                albums.set(k, had);
            }
        }
        const top = (m) => [...m.values()].sort((x, y) => y.plays - x.plays).slice(0, TOP);
        return { songs: songs.slice(0, TOP), artists: top(artists), albums: top(albums) };
    }

    function setupMusicStatsView(app) {
        if (!app || app.openStatsView) return;
        const doc = global.document;
        let overlay = null;
        let range = 30;
        try { const v = Number(global.localStorage?.getItem(RANGE_KEY)); if (RANGES.some(([d]) => d === v)) range = v; } catch (e) { /* 默认 30 天 */ }

        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const title = (t) => (app.stripAudioExtension ? app.stripAudioExtension(t.title || '') : String(t.title || '')) || '未知标题';

        const close = () => {
            if (!overlay) return;
            const o = overlay;
            overlay = null;
            global.removeEventListener('keydown', onKey, true);
            o.classList.remove('visible');
            setTimeout(() => o.remove(), 320);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) e.stopPropagation();
        };

        const list = (heading, rows, render) => {
            const box = el('section', 'mstats-top');
            box.appendChild(el('h4', '', heading));
            if (!rows.length) { box.appendChild(el('p', 'mstats-none', '—')); return box; }
            const ol = el('ol');
            rows.forEach((row) => {
                const li = el('li');
                const btn = el('button', 'mstats-row');
                btn.type = 'button';
                const [main, sub, run] = render(row);
                btn.appendChild(el('span', 'mstats-name', main));
                if (sub) btn.appendChild(el('span', 'mstats-sub', sub));
                btn.appendChild(el('span', 'mstats-count', `${row.plays} 次`));
                btn.addEventListener('click', () => { close(); run(); });
                li.appendChild(btn);
                ol.appendChild(li);
            });
            box.appendChild(ol);
            return box;
        };

        const render = () => {
            if (!overlay) return;
            const body = overlay.querySelector('.mstats-body');
            body.innerHTML = '';
            overlay.querySelectorAll('.mstats-range button').forEach((b) => {
                const on = Number(b.dataset.days) === range;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            const stats = app.musicStats;
            const s = stats && typeof stats.summary === 'function' ? stats.summary({ days: range }) : null;
            if (!s || (!s.seconds && !s.plays)) {
                body.appendChild(el('p', 'mstats-empty', range ? '这段时间还没有听歌记录。' : '还没有听歌记录。'));
                body.appendChild(el('p', 'mstats-note', '一首歌放到一半（或满 4 分钟）算听了一次；记录只存在这台电脑上。'));
                return;
            }
            const totals = el('div', 'mstats-totals');
            [[formatDuration(s.seconds), '听歌时长'], [`${s.plays}`, '听完的歌（次）'], [`${s.activeDays}`, '有听歌的天数']].forEach(([v, k]) => {
                const cell = el('div', 'mstats-total');
                cell.appendChild(el('strong', '', v));
                cell.appendChild(el('span', '', k));
                totals.appendChild(cell);
            });
            body.appendChild(totals);

            const max = Math.max(...s.hours);
            if (max > 0) {
                const peak = s.hours.indexOf(max);
                const chart = el('section', 'mstats-hours');
                chart.appendChild(el('h4', '', `一天里最常在${hourName(peak)}听`));
                const bars = el('div', 'mstats-bars');
                bars.setAttribute('role', 'img');
                bars.setAttribute('aria-label', `24 小时听歌分布，最多在 ${peak} 点`);
                s.hours.forEach((v, h) => {
                    const bar = el('i', h === peak ? 'peak' : '');
                    bar.style.setProperty('--h', `${Math.max(v > 0 ? 6 : 2, Math.round((v / max) * 100))}%`);
                    bar.title = `${h}:00–${h + 1}:00　${formatDuration(v)}`;
                    bars.appendChild(bar);
                });
                chart.appendChild(bars);
                const axis = el('div', 'mstats-axis');
                ['0', '6', '12', '18', '24'].forEach((t) => axis.appendChild(el('span', '', t)));
                chart.appendChild(axis);
                body.appendChild(chart);
            }

            const r = rank(s, app.playlist || []);
            const tops = el('div', 'mstats-tops');
            tops.appendChild(list('最常听的歌', r.songs, (row) => [title(row.track), firstArtist(row.track), () => app.loadTrack?.(row.index)]));
            tops.appendChild(list('最常听的歌手', r.artists, (row) => [row.name, '', () => app.goToGroup?.(row.index, 'artist')]));
            tops.appendChild(list('最常听的专辑', r.albums, (row) => [row.name, row.artist, () => app.goToGroup?.(row.index, 'album')]));
            body.appendChild(tops);
            if (!range && s.since) body.appendChild(el('p', 'mstats-note', `听歌时长从 ${s.since} 开始记；次数包括更早的记录。`));
        };

        app.openStatsView = () => {
            if (overlay) return;
            overlay = el('div', 'dialog-overlay music-stats-dialog');
            const dialog = el('div', 'dialog glass-panel mstats');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', 'mstats-title');
            const head = el('header', 'mstats-head');
            const h = el('h3', '', '听歌统计');
            h.id = 'mstats-title';
            head.appendChild(h);
            const seg = el('div', 'mstats-range');
            seg.setAttribute('role', 'group');
            seg.setAttribute('aria-label', '时间范围');
            RANGES.forEach(([d, label]) => {
                const b = el('button', '', label);
                b.type = 'button';
                b.dataset.days = String(d);
                b.addEventListener('click', () => {
                    range = d;
                    try { global.localStorage?.setItem(RANGE_KEY, String(d)); } catch (e) { /* 只是偏好 */ }
                    render();
                });
                seg.appendChild(b);
            });
            head.appendChild(seg);
            const x = el('button', 'mstats-close', '×');
            x.type = 'button';
            x.setAttribute('aria-label', '关闭');
            x.addEventListener('click', close);
            head.appendChild(x);
            dialog.appendChild(head);
            dialog.appendChild(el('div', 'mstats-body'));
            overlay.appendChild(dialog);
            overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
            doc.body.appendChild(overlay);
            global.addEventListener('keydown', onKey, true);
            render();
            requestAnimationFrame(() => {
                if (!overlay) return;
                overlay.classList.add('visible');
                overlay.querySelector('.mstats-range button.active')?.focus({ preventScroll: true });
            });
        };
        app.closeStatsView = close;
    }

    // 命令面板直接调这个：第一次用时才装上
    const open = (app) => { setupMusicStatsView(app); app?.openStatsView?.(); };
    const exported = { setupMusicStatsView, open, rank, formatDuration, hourName };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.setupMusicStatsView = setupMusicStatsView;
    global.MusicStatsView = exported;
})(typeof window !== 'undefined' ? window : globalThis);
