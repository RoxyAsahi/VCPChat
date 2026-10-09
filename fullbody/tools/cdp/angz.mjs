import fs from 'node:fs'; import path from 'node:path';
const [out, ...vals] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const list = await (await fetch('http://127.0.0.1:9377/json')).json();
const t = list.find((x) => x.type === 'page' && x.title.includes('Nova · 桌宠'));
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (code) => { const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(await ev(`(()=>{const P=__m.internalModel.coreModel.getModel().parameters;const i=P.ids.indexOf('ParamAngleZ');return [P.minimumValues[i],P.maximumValues[i], typeof __setPose].join(',')})()`));
for (const v of vals.map(Number)) { await ev(`__setPose({ParamAngleZ:${v},ParamEyeLOpen:1,ParamEyeROpen:1}); 1`); await sleep(1200);
  const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, `z${v}.png`), Buffer.from(s.result.data, 'base64')); }
await ev(`__setPose({}); 1`); ws.close(); process.exit(0);
