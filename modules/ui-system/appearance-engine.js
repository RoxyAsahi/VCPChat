(() => {
    const STORAGE_KEY = 'vcpchat.appearanceProfile';
    const OPTION_SETS = Object.freeze({
        density: new Set(['compact', 'comfortable', 'relaxed']),
        radius: new Set(['square', 'small', 'medium', 'round']),
        typography: new Set(['system', 'humanist', 'serif']),
        fontScale: new Set(['small', 'normal', 'large']),
        contentWidth: new Set(['full', 'centered']),
        surface: new Set(['solid', 'translucent'])
    });
    const PRESETS = Object.freeze({
        classic: Object.freeze({
            density: 'comfortable', radius: 'small', typography: 'system',
            fontScale: 'normal', contentWidth: 'full', surface: 'translucent'
        }),
        next: Object.freeze({
            density: 'comfortable', radius: 'medium', typography: 'humanist',
            fontScale: 'normal', contentWidth: 'full', surface: 'translucent'
        })
    });

    function normalizeUiMode(mode) {
        return mode === 'next' ? 'next' : 'classic';
    }

    function normalize(profile, uiMode = 'classic') {
        const preset = PRESETS[normalizeUiMode(uiMode)];
        const source = profile && typeof profile === 'object' ? profile : {};
        return Object.fromEntries(Object.entries(OPTION_SETS).map(([key, allowed]) => {
            const value = source[key];
            return [key, allowed.has(value) ? value : preset[key]];
        }));
    }

    function apply(profile, options = {}) {
        const uiMode = options.uiMode || document.documentElement.dataset.uiMode || 'classic';
        const resolved = normalize(profile, uiMode);
        const root = document.documentElement;
        root.dataset.vcpDensity = resolved.density;
        root.dataset.vcpRadius = resolved.radius;
        root.dataset.vcpTypography = resolved.typography;
        root.dataset.vcpFontScale = resolved.fontScale;
        root.dataset.vcpContentWidth = resolved.contentWidth;
        root.dataset.vcpSurface = resolved.surface;
        document.querySelectorAll('.vcp-ui-scope').forEach((scope) => {
            scope.dataset.density = resolved.density;
        });
        if (options.cache === true) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(resolved));
        }
        window.dispatchEvent(new CustomEvent('vcp-appearance-changed', {
            detail: { profile: resolved, source: options.source || 'runtime' }
        }));
        return resolved;
    }

    function readCache(uiMode = 'classic') {
        try {
            return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'), uiMode);
        } catch {
            return normalize(null, uiMode);
        }
    }

    const bootMode = document.documentElement.dataset.uiMode || 'classic';
    apply(readCache(bootMode), { uiMode: bootMode, source: 'boot-cache' });
    window.VCPAppearance = Object.freeze({ PRESETS, normalize, apply, readCache });
})();
