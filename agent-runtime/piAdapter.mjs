// Pi adapter: embeds @earendil-works/pi-agent-core in the worker process.
//
// Model traffic goes through a custom streamFn that talks to the VCPToolBox
// OpenAI-compatible /v1/chat/completions endpoint, so no provider key is ever
// required in this process beyond the VCP key supplied by the main process.
// Pi built-in file/bash tools are NOT registered. Real execution goes through
// VCPToolBox via vcp_invoke; only the reviewable patch workflow and orchestration
// controls remain as VCPChat runtime tools.

import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

const VCP_DELEGATE = 'vcp_delegate';
const VCP_INVOKE = 'vcp_invoke';

const RUNTIME_TOOL_DEFINITIONS = [
    ['workspace_propose_patch', 'Create a reviewable workspace patch. Reading the base file is delegated to VCP FileOperator.', Type.Object({ path: Type.String(), content: Type.String() })],
    ['workspace_apply_patch', 'Apply an approved patch proposal through VCP FileOperator.', Type.Object({ proposalId: Type.String() })],
    ['workspace_revert_patch', 'Revert an applied patch through VCP FileOperator after approval.', Type.Object({ proposalId: Type.String() })],
    ['spawn_agent', 'Spawn a budgeted child Pi session through the Main coordinator.', Type.Object({ prompt: Type.String(), title: Type.Optional(Type.String()), model: Type.Optional(Type.String()), budget: Type.Optional(Type.Object({ timeMs: Type.Optional(Type.Number({ minimum: 0 })), tokens: Type.Optional(Type.Number({ minimum: 0 })), cost: Type.Optional(Type.Number({ minimum: 0 })) })) })],
    ['await_agent', 'Await a child agent task.', Type.Object({ taskId: Type.String() })],
    ['cancel_agent', 'Cancel a child agent task and its descendants.', Type.Object({ taskId: Type.String(), reason: Type.Optional(Type.String()) })],
];

function makeVcpModel(config) {
    return {
        id: config.model || 'vcp-default',
        name: config.model || 'vcp-default',
        api: 'openai-completions',
        provider: 'vcp',
        baseUrl: config.baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow || 128000,
        maxTokens: config.maxTokens || 8192,
    };
}

function toOpenAiMessages(messages) {
    const output = [];
    for (const message of messages) {
        if (message.role === 'user') {
            const text = typeof message.content === 'string'
                ? message.content
                : (message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
            output.push({ role: 'user', content: text });
        } else if (message.role === 'assistant') {
            const textParts = [];
            const toolCalls = [];
            for (const part of message.content || []) {
                if (part.type === 'text') {
                    textParts.push(part.text);
                } else if (part.type === 'toolCall') {
                    toolCalls.push({
                        id: part.id,
                        type: 'function',
                        function: { name: part.name, arguments: JSON.stringify(part.arguments || {}) },
                    });
                }
            }
            const entry = { role: 'assistant', content: textParts.join('\n') || null };
            if (toolCalls.length > 0) {
                entry.tool_calls = toolCalls;
            }
            output.push(entry);
        } else if (message.role === 'toolResult') {
            const text = (message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
            output.push({
                role: 'tool',
                tool_call_id: message.toolCallId,
                content: message.isError ? `[error] ${text}` : text,
            });
        }
    }
    return output;
}

function toOpenAiTools(tools) {
    return (tools || []).map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.parameters || { type: 'object', properties: {} },
        },
    }));
}

function emptyUsage() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function textContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
}

function safeInitialMessages(messages, summary) {
    const transcript = [];
    if (typeof summary === 'string' && summary.trim()) {
        transcript.push({ role: 'user', content: `[Previous conversation summary]\n${summary.trim()}`, timestamp: Date.now() });
    }
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || message.compacted || (message.role !== 'user' && message.role !== 'assistant')) continue;
        const text = textContent(message.content);
        if (!text) continue;
        if (message.role === 'user') {
            transcript.push({ role: 'user', content: text, timestamp: Number(message.createdAt) || Date.now() });
        } else {
            transcript.push({
                role: 'assistant',
                content: [{ type: 'text', text }],
                api: 'openai-completions',
                provider: 'vcp',
                model: String(message.metadata?.model || 'vcp-restored'),
                usage: emptyUsage(),
                stopReason: 'stop',
                timestamp: Number(message.createdAt) || Date.now(),
            });
        }
    }
    return transcript;
}

