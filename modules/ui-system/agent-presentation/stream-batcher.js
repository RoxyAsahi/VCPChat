function createAnimationFrameBatcher({ requestFrame, cancelFrame, flush }) {
    if (typeof requestFrame !== 'function') throw new TypeError('requestFrame is required');
    if (typeof flush !== 'function') throw new TypeError('flush is required');
    const pending = new Map();
    let frameId = null;
    let disposed = false;

    const run = () => {
        frameId = null;
        if (disposed || pending.size === 0) return;
        const batch = new Map(pending);
        pending.clear();
        flush(batch);
    };

    return {
        enqueue(key, value) {
            if (disposed) return false;
            pending.set(key, value);
            if (frameId === null) frameId = requestFrame(run);
            return true;
        },
        flushNow() {
            if (frameId !== null && typeof cancelFrame === 'function') cancelFrame(frameId);
            frameId = null;
            run();
        },
        dispose() {
            disposed = true;
            pending.clear();
            if (frameId !== null && typeof cancelFrame === 'function') cancelFrame(frameId);
            frameId = null;
        },
        get size() {
            return pending.size;
        },
    };
}

export { createAnimationFrameBatcher };
