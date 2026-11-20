/*
 * 町景截图：固定几个机位各拍一张，再打印绘制调用和三角面。
 *   node tests/music-stage-bench/kowloon-shots.cjs [--out=dir] [--size=1600x900] [--t=30]
 *       [--shots=iso,street,screen,roof] [--quality=standard]
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v = '1'] = a.slice(2).split('='); return [k, v]; }));
const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const OUT = path.resolve(args.out || path.join(ROOT, 'artifacts', 'kowloon'));
const [W, H] = (args.size || '1600x900').split('x').map(Number);
const SHOTS = (args.shots || 'iso,street,screen,roof').split(',');
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const server = await require('./serve.cjs')(ROOT);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', m => { if (/error|warn/i.test(m.type()) && !/deprecated/.test(m.text())) console.log('[page]', m.type(), m.text().slice(0, 400)); });
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await page.goto(`${origin}/blank.html`);
    await page.evaluate(({ quality, extra }) => {
        localStorage.clear();
        localStorage.setItem('musicStageMode', 'kowloon');
        localStorage.setItem('musicStageConfig', JSON.stringify({ quality, modes: { kowloon: JSON.parse(extra || '{}') } }));
    }, { quality: args.quality || 'standard', extra: args.kowloon || '' });
    const t = Number(args.t || 30);
    await page.goto(`${origin}/Musicmodules/harness.html?lyrics=song&duration=215&t=${t}`);
    await page.waitForTimeout(400);
    await page.evaluate(() => __h.app.stageHost.enter());
    await page.waitForFunction(() => { try { const m = __h.snap().mode; return m?.initialized || m?.fallbackMode; } catch { return false; } }, null, { timeout: 180000 });
    await page.evaluate(() => __h.pause && __h.pause());
    for (const shot of SHOTS) {
        const [id, tt] = shot.split('@');
        if (args.time) await page.evaluate((t) => MusicStageKowloonManager.debugInstance().debugTime(t), Number(args.time));
        await page.evaluate(({ id, tt }) => MusicStageKowloonManager.debugInstance().debugSetShot(id, tt === undefined ? 0.5 : Number(tt)), { id, tt });
        await page.waitForTimeout(600);
        const file = path.join(OUT, `${shot.replace('@', '-')}.png`);
        await page.screenshot({ path: file });
        const snap = await page.evaluate(() => __h.snap().mode);
        console.log(shot, JSON.stringify({ draws: snap.drawCalls, tris: snap.triangles, programs: snap.programs, lights: snap.lights, fallback: snap.fallbackMode }));
    }
    console.log(JSON.stringify(await page.evaluate(() => __h.snap().mode)).slice(0, 800));
    await browser.close();
    server.close();
})().catch(e => { console.error(e); process.exit(1); });
