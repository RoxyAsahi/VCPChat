import fs from 'node:fs';
const [out, z, ...hide] = process.argv.slice(2);
const list = await (await fetch('http://127.0.0.1:9377/json')).json();
const t = list.find((x) => x.type === 'page' && x.title.includes('Nova · 桌宠'));
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = (code) => send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
await ev(`(async () => { const cm = __m.internalModel.coreModel; const D = cm.getModel().drawables;
 if (!cm.__upd) { cm.__upd = cm.update.bind(cm); cm.update = () => { cm.__upd(); for (const id of (window.__hide||[])) { const i = D.ids.indexOf(id); if (i>=0) D.opacities[i]=0; } }; }
 window.__hide = ${JSON.stringify(hide)}; __setPose({ParamAngleZ:${z},ParamEyeLOpen:1,ParamEyeROpen:1}); await new Promise(r=>setTimeout(r,1200)); return 1; })()`);
const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
await ev(`window.__hide=[]; __setPose({}); 1`); ws.close(); process.exit(0);
