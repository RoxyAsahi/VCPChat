function createAgentVisibilityController({ container, window, margin = 200 }) {
    const observed = new Set();
    const states = new WeakMap();
    let disposed = false;

    function stateFor(row) {
        let state = states.get(row);
        if (!state) {
            state = { animations: [], media: new Map(), paused: false };
            states.set(row, state);
        }
        return state;
    }

    function pause(row) {
        const state = stateFor(row);
        if (state.paused) return;
        row.classList.add('vcp-paused');
        try {
            state.animations = row.getAnimations?.({ subtree: true }) || [];
            for (const animation of state.animations) {
                if (animation.playState === 'running') animation.pause();
            }
        } catch { state.animations = []; }
        for (const media of row.querySelectorAll('audio, video')) {
            state.media.set(media, media.paused === false);
            if (media.paused === false) media.pause?.();
        }
        state.paused = true;
    }

    function resume(row) {
        const state = stateFor(row);
        if (!state.paused) return;
        row.classList.remove('vcp-paused');
        for (const animation of state.animations) {
            try { if (animation.playState === 'paused') animation.play(); } catch {}
        }
        for (const [media, wasPlaying] of state.media) {
            if (wasPlaying && media.isConnected) void media.play?.().catch?.(() => {});
        }
        state.animations = [];
        state.media.clear();
        state.paused = false;
    }

    function isMessageInHotZone(row) {
        if (disposed || !container || !row?.isConnected) return false;
        try {
            const viewport = container.getBoundingClientRect();
            const bounds = row.getBoundingClientRect();
            return bounds.bottom > viewport.top - margin && bounds.top < viewport.bottom + margin;
        } catch { return false; }
    }

    const observer = typeof window.IntersectionObserver === 'function'
        ? new window.IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) resume(entry.target);
                else pause(entry.target);
            }
        }, { root: container, rootMargin: `${margin}px 0px`, threshold: 0 })
        : null;

    function observeMessage(row) {
        if (disposed || !row || observed.has(row)) return;
        observed.add(row);
        observer?.observe(row);
        if (!observer && !isMessageInHotZone(row)) pause(row);
    }

    function unobserveMessage(row) {
        if (!row || !observed.delete(row)) return;
        observer?.unobserve(row);
        resume(row);
        states.delete(row);
    }

    function recheckVisibility() {
        if (disposed) return;
        for (const row of observed) {
            if (isMessageInHotZone(row)) resume(row);
            else pause(row);
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        observer?.disconnect();
        for (const row of observed) resume(row);
        observed.clear();
    }

    return { observeMessage, unobserveMessage, isMessageInHotZone, recheckVisibility, dispose };
}

export { createAgentVisibilityController };
