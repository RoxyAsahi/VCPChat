// node expmat.mjs <out> : every expression at EyeOpen 0/0.3/1 (mouth shut) and MouthOpenY 0/0.5/1 (eyes open); run posehook.mjs first
import fs from 'node:fs'; import path from 'node:path';
const [out] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const list = await (await fetch('http://127.0.0.1:9377/json')).json();
const t = list.find((x) => x.type === 'page' && x.title.includes('Nova · 桌宠'));
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (code) => { const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, n + '.png'), Buffer.from(s.result.data, 'base64')); };
const exps = JSON.parse(await ev(`JSON.stringify(__m.internalModel.settings.expressions.map((e) => e.Name ?? e.name))`));
const still = { ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0, ParamEyeBallX: 0, ParamEyeBallY: 0 };
for (const e of exps) {
  await ev(`__setPose(${JSON.stringify({ ...still, ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthOpenY: 0 })}); __m.expression(${JSON.stringify(e)}); 1`); await sleep(1000);
  for (const v of [0, 0.3, 1]) { await ev(`__setPose(${JSON.stringify({ ...still, ParamEyeLOpen: v, ParamEyeROpen: v, ParamMouthOpenY: 0 })}); 1`); await sleep(450); await shot(`${e}_eye${v}`); }
  for (const v of [0, 0.5, 1]) { await ev(`__setPose(${JSON.stringify({ ...still, ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthOpenY: v })}); 1`); await sleep(450); await shot(`${e}_mouth${v}`); }
}
await ev(`__setPose({}); __m.expression('Neutral'); 1`);
console.log(JSON.stringify(exps)); ws.close(); process.exit(0);
