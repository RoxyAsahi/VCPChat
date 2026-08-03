function createAgentRendererSession(initial = {}, host = globalThis) {
    let refs = { ...initial };
    const disposers = new Set();
    const scheduled = new Map();
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
    function track(cancel) {
        let active = true;
        const dispose = () => {
            if (!active) return;
            active = false;
            cancel();
            disposers.delete(dispose);
        };
        disposers.add(dispose);
        return dispose;
    }
    function scheduleCallback(schedule, cancel, callback) {
        const generationAtSchedule = generation;
        let dispose = () => {};
        const handle = schedule(() => {
            scheduled.delete(handle);
            dispose();
            if (generationAtSchedule === generation) callback();
        });
        dispose = track(() => { scheduled.delete(handle); cancel?.(handle); });
        scheduled.set(handle, dispose);
        return handle;
    }
    function scheduleWait(schedule, cancel) {
        const generationAtSchedule = generation;
        return new Promise((resolve) => {
            let settled = false;
            let dispose = () => {};
            const settle = (active) => {
                if (settled) return;
                settled = true;
                scheduled.delete(handle);
                dispose();
                resolve(active);
            };
            const handle = schedule(() => settle(generationAtSchedule === generation));
            dispose = track(() => {
                scheduled.delete(handle);
                cancel?.(handle);
                if (!settled) {
                    settled = true;
                    resolve(false);
                }
            });
            scheduled.set(handle, dispose);
        });
    }
    function frame(callback) {
        const schedule = host.requestAnimationFrame?.bind(host)
            || ((next) => host.setTimeout(next, 0));
        const cancel = host.cancelAnimationFrame?.bind(host)
            || host.clearTimeout?.bind(host);
        return scheduleCallback(schedule, cancel, callback);
    }
    function idle(callback, options = { timeout: 1000 }) {
        const generationAtSchedule = generation;
        const schedule = host.requestIdleCallback?.bind(host)
            || ((next) => host.setTimeout(next, 0));
        const cancel = host.cancelIdleCallback?.bind(host)
            || host.clearTimeout?.bind(host);
        let dispose = () => {};
        const handle = schedule(() => {
            scheduled.delete(handle);
            dispose();
            if (generationAtSchedule === generation) callback();
        }, options);
        dispose = track(() => { scheduled.delete(handle); cancel?.(handle); });
        scheduled.set(handle, dispose);
        return handle;
    }
    function timeout(callback, delay = 0) {
        return scheduleCallback(
            (next) => host.setTimeout(next, delay),
            host.clearTimeout?.bind(host),
            callback,
        );
    }
    function waitFrame() {
        return scheduleWait(
            host.requestAnimationFrame?.bind(host) || ((next) => host.setTimeout(next, 0)),
            host.cancelAnimationFrame?.bind(host) || host.clearTimeout?.bind(host),
        );
    }
    function waitIdle(options = { timeout: 1000 }) {
        return scheduleWait(
            host.requestIdleCallback?.bind(host) || ((next) => host.setTimeout(next, 0)),
            host.cancelIdleCallback?.bind(host) || host.clearTimeout?.bind(host),
        );
    }
    function delay(delayMs = 0) {
        return scheduleWait(
            (next) => host.setTimeout(next, delayMs),
            host.clearTimeout?.bind(host),
        );
    }
    function cancel(handle) { scheduled.get(handle)?.(); }
    function dispose() {
        for (const disposer of [...disposers].reverse()) disposer();
        disposers.clear();
        scheduled.clear();
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
        frame,
        idle,
        timeout,
        waitFrame,
        waitIdle,
        delay,
        cancel,
        dispose,
        get generation() { return generation; },
    };
}

export { createAgentRendererSession };
