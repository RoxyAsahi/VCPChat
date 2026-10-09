// node accept.mjs <outDir> : acceptance render of the current pet model (real Cubism Core inside deskpet-demo)
// params are pinned in afterMotionUpdate (before saveParameters) so physics reacts to them like real motion
import fs from 'node:fs';
import path from 'node:path';
const [out] = process.argv.slice(2);
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
const has = new Set(JSON.parse(await ev(`JSON.stringify(Array.from(__m.internalModel.coreModel.getModel().parameters.ids))`)));
const pose = async (name, p, wait = 900) => { const q = Object.fromEntries(Object.entries(p).filter(([k]) => has.has(k)));
  await ev(`__setPose(${JSON.stringify(q)}); 1`); await sleep(wait); await shot(name); };
await ev(`__m.expression('Neutral'); 1`); await sleep(600);
await shot('p00_base');
// head angles + corners
for (const [n, p] of Object.entries({ angX_m: { ParamAngleX: -99 }, angX_p: { ParamAngleX: 99 }, angY_m: { ParamAngleY: -99 }, angY_p: { ParamAngleY: 99 },
  angZ_m: { ParamAngleZ: -99 }, angZ_p: { ParamAngleZ: 99 }, ang_ul: { ParamAngleX: -99, ParamAngleY: 99 }, ang_ur: { ParamAngleX: 99, ParamAngleY: 99 },
  ang_dl: { ParamAngleX: -99, ParamAngleY: -99 }, ang_dr: { ParamAngleX: 99, ParamAngleY: -99 },
  bodyX_m: { ParamBodyAngleX: -99 }, bodyX_p: { ParamBodyAngleX: 99 }, bodyY_m: { ParamBodyAngleY: -99 }, bodyY_p: { ParamBodyAngleY: 99 },
  bodyZ_m: { ParamBodyAngleZ: -99 }, bodyZ_p: { ParamBodyAngleZ: 99 }, breath_1: { ParamBreath: 1 },
  eyes_closed: { ParamEyeLOpen: 0, ParamEyeROpen: 0 }, eyes_half: { ParamEyeLOpen: 0.5, ParamEyeROpen: 0.5 }, eyes_wide: { ParamEyeLOpen: 99, ParamEyeROpen: 99 },
  eyeform_smile: { ParamEyeBallForm: 1 }, eyeform_m: { ParamEyeBallForm: -1 }, eyeball_ul: { ParamEyeBallX: -1, ParamEyeBallY: 1 }, eyeball_dr: { ParamEyeBallX: 1, ParamEyeBallY: -1 },
  brows_up: { ParamBrowLY: 1, ParamBrowRY: 1 }, brows_down: { ParamBrowLY: -1, ParamBrowRY: -1 } }))
  await pose('p_' + n, { ParamEyeLOpen: 1, ParamEyeROpen: 1, ...p });
for (const o of [0, 0.5, 1]) for (const f of [-1, 0, 1]) await pose(`m_open${o}_form${f}`, { ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthOpenY: o, ParamMouthForm: f }, 500);
await ev(`__setPose({}); 1`); await sleep(400);
// expressions, and each with the mouth driven open (lip sync during an expression)
for (const e of info.exps) {
  await ev(`__m.expression(${JSON.stringify(e)}); 1`); await sleep(1100); await shot('e_' + e);
  await pose('e_' + e + '_mouth', { ParamMouthOpenY: 1 }, 400); await ev(`__setPose({}); 1`);
}
await ev(`__m.expression('Neutral'); 1`); await sleep(900);
// gestures: start / mid / end (+ after end, looking for leftovers)
const gestures = info.groups.filter((g) => !['Idle', 'Blink'].includes(g));
for (const g of gestures) {
  const t0 = Date.now(); await ev(`__m.motion(${JSON.stringify(g)}, 0, 3); 1`);
  const at = async (ms, tag) => { await sleep(Math.max(0, ms - (Date.now() - t0))); await shot(`g_${g}_${tag}`); };
  await at(150, '0start'); await at(1000, '1mid'); await at(2350, '2fade'); await at(3300, '3after');
}
// gesture interrupted by another gesture, then the residue once both are over
if (gestures.length > 3) {
  const [a, b] = gestures.includes('Wave') ? ['Wave', 'Tea'] : [gestures[0], gestures[1]];
  await ev(`__m.motion('${a}', 0, 3); 1`); await sleep(1000);
  await ev(`__m.motion('${b}', 0, 3); 1`); await sleep(120); await shot(`x_${a}_to_${b}_cross`);
  await sleep(1000); await shot(`x_${a}_to_${b}_mid`); await sleep(2600); await shot(`x_${a}_to_${b}_after`);
}
// physics: snap the head across, catch the hair/skirt mid-swing, then the Shake motion
await pose('ph_0_left', { ParamAngleX: -99, ParamBodyAngleX: -99 }, 1500);
await ev(`__setPose({ ParamAngleX: 99, ParamBodyAngleX: 99 }); 1`); await sleep(140); await shot('ph_1_snap140ms');
await sleep(220); await shot('ph_2_snap360ms'); await sleep(1200); await shot('ph_3_settled');
await ev(`__setPose({}); 1`); await sleep(1500);
if (info.groups.includes('Shake')) { await ev(`__m.motion('Shake', 0, 3); 1`); await sleep(450); await shot('ph_4_shake450'); await sleep(400); await shot('ph_5_shake850'); await sleep(2000); }
const res = { info, shots: shots.length, logs, bounds: await ev(`JSON.stringify(window.__deskPetBounds())`) };
fs.writeFileSync(path.join(out, 'accept.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify({ shots: shots.length, logs, url: info.url }));
ws.close(); process.exit(0);
