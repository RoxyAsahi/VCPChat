import fs from 'node:fs'; import path from 'node:path';
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const list = await (await fetch('http://127.0.0.1:9377/json')).json();
const t = list.find((x) => x.type === 'page' && x.title.includes('Nova · 桌宠'));
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (code) => { const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await ev(`(() => { const cm = __m.internalModel.coreModel; const D = cm.getModel().drawables;
 if (!cm.__upd) { cm.__upd = cm.update.bind(cm); cm.update = () => { cm.__upd(); for (const id of (window.__hide||[])) { const i = D.ids.indexOf(id); if (i>=0) D.opacities[i]=0; } for (const id of (window.__show||[])) { const i = D.ids.indexOf(id); if (i>=0) D.opacities[i]=1; } }; }
 __m.expression('Neutral'); return 1; })()`);
const whites = ['ArtMeshEyewhiteL9','ArtMeshEyewhiteR8'];
const cands = { neutral: [], speechless: ['ArtMeshEyelashL3','ArtMeshEyelashR2'], sleepy: ['ArtMeshEyelashL5','ArtMeshEyelashR4'], sad: ['ArtMeshEyelashL7','ArtMeshEyelashR6'], smug: ['ArtMeshEyelashL4','ArtMeshEyelashR3'], shy: ['ArtMeshEyelashL6','ArtMeshEyelashR5'], angry: ['ArtMeshEyelashL9','ArtMeshEyelashR8'], wink: ['ArtMeshEyelashL'], surprised: ['ArtMeshEyelashL2','ArtMeshEyelashR'] };
for (const [n, ids] of Object.entries(cands)) {
  const hide = n === 'neutral' ? [] : [...whites, 'ArtMeshEyelashL8', 'ArtMeshEyelashR7'];
  await ev(`window.__hide=${JSON.stringify(hide)}; window.__show=${JSON.stringify(ids)}; __setPose({ParamEyeLOpen:0,ParamEyeROpen:0,ParamAngleX:0,ParamAngleY:0,ParamAngleZ:0}); 1`); await sleep(900);
  const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `lid_${n}.png`), Buffer.from(s.result.data, 'base64'));
}
await ev(`window.__hide=[]; window.__show=[]; __setPose({}); 1`); ws.close(); process.exit(0);
