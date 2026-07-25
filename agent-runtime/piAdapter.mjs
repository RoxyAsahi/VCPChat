// Pi adapter: embeds @earendil-works/pi-agent-core in the worker process.
//
// Model traffic goes through a custom streamFn that talks to the VCPToolBox
// OpenAI-compatible /v1/chat/completions endpoint, so no provider key is ever
// required in this process beyond the VCP key supplied by the main process.
// Pi built-in file/bash tools are NOT registered; the only tools exposed to
// the model are the vcp_delegate / vcp_invoke bridge tools, which round-trip
// to the Electron main process for approval + execution.

import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

const VCP_DELEGATE = 'vcp_delegate';
const VCP_INVOKE = 'vcp_invoke';

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
            stream: false,
        };
        const openAiTools = toOpenAiTools(context.tools);
        if (openAiTools.length > 0) {
            body.tools = openAiTools;
            body.tool_choice = 'auto';
        }

        const makeMessage = (overrides) => ({
            role: 'assistant',
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: emptyUsage(),
            stopReason: 'stop',
            timestamp: Date.now(),
            ...overrides,
        });

        (async () => {
            let modelResult;
            try {
                modelResult = await requestModel(body, signal);
            } catch (error) {
                const aborted = signal && signal.aborted;
                stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: makeMessage({ stopReason: aborted ? 'aborted' : 'error', errorMessage: error.message }) });
                return;
            }
            if (!modelResult || modelResult.ok === false) {
                stream.push({ type: 'error', reason: 'error', error: makeMessage({ stopReason: 'error', errorMessage: (modelResult && modelResult.error) || 'VCP model gateway failed' }) });
                return;
            }
            const data = modelResult.data;
            const choice = data && data.choices && data.choices[0];
            const message = (choice && choice.message) || {};
            const content = [];
            const partial = makeMessage({ content });
            stream.push({ type: 'start', partial });
            let index = 0;
            if (typeof message.content === 'string' && message.content.length > 0) {
                stream.push({ type: 'text_start', contentIndex: index, partial });
                stream.push({ type: 'text_delta', contentIndex: index, delta: message.content, partial });
                stream.push({ type: 'text_end', contentIndex: index, content: message.content, partial });
                content.push({ type: 'text', text: message.content });
                index += 1;
            }
            const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
            for (const call of toolCalls) {
                let args = {};
                try {
                    args = call.function && call.function.arguments ? JSON.parse(call.function.arguments) : {};
                } catch (error) {
                    args = {};
                }
                const toolCall = {
                    type: 'toolCall',
                    id: call.id || `call_${Date.now()}_${index}`,
                    name: call.function ? call.function.name : 'unknown',
                    arguments: args,
                };
                stream.push({ type: 'toolcall_start', contentIndex: index, partial });
                stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial });
                content.push(toolCall);
                index += 1;
            }
            if (data.usage) {
                partial.usage = {
                    ...emptyUsage(),
                    input: data.usage.prompt_tokens || 0,
                    output: data.usage.completion_tokens || 0,
                    totalTokens: data.usage.total_tokens || 0,
                };
            }
            const reason = toolCalls.length > 0 ? 'toolUse' : 'stop';
            partial.stopReason = reason;
            stream.push({ type: 'done', reason, message: partial });
        })();

        return stream;
    };
}

function buildBridgeTools(getRequestTool) {
    return [
        {
            name: VCP_DELEGATE,
            label: 'VCP Delegate',
            description:
                'Delegate a task to the VCPToolBox agent toolchain. The ToolBox will select and run '
                + 'the appropriate plugins (files, shell, MCP, distributed nodes) and return the final result. '
                + 'Use this for any real-world action. High-risk actions require human approval.',
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
                streamFn: createVcpStreamFn((body, signal) => {
                    if (!sessionState.requestModel) {
                        throw new Error('model bridge not bound to an active turn');
                    }
                    return sessionState.requestModel(body, signal);
                }),
                initialState: {
                    systemPrompt: options.systemPrompt
                        || 'You are the VCPChat agent. Use the vcp_delegate and vcp_invoke tools for any real-world action. Never claim an action succeeded without a tool result.',
                    model: makeVcpModel({
                        model: vcp.model || 'vcp-default',
                        baseUrl: 'main-process://vcp-model-gateway',
                    }),
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
            const unsubscribe = agent.subscribe((event) => {
                if (event.type === 'message_update' && event.assistantMessageEvent) {
                    const sub = event.assistantMessageEvent;
                    if (sub.type === 'text_delta') {
                        emitEvent({ type: 'assistant.delta', turnId, payload: { text: sub.delta } });
                    } else if (sub.type === 'thinking_delta') {
                        emitEvent({ type: 'reasoning.delta', turnId, payload: { text: sub.delta } });
                    }
                } else if (event.type === 'message_start') {
                    emitEvent({ type: 'assistant.started', turnId, payload: {} });
                } else if (event.type === 'message_end') {
                    emitEvent({ type: 'assistant.completed', turnId, payload: {} });
                } else if (event.type === 'tool_execution_start') {
                    emitEvent({
                        type: 'tool.started',
                        turnId,
                        payload: { toolCallId: event.toolCallId, toolName: event.toolName },
                    });
                } else if (event.type === 'tool_execution_end') {
                    emitEvent({
                        type: event.isError ? 'tool.failed' : 'tool.completed',
                        turnId,
                        payload: { toolCallId: event.toolCallId, toolName: event.toolName },
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
