function createAgentRendererSession(initial = {}) {
    let refs = { ...initial };
    const disposers = new Set();
    let generation = 0;

    function update(next = {}) { refs = { ...refs, ...next }; generation += 1; return generation; }
    function context(subject = null) {
        const value = refs.getSessionContext?.(subject) || {};
        return {
            sessionId: value.sessionId || null,
            threadId: value.threadId || null,
            participant: value.participant || {},
            messages: Array.isArray(value.messages) ? value.messages : [],
            settings: value.settings || {},
        };
    }
    function bind(type, handler, options) {
        const root = refs.chatMessagesDiv;
        root?.addEventListener?.(type, handler, options);
        const dispose = () => root?.removeEventListener?.(type, handler, options);
        disposers.add(dispose);
        return dispose;
    }
    function dispose() {
        for (const disposer of [...disposers].reverse()) disposer();
        disposers.clear();
        refs = {};
        generation += 1;
    }
    return {
        update,
        context,
        messages: (subject) => context(subject).messages,
        participant: (subject) => context(subject).participant,
        settings: (subject) => context(subject).settings,
        bind,
        dispose,
        get generation() { return generation; },
    };
}

export { createAgentRendererSession };
