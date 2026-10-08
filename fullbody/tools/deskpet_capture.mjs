// Drive the deskpet-demo pet window over CDP and save Live2D canvas captures (RGBA PNG).
//
// usage: node deskpet_capture.mjs <port> <agentId> <outDir>
//
// Opens the agent's pet through chatAPI.toggleDeskPet, finds the Live2DModel / PIXI.Application
// with Runtime.queryObjects, detaches the real-cursor focus, then captures:
//   idle, gaze left/right/top, Nod / Shake sequences, forced eyes closed, MouthOpenY 0 vs 1,
//   and a hem/hair sequence after a fast head turn. Closes the pet at the end.
import fs from 'node:fs';
import path from 'node:path';

const [port, agentId, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await fetch(`http://127.0.0.1:${port}/json`)).json();

async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let n = 0;
    const pending = new Map();
    const logs = [];
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
        else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 500));
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++n;
        pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`eval failed: ${expression.slice(0, 120)} -> ${JSON.stringify(r.exceptionDetails).slice(0, 800)}`);
        return r.result.value;
    };
    return { ws, send, evaluate, logs };
}

const petTarget = async () => (await targets()).find((t) => t.type === 'page' && t.url.startsWith('vcp-deskpet://'));

async function main() {
    const all = await targets();
    const main = all.find((t) => t.type === 'page' && !t.url.startsWith('vcp-deskpet://') && /main|index/i.test(t.url)) ||
        all.find((t) => t.type === 'page' && !t.url.startsWith('vcp-deskpet://'));
    if (!main) throw new Error('no main window target: ' + JSON.stringify(all.map((t) => t.url)));
    const mc = await connect(main.webSocketDebuggerUrl);
    if (await petTarget()) {   // stale pet from a previous run: close it first
        await mc.evaluate(`window.chatAPI.toggleDeskPet(${JSON.stringify(agentId)})`);
        await sleep(1500);
    }
    await mc.evaluate(`window.chatAPI.toggleDeskPet(${JSON.stringify(agentId)})`);
    let pt;
    for (let i = 0; i < 60 && !(pt = await petTarget()); i++) await sleep(250);
    if (!pt) throw new Error('pet window did not appear');
    const pc = await connect(pt.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    let ready;
    for (let i = 0; i < 120; i++) {
        ready = await pc.evaluate('window.__deskPetReady || null');
        if (ready) break;
        await sleep(250);
    }
    const meta = { ready, logs: pc.logs };
    if (!ready || ready.backend !== 'live2d') {
        fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));
        throw new Error('pet not ready as live2d: ' + JSON.stringify(ready) + '\n' + pc.logs.join('\n'));
    }

    // Grab the model and the app from the heap.
    for (const [glob, proto] of [['__m', 'PIXI.live2d.Live2DModel.prototype'], ['__app', 'PIXI.Application.prototype']]) {
        const p = await pc.send('Runtime.evaluate', { expression: proto });
        const q = await pc.send('Runtime.queryObjects', { prototypeObjectId: p.result.objectId });
        await pc.send('Runtime.callFunctionOn', {
            objectId: q.objects.objectId,
            functionDeclaration: `function () { window.${glob} = this[0]; return this.length; }`,
        });
    }
    meta.setup = await pc.evaluate(`(() => {
        const m = window.__m, im = m.internalModel, core = im.coreModel;
        window.__ov = {};
        im.on('beforeModelUpdate', () => {
            for (const [id, v] of Object.entries(window.__ov)) core.setParameterValueById(im.getIdSafe(id), v);
        });
        // Detach the real cursor: the page keeps calling model.focus with the OS cursor.
        window.__focus = m.focus.bind(m);
        m.focus = () => {};
        window.__cap = () => new Promise((res) => window.__app.ticker.addOnce(
            () => res(window.__app.canvas.toDataURL('image/png')), null, -100));
        const b = m.getBounds();
        // Mouth art meshes in window CSS px: drawable vertices -> internal localTransform -> model world.
        const ids = im.getDrawableIDs();
        let mouth = null;
        ids.forEach((id, i) => {
            if (!/mouth/i.test(id)) return;
            const v = im.getDrawableVertices(i);
            for (let k = 0; k < v.length; k += 2) {
                const g = m.toGlobal(im.localTransform.apply({ x: v[k], y: v[k + 1] }));
                mouth = mouth || { x0: g.x, y0: g.y, x1: g.x, y1: g.y, ids: [] };
                mouth.x0 = Math.min(mouth.x0, g.x); mouth.x1 = Math.max(mouth.x1, g.x);
                mouth.y0 = Math.min(mouth.y0, g.y); mouth.y1 = Math.max(mouth.y1, g.y);
            }
            mouth.ids.push(id);
        });
        return { mouth, inner: [innerWidth, innerHeight], dpr: devicePixelRatio,
                 canvas: [__app.canvas.width, __app.canvas.height],
                 modelSize: [im.width, im.height], scale: m.scale.x,
                 bounds: { x: b.x, y: b.y, w: b.width, h: b.height },
                 motions: Object.keys(im.motionManager.definitions || {}),
                 params: (core._model?.parameters?.ids || []).length };
    })()`);
    const { bounds } = meta.setup;
    const cx = bounds.x + bounds.w / 2;
    const headY = bounds.y + bounds.h * 0.15;
    const shot = async (name) => {
        const url = await pc.evaluate('window.__cap()');
        fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(url.split(',')[1], 'base64'));
    };
    const focus = (x, y, instant = false) => pc.evaluate(`window.__focus(${x}, ${y}, ${instant})`);
    const ov = (o) => pc.evaluate(`window.__ov = ${JSON.stringify(o)}`);

    await focus(cx, headY, true);
    await sleep(1500);
    for (const i of [0, 1, 2]) { await shot(`idle_${i}`); await sleep(700); }
    // Gaze: focus is in window coordinates; far points saturate the look direction.
    for (const [name, x, y] of [['gaze_left', -400, headY], ['gaze_right', 760, headY], ['gaze_top', cx, -600]]) {
        await focus(x, y); await sleep(1400); await shot(name);
    }
    await focus(cx, headY); await sleep(1500);
    for (const g of ['Nod', 'Shake']) {
        const ok = await pc.evaluate(`window.__m.motion(${JSON.stringify(g)}, 0, 3)`);
        meta[`motion_${g}`] = ok;
        for (const t of [250, 500, 750, 1000]) { await sleep(250); await shot(`${g.toLowerCase()}_${t}`); }
        await sleep(1500);
    }
    await ov({ ParamEyeLOpen: 0, ParamEyeROpen: 0 }); await sleep(400); await shot('eyes_closed');
    await ov({ ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthOpenY: 0 }); await sleep(400); await shot('mouth_0');
    await ov({ ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthOpenY: 1 }); await sleep(400); await shot('mouth_1');
    await ov({});
    // Head turn: hold far left, snap to far right, sample the hem / hair swing.
    await focus(-400, headY); await sleep(2000); await shot('turn_000');
    await focus(760, headY);
    let t0 = Date.now();
    for (const t of [120, 240, 400, 600, 900, 1400]) {
        await sleep(Math.max(0, t - (Date.now() - t0)));
        await shot(`turn_${String(t).padStart(3, '0')}`);
    }
    await focus(cx, headY);
    meta.logs = pc.logs;
    fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));
    await mc.evaluate(`window.chatAPI.toggleDeskPet(${JSON.stringify(agentId)})`);
    await sleep(1000);
    pc.ws.close(); mc.ws.close();
    console.log(JSON.stringify(meta.setup), 'Nod', meta.motion_Nod, 'Shake', meta.motion_Shake);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
