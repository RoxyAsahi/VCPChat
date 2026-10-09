// node main.mjs <code>: evaluate in the Electron main process (inspector on 9378)
const list = await (await fetch('http://127.0.0.1:9378/json')).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const r = await send('Runtime.evaluate', { expression: `(async () => { const req = process.mainModule.require; ${process.argv[2]} })()`, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1));
ws.close(); process.exit(0);
