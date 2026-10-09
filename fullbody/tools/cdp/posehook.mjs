// node accept.mjs <outDir> : acceptance render of the current pet model (real Cubism Core inside deskpet-demo)
// params are pinned in afterMotionUpdate (before saveParameters) so physics reacts to them like real motion
import fs from 'node:fs';
import path from 'node:path';
const out = process.env.TEMP + '/posehook';
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
const shots = [];
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.result.data, 'base64')); shots.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable');
const info = JSON.parse(await ev(fs.readFileSync(new URL('./hook.js', import.meta.url), 'utf8')));
// wake the pet (it may have dozed off: drowsy eyes) before freezing the life loop
await ev(`window.__deskPetLife?.force('awake'); 1`); await sleep(3000);
await ev(`(() => {
  const life = window.__deskPetLife; if (life && !life.__tick) { life.__tick = life.tick; life.tick = () => {}; }  // no random life actions mid-shot
  const im = __m.internalModel, P = im.coreModel.getModel().parameters, ix = (k) => P.ids.indexOf(k);
  window.__pose = {};
  // values are clamped to each parameter's range, so +-99 means "that parameter's extreme"
  if (!window.__poseHook) { window.__poseHook = () => { for (const [k, v] of Object.entries(window.__pose)) { const i = ix(k); if (i >= 0) P.values[i] = Math.max(P.minimumValues[i], Math.min(P.maximumValues[i], v)); } }; im.on('afterMotionUpdate', window.__poseHook); }
  window.__setPose = (p) => { const prev = window.__pose; const reset = {};
    for (const k of Object.keys(prev)) if (!(k in p)) reset[k] = P.defaultValues[ix(k)];
    window.__pose = { ...reset, ...p }; setTimeout(() => { for (const k of Object.keys(reset)) delete window.__pose[k]; }, 120); };
  return 1; })()`);

ws.close(); process.exit(0);
