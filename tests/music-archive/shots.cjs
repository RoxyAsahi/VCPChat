/*
 * 档案页离线截图：node tests/music-archive/shots.cjs [--out=dir] [--size=1600x900]
 * 用假播放器（harness.html），不碰真实数据。
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(args.out || path.join(require('node:os').tmpdir(), 'music-archive-shots'));
const [W, H] = (args.size || '1600x900').split('x').map(Number);
const CASES = (args.cases || 'dark,light,dark-dock,light-narrow,light-narrow-list,dark-search,light-pinyin,dark-nolist,light-empty').split(',');
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await require('../music-stage-bench/serve.cjs')(ROOT);
  const base = `http://127.0.0.1:${server.address().port}/tests/music-archive/harness.html`;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const name of CASES) {
    const narrow = name.includes('narrow');
    const page = await browser.newPage({ viewport: { width: narrow ? 900 : W, height: narrow ? 700 : H }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    const qs = new URLSearchParams();
    if (name.includes('light')) qs.set('light', '');
    if (name.includes('dock')) qs.set('dock', '118');
    if (name.includes('empty')) qs.set('empty', '');
    if (args.n) qs.set('n', args.n);
    await page.goto(base + '?' + qs.toString());
    await page.waitForFunction(() => window.__ready);
    await page.waitForTimeout(400);
    if (name.includes('nolist') || name.includes('narrow-list')) await page.keyboard.press('l');
    if (name.includes('search')) { await page.keyboard.press('/'); await page.keyboard.type('站台'); await page.waitForTimeout(300); }
    else if (name.includes('pinyin')) { await page.waitForFunction(() => window.pinyinPro); await page.keyboard.press('/'); await page.keyboard.type('hh'); await page.waitForTimeout(300); await page.keyboard.press('ArrowDown'); }
    else if (!name.includes('empty')) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight'); }
    await page.waitForTimeout(2600);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    const dbg = await page.evaluate(() => window.app.archiveView.debug());
    console.log(name, JSON.stringify({ lane: dbg.lane, row: dbg.row, sel: dbg.selected, scene: dbg.scene, cols: dbg.columns.length }), errors.length ? 'ERR ' + errors.join(' | ') : '');
    await page.close();
  }
  await browser.close();
  server.close();
})();
