// tiny CDP client: node cdp.mjs <port> <title-substring> <js-file|-e code> [screenshot.png]
import fs from 'node:fs';
const [port, title, src, shot] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const t = list.find((x) => x.type === 'page' && x.title.includes(title));
if (!t) { console.error('no target', list.map((x) => x.title)); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(d.params.type + ': ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (d.method === 'Runtime.exceptionThrown') logs.push('exception: ' + d.params.exceptionDetails.exception?.description); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
globalThis.send = send;
await send('Runtime.enable');
const code = src === '-e' ? process.argv[5] : fs.readFileSync(src, 'utf8');
const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r, null, 1));
if (shot && src !== '-e') { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shot, Buffer.from(s.result.data, 'base64')); }
if (logs.length) console.log('LOGS', logs);
ws.close(); process.exit(0);
