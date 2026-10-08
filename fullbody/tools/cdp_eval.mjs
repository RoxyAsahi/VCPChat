// usage: node cdp_eval.mjs <port> <main|pet> <expression>   (debug helper)
const [port, which, expr] = process.argv.slice(2);
const ts = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const t = ts.find((x) => x.type === 'page' && (which === 'pet' ? x.url.startsWith('vcp-deskpet://') : /main\.html/.test(x.url)));
if (!t) { console.error('no target', ts.map((x) => x.url)); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { console.log(JSON.stringify(m.result?.result?.value ?? m.result ?? m.error, null, 1)); ws.close(); } };
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
