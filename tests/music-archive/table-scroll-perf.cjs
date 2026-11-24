/*
 * 平放大幅上下滚动卡不卡：鼠标滚轮式大步（每帧 deltaY ±120）来回滚，记帧间隔；
 * --ab 时逐项关掉景深 / 遮罩 / 阴影等再量一遍，看哪项最贵（无头软件渲染，只看相对值）。
 *   node tests/music-archive/table-scroll-perf.cjs [--ab] [--w=1600 --h=900]
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(args.out || path.join(require('node:os').tmpdir(), 'music-wall-shots'));
const N = Number(args.n || 240);
const W = Number(args.w || 1600), H = Number(args.h || 900);
// 假封面放在仓库里不提交的 .covers/ 下，用 http 取（页面是 http 的，file:// 图片会被拦）
const COVER_DIR = path.join(__dirname, '.covers');
const COVERS = fs.existsSync(COVER_DIR) ? fs.readdirSync(COVER_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f)).map((f) => 'C:/covers/' + f) : [];

const FAKE = ({ n, light, covers }) => {
  const albums = ['Low Tide', '窗边', 'Static Bloom', '夜行列车', 'Glass Hour', '白昼', 'Paper Moon', 'Undertow', '雾港', 'Lattice', 'Signal', 'Ember', 'North Line', '温室', 'Drift', 'Orbit'];
  const words = ['海边', 'Blue', '午后', 'Window', '回声', 'Lights', '纸飞机', 'Night Walk', '旧站台', 'Static', '远方', 'Bloom', '晴天', 'Satellite', '雨', 'Harbor'];
  const tracks = Array.from({ length: n }, (_, i) => ({
    path: 'D:\\Music\\t' + i + '.flac',
    title: words[i % words.length] + ' ' + (i % 7 === 0 ? '(Live)' : String.fromCharCode(65 + (i * 7) % 26)) + '.flac',
    artist: ['Aki', 'Ren', 'Lumi', '七海', 'Sora'][i % 5],
    album: albums[i % albums.length],
    duration: 150 + (i * 37) % 160,
    albumArt: covers.length && i % 9 !== 4 ? covers[(i * 5) % covers.length] : undefined
  }));
  const playlists = [{ id: 'p1', name: '海边线路', tracks: tracks.slice(0, 18).map((t) => t.path) }];
  window.__calls = [];
  // 封面地址 file:///C:/covers/x.jpg → 同源 http 的 /tests/music-archive/.covers/x.jpg
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get() { return desc.get.call(this); }, set(v) { const m = /^file:\/\/\/?C:\/covers\/(.+)$/.exec(String(v)); desc.set.call(this, m ? '/tests/music-archive/.covers/' + m[1] : v); } });
  // 播放器的 app 不挂全局：截住 MusicArchive.init 拿到它
  let real;
  Object.defineProperty(window, 'MusicArchive', { configurable: true, get: () => real, set: (v) => { real = { init: (app, o) => { window.app = app; return v.init(app, o); } }; } });
  const state = { is_playing: false, current_time: 0, duration: 200, file_path: null };
  const fns = {
    getMusicPlaylist: async () => tracks,
    getCustomPlaylists: async () => playlists,
    getMusicState: async () => ({ state }),
    getMusicPendingTrack: async () => null,
    getCurrentTheme: async () => (light ? 'light' : 'dark'),
    getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
    listMusicIrPresets: async () => [],
    listWebdavServers: async () => [],
    musicLoad: async (t) => { window.__calls.push(['musicLoad', t && t.path]); state.file_path = t && t.path; return { status: 'success', state }; },
    musicPlay: async () => { window.__calls.push(['musicPlay']); state.is_playing = true; return { status: 'success', state }; },
    musicPause: async () => { state.is_playing = false; return { status: 'success', state }; },
    getMusicLyrics: async () => null, fetchMusicLyrics: async () => null
  };
  const handler = { get: (_, k) => fns[k] || (k.startsWith('on') ? () => () => {} : async () => ({ status: 'success' })) };
  window.electronAPI = new Proxy({}, handler);
  try { localStorage.setItem('musicArchiveLayout', 'wall'); localStorage.setItem('musicArchiveList', '1'); } catch (e) { /* */ }
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await require('../music-stage-bench/serve.cjs')(ROOT);
  const url = `http://127.0.0.1:${server.address().port}/Musicmodules/music.html`;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-web-security', '--allow-file-access-from-files'] });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: Number(args.dpr || 1) });
  const page = await context.newPage();
  page.setDefaultTimeout(200000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|WebSocket/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.addInitScript(FAKE, { n: N, light: Boolean(args.light), covers: COVERS });
  await page.goto(url, { timeout: 240000 });
  await page.waitForFunction(() => window.app?.archiveView?.wall, null, { timeout: 90000 }).catch(async (e) => { console.log('errors:', errors.slice(0, 5)); console.log(await page.evaluate(() => ({ app: Boolean(window.app), av: Boolean(window.app?.archiveView), wallLib: Boolean(window.MusicArchiveWall) }))); throw e; });
  await page.waitForTimeout(3500);
  const results = [];
  const check = (name, ok, extra = '') => { results.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
  await page.click('.archive-nav [data-layout="table"]');
  await page.waitForFunction(() => !document.querySelector('.archive-layout-sweep'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const run = (label) => page.evaluate((label) => new Promise((done) => {
    const el = document.querySelector('.archive-wall.aw-table');
    const r = el.getBoundingClientRect();
    const times = []; let last = performance.now(), n = 0; let maxTiles = 0;
    const N = 120;
    const step = () => {
      // 前 60 帧往下、后 60 帧往回：像连续拨滚轮
      const dy = n < N / 2 ? 120 : -120;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
      requestAnimationFrame(() => {
        const now = performance.now(); times.push(now - last); last = now;
        maxTiles = Math.max(maxTiles, el.querySelectorAll('.aw-tile').length);
        if (++n < N) step(); else { const s = times.slice(1).sort((a, b) => a - b); done({ label, med: Math.round(s[s.length >> 1]), p90: Math.round(s[Math.floor(s.length * 0.9)]), max: Math.round(s[s.length - 1]), tiles: maxTiles }); }
      });
    };
    step();
  }), label);
  const variants = args.ab ? [
    ['原样', ''],
    ['世界平面化', '.aw-table .aw-world{transform-style:flat!important}'],
    ['关景深', '.archive-wall.aw-table::after{display:none!important}'],
    ['关外框遮罩', '.archive-wall.aw-table{-webkit-mask-image:none!important;mask-image:none!important}'],
    ['关阴影', '.aw-table .aw-in{box-shadow:none!important}'],
    ['关字幕/徽标', '.aw-table :is(.aw-cap,.aw-no,.aw-shade){display:none!important}'],
    ['全关', '.archive-wall.aw-table::after{display:none!important}.archive-wall.aw-table{-webkit-mask-image:none!important;mask-image:none!important}.aw-table .aw-in{box-shadow:none!important}.aw-table :is(.aw-cap,.aw-no,.aw-shade){display:none!important}']
  ] : [['原样', '']];
  if (args.vis) {
    const v = await page.evaluate(() => {
      const el = document.querySelector('.archive-wall.aw-table'); const R = el.getBoundingClientRect();
      const tiles = [...el.querySelectorAll('.aw-tile')]; let on = 0; const wx = [], wy = [];
      const wr = el.querySelector('.aw-world');
      for (const t of tiles) { const b = t.getBoundingClientRect(); if (b.right > R.left && b.left < R.right && b.bottom > R.top && b.top < R.bottom) { on++; wx.push(parseFloat(t.dataset.x || 'NaN')); } }
      return { total: tiles.length, onScreen: on, room: [Math.round(R.width), Math.round(R.height)] };
    });
    console.log('VIS', JSON.stringify(v));
  }
  if (args.prof) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
    console.log('PERF', JSON.stringify(await run('prof')));
    const { profile } = await cdp.send('Profiler.stop');
    const byId = new Map(profile.nodes.map((n) => [n.id, n])); const parent = new Map(); profile.nodes.forEach((n) => (n.children || []).forEach((c) => parent.set(c, n.id)));
    const counts = new Map(); profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (profile.timeDeltas[i] || 0)));
    const self = new Map(), incl = new Map();
    const key = (n) => (n.callFrame.functionName || '(anon)') + ' ' + n.callFrame.url.split('/').slice(-1)[0] + ':' + n.callFrame.lineNumber;
    for (const [id, us] of counts) { self.set(key(byId.get(id)), (self.get(key(byId.get(id))) || 0) + us); const seen = new Set(); let c = id; while (c) { const k = key(byId.get(c)); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + us); } c = parent.get(c); } }
    console.log('== self'); [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(String(Math.round(v / 1000)).padStart(6), k));
    console.log('== incl'); [...incl].filter(([k]) => /archive/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(String(Math.round(v / 1000)).padStart(6), k));
  }
  for (const [label, css] of variants) {
    await page.evaluate((css) => { let s = document.getElementById('__ab'); if (!s) { s = document.createElement('style'); s.id = '__ab'; document.head.appendChild(s); } s.textContent = css; }, css);
    await page.waitForTimeout(800);
    console.log('PERF', JSON.stringify(await run(label)));
  }
  await browser.close(); server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
