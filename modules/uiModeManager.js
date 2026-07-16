(() => {
    const STORAGE_KEY = 'vcpchat.uiMode';
    const CLASSIC_MODE = 'classic';
    const NEXT_MODE = 'next';

    function normalize(mode) {
        return mode === NEXT_MODE ? NEXT_MODE : CLASSIC_MODE;
    }

    function apply(mode, options = {}) {
        const normalizedMode = normalize(mode);
        const previousMode = document.documentElement.dataset.uiMode;

        document.documentElement.dataset.uiMode = normalizedMode;

        if (options.cache !== false) {
            localStorage.setItem(STORAGE_KEY, normalizedMode);
        }

        if (previousMode && previousMode !== normalizedMode) {
            window.dispatchEvent(new CustomEvent('ui-mode-changed', {
                detail: { mode: normalizedMode, previousMode }
            }));
        }

        return normalizedMode;
    }

    function getCurrentMode() {
        return normalize(document.documentElement.dataset.uiMode);
    }

    const cachedMode = localStorage.getItem(STORAGE_KEY);
    apply(cachedMode, { cache: false });

    window.uiModeManager = Object.freeze({
        CLASSIC_MODE,
        NEXT_MODE,
        apply,
        getCurrentMode,
        normalize
    });
})();
