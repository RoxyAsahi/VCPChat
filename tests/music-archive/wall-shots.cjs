/*
 * 封面墙截图与冒烟：完整 music.html + 假 electronAPI，曲目带假封面。
 *   node tests/music-archive/wall-shots.cjs --covers=/path/to/jpgs --out=dir [--n=240] [--w=1600 --h=900] [--light] [--only=name]
 * 检查：切到封面墙、3D 停画、点封面展开、双击播放、方向键、Esc 收起、切回阵列。
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
  const dbg = () => page.evaluate(() => window.app.archiveView.debug());
  const shot = async (name) => { if (!args.only || args.only === name) await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 200000 }); };
  const tag = (args.light ? 'light' : 'dark') + '-' + W;

  let d = await dbg();
  check('封面墙开着', d.layout === 'wall' && d.wall && d.wall.on, JSON.stringify(d.wall));
  check('3D 不画', d.rendering === false && d.allowed === false);
  check('有封面格', d.wall.tiles > 20, 'tiles=' + d.wall.tiles);
  await page.waitForTimeout(1500);
  await shot(tag + '-1-wall');

  // 点一张封面：展开
  const box = await page.evaluate(() => {
    const el = document.querySelector('.archive-wall');
    const r = el.getBoundingClientRect();
    const t = [...el.querySelectorAll('.aw-tile')].map((x) => x.getBoundingClientRect()).find((b) => b.left > r.left + r.width * 0.3 && b.top > r.top + 40 && b.right < r.right - 40 && b.bottom < r.bottom - 40);
    return t ? { x: t.left + t.width / 2, y: t.top + t.height / 2 } : null;
  });
  if (box) await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(1600);
  d = await dbg();
  check('点了展开', Boolean(d.wall.expanded), d.wall.expanded);
  const panelOk = await page.evaluate(() => Boolean(document.querySelector('.aw-tile.is-open .aw-panel-title')?.textContent));
  check('大卡有资料片', panelOk);
  await shot(tag + '-2-open');

  // 方向键
  const before = d.selected;
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1200);
  d = await dbg();
  check('方向键换选中', d.selected !== before, before + ' → ' + d.selected);
  await shot(tag + '-3-step');

  // 播放按钮
  await page.click('.aw-tile.is-open [data-wall="play"]').catch(() => {});
  await page.waitForTimeout(1500);
  const calls = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'musicLoad').length);
  check('播放按钮调了 musicLoad', calls > 0, 'calls=' + calls);
  // 大卡进度条：展开的是正在播放的那首时出现
  const seek = await page.evaluate(async () => {
    const a = window.app;
    a.lastKnownDuration = 200; a.lastKnownCurrentTime = 50; a.lastStateUpdateTime = Date.now(); a.isPlaying = true;
    const sel = a.__archiveSel ?? null;
    window.__wallRefresh?.();
    await new Promise((r) => setTimeout(r, 700));
    const el = document.querySelector('.aw-tile.is-open .aw-seek');
    if (!el) return { none: true, open: document.querySelectorAll('.aw-tile.is-open').length, panel: !!document.querySelector('.aw-panel'), cur: a.currentTrackIndex };
    return el ? { hidden: el.hidden, t: el.firstChild.textContent, d: el.lastChild.textContent, cur: a.currentTrackIndex } : null;
  });
  check('大卡进度条', seek && !seek.hidden && seek.d === '3:20', JSON.stringify(seek));
  await shot(tag + '-2b-seek');

  // Esc 收起
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  d = await dbg();
  check('Esc 收起', !d.wall.expanded);

  // 拖动
  const r = await page.evaluate(() => { const b = document.querySelector('.archive-wall').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  const cam0 = d.wall.cam;
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(r.x - k * 40, r.y - k * 18);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  d = await dbg();
  check('拖动移动了镜头', Math.abs(d.wall.cam.x - cam0.x) > 200, JSON.stringify(cam0) + ' → ' + JSON.stringify(d.wall.cam));
  await shot(tag + '-4-dragged');

  // 收起目录：墙变宽
  const w0 = await page.evaluate(() => document.querySelector('.archive-wall').offsetWidth);
  await page.click('.archive-nav [data-act="list"]');
  await page.waitForTimeout(1200);
  const w1 = await page.evaluate(() => document.querySelector('.archive-wall').offsetWidth);
  check('目录收起后墙让回宽度', w1 > w0 + 100, w0 + ' → ' + w1);
  await shot(tag + '-5-nolist');
  await page.click('.archive-nav [data-act="list"]');

  // 分节网格
  await page.click('.archive-nav [data-layout="grid"]');
  await page.waitForTimeout(2500);
  d = await dbg();
  check('网格开着、墙关了', d.layout === 'grid' && d.grid && d.grid.on && !d.wall.on && d.allowed === false, JSON.stringify(d.grid));
  check('网格有格子和分节', d.grid.cells > 8 && d.grid.sections >= 1, 'cells=' + d.grid.cells + ' sections=' + d.grid.sections);
  await shot(tag + '-7-grid');
  const g0 = d.selected;
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(900);
  d = await dbg();
  check('网格方向键换选中', d.selected !== g0, g0 + ' → ' + d.selected);
  await page.evaluate(() => document.querySelector('.ag-scroll').scrollBy(0, 900));
  await page.waitForTimeout(1500);
  await shot(tag + '-8-grid-scrolled');
  const cellBox = await page.evaluate(() => { const c = [...document.querySelectorAll('.ag-cell')].map((x) => x.getBoundingClientRect()).find((b) => b.top > 200 && b.bottom < 700); return c ? { x: c.left + c.width / 2, y: c.top + 40 } : null; });
  if (cellBox) { await page.mouse.click(cellBox.x, cellBox.y); await page.mouse.click(cellBox.x, cellBox.y); }
  await page.waitForTimeout(1500);
  const calls2 = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'musicLoad').length);
  check('网格双击播放', calls2 > calls, calls + ' → ' + calls2);

  // 平放
  await page.click('.archive-nav [data-layout="table"]');
  await page.waitForTimeout(3000);
  d = await dbg();
  const tdbg = await page.evaluate(() => ({ on: !document.querySelector('.archive-wall.aw-table').hidden, tiles: document.querySelectorAll('.aw-table .aw-tile').length }));
  check('平放开着', d.layout === 'table' && tdbg.on && tdbg.tiles > 20 && d.allowed === false, JSON.stringify(tdbg));
  await shot(tag + '-9-table');
  const tb = await page.evaluate(() => {
    const el = document.querySelector('.aw-table');
    const r = el.getBoundingClientRect();
    const t = [...el.querySelectorAll('.aw-tile')].map((x) => x.getBoundingClientRect()).find((b) => b.left > r.left + r.width * 0.35 && b.right < r.right - r.width * 0.35 && b.top > r.top + r.height * 0.5 && b.bottom < r.bottom - 30);
    return t ? { x: t.left + t.width / 2, y: t.top + t.height / 2 } : null;
  });
  if (tb) await page.mouse.click(tb.x, tb.y);
  await page.waitForTimeout(2200);
  const opened = await page.evaluate(() => Boolean(document.querySelector('.aw-table .aw-tile.is-open')));
  check('平放点了立起来', opened, JSON.stringify(tb));
  await shot(tag + '-10-table-open');
  await page.keyboard.press('Escape');

  // 切回阵列
  await page.click('.archive-nav [data-layout="array"]');
  await page.waitForTimeout(2500);
  d = await dbg();
  check('切回阵列', d.layout === 'array' && !d.wall.on && d.allowed === true);
  await shot(tag + '-6-array');
  check('没有页面错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  server.close();
  process.exit(results.every((x) => x[1]) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
