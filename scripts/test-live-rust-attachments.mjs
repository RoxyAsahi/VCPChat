import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../modules/agent-runtime/rustDaemonTransport');
const repo = path.resolve(import.meta.dirname, '..');
const live = await requireLiveRustEnvironment();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const kind = Buffer.from(type, 'ascii');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([header, kind, data, checksum]);
}

// A valid 32×32 RGBA image: solid VCP blue. It exceeds the imported Grok
// minimum-pixel limit, carries valid chunk CRCs, and lets the vision prompt
// prove that the model request contained the image rather than just text.
function bluePng() {
    const width = 32;
    const height = 32;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((1 + width * 4) * height);
    for (let row = 0; row < height; row += 1) {
        const base = row * (1 + width * 4);
        raw[base] = 0;
        for (let column = 0; column < width; column += 1) {
            const pixel = base + 1 + column * 4;
            raw[pixel] = 35;
            raw[pixel + 1] = 118;
            raw[pixel + 2] = 216;
            raw[pixel + 3] = 255;
        }
    }
    const zlib = require('node:zlib');
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function deferred(label, timeoutMs = 180_000) {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    return {
        promise,
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
    };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-live-image-'));
const settingsPath = path.join(root, 'settings.json');
const imagePath = path.join(root, 'vcp-blue.png');
fs.writeFileSync(settingsPath, JSON.stringify({
    vcpServerUrl: live.serverUrl,
    vcpApiKey: live.apiKey,
    agentRuntime: { tui: { defaultModel: 'gpt-5.6-terra' } },
}), 'utf8');
fs.writeFileSync(imagePath, bluePng());

const imported = deferred('attachment import control result', 30_000);
const completed = deferred('vision turn completion');
const topicRead = deferred('durable topic snapshot');
let answer = '';
const transport = new RustDaemonTransport({
    projectRoot: repo,
    settingsPath,
    agentsDir: path.join(root, 'Agents'),
    workspaceRoot: repo,
    model: 'gpt-5.6-terra',
    agent: 'Nova',
    onMessage(message) {
        if (message.type === 'control-event' && message.requestId === 'live-image-import') {
            imported.resolve(message.payload?.attachment);
        }
        if (message.type === 'control-event' && message.requestId === 'live-image-topic-read') {
            topicRead.resolve(message.payload);
        }
        if (message.type !== 'event') return;
        if (message.event?.type === 'assistant.delta') answer += message.event.payload?.text || '';
        if (message.event?.type === 'turn.completed') completed.resolve(message.event);
        if (message.event?.type === 'turn.failed') completed.reject(new Error(message.event?.payload?.error || 'vision turn failed'));
    },
});

try {
    await transport.start();
    const session = await transport.request('create-session');
    await transport.request('import-attachment', {
        sessionId: session.sessionId,
        path: imagePath,
    }, 'live-image-import');
    const descriptor = await imported.promise;
    assert.equal(descriptor?.mimeType, 'image/png');
    assert.equal(descriptor?.width, 32);
    assert.equal(descriptor?.height, 32);
    assert.match(descriptor?.sha256 || '', /^[0-9a-f]{64}$/i);
    assert.equal('path' in descriptor, false, 'the daemon must not return an OS path to its caller');
    assert.equal(JSON.stringify(descriptor).includes('base64'), false, 'the descriptor must never carry raw image data');

    await transport.request('start-turn', {
        sessionId: session.sessionId,
        turnId: `turn-live-image-${crypto.randomUUID()}`,
        prompt: '只回答这张附图的主颜色（中文或英文），不要调用工具，也不要猜测没有看到的内容。',
        attachments: [descriptor],
    });
    await completed.promise;
    assert.match(answer, /(蓝|blue)/i, `vision reply did not identify the attached blue image: ${answer.slice(0, 500)}`);

    await transport.request('read-topic', { topicId: session.topicId }, 'live-image-topic-read');
    const snapshot = await topicRead.promise;
    const durable = JSON.stringify(snapshot);
    assert.equal(/data:image\/[^;]+;base64,/i.test(durable), false, 'Topic snapshot must not persist data URLs');
    assert.equal(/base64/i.test(durable), false, 'Topic snapshot must not persist raw image encoding');
    assert.match(durable, /assetFile/, 'Topic snapshot retains only the attachment descriptor');
    console.log('Live Rust image attachment passed: import → descriptor → vision response → redaction-safe Topic snapshot.');
} finally {
    await transport.stop();
    fs.rmSync(root, { recursive: true, force: true });
}
