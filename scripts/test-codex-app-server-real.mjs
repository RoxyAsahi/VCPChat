import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexRuntimeManager } = require('../modules/codex-runtime/runtimeManager.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-app-server-real-'));
const options = {
    projectRoot: path.resolve(import.meta.dirname, '..'),
    settingsPath: path.join(root, 'settings.json'),
    getSettings: () => ({}),
};
let manager = new CodexRuntimeManager(options);
let recoveredManager = null;

try {
    await manager.start();
    const topic = await manager.createSessionRecord({
        agentId: 'codex',
        title: 'Codex App Server hermetic smoke A',
        workspaceRoot: path.resolve(import.meta.dirname, '..'),
    });
    const secondTopic = await manager.createSessionRecord({
        agentId: 'codex',
        title: 'Codex App Server hermetic smoke B',
        workspaceRoot: path.resolve(import.meta.dirname, '..'),
    });
    const [session, secondSession] = await Promise.all([
        manager.createSession({ sessionId: topic.sessionId }),
        manager.createSession({ sessionId: secondTopic.sessionId }),
    ]);
    assert.match(session.threadId, /^[0-9a-f-]{36}$/i);
    assert.match(secondSession.threadId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(session.threadId, secondSession.threadId, 'parallel VChat Sessions must not share a Codex Thread');
    const [projection, secondProjection] = await Promise.all([
        manager.readSession({ sessionId: topic.sessionId }),
        manager.readSession({ sessionId: secondTopic.sessionId }),
    ]);
    assert.equal(projection.messages.length, 0);
    assert.equal(secondProjection.messages.length, 0);
    assert.equal(projection.session.orphaned, false, 'an empty, newly started Thread is not orphaned');
    assert.equal(secondProjection.session.orphaned, false, 'a second empty Thread is not orphaned');
    const runtimes = manager.getStatus().runtimes;
    assert.equal(runtimes.filter((runtime) => [session.threadId, secondSession.threadId].includes(runtime.threadId)).length, 2);
    // App Server state is process-local. A replacement process must issue
    // thread/resume before it can safely write to a persisted VChat Session;
    // read-only SQLite/Thread projection alone is not a live subscription.
    await manager.stop();
    recoveredManager = new CodexRuntimeManager(options);
    await recoveredManager.start();
    const resumedSession = await recoveredManager.createSession({ sessionId: topic.sessionId });
    assert.notEqual(resumedSession.threadId, session.threadId,
        'an empty pre-turn Thread is not yet a persisted rollout and must be safely recreated');
    const resumedProjection = await recoveredManager.readSession({ sessionId: topic.sessionId });
    assert.equal(resumedProjection.session.orphaned, false);
    console.log(JSON.stringify({
        runtime: recoveredManager.getStatus().runtime,
        executable: recoveredManager.getStatus().worker?.executable || null,
        threadId: session.threadId,
        secondThreadId: secondSession.threadId,
        concurrentEmptyThreadRead: 'passed',
        unmaterializedThreadRecreated: 'passed',
    }));
} finally {
    await recoveredManager?.stop().catch(() => null);
    await manager.stop().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
}
