import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexAppServerTransport, resolveCodexLaunch } = require('../modules/codex-runtime/appServerTransport.js');

class FakeChild extends EventEmitter {
    constructor(userAgent = 'Codex Desktop/0.146.0 (fixture)') {
        super();
        this.killed = false;
        this.pid = 4242;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.stdin = new Writable({
            write: (chunk, _encoding, callback) => {
                const message = JSON.parse(String(chunk).trim());
                if (message.method === 'initialize') {
                    this.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent } })}\n`);
                    return callback();
                }
                if (message.method === 'thread/start') {
                    this.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: 'thr_1' } } })}\n`);
                    this.stdout.write(`${JSON.stringify({ method: 'thread/started', params: { thread: { id: 'thr_1' } } })}\n`);
                }
                return callback();
            },
        });
    }

    kill() {
        this.killed = true;
        this.emit('exit', 0, 'SIGTERM');
        return true;
    }
}

const launch = resolveCodexLaunch({ executable: 'codex-app-server.exe' });
assert.deepEqual(launch.args, ['--listen', 'stdio://']);
const originalExplicit = process.env.VCP_CODEX_APP_SERVER;
process.env.VCP_CODEX_APP_SERVER = 'explicit-codex.exe';
assert.equal(resolveCodexLaunch({ executable: 'configured-codex.exe' }).source, 'explicit-codex.exe');
if (originalExplicit === undefined) delete process.env.VCP_CODEX_APP_SERVER;
else process.env.VCP_CODEX_APP_SERVER = originalExplicit;
const fake = new FakeChild();
let spawnedEnv = null;
const transport = new CodexAppServerTransport({
    executable: 'codex-app-server.exe',
    env: { VCP_TOOLBOX_API_KEY: 'must-not-reach-codex', VCP_CODEX_RESPONSES_ADAPTER_CAPABILITY: 'loopback-capability' },
    unsetEnv: ['VCP_TOOLBOX_API_KEY'],
    spawnImpl: (_command, _args, options) => {
        spawnedEnv = options.env;
        return fake;
    },
    startTimeoutMs: 2_000,
});
const notifications = [];
transport.on('notification', (message) => notifications.push(message));
await transport.start();
assert.equal(transport.status.ready, true);
assert.equal(transport.status.version, '0.146.0');
assert.equal(spawnedEnv.VCP_TOOLBOX_API_KEY, undefined, 'Codex must not inherit the upstream ToolBox API key');
assert.equal(spawnedEnv.VCP_CODEX_RESPONSES_ADAPTER_CAPABILITY, 'loopback-capability');
const result = await transport.request('thread/start', { model: 'fake' });
assert.equal(result.thread.id, 'thr_1');
assert.equal(notifications[0].method, 'thread/started');

const serverRequest = new Promise((resolve) => transport.once('server-request', resolve));
fake.stdout.write(JSON.stringify({
    id: 'tool-call-1',
    method: 'item/tool/call',
    params: { threadId: 'thr_1', turnId: 'turn_1', callId: 'call_1' },
}) + '\n');
const request = await serverRequest;
assert.equal(request.params.callId, 'call_1');
transport.respond(request.id, { contentItems: [{ type: 'inputText', text: 'ok' }] });
await transport.stop();
assert.equal(transport.status.ready, false);

const obsolete = new FakeChild('Codex Desktop/0.145.0 (fixture)');
const obsoleteTransport = new CodexAppServerTransport({
    executable: 'codex-app-server.exe',
    spawnImpl: () => obsolete,
    startTimeoutMs: 2_000,
});
await assert.rejects(() => obsoleteTransport.start(), (error) => error.code === 'UNSUPPORTED_VERSION');
assert.equal(obsolete.killed, true, 'unsupported App Server must be stopped fail-closed');

// The app-server negotiates the client name into its userAgent prefix
// (`<originator>/<version> ...`) rather than an immutable `Codex/` prefix.
const originatorForm = new FakeChild('vcp_chat/0.146.0 (Windows 10.0.26200; x86_64) unknown (vcp_chat; vcp-chat-codex-agent-0.1.0)');
const originatorTransport = new CodexAppServerTransport({
    executable: 'codex-app-server.exe',
    spawnImpl: () => originatorForm,
    startTimeoutMs: 2_000,
});
await originatorTransport.start();
assert.equal(originatorTransport.status.version, '0.146.0', 'version must be parsed from the echoed originator userAgent');
await originatorTransport.stop();

const obsoleteOriginator = new FakeChild('vcp_chat/0.145.0 (Windows 10.0.26200; x86_64) unknown (vcp_chat; vcp-chat-codex-agent-0.1.0)');
const obsoleteOriginatorTransport = new CodexAppServerTransport({
    executable: 'codex-app-server.exe',
    spawnImpl: () => obsoleteOriginator,
    startTimeoutMs: 2_000,
});
await assert.rejects(() => obsoleteOriginatorTransport.start(), (error) => error.code === 'UNSUPPORTED_VERSION');
assert.equal(obsoleteOriginator.killed, true, 'obsolete originator-form App Server must be stopped fail-closed');

const newerLine = new FakeChild('Codex Desktop/0.147.0 (fixture)');
const pinnedTransport = new CodexAppServerTransport({
    executable: 'codex-app-server.exe',
    supportedVersionLine: '0.146',
    spawnImpl: () => newerLine,
    startTimeoutMs: 2_000,
});
await assert.rejects(() => pinnedTransport.start(), (error) => error.code === 'UNSUPPORTED_PROTOCOL_VERSION');
assert.equal(newerLine.killed, true, 'a server outside the pinned fixture line must stop fail-closed');
console.log('Codex App Server transport tests passed.');
