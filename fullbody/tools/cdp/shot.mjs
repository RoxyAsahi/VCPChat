import fs from 'node:fs';
const [out] = process.argv.slice(2);
const list = await (await fetch('http://127.0.0.1:9377/json')).json();
const t = list.find((x) => x.type === 'page' && x.title.includes('Nova · 桌宠'));
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const s = await new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
fs.writeFileSync(out, Buffer.from(s.result.data, 'base64')); ws.close(); process.exit(0);
