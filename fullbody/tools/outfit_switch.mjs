// Outfit-switch test for the desk pet: drives the real right-click menu (换装) through the main
// process inspector and checks each outfit in the pet window over CDP.
//
// usage: node outfit_switch.mjs <rendererPort> <mainInspectPort> <agentId> <appDataDir> <outDir> <outfitId>...
//
// The menu is a native popup, so Menu.prototype.popup is wrapped in the main process to keep a
// handle on the built menu; the test then calls the 换装 submenu item's click(), exactly the
// handler a real click runs. For every outfit: window bounds, canvas capture (feet gap), a page
// screenshot, eyes-closed / mouth-open / gaze-left checks, console errors, and state.json.
import fs from 'node:fs';
import path from 'node:path';

const [rport, mport, agentId, appData, outDir, ...sequence] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(wsUrl, onEvent = () => {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let n = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) onEvent(m);
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++n;
        pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
        if (r.exceptionDetails) throw new Error(`eval: ${expression.slice(0, 100)} -> ${JSON.stringify(r.exceptionDetails).slice(0, 600)}`);
        return r.result.value;
    };
    return { ws, send, evaluate };
}

const pageTargets = async () => (await (await fetch(`http://127.0.0.1:${rport}/json`)).json()).filter((t) => t.type === 'page');

// ---- main process ----
const mainTarget = (await (await fetch(`http://127.0.0.1:${mport}/json`)).json())[0];
const main = await connect(mainTarget.webSocketDebuggerUrl);
await main.send('Runtime.enable');
await main.evaluate(`(() => {
    const { Menu, BrowserWindow } = process.mainModule.require('electron');
    // keep the menu the real handler built, but don't show it: a native popup on screen
    // races the real mouse cursor
    if (!globalThis.__menuCaptured) {
        globalThis.__realPopup = globalThis.__realPopup || Menu.prototype.popup;
        Menu.prototype.popup = function () { globalThis.__lastMenu = this; };
        globalThis.__menuCaptured = true;
    }
    globalThis.__petWin = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('vcp-deskpet://pet'));
    return true;
})()`);
const winInfo = () => main.evaluate(`(() => { const w = __petWin(); if (!w) return null;
    const { screen } = process.mainModule.require('electron');
    const b = w.getBounds(); const d = screen.getDisplayMatching(b);
    return { bounds: b, content: w.getContentBounds(), workArea: d.workArea, scaleFactor: d.scaleFactor }; })()`);

// ---- open the pet ----
const mainPage = (await pageTargets()).find((t) => /main\.html/.test(t.url));
const mc = await connect(mainPage.webSocketDebuggerUrl);
const petTarget = async () => (await pageTargets()).find((t) => t.url.startsWith('vcp-deskpet://pet'));
if (!(await petTarget())) await mc.evaluate(`window.chatAPI.toggleDeskPet(${JSON.stringify(agentId)})`);

