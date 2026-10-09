// node sweep.mjs <outfitKey> <outDir> : screenshots every expression, every motion group, lip sync, life actions
import fs from 'node:fs';
import path from 'node:path';
const [key, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const list = await (await fetch('http://127.0.0.1:9377/json')).json();
const t = list.find((x) => x.type === 'page' && x.title.includes('Nova · 桌宠'));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(d.params.type + ': ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (d.method === 'Runtime.exceptionThrown') logs.push('exception: ' + d.params.exceptionDetails.exception?.description); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (code) => { const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.result.data, 'base64')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable');
const info = JSON.parse(await ev(fs.readFileSync(new URL('./hook.js', import.meta.url), 'utf8')));
const res = { info, exps: {}, motions: {}, life: {} };
// quiet the autonomous life loop so it doesn't overlap our shots
await ev(`window.__deskPetLife?.force?.('awake'); 1`);
await shot('00_idle');
for (const e of info.exps) {
  res.exps[e] = await ev(`Promise.resolve(__m.expression(${JSON.stringify(e)})).then(String)`);
  await sleep(1300); await shot('exp_' + e);
}
await ev(`__m.expression('Neutral'); 1`); await sleep(800);
for (const g of info.groups.filter((g) => !['Idle', 'Blink'].includes(g))) {
  res.motions[g] = await ev(`Promise.resolve(__m.motion(${JSON.stringify(g)}, 0, 3)).then(String)`);
  await sleep(1000); await shot('mot_' + g); await sleep(1700);
}
// lip sync: drive ParamMouthOpenY each frame
await ev(`window.__lip = (() => { const c = __m.internalModel.coreModel; const f = () => c.setParameterValueById('ParamMouthOpenY', 1); __m.internalModel.on('beforeModelUpdate', f); return f; })(); 1`);
await sleep(500); await shot('lip_Neutral_open');
const emo = info.exps.includes('Happy') ? 'Happy' : info.exps[1];
await ev(`__m.expression('${emo}'); 1`); await sleep(1300); await shot('lip_' + emo + '_open');
await ev(`__m.internalModel.off('beforeModelUpdate', window.__lip); __m.expression('Neutral'); 1`); await sleep(1000);
res.lip = await ev(`__m.internalModel.coreModel.getParameterValueById('ParamMouthOpenY')`);
// runtime path: life actions use deskpet.json
for (const a of ['yawn', 'wake', 'stretch']) {
  res.life[a] = await ev(`Promise.resolve(window.__deskPetLife?.perform?.('${a}')).then((r) => String(r))`);
  await sleep(1100); await shot('life_' + a); await sleep(1800);
}
res.bounds = await ev(`JSON.stringify(window.__deskPetBounds())`);
res.logs = logs;
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
ws.close(); process.exit(0);