function parseArguments(value) {
    if (!value) return {};
    try {
        return JSON.parse(value);
    } catch (error) {
        return {};
    }
}

function toUsage(usage) {
    if (!usage) return emptyUsage();
    return {
        ...emptyUsage(),
        input: usage.prompt_tokens || usage.input || 0,
        output: usage.completion_tokens || usage.output || 0,
        reasoning: usage.completion_tokens_details?.reasoning_tokens || usage.reasoning,
        totalTokens: usage.total_tokens || usage.totalTokens || 0,
    };
}

function createVcpStreamFn(requestModel) {
    return async function vcpStreamFn(model, context, options) {
        const stream = createAssistantMessageEventStream();
        const signal = options && options.signal;
        const body = {
            model: model.id,
            messages: [
                ...(context.systemPrompt ? [{ role: 'system', content: context.systemPrompt }] : []),
                ...toOpenAiMessages(context.messages || []),
            ],
            stream: true,
            stream_options: { include_usage: true },
        };
        const openAiTools = toOpenAiTools(context.tools);
        if (openAiTools.length > 0) {
            body.tools = openAiTools;
            body.tool_choice = 'auto';
        }

        const makeMessage = (overrides) => ({
            role: 'assistant', content: [], api: model.api, provider: model.provider,
            model: model.id, usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now(),
            ...overrides,
        });

        (async () => {
            const partial = makeMessage({ content: [] });
            const toolBlocks = new Map();
            let textBlock = null;
            let thinkingBlock = null;
            let finishReason = 'stop';
            let usage = null;
            stream.push({ type: 'start', partial });

            const ensureText = () => {
                if (!textBlock) {
                    textBlock = { type: 'text', text: '' };
                    partial.content.push(textBlock);
                    stream.push({ type: 'text_start', contentIndex: partial.content.indexOf(textBlock), partial });
                }
                return textBlock;
            };
            const ensureThinking = () => {
                if (!thinkingBlock) {
                    thinkingBlock = { type: 'thinking', thinking: '' };
                    partial.content.push(thinkingBlock);
                    stream.push({ type: 'thinking_start', contentIndex: partial.content.indexOf(thinkingBlock), partial });
                }
                return thinkingBlock;
            };
            const applyDelta = (delta = {}) => {
                if (delta.content) {
                    const block = ensureText();
                    block.text += delta.content;
                    stream.push({ type: 'text_delta', contentIndex: partial.content.indexOf(block), delta: delta.content, partial });
                }
                const reasoning = delta.reasoning_content || delta.reasoning || delta.reasoning_text;
                if (reasoning) {
                    const block = ensureThinking();
                    block.thinking += reasoning;
                    stream.push({ type: 'thinking_delta', contentIndex: partial.content.indexOf(block), delta: reasoning, partial });
                }
                for (const call of delta.tool_calls || []) {
                    const key = Number.isInteger(call.index) ? call.index : (call.id || toolBlocks.size);
                    let block = toolBlocks.get(key);
                    if (!block) {
                        block = {
                            type: 'toolCall', id: call.id || '', name: call.function?.name || '',
                            arguments: {}, partialArgs: '',
                        };
                        toolBlocks.set(key, block);
                        partial.content.push(block);
                        stream.push({ type: 'toolcall_start', contentIndex: partial.content.indexOf(block), partial });
                    }
                    if (call.id) block.id = call.id;
                    // OpenAI-compatible SSE providers commonly repeat the complete
                    // function name on every chunk.  Unlike argument text, it is
                    // not a delta, so appending it turns `vcp_invoke` into
                    // `vcp_invokevcp_invoke` and makes Pi look up a non-existent tool.
                    if (call.function?.name && !block.name) block.name = call.function.name;
                    const argumentDelta = call.function?.arguments || '';
                    block.partialArgs += argumentDelta;
                    block.arguments = parseArguments(block.partialArgs);
                    stream.push({ type: 'toolcall_delta', contentIndex: partial.content.indexOf(block), delta: argumentDelta, partial });
                }
            };
            const finish = () => {
                if (textBlock) stream.push({ type: 'text_end', contentIndex: partial.content.indexOf(textBlock), content: textBlock.text, partial });
                if (thinkingBlock) stream.push({ type: 'thinking_end', contentIndex: partial.content.indexOf(thinkingBlock), content: thinkingBlock.thinking, partial });
                for (const block of toolBlocks.values()) {
                    block.arguments = parseArguments(block.partialArgs);
                    delete block.partialArgs;
                    if (!block.id) block.id = `call_${Date.now()}_${partial.content.indexOf(block)}`;
                    stream.push({ type: 'toolcall_end', contentIndex: partial.content.indexOf(block), toolCall: block, partial });
                }
                partial.usage = toUsage(usage);
                const reason = toolBlocks.size > 0 || finishReason === 'tool_calls'
                    ? 'toolUse' : (finishReason === 'length' ? 'length' : 'stop');
                partial.stopReason = reason;
                stream.push({ type: 'done', reason, message: partial });
            };

            let modelResult;
            try {
                modelResult = await requestModel(body, signal, (event) => {
                    if (event.type === 'delta') applyDelta(event.delta);
                    if (event.type === 'done') {
                        usage = event.usage || usage;
                        finishReason = event.finishReason || finishReason;
                    }
                });
            } catch (error) {
                const aborted = signal && signal.aborted;
                stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: makeMessage({ stopReason: aborted ? 'aborted' : 'error', errorMessage: error.message }) });
                return;
            }
            if (!modelResult || modelResult.ok === false) {
                const aborted = Boolean(modelResult?.cancelled || signal?.aborted);
                stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: makeMessage({ stopReason: aborted ? 'aborted' : 'error', errorMessage: modelResult?.error || 'VCP model gateway failed' }) });
                return;
            }
            if (!modelResult.streamed) {
                const data = modelResult.data || {};
                const choice = data.choices?.[0] || {};
                const message = choice.message || {};
                applyDelta({
                    content: message.content,
                    reasoning_content: message.reasoning_content,
                    tool_calls: message.tool_calls,
                });
                usage = data.usage;
                finishReason = choice.finish_reason || finishReason;
            } else {
                usage = modelResult.usage || usage;
                finishReason = modelResult.finishReason || finishReason;
            }
            finish();
        })();

        return stream;
    };
}

