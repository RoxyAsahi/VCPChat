// VCP-controlled, minimal Pi Agent loop fork. See UPSTREAM.md and LICENSE.

export const VCP_PI_CORE_VERSION = '0.82.1-vcp.1';

function copy(value) {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export class EventStream {
    constructor(isComplete, extractResult) {
        this.queue = [];
        this.waiting = [];
        this.done = false;
        this.isComplete = isComplete;
        this.extractResult = extractResult;
        this.finalResult = new Promise((resolve) => { this.resolveFinalResult = resolve; });
    }

    push(event) {
        if (this.done) return;
        if (this.isComplete(event)) {
            this.done = true;
            this.resolveFinalResult(this.extractResult(event));
        }
        const waiter = this.waiting.shift();
        if (waiter) waiter({ value: event, done: false });
        else this.queue.push(event);
    }

    end(result) {
        this.done = true;
        if (result !== undefined) this.resolveFinalResult(result);
        while (this.waiting.length) this.waiting.shift()({ value: undefined, done: true });
    }

    result() { return this.finalResult; }

    async *[Symbol.asyncIterator]() {
        while (true) {
            if (this.queue.length) yield this.queue.shift();
            else if (this.done) return;
            else {
                const next = await new Promise((resolve) => this.waiting.push(resolve));
                if (next.done) return;
                yield next.value;
            }
        }
    }
}

export class AssistantMessageEventStream extends EventStream {
    constructor() {
        super(
            (event) => event.type === 'done' || event.type === 'error',
            (event) => event.type === 'done' ? event.message : event.error,
        );
    }
}

export function createAssistantMessageEventStream() {
    return new AssistantMessageEventStream();
}

function validationError(name, reason) {
    throw new Error(`Validation failed for tool "${name}": ${reason}`);
}

function validateValue(name, schema, value, path = 'root') {
    if (!schema || typeof schema !== 'object') return;
    if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
        const alternatives = schema.anyOf || schema.oneOf;
        if (!alternatives.some((candidate) => {
            try { validateValue(name, candidate, copy(value), path); return true; } catch { return false; }
        })) validationError(name, `${path} does not match an allowed schema`);
        return;
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const accepts = (type) => (
        type === undefined || type === 'any' ||
        (type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) ||
        (type === 'array' && Array.isArray(value)) ||
        (type === 'string' && typeof value === 'string') ||
        (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
        (type === 'integer' && Number.isInteger(value)) ||
        (type === 'boolean' && typeof value === 'boolean') ||
        (type === 'null' && value === null)
    );
    if (!types.some(accepts)) validationError(name, `${path} has an invalid type`);
    if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const required of schema.required || []) {
            if (!(required in value)) validationError(name, `${path}.${required} is required`);
        }
        for (const [key, child] of Object.entries(schema.properties || {})) {
            if (key in value) validateValue(name, child, value[key], `${path}.${key}`);
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!(key in (schema.properties || {}))) validationError(name, `${path}.${key} is not allowed`);
            }
        }
    }
    if (schema.type === 'array' && Array.isArray(value) && schema.items) {
        value.forEach((item, index) => validateValue(name, schema.items, item, `${path}[${index}]`));
    }
}

export function validateToolArguments(tool, toolCall) {
    const args = copy(toolCall.arguments || {});
    validateValue(toolCall.name, tool.parameters || {}, args);
    return args;
}

function textPrompt(input, images) {
    if (Array.isArray(input)) return input;
    if (typeof input !== 'string') return [input];
    const content = [{ type: 'text', text: input }];
    if (Array.isArray(images)) content.push(...images);
    return [{ role: 'user', content, timestamp: Date.now() }];
}

function toolError(message) {
    return { content: [{ type: 'text', text: message }], details: {} };
}

function toolResult(finalized) {
    return {
        role: 'toolResult', toolCallId: finalized.toolCall.id, toolName: finalized.toolCall.name,
        content: finalized.result.content || [], details: finalized.result.details,
        usage: finalized.result.usage, isError: finalized.isError, timestamp: Date.now(),
    };
}

function defaultConvertToLlm(messages) {
    return messages.filter((message) => ['user', 'assistant', 'toolResult'].includes(message.role));
}

export class Agent {
    constructor(options = {}) {
        const initial = options.initialState || {};
        this._state = {
            systemPrompt: initial.systemPrompt || '', model: initial.model || {}, thinkingLevel: initial.thinkingLevel || 'off',
            tools: (initial.tools || []).slice(), messages: (initial.messages || []).slice(), isStreaming: false,
            streamingMessage: undefined, pendingToolCalls: new Set(), errorMessage: undefined,
        };
        this.streamFn = options.streamFn;
        if (typeof this.streamFn !== 'function') throw new Error('VCP Pi core requires streamFn');
        this.convertToLlm = options.convertToLlm || defaultConvertToLlm;
        this.transformContext = options.transformContext;
        this.beforeToolCall = options.beforeToolCall;
        this.afterToolCall = options.afterToolCall;
        this.toolExecution = options.toolExecution || 'sequential';
        this.listeners = new Set();
        this.steeringQueue = [];
        this.followUpQueue = [];
        this.activeRun = null;
    }

    get state() { return this._state; }
    get signal() { return this.activeRun?.controller.signal; }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    steer(message) { this.steeringQueue.push(message); }
    followUp(message) { this.followUpQueue.push(message); }
    clearSteeringQueue() { this.steeringQueue = []; }
    clearFollowUpQueue() { this.followUpQueue = []; }
    clearAllQueues() { this.clearSteeringQueue(); this.clearFollowUpQueue(); }
    hasQueuedMessages() { return this.steeringQueue.length > 0 || this.followUpQueue.length > 0; }
    abort() { this.activeRun?.controller.abort(); }
    waitForIdle() { return this.activeRun?.promise || Promise.resolve(); }
    reset() { this._state.messages = []; this._state.errorMessage = undefined; this.clearAllQueues(); }

