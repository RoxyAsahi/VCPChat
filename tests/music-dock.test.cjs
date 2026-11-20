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
        assert.equal(doc.querySelector('.md-qh span').textContent, '2');

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