function buildBridgeTools(getRequestTool) {
    const runtimeTools = RUNTIME_TOOL_DEFINITIONS.map(([name, description, parameters]) => ({
        name,
        label: name,
        description,
        parameters,
        executionMode: 'sequential',
        execute: async (toolCallId, params, signal, onUpdate) => {
            const result = await getRequestTool()({ toolCallId, toolName: name, arguments: params, signal, onUpdate });
            const text = result.ok ? JSON.stringify(result.output) : `[${name} failed] ${result.error}`;
            return { content: [{ type: 'text', text }], details: { ok: result.ok, audit: result.audit } };
        },
    }));
    return [
        {
            name: VCP_DELEGATE,
            label: 'VCP Delegate',
            description:
                'Delegate a task to the VCPToolBox agent toolchain. The ToolBox will select and run '
                + 'the appropriate plugins and return the final result. Use only as a compatibility fallback '
                + 'when a direct vcp_invoke call cannot be selected. High-risk actions require human approval.',
            parameters: Type.Object({
                task: Type.String({ description: 'Natural language task for the VCPToolBox agent loop.' }),
                context: Type.Optional(Type.String({ description: 'Additional context for the task.' })),
            }),
            executionMode: 'sequential',
            execute: async (toolCallId, params, signal, onUpdate) => {
                const result = await getRequestTool()({
                    toolCallId,
                    toolName: VCP_DELEGATE,
                    arguments: { task: params.task, context: params.context },
                    signal,
                    onUpdate,
                });
                return {
                    content: [{ type: 'text', text: result.ok ? String(result.output) : `[vcp_delegate failed] ${result.error}` }],
                    details: { ok: result.ok, audit: result.audit },
                };
            },
        },
        {
            name: VCP_INVOKE,
            label: 'VCP Invoke',
            description:
                'Directly invoke a named VCPToolBox tool/plugin with structured arguments. '
                + 'Only use tool names that are known to exist on the connected ToolBox. '
                + 'High-risk tools require human approval.',
            parameters: Type.Object({
                toolName: Type.String({ description: 'VCPToolBox tool/plugin name, e.g. FileOperator.' }),
                arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
                reason: Type.Optional(Type.String({ description: 'Why this tool is needed.' })),
            }),
            executionMode: 'sequential',
            execute: async (toolCallId, params, signal, onUpdate) => {
                const result = await getRequestTool()({
                    toolCallId,
                    toolName: VCP_INVOKE,
                    arguments: {
                        toolName: params.toolName,
                        arguments: params.arguments || {},
                        reason: params.reason,
                    },
                    signal,
                    onUpdate,
                });
                return {
                    content: [{ type: 'text', text: result.ok ? String(result.output) : `[vcp_invoke failed] ${result.error}` }],
                    details: { ok: result.ok, audit: result.audit },
                };
            },
        },
        ...runtimeTools,
    ];
}

