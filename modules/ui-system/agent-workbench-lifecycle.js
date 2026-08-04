function createRendererLifecycleScope(host = globalThis) {
    const disposers = new Set();
    let disposed = false;
    function add(disposer) {
        if (typeof disposer !== 'function') return () => {};
        if (disposed) { disposer(); return () => {}; }
        disposers.add(disposer);
        return () => { if (disposers.delete(disposer)) disposer(); };
    }
    function listen(target, type, listener, options) {
        target?.addEventListener?.(type, listener, options);
        return add(() => target?.removeEventListener?.(type, listener, options));
    }
    function trackTimeout(id) { return add(() => host.clearTimeout?.(id)); }
    function trackInterval(id) { return add(() => host.clearInterval?.(id)); }
    function trackAnimationFrame(id) { return add(() => host.cancelAnimationFrame?.(id)); }
    function dispose() {
        if (disposed) return;
        disposed = true;
        for (const disposer of [...disposers].reverse()) { try { disposer(); } catch {} }
        disposers.clear();
    }
    return { add, listen, trackTimeout, trackInterval, trackAnimationFrame, dispose,
        get disposed() { return disposed; } };
}

function createWorkbenchLifecycle(host = globalThis) {
    const base = createRendererLifecycleScope(host);
    const resources = new Map();

    function clear(name) {
        const dispose = resources.get(name);
        if (!dispose) return false;
        resources.delete(name);
        dispose();
        return true;
    }

    function register(name, handle, cancel) {
        if (base.disposed) {
            cancel?.(handle);
            return null;
        }
        clear(name);
        const dispose = () => cancel?.(handle);
        resources.set(name, dispose);
        return handle;
    }

    function timeout(name, callback, delay) {
        if (base.disposed) return null;
        clear(name);
        const handle = host.setTimeout?.(() => {
            resources.delete(name);
            if (!base.disposed) callback();
        }, delay);
        resources.set(name, () => host.clearTimeout?.(handle));
        return handle;
    }

    function interval(name, callback, delay) {
        return register(name, host.setInterval?.(callback, delay), (handle) => host.clearInterval?.(handle));
    }

    function frame(name, callback) {
        if (base.disposed) return null;
        clear(name);
        const request = host.requestAnimationFrame?.bind(host)
            || ((next) => host.setTimeout?.(next, 0));
        const cancel = host.cancelAnimationFrame?.bind(host)
            || host.clearTimeout?.bind(host);
        const handle = request(() => {
            resources.delete(name);
            if (!base.disposed) callback();
        });
        resources.set(name, () => cancel?.(handle));
        return handle;
    }

    function dispose() {
        for (const name of [...resources.keys()]) clear(name);
        base.dispose();
    }

    return { add: base.add, listen: base.listen, timeout, interval, frame, clear, dispose,
        get disposed() { return base.disposed; } };
}

export { createRendererLifecycleScope, createWorkbenchLifecycle };
