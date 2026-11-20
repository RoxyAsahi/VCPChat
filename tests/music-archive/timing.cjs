/*
 * 档案页耗时（node + jsdom，不画 3D）：N 首曲库下，目录检索每敲一个字、切排序后阵列和目录重排各要多久。
 *   node tests/music-archive/timing.cjs [--n=570]
 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const N = Number(args.n || 570);
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const dom = new JSDOM('<!doctype html><body><div id="music-archive-view"></div><button id="music-archive-return"></button></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
w.console.warn = () => {};
w.eval(read('node_modules/pinyin-pro/dist/index.js'));
for (const n of ['model', 'scene', 'index', 'list', 'view']) w.eval(read(`Musicmodules/music-archive/archive-${n}.js`));
const W1 = ['清晨的', '黄昏', '空车厢', '潮汐', '雨后的', '末班', '远处的', '水面', 'Blue', 'Night', 'アイドル', '夏日'];
const W2 = ['站台', '信号', '回声', '海风', 'Bird', 'Drive', '灯塔', '车窗', '来信', 'のうた', '月台', '旧磁带'];
const ART = ['Aki', '周杰伦', 'YOASOBI', 'いきものがかり', 'Ren', 'Lumi', 'Tsubame', 'REONA'];
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const tracks = Array.from({ length: N }, (_, i) => ({ path: 'D:\\M\\' + i + '.flac', title: W1[Math.floor(rnd() * 12)] + W2[Math.floor(rnd() * 12)] + ' ' + i + '.flac', artist: ART[Math.floor(rnd() * 8)], album: 'Album ' + (i % 37), duration: 120 + Math.floor(rnd() * 400) }));
const app = { playlist: tracks, customPlaylists: [{ id: 'p', name: '歌单', tracks: tracks.slice(0, 40).map((t) => t.path) }], currentTrackIndex: 0, isPlaying: false, loadTrack() {}, renderPlaylist() {}, stageHost: { active: false, enter() {} } };
const view = w.MusicArchive.init(app, { pinyinSrc: false });
view.refresh();
view.setListOpen(true);
const vp = view.list.el.querySelector('[data-l="viewport"]');
Object.defineProperty(vp, 'clientHeight', { value: 700 });
const input = view.list.input;
const t = () => w.performance.now();
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = { n: N };
// 每敲一个字：input 事件 → 80ms 去抖后 rebuild + 选中第一条（这里直接走 flush：按 ↓ 键会立刻刷新）
const typing = [];
for (const q of ['q', 'qi', 'qin', 'qing', 'qingc', 'y', 'yo', 'yoa', 'b', 'bl', 'blu', '海', '海风', 'zjl']) {
  input.value = q;
  const a = t();
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  typing.push({ q, ms: +(t() - a).toFixed(1), hits: view.list.count });
}
out.typing = { median: med(typing.map((x) => x.ms)), max: Math.max(...typing.map((x) => x.ms)), each: typing };
input.value = '';
input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const sorts = [];
for (let round = 0; round < 3; round++) {
  for (const m of ['artist', 'duration', 'added', 'title']) {
    const a = t();
    view.setSort(m);
    sorts.push({ m, ms: +(t() - a).toFixed(1) });
  }
}
out.sort = { median: med(sorts.map((x) => x.ms)), max: Math.max(...sorts.map((x) => x.ms)), each: sorts.slice(0, 4) };
// 只重建索引（拼音）一次的耗时，作参考
const a = t(); view.refresh(); out.refresh = +(t() - a).toFixed(1);
console.log(JSON.stringify(out, null, 1));
view.destroy(); w.close();
