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
        return { starts: 0, resumes: 0, turnStarts: 0, archives: 0, unarchives: 0, deletes: 0, threads: {} };
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

function inputText(input) {
    return (Array.isArray(input) ? input : [])
        .map((part) => String(part?.text || ''))
        .filter(Boolean)
        .join('\n');
}

function projectionItems(turnId, prompt) {
    const safePrompt = String(prompt || 'fixture turn').slice(0, 1_000);
    return {
        reasoning: {
            id: `reasoning-${turnId}`,
            type: 'reasoning',
            status: 'completed',
            summary: [`reasoning-summary:${safePrompt}`],
            content: [`reasoning-content:${safePrompt}`],
        },
        tool: {
            id: `tool-${turnId}`,
            type: 'dynamicToolCall',
            status: 'completed',
            tool: 'vcp_invoke',
            arguments: {
                tool: 'FileOperator',
                arguments: { command: 'ReadFile', filePath: `${safePrompt}.txt` },
            },
            contentItems: [{ type: 'inputText', text: `tool-result:${safePrompt}` }],
            success: true,
        },
        assistant: {
            id: `assistant-${turnId}`,
            type: 'agentMessage',
            status: 'completed',
            text: `assistant-result:${safePrompt}`,
        },
    };
}

function projectionBurstItems(turnId, prompt) {
    const safePrompt = String(prompt || 'fixture burst').slice(0, 1_000);
    const batchSizes = [3, 1, 2, 3, 2];
    const sequence = [];
    let toolIndex = 0;
    for (let assistantIndex = 0; assistantIndex < batchSizes.length + 1; assistantIndex += 1) {
        sequence.push({
            id: `assistant-${turnId}-${assistantIndex + 1}`,
            type: 'agentMessage', status: 'completed',
            text: `assistant-part-${assistantIndex + 1}:${safePrompt}`,
        });
        if (assistantIndex >= batchSizes.length) continue;
        for (let index = 0; index < batchSizes[assistantIndex]; index += 1) {
            toolIndex += 1;
            sequence.push({
                id: `tool-${turnId}-${toolIndex}`,
                type: 'dynamicToolCall', status: 'completed', tool: 'vcp_invoke',
                arguments: {
                    tool: 'FileOperator',
                    arguments: { command: 'ReadFile', filePath: `${safePrompt}-${toolIndex}.txt` },
                },
                contentItems: [{ type: 'inputText', text: `tool-result:${safePrompt}:${toolIndex}` }],
                success: true,
            });
        }
    }
    return {
        reasoning: {
            id: `reasoning-${turnId}`,
            type: 'reasoning', status: 'completed',
            summary: [`reasoning-summary:${safePrompt}`],
            content: [`reasoning-content:${safePrompt}`],
        },
        sequence,
    };
}

function emitProjectionItemLifecycle(thread, turnId, item) {
    const common = { threadId: thread.id, turnId };
    if (item.type === 'dynamicToolCall') {
        send({ method: 'item/started', params: { ...common, item: { ...item, status: 'inProgress', contentItems: [] } } });
        send({ method: 'item/tool/call', params: {
            ...common, itemId: item.id, callId: item.id,
            tool: item.tool, arguments: item.arguments,
        } });
        send({ method: 'item/completed', params: { ...common, item } });
        return;
    }
    send({ method: 'item/started', params: { ...common, item: { ...item, status: 'inProgress', text: '' } } });
    send({ method: 'item/agentMessage/delta', params: {
        threadId: thread.id, itemId: item.id, delta: item.text,
    } });
    send({ method: 'item/completed', params: { ...common, item } });
}

