// Musicmodules/music-dock/music-dock-palette.js
// 命令面板（Ctrl+K / ⌘K，或快捷行最后那个按钮）：从底部胶囊的位置往上长出来，
// 一个输入框同时搜歌（当前队列优先，再到全部曲目）和常用操作，记住最近用过的十项。
// 过滤写法：--歌手 名字、--专辑 名字、--标题 名字（也认 --artist / --album / --title 和 --a / --al / --t），
// 输入 -- 时列出可用的过滤。主界面和舞台里都能用。
(function (global) {
    'use strict';

    const RECENT_KEY = 'musicDockRecentCommands';
    const MAX_RECENT = 10;
    const MAX_SONGS = 60;
    const FILTERS = Object.freeze([
        { key: 'artist', flag: '歌手', aliases: ['artist', 'a'], hint: '只在歌手里找' },
        { key: 'album', flag: '专辑', aliases: ['album', 'al'], hint: '只在专辑里找' },
        { key: 'title', flag: '标题', aliases: ['title', 't'], hint: '只在歌名里找' }
    ]);
    const FLAG_LOOKUP = new Map();
    for (const f of FILTERS) {
        FLAG_LOOKUP.set(f.flag, f.key);
        for (const alias of f.aliases) FLAG_LOOKUP.set(alias, f.key);
    }

    const lower = (value) => String(value || '').toLowerCase();

    /* 把输入拆成自由文字和 --过滤。"夜 --歌手 远舟" → { text: '夜', artist: '远舟' }。 */
    const parseQuery = (raw) => {
        const out = { text: '', artist: '', album: '', title: '', pendingFlag: null };
        const tokens = String(raw || '').split(/\s+/).filter(Boolean);
        const free = [];
        let current = null;
        for (const token of tokens) {
            if (token.startsWith('--')) {
                const name = token.slice(2);
                const key = FLAG_LOOKUP.get(name) || FLAG_LOOKUP.get(lower(name));
                if (key) { current = key; continue; }
                out.pendingFlag = name;
                current = null;
                continue;
            }
            if (current) out[current] = out[current] ? `${out[current]} ${token}` : token;
            else free.push(token);
        }
        out.text = free.join(' ');
        const last = tokens[tokens.length - 1] || '';
        if (/\s$/.test(raw || '') === false && last.startsWith('--') && !FLAG_LOOKUP.has(last.slice(2))) {
            out.pendingFlag = last.slice(2);
        }
        return out;
    };

    const hasSongFilter = (q) => Boolean(q.text || q.artist || q.album || q.title);

    /* 歌是否匹配：自由文字在标题/歌手/专辑里找，过滤只在对应字段里找；越靠前的命中分越高。 */
    const scoreTrack = (track, q, stripExtension) => {
        if (!track) return -1;
        const title = lower(stripExtension ? stripExtension(track.title) : track.title);
        const artist = lower(track.artist);
        const album = lower(track.album);
        if (q.artist && !artist.includes(lower(q.artist))) return -1;
        if (q.album && !album.includes(lower(q.album))) return -1;
        if (q.title && !title.includes(lower(q.title))) return -1;
        let score = 1;
        if (q.text) {
            const words = lower(q.text).split(/\s+/).filter(Boolean);
            for (const word of words) {
                if (title.startsWith(word)) score += 6;
                else if (title.includes(word)) score += 4;
                else if (artist.includes(word)) score += 2;
                else if (album.includes(word)) score += 1;
                else return -1;
            }
        }
        return score;
    };

    const readRecent = () => {
        try {
            const value = JSON.parse(global.localStorage.getItem(RECENT_KEY) || '[]');
            return Array.isArray(value) ? value.filter((id) => typeof id === 'string').slice(0, MAX_RECENT) : [];
        } catch (error) { return []; }
    };
    const writeRecent = (list) => {
        try { global.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch (error) {}
    };

    function createMusicDockPalette(app, deps) {
        const { host, icon, escapeHtml, trackTitle, trackArtist, openPanel, openSheet, toggleStage, cycleMode, setVolume, readVolume, closeOthers } = deps;

        const root = document.createElement('div');
        root.className = 'md-cmd';
        root.hidden = true;
        root.innerHTML = `
<div class="md-cmd-scrim" data-cmd="scrim"></div>
<div class="md-cmd-wrap">
  <section class="md-cmd-box" role="dialog" aria-modal="true" aria-label="命令面板">
    <div class="md-cmd-body">
      <div class="md-cmd-hints" hidden></div>
      <div class="md-cmd-list" role="listbox" id="music-dock-cmd-list" aria-label="结果"></div>
    </div>
    <div class="md-cmd-hd">
      <span class="md-cmd-ic">${icon('search', 18)}</span>
      <input class="md-cmd-in" type="text" spellcheck="false" autocomplete="off" placeholder="搜歌、歌手、专辑，或输入操作…  --歌手 / --专辑 可过滤"
        role="combobox" aria-expanded="true" aria-controls="music-dock-cmd-list" aria-autocomplete="list">
      <kbd class="md-cmd-kbd">Esc</kbd>
    </div>
  </section>
</div>`;
        host.appendChild(root);
        const input = root.querySelector('.md-cmd-in');
        const list = root.querySelector('.md-cmd-list');
        const hints = root.querySelector('.md-cmd-hints');
        const box = root.querySelector('.md-cmd-box');

        const state = { open: false, items: [], active: 0, lastFocus: null, closeTimer: null };

        // ───────── 命令表 ─────────
        const panelCmd = (tab, iconName, words) => ({
            id: `panel:${tab}`, group: '面板', icon: iconName, title: `打开面板 · ${tab}`, words, run: () => openPanel(tab)
        });
        const commands = () => {
            const playing = app.isPlaying === true;
            const inStage = app.isStageActive === true;
            const mode = app.playModes?.[app.currentPlayMode] || 'repeat';
            const light = document.body.classList.contains('light-theme');
            const v = readVolume();
            return [
                { id: 'toggle-play', group: '播放', icon: playing ? 'pause' : 'play', title: playing ? '暂停' : '播放', hint: 'Space', words: 'play pause 播放 暂停 bofang zanting', run: () => (playing ? app.pauseTrack?.() : app.playTrack?.()) },
                { id: 'next', group: '播放', icon: 'skip-forward', title: '下一首', words: 'next 下一首 xiayishou 切歌', run: () => app.nextTrack?.() },
                { id: 'prev', group: '播放', icon: 'skip-back', title: '上一首', words: 'prev previous 上一首 shangyishou', run: () => app.prevTrack?.() },
                { id: 'mode', group: '播放', icon: mode === 'repeat-one' ? 'repeat-1' : mode === 'shuffle' ? 'shuffle' : 'repeat', title: '切换循环方式', desc: `现在：${{ repeat: '列表循环', 'repeat-one': '单曲循环', shuffle: '随机播放' }[mode]}`, words: 'loop repeat shuffle 循环 单曲 随机 xunhuan', run: cycleMode },
                { id: 'shuffle', group: '播放', icon: 'shuffle', title: mode === 'shuffle' ? '关闭随机播放' : '随机播放', words: 'shuffle random 随机 suiji', run: () => app.setPlayMode?.(mode === 'shuffle' ? 'repeat' : 'shuffle') },
                { id: 'volume-up', group: '音量', icon: 'volume-2', title: '音量 +10%', desc: `现在 ${Math.round(v * 100)}%`, words: 'volume up louder 音量 大 yinliang', run: () => setVolume(readVolume() + 0.1), keepOpen: true },
                { id: 'volume-down', group: '音量', icon: 'volume-1', title: '音量 −10%', desc: `现在 ${Math.round(v * 100)}%`, words: 'volume down quieter 音量 小 yinliang', run: () => setVolume(readVolume() - 0.1), keepOpen: true },
                { id: 'mute', group: '音量', icon: v > 0.001 ? 'volume-x' : 'volume-2', title: v > 0.001 ? '静音' : '取消静音', words: 'mute 静音 jingyin', run: () => setVolume(v > 0.001 ? 0 : 0.7) },
                { id: 'stage', group: '舞台', icon: 'captions', title: inStage ? '离开歌词舞台' : '进入歌词舞台', words: 'stage lyrics 舞台 歌词 wutai geci', run: toggleStage },
                panelCmd('封面', 'image', 'cover 封面 fengmian'),
                panelCmd('歌词', 'file-text', 'lyrics 歌词 geci'),
                panelCmd('控制', 'settings-2', 'controls 控制 kongzhi'),
                panelCmd('播放列表', 'list-music', 'queue playlist 播放列表 队列 bofangliebiao'),
                panelCmd('音质', 'audio-lines', 'quality 音质 yinzhi'),
                { id: 'fx', group: '面板', icon: 'sliders-horizontal', title: '音效设置', words: 'eq effects dsp 音效 均衡 yinxiao', run: () => openSheet() },
                ...(typeof global.MusicIntro?.replay === 'function'
                    ? [{ id: 'intro', group: '外观', icon: 'clapperboard', title: '播放完整开场', words: 'intro opening replay 开场 过场 动画 kaichang', run: () => global.MusicIntro.replay() }]
                    : []),
                { id: 'theme', group: '外观', icon: light ? 'moon' : 'sun', title: light ? '切到深色' : '切到浅色', words: 'theme dark light 深色 浅色 主题 zhuti', run: () => { app.applyTheme?.(light ? 'dark' : 'light'); app.stageHost?.updateTheme?.(); } }
            ];
        };

        // 「音量 40」「vol 40」这种直接给数字的。
        const volumeCommand = (text) => {
            const m = /^(?:音量|vol(?:ume)?|yinliang)\s*(\d{1,3})\s*%?$/i.exec(String(text || '').trim());
            if (!m) return null;
            const value = Math.min(100, Number(m[1]));
            return { id: 'volume-set', group: '音量', icon: 'volume-2', title: `把音量设为 ${value}%`, run: () => setVolume(value / 100), noRecent: true };
        };

        const matchCommand = (cmd, text) => {
            const words = lower(text).split(/\s+/).filter(Boolean);
            if (!words.length) return 0;
            const hay = lower(`${cmd.title} ${cmd.words || ''} ${cmd.group}`);
            let score = 0;
            for (const word of words) {
                if (lower(cmd.title).startsWith(word)) score += 3;
                else if (hay.includes(word)) score += 1;
                else return 0;
            }
            return score;
        };

        const songItem = (track, group) => {
            const index = app.playlist.indexOf(track);
            const isCurrent = index === app.currentTrackIndex;
            return {
                id: `song:${track.path}`,
                group,
                icon: isCurrent && app.isPlaying ? 'audio-lines' : 'music',
                title: trackTitle(track),
                desc: [trackArtist(track), track.album].filter(Boolean).join(' · '),
                current: isCurrent,
                run: () => { if (index !== -1) app.loadTrack?.(index); }
            };
        };

        const recentItems = () => {
            const all = commands();
            const byPath = new Map((app.playlist || []).map((t) => [`song:${t.path}`, t]));
            return readRecent().map((id) => {
                if (id.startsWith('song:')) { const t = byPath.get(id); return t ? songItem(t, '最近') : null; }
                const cmd = all.find((c) => c.id === id);
                return cmd ? { ...cmd, group: '最近' } : null;
            }).filter(Boolean);
        };

        const build = () => {
            const raw = input.value;
            const q = parseQuery(raw);
            const items = [];
            if (!raw.trim()) {
                const recent = recentItems();
                const seen = new Set(recent.map((r) => r.id));
                items.push(...recent);
                items.push(...commands().filter((c) => !seen.has(c.id)));
            } else {
                const vol = volumeCommand(raw);
                if (vol) items.push(vol);
                if (q.text && !q.artist && !q.album && !q.title) {
                    commands()
                        .map((c) => ({ c, s: matchCommand(c, q.text) }))
                        .filter((x) => x.s > 0)
                        .sort((a, b) => b.s - a.s)
                        .slice(0, 6)
                        .forEach((x) => items.push(x.c));
                }
                if (hasSongFilter(q)) {
                    const strip = app.stripAudioExtension;
                    const queue = app.currentFilteredTracks || null;
                    const seen = new Set();
                    const rank = (tracks, group, limit) => {
                        const scored = [];
                        for (const track of tracks || []) {
                            if (!track || seen.has(track)) continue;
                            const s = scoreTrack(track, q, strip);
                            if (s > 0) scored.push({ track, s });
                        }
                        scored.sort((a, b) => b.s - a.s);
                        for (const { track } of scored.slice(0, limit)) { seen.add(track); items.push(songItem(track, group)); }
                    };
                    if (queue && queue !== app.playlist) rank(queue, '队列', 20);
                    rank(app.playlist, '曲库', MAX_SONGS);
                }
            }
            state.items = items;
            state.active = 0;
            renderHints(raw, q);
            render();
        };

        const renderHints = (raw, q) => {
            const last = String(raw || '').split(/\s+/).pop() || '';
            const show = last.startsWith('--') && !FLAG_LOOKUP.has(last.slice(2));
            hints.hidden = !show;
            if (!show) { hints.innerHTML = ''; return; }
            const typed = lower(last.slice(2));
            const options = FILTERS.filter((f) => !typed || f.flag.startsWith(typed) || f.aliases.some((a) => a.startsWith(typed)));
            hints.innerHTML = '<div class="md-cmd-hints-k">过滤</div>' + (options.length ? options : FILTERS).map((f) => (
                `<button type="button" class="md-cmd-hint" data-flag="${f.flag}"><b>--${f.flag}</b><span>${f.hint}</span><i>${f.aliases.map((a) => `--${a}`).join(' ')}</i></button>`
            )).join('');
            void q;
        };

        const render = () => {
            if (!state.items.length) {
                list.innerHTML = `<div class="md-cmd-empty">${icon('search', 22)}<span>没有找到匹配的歌或操作</span></div>`;
                input.removeAttribute('aria-activedescendant');
                return;
            }
            list.innerHTML = state.items.map((item, i) => (
                `<button type="button" class="md-cmd-row${i === state.active ? ' md-act' : ''}${item.current ? ' md-cur' : ''}" role="option" id="md-cmd-opt-${i}" aria-selected="${i === state.active}" data-i="${i}">`
                + `<span class="md-cmd-ri">${icon(item.icon || 'command', 16)}</span>`
                + `<span class="md-cmd-rt"><span class="md-cmd-l1"><span class="md-cmd-title">${escapeHtml(item.title)}</span>`
                + (item.hint ? `<kbd class="md-cmd-chip">${escapeHtml(item.hint)}</kbd>` : '')
                + `<span class="md-cmd-grp">${escapeHtml(item.group)}</span></span>`
                + (item.desc ? `<span class="md-cmd-desc">${escapeHtml(item.desc)}</span>` : '')
                + `</span><span class="md-cmd-run">${icon('corner-down-left', 13)}${item.id.startsWith('song:') ? '播放' : '运行'}</span></button>`
            )).join('');
            syncActive(false);
        };

        const syncActive = (scroll = true) => {
            const prev = list.querySelector('.md-cmd-row.md-act');
            if (prev) { prev.classList.remove('md-act'); prev.setAttribute('aria-selected', 'false'); }
            const row = list.querySelector(`[data-i="${state.active}"]`);
            if (!row) return;
            row.classList.add('md-act');
            row.setAttribute('aria-selected', 'true');
            input.setAttribute('aria-activedescendant', row.id);
            if (scroll) row.scrollIntoView?.({ block: 'nearest' });
        };

        const remember = (item) => {
            if (item.noRecent) return;
            writeRecent([item.id, ...readRecent().filter((id) => id !== item.id)]);
        };

        const execute = (index) => {
            const item = state.items[index];
            if (!item) return;
            remember(item);
            if (item.keepOpen) {
                item.run();
                const keep = state.active;
                build();
                state.active = Math.min(keep, state.items.length - 1);
                syncActive(false);
                input.focus();
                return;
            }
            close(false);
            item.run();
        };

        // ───────── 打开 / 关闭 ─────────
        const place = () => {
            const cap = host.querySelector('.md-cap');
            const rect = cap?.getBoundingClientRect();
            const gap = rect && rect.height ? Math.max(12, global.innerHeight - rect.bottom) : 32;
            root.style.setProperty('--md-cmd-bottom', `${Math.round(gap)}px`);
        };
        function open(initial = '') {
            if (state.open) { input.focus(); input.select(); return; }
            closeOthers?.();
            state.open = true;
            state.lastFocus = document.activeElement;
            if (state.closeTimer) { clearTimeout(state.closeTimer); state.closeTimer = null; }
            place();
            root.hidden = false;
            document.body.classList.add('music-dock-cmd-open');
            input.value = initial;
            build();
            requestAnimationFrame(() => root.classList.add('md-open'));
            input.focus();
        }
        function close(restoreFocus = true) {
            if (!state.open) return;
            state.open = false;
            root.classList.remove('md-open');
            document.body.classList.remove('music-dock-cmd-open');
            state.closeTimer = setTimeout(() => { state.closeTimer = null; if (!state.open) root.hidden = true; }, 200);
            if (restoreFocus && state.lastFocus?.isConnected) state.lastFocus.focus?.({ preventScroll: true });
            // 关掉后输入框不能还占着焦点，否则下一次 Ctrl+K 会落进已关闭的面板里。
            if (root.contains(document.activeElement)) document.activeElement.blur();
            state.lastFocus = null;
        }
        const toggle = () => (state.open ? close() : open());

        // ───────── 事件 ─────────
        input.addEventListener('input', build);
        input.addEventListener('keydown', (event) => {
            event.stopPropagation(); // 别让档案页、舞台的快捷键收到输入框里的按键
            const n = state.items.length;
            // 列表倒着排（最好的结果贴着输入框），所以 ↑ 是往后、↓ 是往前。
            if (event.key === 'ArrowUp') { event.preventDefault(); if (n) { state.active = (state.active + 1) % n; syncActive(); } }
            else if (event.key === 'ArrowDown') { event.preventDefault(); if (n) { state.active = (state.active - 1 + n) % n; syncActive(); } }
            else if (event.key === 'Enter') { event.preventDefault(); if (!event.isComposing) execute(state.active); }
            else if (event.key === 'Escape') { event.preventDefault(); if (input.value) { input.value = ''; build(); } else close(); }
            else if (event.key === 'Tab') {
                event.preventDefault();
                const hint = hints.hidden ? null : hints.querySelector('.md-cmd-hint');
                if (hint) acceptFlag(hint.dataset.flag);
            } else if ((event.ctrlKey || event.metaKey) && lower(event.key) === 'k') { event.preventDefault(); toggle(); }
        });
        const acceptFlag = (flag) => {
            input.value = input.value.replace(/--\S*$/, `--${flag} `);
            input.focus();
            build();
        };
        hints.addEventListener('mousedown', (event) => event.preventDefault());
        hints.addEventListener('click', (event) => {
            const button = event.target.closest('[data-flag]');
            if (button) acceptFlag(button.dataset.flag);
        });
        list.addEventListener('mousedown', (event) => event.preventDefault());
        list.addEventListener('pointermove', (event) => {
            const row = event.target.closest('.md-cmd-row');
            if (!row) return;
            const i = Number(row.dataset.i);
            if (i !== state.active) { state.active = i; syncActive(false); }
        });
        list.addEventListener('click', (event) => {
            const row = event.target.closest('.md-cmd-row');
            if (row) execute(Number(row.dataset.i));
        });
        root.querySelector('[data-cmd="scrim"]').addEventListener('pointerdown', () => close());
        box.addEventListener('keydown', (event) => event.stopPropagation());

        const onGlobalKey = (event) => {
            if (!((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && lower(event.key) === 'k')) return;
            if (state.open && event.target?.closest?.('.md-cmd')) return;
            event.preventDefault();
            event.stopPropagation();
            toggle();
        };
        document.addEventListener('keydown', onGlobalKey, true);
        global.addEventListener('resize', place);

        return {
            open,
            close,
            toggle,
            get isOpen() { return state.open; },
            destroy() {
                close(false);
                document.removeEventListener('keydown', onGlobalKey, true);
                global.removeEventListener('resize', place);
                root.remove();
            }
        };
    }

    global.createMusicDockPalette = createMusicDockPalette;
    global.MusicDockPaletteQuery = Object.freeze({ parseQuery, scoreTrack });
})(window);
