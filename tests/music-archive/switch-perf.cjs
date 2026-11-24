/*
 * 换视图卡不卡：阵列 ↔ 封面墙 / 平放 / 网格 来回切，记每次切换后 1.5 秒里的帧间隔和长任务。
 *   node tests/music-archive/switch-perf.cjs [--covers 同 wall-shots] [--w=1600 --h=900] [--rounds=2]
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
  await page.evaluate(() => {
    window.__lt = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: false }); } catch (e) { /* */ }
  });
  const measure = (to) => page.evaluate(async (to) => {
    const frames = [];
    const t0 = performance.now();
    window.__lt.length = 0;
    let last = t0;
    let run = true;
    const phases = [];
    const phaseNow = () => { const sw = document.querySelector('.archive-layout-sweep'); return !sw ? 'open' : sw.classList.contains('is-covering') ? (sw.dataset.full ? 'hidden' : 'cover') : 'reveal'; };
    // 每帧记它画出来时处在哪一段：hidden = 纸完全盖着（这时卡住看不见），其余都是看得见的
    let ph = phaseNow();
    const tick = (t) => { frames.push(t - last); phases.push(ph); ph = phaseNow(); last = t; if (run) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const btn = document.querySelector('.archive-nav [data-layout="' + to + '"]');
    const c0 = performance.now();
    btn.click();
    const clickMs = performance.now() - c0;
    await new Promise((r) => setTimeout(r, 1500));
    run = false;
    const s = frames.slice().sort((a, b) => a - b);
    const lt = window.__lt.filter((e) => e.t >= t0 - 5);
    const vis = frames.filter((f, k) => phases[k] !== 'hidden' && k > 0);
    const vs = vis.slice().sort((a, b) => a - b);
    return { to, visMax: Math.round(vs[vs.length - 1] || 0), visOver50: vis.filter((f) => f > 50).length, hiddenMax: Math.round(Math.max(0, ...frames.filter((f, k) => phases[k] === 'hidden'))), clickMs: Math.round(clickMs), first: Math.round(frames[0] || 0), max: Math.round(s[s.length - 1] || 0), p90: Math.round(s[Math.floor(s.length * 0.9)] || 0), over50: frames.filter((f) => f > 50).length, frames: frames.length, longTasks: lt.length, longSum: Math.round(lt.reduce((a, e) => a + e.d, 0)) };
  }, to);
  const seq = [];
  for (let r = 0; r < Number(args.rounds || 2); r++) seq.push('array', 'wall', 'array', 'table', 'array', 'grid', 'wall', 'table', 'grid');
  const out = [];
  // 先落到阵列
  await page.click('.archive-nav [data-layout="array"]'); await page.waitForTimeout(2500);
  let prev = 'array';
  for (const to of seq) {
    if (to === prev) continue;
    const m = await measure(to);
    m.from = prev; prev = to;
    out.push(m);
    console.log(JSON.stringify(m));
    await page.waitForTimeout(400);
  }
  const by = {};
  for (const m of out) { const k = m.from + '→' + m.to; (by[k] = by[k] || []).push(m); }
  console.log('== 汇总（ms，取最大）：click 点击同步耗时；seen 看得见的最长一帧；seen>50 看得见的掉帧数；hidden 纸盖着时的最长一帧');
  for (const [k, v] of Object.entries(by)) console.log(k.padEnd(14), 'click', Math.max(...v.map((x) => x.clickMs)), 'seen', Math.max(...v.map((x) => x.visMax)), 'seen>50', Math.max(...v.map((x) => x.visOver50)), 'hidden', Math.max(...v.map((x) => x.hiddenMax)));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
  await browser.close(); server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
