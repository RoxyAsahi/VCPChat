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

export { createRendererLifecycleScope };
