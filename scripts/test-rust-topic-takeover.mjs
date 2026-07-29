import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RustDaemonTransport } from '../modules/agent-runtime/rustDaemonTransport.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-agent-topic-takeover-'));
const appData = path.join(root, 'AppData');
const settingsPath = path.join(appData, 'settings.json');
const agentsDir = path.join(appData, 'Agents');
const topicId = 'takeover-source';

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function options(onMessage, resume) {
    return {
        projectRoot: repo,
        settingsPath,
        agentsDir,
        workspaceRoot: repo,
        model: 'gpt-5.6-terra',
        agent: 'Nova',
        resume,
        onMessage,
    };
}

async function waitFor(predicate, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(200);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

let owner;
let requester;
let claimant;
try {
    await fs.mkdir(path.join(agentsDir, 'Nova'), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({
        vcpServerUrl: 'http://127.0.0.1:9',
        vcpApiKey: 'test-only-placeholder',
        agentRuntime: { tui: { defaultModel: 'gpt-5.6-terra', defaultAgentId: 'Nova' } },
    }), 'utf8');
    await fs.writeFile(path.join(agentsDir, 'Nova', 'config.json'), JSON.stringify({
        name: 'Nova', model: 'gpt-5.6-terra', systemPrompt: '{{Nova}}',
    }), 'utf8');

    // A visible Topic is always a checkpoint.  Seed one without a model call
    // so this concurrency test remains hermetic and never reaches ToolBox.
    const topicDirectory = path.join(appData, 'UserData', 'nova', 'topics', topicId);
    await fs.mkdir(topicDirectory, { recursive: true });
    await fs.writeFile(path.join(topicDirectory, 'agent-state.json'), JSON.stringify({
        version: 1,
        title: '接管测试 Topic',
        snapshot: { version: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '保留的 checkpoint' }] }] },
        usage: null,
        workspaceRef: repo,
        model: 'gpt-5.6-terra',
        updatedAt: Date.now(),
    }), 'utf8');
    await fs.writeFile(path.join(topicDirectory, 'history.json'), JSON.stringify([
        { id: 'history-user', role: 'user', content: '保留的 checkpoint', timestamp: Date.now() },
    ]), 'utf8');

    owner = new RustDaemonTransport(options(() => {}, topicId));
    await owner.start();
    const ownerSession = await owner.request('create-session');
    assert.equal(ownerSession.topicId, topicId, 'first daemon must own the source Topic');

    const requesterEvents = [];
    requester = new RustDaemonTransport(options((message) => {
        if (message.type === 'control-event') requesterEvents.push(message);
    }));
    await requester.start();
    await requester.request('takeover-topic', { topicId });
    await waitFor(
        () => requesterEvents.some((message) => message.kind === 'topic-takeover-pending' && message.payload?.topicId === topicId),
        'the cooperative takeover request acknowledgement',
    );

    // The owner observes the request during its bounded lease heartbeat,
    // cancels/checkpoints any active work, and releases.  Until then no second
    // daemon may acquire the Topic, so this is a real single-writer test.
    const sourceReleased = await waitFor(async () => {
        requesterEvents.length = 0;
        await requester.request('list-topics');
        await sleep(20);
        const topics = requesterEvents
            .filter((message) => message.kind === 'topics')
            .flatMap((message) => Array.isArray(message.payload) ? message.payload : []);
        const topic = topics.find((item) => item.id === topicId);
        return topic?.inUse ? null : topic;
    }, 'the original owner to checkpoint and release the Topic');
    assert.equal(sourceReleased.id, topicId);

    await requester.stop();
    requester = null;
    claimant = new RustDaemonTransport(options(() => {}, topicId));
    await claimant.start();
    const claimedSession = await claimant.request('create-session');
    assert.equal(claimedSession.topicId, topicId, 'a replacement daemon must acquire the released Topic');
} finally {
    await claimant?.stop();
    await requester?.stop();
    await owner?.stop();
    await fs.rm(root, { recursive: true, force: true });
}

console.log('Rust daemon cooperative Topic takeover test passed.');