async function attachPet() {
    let t;
    for (let i = 0; i < 80 && !(t = await petTarget()); i++) await sleep(250);
    if (!t) throw new Error('pet window missing');
    const logs = [];
    const pc = await connect(t.webSocketDebuggerUrl, (m) => {
        if (m.method === 'Runtime.consoleAPICalled') logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
        if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('log-error: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    });
    await pc.send('Runtime.enable');
    await pc.send('Log.enable');
    return { pc, logs };
}

async function waitReady(pc, outfitId) {
    for (let i = 0; i < 120; i++) {
        const r = await pc.evaluate('window.__deskPetReady || null').catch(() => null);
        const assets = r && await pc.evaluate('window.deskPetAPI.getAssets().then(a => a.outfit && a.outfit.id)').catch(() => null);
        if (r && (!outfitId || assets === outfitId)) return r;
        await sleep(250);
    }
    return null;
}

async function grabModel(pc) {
    for (const [glob, proto] of [['__m', 'PIXI.live2d.Live2DModel.prototype'], ['__app', 'PIXI.Application.prototype']]) {
        const p = await pc.send('Runtime.evaluate', { expression: proto });
        const q = await pc.send('Runtime.queryObjects', { prototypeObjectId: p.result.objectId });
        await pc.send('Runtime.callFunctionOn', { objectId: q.objects.objectId, functionDeclaration: `function () { window.${glob} = this[this.length - 1]; return this.length; }` });
    }
    return pc.evaluate(`(() => {
        const m = window.__m, im = m.internalModel, core = im.coreModel;
        window.__ov = {};
        im.on('beforeModelUpdate', () => { for (const [id, v] of Object.entries(window.__ov)) core.setParameterValueById(im.getIdSafe(id), v); });
        window.__focus = m.focus.bind(m); m.focus = () => {};
        window.__cap = () => new Promise((res) => window.__app.ticker.addOnce(() => res(window.__app.canvas.toDataURL('image/png')), null, -100));
        const b = m.getBounds();
        return { modelUrl: decodeURIComponent((im.settings && im.settings.url) || ''), inner: [innerWidth, innerHeight], dpr: devicePixelRatio,
                 canvas: [__app.canvas.width, __app.canvas.height], bounds: { x: b.x, y: b.y, w: b.width, h: b.height } };
    })()`);
}

async function shootCanvas(pc, file) {
    const url = await pc.evaluate('window.__cap()');
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
}

async function clickOutfit(pc, outfitId) {
    await main.evaluate('globalThis.__lastMenu = null');
    await pc.evaluate('window.deskPetAPI.openContextMenu()');
    let menu;
    for (let i = 0; i < 40; i++) {
        menu = await main.evaluate(`(() => { const m = globalThis.__lastMenu; if (!m) return null;
            const sub = m.items.find((it) => it.label === '换装');
            return { enabled: sub && sub.enabled, items: sub && sub.submenu ? sub.submenu.items.map((it) => ({ label: it.label, checked: it.checked })) : [] }; })()`);
        if (menu) break;
        await sleep(100);
    }
    if (!menu) throw new Error('context menu did not pop');
    const outfits = await pc.evaluate('window.deskPetAPI.getAssets().then(a => a.outfits)');
    const wanted = outfits.find((o) => o.id === outfitId);
    if (!wanted) throw new Error(`outfit ${outfitId} not in ${JSON.stringify(outfits)}`);
    const clicked = await main.evaluate(`(() => { const m = globalThis.__lastMenu; const sub = m.items.find((it) => it.label === '换装');
        const item = sub.submenu.items.find((it) => it.label === ${JSON.stringify(wanted.label)});
        if (!item) return false; item.click(); return true; })()`);
    return { menu, outfits, clicked, label: wanted.label };
}

function readState() {
    try { return JSON.parse(fs.readFileSync(path.join(appData, 'deskpet', 'state.json'), 'utf8'))[agentId] || null; } catch (e) { return 'unreadable: ' + e.message; }
}

const report = { steps: [] };
let { pc, logs } = await attachPet();
let ready = await waitReady(pc);
report.initial = { ready, outfit: await pc.evaluate('window.deskPetAPI.getAssets().then(a => a.outfit)'), win: await winInfo(), state: readState() };
for (const [i, outfitId] of sequence.entries()) {
    const step = { outfitId, outfitBefore: await pc.evaluate('window.deskPetAPI.getAssets().then(a => a.outfit && a.outfit.id)') };
    const before = await winInfo();
    await pc.evaluate('window.__stale = true');
    step.menu = await clickOutfit(pc, outfitId);
    // the switch reloads the page: wait until the old document is gone before re-attaching
    for (let k = 0; k < 40; k++) {
        if (!(await pc.evaluate('window.__stale === true').catch(() => false))) break;
        await sleep(250);
    }
    pc.ws.close();
    ({ pc, logs } = await attachPet());
    step.ready = await waitReady(pc, outfitId);
    await sleep(2500);   // figure measurement + window reshape
    step.winBefore = before;
    step.win = await winInfo();
    step.model = step.ready?.backend === 'live2d' ? await grabModel(pc) : null;
    const tag = `${String(i + 1).padStart(2, '0')}_${outfitId}`;
    if (step.model) {
        const b = step.model.bounds;
        await pc.evaluate(`window.__focus(${b.x + b.w / 2}, ${b.y + b.h * 0.15}, true)`);
        await sleep(1200);
        await shootCanvas(pc, path.join(outDir, `${tag}_canvas.png`));
        const shot = await pc.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, `${tag}_page.png`), Buffer.from(shot.data, 'base64'));
        await pc.evaluate(`window.__ov = { ParamEyeLOpen: 0, ParamEyeROpen: 0, ParamMouthOpenY: 1 }`);
        await sleep(500);
        await shootCanvas(pc, path.join(outDir, `${tag}_eyes0_mouth1.png`));
        await pc.evaluate('window.__ov = {}');
        await pc.evaluate(`window.__focus(-400, ${b.y + b.h * 0.15})`);
        await sleep(1300);
        await shootCanvas(pc, path.join(outDir, `${tag}_gaze_left.png`));
        await pc.evaluate(`window.__focus(${b.x + b.w / 2}, ${b.y + b.h * 0.15})`);
    }
    step.state = readState();
    step.console = logs.slice();
    report.steps.push(step);
    console.log(outfitId, 'clicked', step.menu.clicked, step.menu.label, 'ready', JSON.stringify(step.ready), 'win', JSON.stringify(step.win?.bounds), 'state', JSON.stringify(step.state));
}
fs.writeFileSync(path.join(outDir, 'switch_report.json'), JSON.stringify(report, null, 1));
await main.evaluate(`(() => { const { Menu } = process.mainModule.require('electron');
    Menu.prototype.popup = globalThis.__realPopup; globalThis.__menuCaptured = false; return true; })()`);
pc.ws.close(); mc.ws.close(); main.ws.close();
