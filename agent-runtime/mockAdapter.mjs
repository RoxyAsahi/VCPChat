// Mock adapter: drives the full sidecar protocol without Pi or network access.
// Used by contract tests and by the Workbench when the Pi probe is degraded.

const sessions = new Map();

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(new Error('aborted'));
        };
        const cleanup = () => {
            clearTimeout(timer);
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        };
        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

export function createMockAdapter() {
    return {
        kind: 'mock',

        async probe() {
            return {
                available: true,
                runtime: 'mock',
                node: process.version,
                details: 'mock adapter always available',
            };
        },

        async createSession(sessionId) {
            sessions.set(sessionId, {
                sessionId,
                abortControllers: new Map(),
            });
            return { ok: true };
        },

        async runTurn({ sessionId, turnId, prompt, emitEvent, requestTool }) {
            const session = sessions.get(sessionId);
            if (!session) {
                throw new Error(`unknown session: ${sessionId}`);
            }
            const controller = new AbortController();
            session.abortControllers.set(turnId, controller);
            const signal = controller.signal;
            try {
                emitEvent({ type: 'assistant.started', turnId, payload: {} });
                const reply = `[mock] received prompt (${prompt.length} chars): ${prompt.slice(0, 80)}`;
                for (const word of reply.split(' ')) {
                    await delay(15, signal);
                    emitEvent({ type: 'assistant.delta', turnId, payload: { text: `${word} ` } });
                }
                emitEvent({ type: 'assistant.completed', turnId, payload: {} });

                if (/\btool\b/i.test(prompt)) {
                    const result = await requestTool({
                        toolName: 'vcp_invoke',
                        arguments: {
                            toolName: 'FileOperator',
                            command: 'ListFiles',
                            path: '.',
                        },
                        reason: 'mock turn requested a demo tool call',
                    });
                    emitEvent({
                        type: 'assistant.delta',
                        turnId,
                        payload: { text: `\n[mock] tool result ok=${result.ok}: ${String(result.output).slice(0, 200)}\n` },
                    });
                }
                return { ok: true };
            } catch (error) {
                if (error && error.message === 'aborted') {
                    return { ok: false, cancelled: true };
                }
                throw error;
            } finally {
                session.abortControllers.delete(turnId);
            }
        },

        async cancelTurn(sessionId, turnId) {
            const session = sessions.get(sessionId);
            if (!session) {
                return { ok: false };
            }
            if (turnId) {
                const controller = session.abortControllers.get(turnId);
                if (controller) {
                    controller.abort();
                }
                return { ok: true };
            }
            for (const controller of session.abortControllers.values()) {
                controller.abort();
            }
            return { ok: true };
        },

        async closeSession(sessionId) {
            const session = sessions.get(sessionId);
            if (session) {
                for (const controller of session.abortControllers.values()) {
                    controller.abort();
                }
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
