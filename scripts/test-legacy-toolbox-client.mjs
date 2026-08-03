import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LegacyVcpToolboxClient } = require('../archive/agent-runtime/toolbox/legacyVcpToolboxClient.js');

const requests = [];
const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });
    if (req.url === '/v1/human/tool') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'success', content: 'listed files' }));
        return;
    }
    if (req.url === '/v1/chatvcp/completions') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'delegated ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'result' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
    }
    if (req.url === '/v1/interrupt') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
        return;
    }
    res.statusCode = 404;
    res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const client = new LegacyVcpToolboxClient({ baseUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`, apiKey: 'unit-test-key' });
try {
    const invoked = await client.invokeTool({ toolName: 'FileOperator', args: { command: 'ListFiles', path: '.' } });
    assert.equal(invoked.ok, true);
    assert.equal(invoked.output, 'listed files');
    const human = requests.find((request) => request.url === '/v1/human/tool');
    assert.equal(human.authorization, 'Bearer unit-test-key');
    assert.match(human.body, /<<<\[TOOL_REQUEST\]>>>/);

    let deltas = '';
    const delegated = await client.delegate({ task: 'read-only task', requestId: 'req-test', onDelta: (delta) => { deltas += delta; } });
    assert.equal(delegated.ok, true);
    assert.equal(delegated.output, 'delegated result');
    assert.equal(deltas, 'delegated result');
    const delegateRequest = requests.find((request) => request.url === '/v1/chatvcp/completions');
    assert.equal(JSON.parse(delegateRequest.body).requestId, 'req-test');

    const interrupted = await client.interrupt('req-test');
    assert.equal(interrupted.ok, true);
    assert.equal(JSON.parse(requests.find((request) => request.url === '/v1/interrupt').body).requestId, 'req-test');
} finally {
    await new Promise((resolve) => server.close(resolve));
}

console.log('Legacy VCPToolBox HTTP client contract test passed (human/tool, chatvcp SSE, interrupt).');
