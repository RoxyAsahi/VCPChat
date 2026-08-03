import { createRendererLifecycleScope } from './agent-renderer-lifecycle.js';

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

export { createWorkbenchLifecycle };
