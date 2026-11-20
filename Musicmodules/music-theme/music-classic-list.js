// 经典视图的曲目列表：标题、歌手、时长三列，表头可以按标题 / 歌手 / 时长 / 添加时间（行号那一格的 #）排序。
// 只包一层 app.renderPlaylist：排好序再交给原来的渲染，渲染完给每行补上歌手和时长。
// 排序只改变显示顺序，不改曲库本身的顺序。
(function (global) {
    'use strict';

    const SORT_KEY = 'musicClassicSort';
    const COLUMNS = [
        { key: 'title', label: '标题', hint: '按标题排序' },
        { key: 'artist', label: '歌手', hint: '按歌手排序' },
        { key: 'duration', label: '时长', hint: '按时长排序' },
        { key: 'added', label: '#', hint: '按添加时间排序' }
    ];

    const formatDuration = (seconds) => {
        const s = Number(seconds);
        if (!(s > 0) || !Number.isFinite(s)) return '';
        const total = Math.round(s);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = String(total % 60).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
    };

    const collator = typeof Intl !== 'undefined' && Intl.Collator
        ? new Intl.Collator(['zh-Hans-CN', 'ja', 'en'], { numeric: true, sensitivity: 'base' })
        : { compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0) };

    global.setupMusicClassicList = (app) => {
        const list = app.playlistEl || document.getElementById('playlist');
        if (!list || typeof app.renderPlaylist !== 'function') return;

        let sort = { key: 'added', dir: 1 };
        try {
            const saved = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
            if (saved && COLUMNS.some((c) => c.key === saved.key)) sort = { key: saved.key, dir: saved.dir === -1 ? -1 : 1 };
        } catch (e) { /* 用默认顺序 */ }

        const titleOf = (t) => (app.stripAudioExtension ? app.stripAudioExtension(t?.title || '') : (t?.title || '')) || '';
        const value = {
            title: (t) => titleOf(t),
            artist: (t) => String(t?.artist || ''),
            duration: (t) => Number(t?.duration) || 0
        };

        const sorted = (songs) => {
            if (sort.key === 'added') {
                // 添加时间就是进曲库的先后：正序原样返回，倒序反过来。
                return sort.dir === 1 ? null : songs.slice().reverse();
            }
            const get = value[sort.key];
            const order = new Map(app.playlist.map((t, i) => [t, i]));
            return songs.slice().sort((a, b) => {
                const va = get(a), vb = get(b);
                // 没有这一项的（没写歌手、时长未知）总是排在最后
                const ea = va === '' || va === 0, eb = vb === '' || vb === 0;
                if (ea !== eb) return ea ? 1 : -1;
                const c = typeof va === 'number' ? va - vb : collator.compare(va, vb);
                return c ? c * sort.dir : (order.get(a) ?? 0) - (order.get(b) ?? 0);
            });
        };

        // 每行拆成标题 / 歌手 / 时长三格。原渲染只在列表内容变化时重建 <li>，已拆过的行跳过。
        const decorate = () => {
            for (const li of list.children) {
                if (li.dataset.cols === '1') continue;
                const track = app.playlist[Number(li.dataset.index)];
                const title = document.createElement('span');
                title.className = 'cl-title';
                title.textContent = li.textContent;
                const artist = document.createElement('span');
                artist.className = 'cl-artist';
                artist.textContent = track?.artist || '';
                const duration = document.createElement('span');
                duration.className = 'cl-duration';
                duration.textContent = formatDuration(track?.duration);
                li.replaceChildren(title, artist, duration);
                li.title = [titleOf(track), track?.artist].filter(Boolean).join(' — ');
                li.dataset.cols = '1';
            }
        };

        const base = app.renderPlaylist;
        let lastFiltered = null;
        app.renderPlaylist = (filtered) => {
            lastFiltered = filtered || null;
            const songs = filtered || app.playlist;
            const result = base(sorted(songs) || filtered);
            decorate();
            return result;
        };

        // 表头
        const head = document.createElement('div');
        head.className = 'music-list-head';
        head.setAttribute('role', 'toolbar');
        head.setAttribute('aria-label', '排序');
        const buttons = COLUMNS.map((col) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `music-list-sort is-${col.key}`;
            button.dataset.sort = col.key;
            button.title = col.hint;
            button.setAttribute('aria-label', col.hint);
            button.innerHTML = `<span>${col.label}</span><i aria-hidden="true"></i>`;
            button.addEventListener('click', () => {
                sort = sort.key === col.key ? { key: col.key, dir: -sort.dir } : { key: col.key, dir: 1 };
                try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch (e) { /* 只是记住排序 */ }
                syncHead();
                app.renderPlaylist(lastFiltered || undefined);
            });
            head.appendChild(button);
            return button;
        });
        const syncHead = () => {
            for (const button of buttons) {
                const on = button.dataset.sort === sort.key;
                button.classList.toggle('is-on', on);
                button.setAttribute('aria-pressed', String(on));
                button.querySelector('i').textContent = on ? (sort.dir === 1 ? '↑' : '↓') : '';
            }
        };
        syncHead();
        list.before(head);

        // 已经渲染过的列表补一次
        if (list.children.length) app.renderPlaylist(app.currentFilteredTracks || undefined);
    };

    global.MusicClassicList = { formatDuration };
})(window);
