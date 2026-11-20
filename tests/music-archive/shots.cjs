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
    if (name.includes('playing')) qs.set('playing', '');
    if (name.includes('lyrics')) qs.set('lyrics', '');
    if (args.n) qs.set('n', args.n);
    await page.goto(base + '?' + qs.toString());
    await page.waitForFunction(() => window.__ready);
    await page.waitForTimeout(400);
    if (name.includes('nolist') || name.includes('narrow-list')) await page.evaluate(() => document.querySelector('[data-act="list"]').click());
    if (name.includes('sortmenu')) { await page.evaluate(() => document.querySelector('[data-l="sortBtn"]').click()); await page.waitForTimeout(2600); await page.screenshot({ path: path.join(OUT, name + '.png') }); await page.close(); continue; }
    if (name.includes('sortartist')) { await page.evaluate(() => document.querySelector('[data-l="sortBtn"]').click()); await page.evaluate(() => document.querySelector('[data-sort="artist"]').click()); }
    if (name.includes('cover')) {
      // 假封面（离线截图拿不到本地文件）：一张渐变加几何图形的画
      await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = c.height = 480;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 480, 480); grad.addColorStop(0, '#7fb3c8'); grad.addColorStop(1, '#e9c9a8');
        g.fillStyle = grad; g.fillRect(0, 0, 480, 480);
        g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.arc(320, 170, 70, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#2f4a55'; g.fillRect(0, 330, 480, 150);
        g.fillStyle = '#f4efe8'; g.font = '700 54px sans-serif'; g.fillText('LOW TIDE', 36, 420);
        const el = document.querySelector('.archive-cover');
        el.style.backgroundImage = 'url(' + c.toDataURL() + ')'; el.classList.add('on');
      });
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      await page.close();
      continue;
    }
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