    async prompt(input, images) {
        if (this.activeRun) throw new Error('Agent is already processing a prompt');
        return this.#run(textPrompt(input, images));
    }

    async continue() {
        if (this.activeRun) throw new Error('Agent is already processing');
        if (!this._state.messages.length) throw new Error('No messages to continue from');
        return this.#run([]);
    }

    async #emit(event) {
        if (event.type === 'message_start' || event.type === 'message_update') this._state.streamingMessage = event.message;
        if (event.type === 'message_end') {
            this._state.streamingMessage = undefined;
            this._state.messages.push(event.message);
        }
        if (event.type === 'tool_execution_start') this._state.pendingToolCalls.add(event.toolCallId);
        if (event.type === 'tool_execution_end') this._state.pendingToolCalls.delete(event.toolCallId);
        if (event.type === 'turn_end' && event.message?.errorMessage) this._state.errorMessage = event.message.errorMessage;
        for (const listener of this.listeners) await listener(event, this.signal);
    }

    async #run(initialPrompts) {
        const controller = new AbortController();
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        this.activeRun = { controller, promise };
        this._state.isStreaming = true;
        this._state.errorMessage = undefined;
        try {
            await this.#loop(initialPrompts, controller.signal);
        } catch (error) {
            const failure = {
                role: 'assistant', content: [{ type: 'text', text: '' }], api: this._state.model.api,
                provider: this._state.model.provider, model: this._state.model.id,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
                stopReason: controller.signal.aborted ? 'aborted' : 'error', errorMessage: error.message, timestamp: Date.now(),
            };
            await this.#emit({ type: 'message_start', message: failure });
            await this.#emit({ type: 'message_end', message: failure });
            await this.#emit({ type: 'turn_end', message: failure, toolResults: [] });
        } finally {
            this._state.isStreaming = false;
            this._state.streamingMessage = undefined;
            this._state.pendingToolCalls.clear();
            await this.#emit({ type: 'agent_end', messages: this._state.messages.slice() });
            this.activeRun = null;
            resolve();
        }
    }

    async #loop(initialPrompts, signal) {
        let pending = initialPrompts.slice();
        await this.#emit({ type: 'agent_start' });
        while (!signal.aborted) {
            await this.#emit({ type: 'turn_start' });
            for (const message of pending) {
                await this.#emit({ type: 'message_start', message });
                await this.#emit({ type: 'message_end', message });
            }
            pending = [];
            const assistant = await this.#streamAssistant(signal);
            const calls = (assistant.content || []).filter((part) => part.type === 'toolCall');
            const results = [];
            for (const call of calls) {
                const finalized = await this.#executeTool(call, assistant, signal);
                const result = toolResult(finalized);
                results.push(result);
                await this.#emit({ type: 'message_start', message: result });
                await this.#emit({ type: 'message_end', message: result });
            }
            await this.#emit({ type: 'turn_end', message: assistant, toolResults: results });
            if (signal.aborted || assistant.stopReason === 'error' || assistant.stopReason === 'aborted') return;
            if (calls.length) {
                pending = this.steeringQueue.splice(0);
                continue;
            }
            pending = this.steeringQueue.splice(0);
            if (!pending.length) pending = this.followUpQueue.splice(0);
            if (!pending.length) return;
        }
    }

    async #streamAssistant(signal) {
        let messages = this._state.messages.slice();
        if (this.transformContext) messages = await this.transformContext(messages, signal);
        const stream = await this.streamFn(this._state.model, {
            systemPrompt: this._state.systemPrompt, messages: await this.convertToLlm(messages), tools: this._state.tools.slice(),
        }, { signal, reasoning: this._state.thinkingLevel === 'off' ? undefined : this._state.thinkingLevel });
        let partial = null;
        let added = false;
        for await (const event of stream) {
            if (event.type === 'start') {
                partial = event.partial;
                await this.#emit({ type: 'message_start', message: { ...partial } });
            } else if (['text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end'].includes(event.type)) {
                partial = event.partial || partial;
                if (partial) await this.#emit({ type: 'message_update', assistantMessageEvent: event, message: { ...partial } });
            } else if (event.type === 'done' || event.type === 'error') {
                const finalMessage = await stream.result();
                await this.#emit({ type: 'message_end', message: finalMessage });
                added = true;
                return finalMessage;
            }
        }
        const finalMessage = await stream.result();
        if (!added) await this.#emit({ type: 'message_end', message: finalMessage });
        return finalMessage;
    }

    async #executeTool(toolCall, assistantMessage, signal) {
        await this.#emit({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
        let result;
        let isError = false;
        try {
            const tool = this._state.tools.find((candidate) => candidate.name === toolCall.name);
            if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
            const args = validateToolArguments(tool, toolCall);
            const before = this.beforeToolCall && await this.beforeToolCall({ assistantMessage, toolCall, args }, signal);
            if (before?.block) throw new Error(before.reason || 'Tool execution was blocked');
            result = await tool.execute(toolCall.id, args, signal, (update) => this.#emit({
                type: 'tool_execution_update', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments, partialResult: update,
            }));
            const after = this.afterToolCall && await this.afterToolCall({ assistantMessage, toolCall, args, result, isError: false }, signal);
            if (after) result = { ...result, ...after, content: after.content ?? result.content, details: after.details ?? result.details };
        } catch (error) {
            result = toolError(error instanceof Error ? error.message : String(error));
            isError = true;
        }
        await this.#emit({ type: 'tool_execution_end', toolCallId: toolCall.id, toolName: toolCall.name, result, isError });
        return { toolCall, result, isError };
    }
}
