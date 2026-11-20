const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function setup() {
    const dom = new JSDOM(`<!doctype html><body>
        <div class="main-content"><div class="settings-container" id="dsp"></div></div>
        <div class="track-title">未选择歌曲</div><div class="track-artist"></div><div class="album-art"></div>
        <span class="current-time">0:00</span><span class="duration">0:00</span>
        <button id="mode-btn" title="列表循环"></button>
        <input id="volume-slider" type="range" min="0" max="1" step="0.01" value="0.5">
        <ul id="playlist"></ul>
        <div id="music-dock-root"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    window.MusicStageConfig = { modes: [{ id: 'luminous', label: '流光' }, { id: 'partita', label: '云阶' }] };
    window.eval(read('Musicmodules/music-dock/music-dock-icons.js'));
    window.eval(read('Musicmodules/music-dock/music-dock-palette.js'));
    window.eval(read('Musicmodules/music-dock/music-dock.js'));
    const doc = window.document;
    const calls = [];
    const playlist = [
        { path: 'C:/a.flac', title: 'Alpha.flac', artist: 'A', albumArt: null },
        { path: 'C:/b.flac', title: 'Beta.flac', artist: 'B', albumArt: null }
    ];
    const app = {
        playlist,
        currentTrackIndex: 0,
        isPlaying: false,
        lastKnownCurrentTime: 0,
        lastKnownDuration: 200,
        lastStateUpdateTime: Date.now(),
        playModes: ['repeat', 'repeat-one', 'shuffle'],
        currentPlayMode: 0,
        currentLyrics: [{ time: 3, text: '第一句' }, { time: 9, text: '第二句' }],
        currentLyricIndex: 0,
        trackTitle: doc.querySelector('.track-title'),
        trackArtist: doc.querySelector('.track-artist'),
        albumArt: doc.querySelector('.album-art'),
        currentTimeEl: doc.querySelector('.current-time'),
        durationEl: doc.querySelector('.duration'),
        modeBtn: doc.getElementById('mode-btn'),
        volumeSlider: doc.getElementById('volume-slider'),
        playlistEl: doc.getElementById('playlist'),
        stripAudioExtension: (t) => t.replace(/\.flac$/, ''),
        playTrack() { calls.push('play'); },
        pauseTrack() { calls.push('pause'); },
        prevTrack() { calls.push('prev'); },
        nextTrack() { calls.push('next'); },
        seekTo(t) { calls.push(['seek', t]); },
        loadTrack(i) { calls.push(['load', i]); },
        setPlayMode(i) {
            app.currentPlayMode = i % 3;
            app.modeBtn.title = ['列表循环', '单曲循环', '随机播放'][app.currentPlayMode];
        },
        stageHost: { toggle() { calls.push('stage'); }, enter() { calls.push('enter'); }, modeId: 'luminous', setMode(id) { calls.push(['mode', id]); } }
    };
    app.volumeSlider.addEventListener('input', () => calls.push(['volume', app.volumeSlider.value]));
    const dock = window.initMusicDock(app);
    return { dom, window, doc, app, dock, calls };
}

test('dock drives the existing player methods and keeps the old slider as the volume path', async () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        assert.equal(doc.body.style.getPropertyValue('--music-dock-safe-bottom'), '96px');
        assert.ok(doc.body.classList.contains('music-dock-on'));

        doc.querySelector('[data-md="play"]').click();
        assert.deepEqual(calls.pop(), 'play');
        app.isPlaying = true;
        doc.body.classList.add('music-playing');
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        assert.equal(doc.querySelector('[data-md="play"]').getAttribute('aria-label'), '暂停');
        doc.querySelector('[data-md="play"]').click();
        assert.equal(calls.pop(), 'pause');

        doc.querySelector('[data-md="next"]').click();
        assert.equal(calls.pop(), 'next');
        doc.querySelector('[data-md="mode"]').click();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        assert.equal(doc.querySelector('[data-md="mode"]').getAttribute('aria-label'), '单曲循环');

        app.trackTitle.textContent = 'Beta';
        app.currentTrackIndex = 1;
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        assert.equal(doc.querySelector('[data-md="title"]').textContent, 'Beta');

        dock.openPanel('控制');
        assert.ok(doc.querySelector('.md-pnl').classList.contains('md-open'));
        assert.equal(doc.querySelector('.md-pct').textContent, '50%');
        doc.querySelector('[data-act="mute"]').click();
        assert.deepEqual(calls.pop(), ['volume', '0']);
        doc.querySelector('[data-act="mute"]').click();
        assert.deepEqual(calls.pop(), ['volume', '0.5']);

        doc.querySelector('[data-act="scene-step"][data-d="1"]').click();
        assert.deepEqual(calls.pop(), ['mode', 'partita']);

        window.MusicIntro = { replay() { calls.push('intro'); } };
        dock.openPanel('控制');
        doc.querySelector('[data-act="intro"]').click();
        assert.equal(calls.pop(), 'intro');
        assert.equal(dock.panelOpen, false);

        dock.openPanel('歌词');
        const lines = doc.querySelectorAll('.md-lyrl p');
        assert.equal(lines.length, 2);
        lines[1].click();
        assert.deepEqual(calls.pop(), ['seek', 9]);

        dock.openPanel('播放列表');
        assert.equal(doc.querySelector('.md-qh span').textContent, '1', 'upcoming count leaves out the playing track');

        dock.openSheet();
        assert.equal(doc.getElementById('dsp').parentElement.className, 'md-sheet-body');
        dock.closeSheet();
        assert.equal(doc.getElementById('dsp').parentElement.className, 'main-content');

        doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(dock.panelOpen, false);

        doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        const palette = doc.querySelector('.md-cmd');
        assert.equal(palette.hidden, false);
        const input = palette.querySelector('.md-cmd-in');
        input.value = 'beta';
        input.dispatchEvent(new window.Event('input'));
        assert.equal(palette.querySelector('.md-cmd-row .md-cmd-title').textContent, 'Beta');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.deepEqual(calls.pop(), ['load', 1]);
        assert.ok(!palette.classList.contains('md-open'));
        assert.notEqual(doc.activeElement, input);
        // 回车放歌后焦点不能卡在已关闭的输入框里，再按 Ctrl+K 要能重新打开
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        assert.ok(doc.body.classList.contains('music-dock-cmd-open'));
        assert.equal(palette.querySelector('.md-cmd-row .md-cmd-grp').textContent, '最近');
        input.value = '音量 30';
        input.dispatchEvent(new window.Event('input'));
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        assert.deepEqual(calls.pop(), ['volume', '0.3']);
    } finally {
        dock.destroy();
        assert.equal(doc.getElementById('music-dock-root').innerHTML, '');
        assert.ok(!doc.body.classList.contains('music-dock-on'));
        window.close();
    }
});

test('music.html loads the dock after music.js and music.js starts it once', () => {
    const html = read('Musicmodules/music.html');
    const block = html.slice(html.indexOf('<!-- music-dock -->'), html.indexOf('<!-- /music-dock -->'));
    assert.ok(block.includes('music-dock/music-dock.css'));
    assert.ok(block.includes('id="music-dock-root"'));
    assert.ok(html.indexOf('music-dock/music-dock.js') > html.indexOf('src="music.js"'));
    const js = read('Musicmodules/music.js');
    assert.equal(js.split('initMusicDock(app)').length - 1, 1);
});

test('command palette parses --filters and ranks title hits above artist hits', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(read('Musicmodules/music-dock/music-dock-palette.js'));
    const { parseQuery, scoreTrack } = dom.window.MusicDockPaletteQuery;
    const q = parseQuery('夜 --歌手 远 舟 --al Demo');
    assert.equal(q.text, '夜');
    assert.equal(q.artist, '远 舟');
    assert.equal(q.album, 'Demo');
    const english = parseQuery('rain --artist tidal');
    assert.equal(english.artist, 'tidal');
    const track = { title: '夜航.flac', artist: '远舟', album: 'Demo' };
    const strip = (t) => t.replace(/\.flac$/, '');
    assert.ok(scoreTrack(track, parseQuery('夜航'), strip) > scoreTrack(track, parseQuery('远舟'), strip));
    assert.equal(scoreTrack(track, parseQuery('--歌手 别人'), strip), -1);
    assert.equal(scoreTrack(track, parseQuery('不存在'), strip), -1);
    dom.window.close();
});

test('queue page shows now playing, the manual layer and the real upcoming order, and edits the manual layer', async () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const [a, b] = app.playlist;
        const c = { path: 'C:/c.flac', title: 'Gamma.flac', artist: 'C' };
        app.playlist.push(c);
        app.manualQueue = [c, b];
        app.getUpNext = () => ({ manual: app.manualQueue.slice(), context: [b, c] });
        app.queueRemove = (i) => { calls.push(['qremove', i]); app.manualQueue.splice(i, 1); doc.dispatchEvent(new window.Event('music-queue-change')); };
        app.queueMove = (f, t) => { calls.push(['qmove', f, t]); };
        app.queueClear = () => { calls.push('qclear'); };
        app.queuePlayNext = (t) => { calls.push(['qnext', t.path]); return t; };
        dock.openPanel('播放列表');
        const titles = () => [...doc.querySelectorAll('.md-ql .md-qi b')].map((n) => n.textContent);
        assert.deepEqual(titles(), ['Alpha', 'Gamma', 'Beta', 'Beta', 'Gamma']);
        assert.deepEqual([...doc.querySelectorAll('.md-qhd span:first-child')].map((n) => n.textContent), ['接下来播放', '接着播放 · 全部曲目']);
        assert.equal(doc.querySelector('.md-qh span').textContent, '4');

        doc.querySelectorAll('.md-man [data-qact="remove"]')[1].click();
        assert.deepEqual(calls.pop(), ['qremove', 1]);
        assert.deepEqual(titles(), ['Alpha', 'Gamma', 'Beta', 'Gamma'], 'repaints on music-queue-change');

        doc.querySelector('.md-qi:not(.md-man):not(.md-now) [data-qact="next"]').click();
        assert.deepEqual(calls.pop(), ['qnext', 'C:/b.flac']);

        doc.querySelector('.md-man [data-qact="play"]').click();
        assert.deepEqual(calls.pop(), ['load', 2]);
        assert.deepEqual(calls.pop(), ['qremove', 0]);

        app.manualQueue = [b, c];
        doc.dispatchEvent(new window.Event('music-queue-change'));
        const row = doc.querySelector('.md-man');
        const fire = (type, y, target = row) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientY: y, button: 0 }));
        fire('pointerdown', 100);
        fire('pointermove', 102, doc);
        assert.ok(!row.classList.contains('md-qdrag'), 'under 4px is still a click');
        fire('pointermove', 150, doc);
        assert.ok(row.classList.contains('md-qdrag'));
        fire('pointerup', 150, doc);
        assert.deepEqual(calls.pop(), ['qmove', 0, 1]);
        await new Promise((resolve) => window.setTimeout(resolve, 0));

        doc.querySelector('[data-qact="clear"]').click();
        assert.equal(calls.pop(), 'qclear');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('palette groups songs, playlists and commands; shift/ctrl+enter queue; pinyin search uses the archive index', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        window.eval(read('Musicmodules/music-archive/archive-index.js'));
        const PY = { 夜: 'ye', 航: 'hang' };
        window.pinyinPro = { pinyin: (c) => PY[c] || '' };
        app.playlist.push({ path: 'C:/y.flac', title: '夜航.flac', artist: '远舟', album: 'Demo' });
        app.customPlaylists = [{ id: 'p1', name: 'Beta Mix', tracks: ['C:/b.flac', 'C:/y.flac'] }];
        app.queuePlayNext = (t) => { calls.push(['qnext', t.path]); return t; };
        app.queueAdd = (t) => { calls.push(['qadd', t.path]); return t; };
        app.renderPlaylist = () => {};
        const seen = [];
        doc.addEventListener('keydown', (e) => seen.push(e.key));

        dock.openPalette();
        const palette = doc.querySelector('.md-cmd');
        const input = palette.querySelector('.md-cmd-in');
        const type = (text) => { input.value = text; input.dispatchEvent(new window.Event('input')); };
        const key = (k, extra = {}) => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));

        type('yh');
        assert.equal(palette.querySelector('.md-cmd-row .md-cmd-title').textContent, '夜航', 'initials find the Chinese title');
        type('beta');
        assert.deepEqual([...palette.querySelectorAll('.md-cmd-sec')].map((n) => n.textContent), ['歌曲', '歌单']);
        assert.equal(palette.querySelector('.md-cmd-foot').hidden, false);
        key('Enter', { shiftKey: true });
        assert.deepEqual(calls.pop(), ['qnext', 'C:/b.flac']);
        assert.ok(palette.classList.contains('md-open') || !palette.hidden, 'stays open after queueing');
        key('Enter', { ctrlKey: true });
        assert.deepEqual(calls.pop(), ['qadd', 'C:/b.flac']);

        // 歌单那一行：Ctrl+回车整单入队，回车把歌单设成当前列表并播放
        const rows = [...palette.querySelectorAll('.md-cmd-row')];
        const plRow = rows.find((r) => r.querySelector('.md-cmd-title').textContent === 'Beta Mix');
        plRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
        assert.deepEqual(calls.splice(-2), [['qadd', 'C:/b.flac'], ['qadd', 'C:/y.flac']]);
        plRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        assert.deepEqual(calls.pop(), ['load', 1]);
        assert.equal(app.filteredPlaylistSource.id, 'p1');
        assert.equal(app.currentFilteredTracks.length, 2);

        dock.openPalette();
        type('下一');
        assert.equal(palette.querySelector('.md-cmd-sec').textContent, '命令');
        assert.equal(palette.querySelector('.md-cmd-foot').hidden, true);
        key('k');
        assert.ok(!seen.includes('k'), 'single keys typed in the palette do not reach window shortcuts');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('capsule volume slot: wheel adjusts, click and M mute and restore', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const slot = doc.querySelector('[data-md="vol"]');
        assert.ok(slot);
        const wheel = (deltaY) => slot.dispatchEvent(new window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
        wheel(-100);
        assert.deepEqual(calls.pop(), ['volume', '0.55']);
        wheel(40); wheel(40);
        assert.equal(calls.filter((c) => c[0] === 'volume').length, 0, 'small trackpad deltas accumulate first');
        wheel(40);
        assert.deepEqual(calls.pop(), ['volume', '0.5']);
        slot.click();
        assert.deepEqual(calls.pop(), ['volume', '0']);
        assert.equal(slot.getAttribute('aria-label'), '取消静音');
        doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'm', bubbles: true }));
        assert.deepEqual(calls.pop(), ['volume', '0.5'], 'M restores the volume from before muting');
        const field = doc.createElement('input');
        doc.body.appendChild(field);
        field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'm', bubbles: true }));
        assert.equal(calls.filter((c) => c[0] === 'volume').length, 0, 'typing m in a text field does nothing');
        assert.equal(app.volumeSlider.value, '0.5');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('controls tab offers the window-wide reduce-motion setting and follows outside changes', () => {
    const { window, doc, dock } = setup();
    try {
        const sets = [];
        let pref = 'system';
        window.MusicMotion = {
            PREFERENCES: [{ value: 'system', label: '跟随系统' }, { value: 'on', label: '开' }, { value: 'off', label: '关' }],
            get preference() { return pref; },
            set(v) { sets.push(v); pref = v; },
            reduced: () => pref === 'on'
        };
        dock.openPanel('控制');
        const seg = () => doc.querySelector('.md-seg[data-act="motion"]');
        assert.equal(seg().querySelector('button.md-on').textContent, '跟随系统');
        seg().querySelectorAll('button')[1].click();
        assert.deepEqual(sets, ['on']);
        assert.equal(seg().querySelector('button.md-on').textContent, '开');
        pref = 'off';
        window.dispatchEvent(new window.Event('music-motion-change'));
        assert.equal(seg().querySelector('button.md-on').textContent, '关');
    } finally {
        dock.destroy();
        window.close();
    }
});

test('window keymap: space without repeat, seek, track and volume keys, help, input and archive guards', () => {
    const { window, doc, app, dock, calls } = setup();
    try {
        const key = (k, extra = {}, target = doc.body) => {
            const e = new window.KeyboardEvent('keydown', { key: k, code: extra.code || (k === ' ' ? 'Space' : ''), bubbles: true, cancelable: true, ...extra });
            target.dispatchEvent(e);
            return e.defaultPrevented;
        };
        const later = [];
        doc.addEventListener('keydown', (e) => later.push(e.key)); // 档案页这种在冒泡阶段的监听

        assert.equal(key(' '), true);
        assert.equal(calls.pop(), 'play');
        key(' ', { repeat: true });
        key(' ');
        assert.equal(calls.length, 0, 'holding space does not toggle again');
        doc.dispatchEvent(new window.KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
        key(' ');
        assert.equal(calls.pop(), 'play');
        assert.ok(!later.includes(' '), 'handled keys do not reach later listeners');

        app.lastKnownCurrentTime = 50; app.lastStateUpdateTime = Date.now();
        key('ArrowRight');
        assert.deepEqual(calls.pop(), ['seek', 55]);
        key('ArrowLeft', { shiftKey: true });
        assert.equal(calls.pop(), 'prev');
        key('ArrowUp', { ctrlKey: true });
        assert.deepEqual(calls.pop(), ['volume', '0.55']);

        app.archiveView = { mode: 'archive' };
        later.length = 0;
        key('ArrowRight');
        assert.equal(calls.length, 0, 'archive keeps the arrow keys for picking songs');
        assert.deepEqual(later, ['ArrowRight']);
        key('ArrowRight', { shiftKey: true });
        assert.equal(calls.pop(), 'next', 'shift+arrow still switches tracks on the archive page');
        later.length = 0;
        assert.equal(key('m'), false); assert.equal(key('?'), false);
        assert.equal(calls.length, 0, 'typing on the archive page goes to its search, not mute or help');
        assert.deepEqual(later, ['m', '?']);
        assert.equal(doc.querySelector('.md-keys'), null);
        app.archiveView = { mode: 'classic' };

        const field = doc.createElement('input');
        doc.body.appendChild(field);
        key(' ', {}, field); key('m', {}, field); key('?', {}, field);
        assert.equal(calls.length, 0, 'single keys in a text field are left for typing');

        key('?');
        const help = doc.querySelector('.md-keys');
        assert.ok(help && !help.hidden);
        assert.ok(help.textContent.includes('按住不会连续切换'));
        key('Escape');
        assert.ok(help.hidden);
    } finally {
        dock.destroy();
        window.close();
    }
});

test('clicking the capsule body enters the stage, and inside the stage opens the command palette', () => {
    const { doc, app, dock, calls } = setup();
    try {
        const cap = doc.querySelector('.md-cap');
        cap.click();
        assert.equal(calls.pop(), 'enter');
        app.isStageActive = true;
        doc.body.classList.add('music-stage-active');
        cap.click();
        assert.ok(doc.querySelector('.md-cmd').classList.contains('md-open') || !doc.querySelector('.md-cmd').hidden);
        assert.ok(doc.body.classList.contains('music-dock-cmd-open'));
        assert.ok(!calls.includes('enter'));
    } finally {
        dock.destroy();
    }
});

test('hovering the title edges previews the real previous and next track', () => {
    const { window, doc, app, dock } = setup();
    try {
        const c = { path: 'C:/c.flac', title: 'Gamma.flac', artist: 'C' };
        app.getUpNext = () => ({ manual: [c], context: [app.playlist[1]] });
        app.peekPrevious = () => app.playlist[1];
        doc.querySelector('.md-zone.md-r').dispatchEvent(new window.Event('pointerenter'));
        assert.equal(doc.querySelector('[data-md="preview"]').textContent, 'Gamma', 'queued track comes first');
        assert.ok(doc.querySelector('.md-tnav').classList.contains('md-previewing'));
        doc.querySelector('.md-zone.md-r').dispatchEvent(new window.Event('pointerleave'));
        doc.querySelector('.md-zone.md-l').dispatchEvent(new window.Event('pointerenter'));
        assert.equal(doc.querySelector('[data-md="preview"]').textContent, 'Beta');
    } finally {
        dock.destroy();
    }
});
