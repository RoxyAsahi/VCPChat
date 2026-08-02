import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const statePath = process.env.VCP_FAKE_CODEX_STATE;
if (!statePath) throw new Error('VCP_FAKE_CODEX_STATE is required');

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
        return { starts: 0, resumes: 0, turnStarts: 0, threads: {} };
    }
}

function saveState(state) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, statePath);
}

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, message) {
    send({ id, error: { code: -32000, message } });
}

const state = loadState();
state.starts += 1;
saveState(state);

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    const { id, method, params = {} } = message;
    if (method === 'initialize') {
        send({ id, result: { userAgent: 'Codex Desktop/0.146.0 (recovery-fixture)' } });
        return;
    }
    if (method === 'thread/start') {
        const threadId = randomUUID();
        state.threads[threadId] = { id: threadId, status: { type: 'idle' }, turns: [] };
        saveState(state);
        send({ id, result: { thread: { id: threadId, status: { type: 'idle' } } } });
        send({ method: 'thread/started', params: { thread: { id: threadId, status: { type: 'idle' } } } });
        return;
    }
    if (method === 'thread/resume') {
        const thread = state.threads[params.threadId];
        if (!thread) {
            rpcError(id, `Thread not found: ${params.threadId}`);
            return;
        }
        state.resumes += 1;
        saveState(state);
        send({ id, result: { thread: { id: thread.id, status: thread.status } } });
        return;
    }
    if (method === 'thread/read') {
        const thread = state.threads[params.threadId];
        if (!thread) {
            rpcError(id, `Thread not found: ${params.threadId}`);
            return;
        }
        send({ id, result: { thread } });
        return;
    }
    if (method === 'turn/start') {
        const thread = state.threads[params.threadId];
        if (!thread) {
            rpcError(id, `Thread not found: ${params.threadId}`);
            return;
        }
        const turnId = randomUUID();
        const userItemId = params.clientUserMessageId || randomUUID();
        thread.turns.push({
            id: turnId,
            status: 'inProgress',
            items: [{
                id: userItemId,
                clientUserMessageId: params.clientUserMessageId || null,
                type: 'userMessage',
                status: 'completed',
                content: Array.isArray(params.input) ? params.input : [],
            }],
        });
        thread.status = { type: 'active' };
        state.turnStarts += 1;
        saveState(state);
        send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
        send({ method: 'turn/started', params: { threadId: thread.id, turn: { id: turnId, status: 'inProgress' } } });
        send({
            id: `interaction-${turnId}`,
            method: 'item/tool/requestUserInput',
            params: {
                threadId: thread.id,
                turnId,
                itemId: `item-${turnId}`,
                questions: [{ id: 'continue', header: 'Continue', question: 'Continue?', options: [] }],
            },
        });
        return;
    }
    if (method === 'turn/interrupt') {
        send({ id, result: {} });
        return;
    }
    rpcError(id, `Unsupported recovery fixture method: ${method}`);
});