function emitProjectionLifecycle(thread, turnId, items) {
    const common = { threadId: thread.id, turnId };
    send({ method: 'item/started', params: { ...common, item: { ...items.reasoning, status: 'inProgress', summary: [], content: [] } } });
    send({ method: 'item/reasoning/summaryPartAdded', params: {
        threadId: thread.id, itemId: items.reasoning.id, summaryIndex: 0,
    } });
    send({ method: 'item/reasoning/summaryTextDelta', params: {
        threadId: thread.id, itemId: items.reasoning.id, summaryIndex: 0, delta: items.reasoning.summary[0],
    } });
    send({ method: 'item/reasoning/textDelta', params: {
        threadId: thread.id, itemId: items.reasoning.id, contentIndex: 0, delta: items.reasoning.content[0],
    } });
    send({ method: 'item/completed', params: { ...common, item: items.reasoning } });

    emitProjectionItemLifecycle(thread, turnId, items.tool);
    emitProjectionItemLifecycle(thread, turnId, items.assistant);
}

function emitBurstProjectionLifecycle(thread, turnId, items) {
    const common = { threadId: thread.id, turnId };
    send({ method: 'item/started', params: { ...common, item: { ...items.reasoning, status: 'inProgress', summary: [], content: [] } } });
    send({ method: 'item/reasoning/summaryPartAdded', params: {
        threadId: thread.id, itemId: items.reasoning.id, summaryIndex: 0,
    } });
    send({ method: 'item/reasoning/summaryTextDelta', params: {
        threadId: thread.id, itemId: items.reasoning.id, summaryIndex: 0, delta: items.reasoning.summary[0],
    } });
    send({ method: 'item/reasoning/textDelta', params: {
        threadId: thread.id, itemId: items.reasoning.id, contentIndex: 0, delta: items.reasoning.content[0],
    } });
    send({ method: 'item/completed', params: { ...common, item: items.reasoning } });
    for (const item of items.sequence) emitProjectionItemLifecycle(thread, turnId, item);
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
    if (!method) return;
    if (method === 'initialize') {
        send({ id, result: { userAgent: 'Codex Desktop/0.146.0 (recovery-fixture)' } });
        return;
    }
    if (method === 'thread/start') {
        const threadId = randomUUID();
        state.threads[threadId] = {
            id: threadId,
            status: { type: 'idle' },
            archived: false,
            turns: [],
            settings: {
                cwd: params.cwd ?? null,
                model: params.model ?? null,
                approvalPolicy: params.approvalPolicy ?? null,
                effort: null,
                personality: params.personality ?? null,
            },
        };
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
        const current = thread.settings || {};
        thread.settings = {
            ...current,
            cwd: params.cwd ?? current.cwd ?? null,
            model: params.model ?? current.model ?? null,
            approvalPolicy: params.approvalPolicy ?? current.approvalPolicy ?? null,
        };
        saveState(state);
        send({
            id,
            result: {
                thread: { id: thread.id, status: thread.status },
                cwd: thread.settings.cwd,
                model: thread.settings.model,
                approvalPolicy: thread.settings.approvalPolicy,
                reasoningEffort: thread.settings.effort ?? null,
            },
        });
        return;
    }
    if (method === 'thread/settings/update') {
        const thread = state.threads[params.threadId];
        if (!thread) {
            rpcError(id, `Thread not found: ${params.threadId}`);
            return;
        }
        thread.settings = {
            cwd: params.cwd ?? null,
            model: params.model ?? null,
            approvalPolicy: params.approvalPolicy ?? null,
            effort: params.effort ?? null,
            personality: params.personality ?? null,
        };
        saveState(state);
        send({ id, result: {} });
        send({
            method: 'thread/settings/updated',
            params: { threadId: thread.id, threadSettings: thread.settings },
        });
        return;
    }
    if (method === 'thread/read') {
        const thread = state.threads[params.threadId];
        if (!thread) {
            rpcError(id, `Thread not found: ${params.threadId}`);
            return;
        }
        const visibleThread = JSON.parse(JSON.stringify(thread));
        if (process.env.VCP_FAKE_CODEX_OMIT_TOOLS_ON_READ === '1') {
            for (const turn of visibleThread.turns || []) {
                turn.items = (turn.items || []).filter((item) => item.type !== 'dynamicToolCall');
            }
        }
        if (process.env.VCP_FAKE_CODEX_OMIT_REASONING_ON_READ === '1') {
            for (const turn of visibleThread.turns || []) {
                turn.items = (turn.items || []).filter((item) => item.type !== 'reasoning');
            }
        }
        if (process.env.VCP_FAKE_CODEX_REWRITE_ITEMS_ON_READ === '1') {
            for (const turn of visibleThread.turns || []) {
                turn.items = (turn.items || []).map((item, index) => ({
                    ...item,
                    id: `history-${turn.id}-${index}`,
                }));
            }
        }
        send({ id, result: { thread: visibleThread } });
        if (thread.archived) {
            send({
                id: `archived-interaction-${thread.id}`,
                method: 'item/tool/requestUserInput',
                params: {
                    threadId: thread.id,
                    turnId: null,
                    itemId: `archived-item-${thread.id}`,
                    questions: [{ id: 'confirm', header: 'Archived', question: 'Resolve before deletion?', options: [] }],
                },
            });
        }
        return;
    }
    if (method === 'thread/list') {
        const data = Object.values(state.threads).filter((thread) => thread.archived === (params.archived === true));
        send({ id, result: { data, nextCursor: null } });
        return;
    }
    if (method === 'thread/archive') {
        const thread = state.threads[params.threadId];
        if (!thread) return rpcError(id, `Thread not found: ${params.threadId}`);
        thread.archived = true;
        state.archives = Number(state.archives || 0) + 1;
        saveState(state);
        send({ id, result: {} });
        return;
    }
    if (method === 'thread/unarchive') {
        const thread = state.threads[params.threadId];
        if (!thread) return rpcError(id, `Thread not found: ${params.threadId}`);
        thread.archived = false;
        state.unarchives = Number(state.unarchives || 0) + 1;
        saveState(state);
        send({ id, result: { thread: { id: thread.id } } });
        return;
    }
    if (method === 'thread/delete') {
        if (!state.threads[params.threadId]) return rpcError(id, `Thread not found: ${params.threadId}`);
        delete state.threads[params.threadId];
        state.deletes = Number(state.deletes || 0) + 1;
        saveState(state);
        send({ id, result: {} });
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
        const userItem = {
            id: userItemId,
            clientUserMessageId: params.clientUserMessageId || null,
            type: 'userMessage',
            status: 'completed',
            content: Array.isArray(params.input) ? params.input : [],
        };
        const prompt = inputText(params.input);
        const burstPrompt = String(process.env.VCP_FAKE_CODEX_TOOL_BURST_ON_PROMPT || '');
        const burst = Boolean(burstPrompt && prompt.includes(burstPrompt));
        const items = burst ? projectionBurstItems(turnId, prompt) : projectionItems(turnId, prompt);
        thread.turns.push({
            id: turnId,
            status: 'inProgress',
            itemsView: 'full',
            items: burst
                ? [userItem, items.reasoning, ...items.sequence]
                : [userItem, items.reasoning, items.tool, items.assistant],
        });
        thread.status = { type: 'active' };
        state.turnStarts += 1;
        saveState(state);
        send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
        send({ method: 'turn/started', params: { threadId: thread.id, turn: { id: turnId, status: 'inProgress' } } });
        send({ method: 'item/started', params: { threadId: thread.id, turnId, item: userItem } });
        send({ method: 'item/completed', params: { threadId: thread.id, turnId, item: userItem } });
        if (burst) emitBurstProjectionLifecycle(thread, turnId, items);
        else emitProjectionLifecycle(thread, turnId, items);
        if (process.env.VCP_FAKE_CODEX_AUTO_COMPLETE_TURNS === '1') {
            const turn = thread.turns.find((candidate) => candidate.id === turnId);
            if (turn) turn.status = 'completed';
            thread.status = { type: 'idle' };
            saveState(state);
            send({ method: 'thread/status/changed', params: {
                threadId: thread.id, status: { type: 'idle' },
            } });
            send({ method: 'turn/completed', params: {
                threadId: thread.id, turn: { id: turnId, status: 'completed' },
            } });
            return;
        }
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