const sessions = new Map();

export function createPiAdapter() {
    return {
        kind: 'pi',

        async probe() {
            const info = {
                available: false,
                runtime: 'pi',
                node: process.version,
                piAgentCore: null,
                details: '',
            };
            try {
                const pkg = await import('@earendil-works/pi-agent-core/package.json', { with: { type: 'json' } });
                info.piAgentCore = pkg.default.version;
                const majorNode = Number(process.versions.node.split('.')[0]);
                const minorNode = Number(process.versions.node.split('.')[1]);
                if (majorNode < 22 || (majorNode === 22 && minorNode < 19)) {
                    info.details = `Node ${process.versions.node} < 22.19.0`;
                    return info;
                }
                info.available = true;
                info.details = 'pi-agent-core importable; model streamFn provided by VCP bridge';
                return info;
            } catch (error) {
                info.details = `pi import failed: ${error.message}`;
                return info;
            }
        },

        async createSession(sessionId, options = {}) {
            const vcp = options.vcp || {};
            if (typeof options.createRequestTool !== 'function') {
                throw new Error('pi session requires a createRequestTool bridge');
            }
            if (typeof options.createRequestModel !== 'function') {
                throw new Error('pi session requires a createRequestModel bridge');
            }
            const sessionState = { requestTool: null, requestModel: null };
            const agent = new Agent({
                streamFn: createVcpStreamFn((body, signal, onEvent) => {
                    if (!sessionState.requestModel) {
                        throw new Error('model bridge not bound to an active turn');
                    }
                    return sessionState.requestModel(body, signal, onEvent);
                }),
                initialState: {
                    systemPrompt: options.systemPrompt
                        || 'You are the VCPChat agent. Use vcp_invoke for real-world actions and vcp_delegate only as a compatibility fallback. Never claim an action succeeded without a tool result.',
                    model: makeVcpModel({
                        model: vcp.model || 'vcp-default',
                        baseUrl: 'main-process://vcp-model-gateway',
                    }),
                    messages: safeInitialMessages(options.messages, options.summary),
                    tools: buildBridgeTools(() => {
                        if (!sessionState.requestTool) {
                            throw new Error('tool bridge not bound to an active turn');
                        }
                        return sessionState.requestTool;
                    }),
                },
                toolExecution: 'sequential',
            });
            sessions.set(sessionId, {
                agent,
                turnTasks: new Map(),
                createRequestTool: options.createRequestTool,
                createRequestModel: options.createRequestModel,
                sessionState,
            });
            return { ok: true };
        },

        async runTurn({ sessionId, turnId, prompt, emitEvent }) {
            const session = sessions.get(sessionId);
            if (!session) {
                throw new Error(`unknown session: ${sessionId}`);
            }
            const { agent } = session;
            session.sessionState.requestTool = session.createRequestTool(turnId);
            session.sessionState.requestModel = session.createRequestModel(turnId);
            let assistantMessageIndex = 0;
            let assistantMessageId = null;
            const emitAssistantEvent = (type, payload = {}) => {
                if (!assistantMessageId) {
                    assistantMessageIndex += 1;
                    assistantMessageId = `msg_${turnId}_${assistantMessageIndex}`;
                }
                emitEvent({ type, turnId, messageId: assistantMessageId, payload });
            };
            const unsubscribe = agent.subscribe((event) => {
                if (event.type === 'message_update' && event.assistantMessageEvent) {
                    const sub = event.assistantMessageEvent;
                    if (sub.type === 'text_delta') {
                        emitAssistantEvent('assistant.delta', { text: sub.delta });
                    } else if (sub.type === 'thinking_start') {
                        emitAssistantEvent('reasoning.started');
                    } else if (sub.type === 'thinking_delta') {
                        emitAssistantEvent('reasoning.delta', { text: sub.delta });
                    } else if (sub.type === 'thinking_end') {
                        emitAssistantEvent('reasoning.completed');
                    }
                } else if (event.type === 'message_start' && event.message?.role === 'assistant') {
                    assistantMessageIndex += 1;
                    assistantMessageId = `msg_${turnId}_${assistantMessageIndex}`;
                    emitAssistantEvent('assistant.started');
                } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
                    emitAssistantEvent('assistant.completed', { message: event.message, usage: event.message?.usage });
                    assistantMessageId = null;
                } else if (event.type === 'tool_execution_start') {
                    emitEvent({
                        type: 'tool.started',
                        turnId,
                        payload: { toolCallId: event.toolCallId, toolName: event.toolName, arguments: event.args },
                    });
                } else if (event.type === 'tool_execution_update') {
                    emitEvent({
                        type: 'tool.progress',
                        turnId,
                        payload: { toolCallId: event.toolCallId, toolName: event.toolName, update: event.partialResult },
                    });
                } else if (event.type === 'tool_execution_end') {
                    emitEvent({
                        type: event.isError ? 'tool.failed' : 'tool.completed',
                        turnId,
                        payload: { toolCallId: event.toolCallId, toolName: event.toolName, result: event.result },
                    });
                }
            });
            const task = (async () => {
                try {
                    await agent.prompt(prompt);
                    await agent.waitForIdle();
                    const errorMessage = agent.state.errorMessage;
                    if (errorMessage) {
                        return { ok: false, error: errorMessage };
                    }
                    return { ok: true };
                } catch (error) {
                    const aborted = /abort/i.test(error && error.message ? error.message : '');
                    return { ok: false, cancelled: aborted, error: error.message };
                } finally {
                    unsubscribe();
                    session.sessionState.requestTool = null;
                    session.sessionState.requestModel = null;
                    session.turnTasks.delete(turnId);
                }
            })();
            session.turnTasks.set(turnId, task);
            return task;
        },

        async cancelTurn(sessionId) {
            const session = sessions.get(sessionId);
            if (!session) {
                return { ok: false };
            }
            session.agent.abort();
            return { ok: true };
        },

        async closeSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session) {
                session.agent.abort();
                sessions.delete(sessionId);
            }
            return { ok: true };
        },

        async dispose() {
            for (const sessionId of Array.from(sessions.keys())) {
                await this.closeSession(sessionId);
            }
            return { ok: true };
        },
    };
}
