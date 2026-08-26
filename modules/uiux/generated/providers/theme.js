export const themeUiDefinition = {
    id: 'theme-ui',
    provide: (context) => {
        const theme = context.services.theme;
        if (!isThemeReadable(theme))
            throw new TypeError('ThemeUiDefinition requires a ThemeReadable service.');
        return Object.freeze({ theme });
    },
};
function isThemeReadable(value) {
    const candidate = value;
    return Boolean(candidate
        && typeof candidate.get === 'function'
        && typeof candidate.getSnapshot === 'function'
        && typeof candidate.subscribe === 'function');
}
function normalizeThemeSnapshot(snapshot) {
    const effective = snapshot.value.effective === 'dark' ? 'dark' : 'light';
    return Object.freeze({
        ...snapshot,
        value: Object.freeze({ ready: snapshot.value.ready === true, effective }),
    });
}
const SEMANTIC_THEME_TOKENS = Object.freeze({
    dark: Object.freeze({
        '--vcp-ui-theme-bg-primary': 'oklch(0.04 0.012 230)',
        '--vcp-ui-theme-bg-secondary': 'oklch(0.18 0.015 230 / 0.92)',
        '--vcp-ui-theme-bg-tertiary': 'oklch(0.25 0.012 230 / 0.72)',
        '--vcp-ui-theme-bg-input': 'oklch(0.25 0.012 230 / 0.82)',
        '--vcp-ui-theme-text-primary': 'oklch(0.96 0.008 230)',
        '--vcp-ui-theme-text-secondary': 'oklch(0.68 0.015 230)',
        '--vcp-ui-theme-text-accent': 'oklch(0.75 0.14 230)',
        '--vcp-ui-theme-border': 'oklch(1 0 0 / 0.10)',
        '--vcp-ui-theme-accent': 'oklch(0.68 0.16 230)',
        '--vcp-ui-theme-accent-hover': 'oklch(0.60 0.18 230)',
        '--vcp-ui-theme-on-accent': 'oklch(1 0 0)',
    }),
    light: Object.freeze({
        '--vcp-ui-theme-bg-primary': 'oklch(0.98 0.008 230)',
        '--vcp-ui-theme-bg-secondary': 'oklch(0.94 0.012 230 / 0.96)',
        '--vcp-ui-theme-bg-tertiary': 'oklch(0.90 0.014 230 / 0.82)',
        '--vcp-ui-theme-bg-input': 'oklch(1 0 0 / 0.94)',
        '--vcp-ui-theme-text-primary': 'oklch(0.22 0.018 230)',
        '--vcp-ui-theme-text-secondary': 'oklch(0.45 0.018 230)',
        '--vcp-ui-theme-text-accent': 'oklch(0.48 0.13 230)',
        '--vcp-ui-theme-border': 'oklch(0.62 0.018 230 / 0.32)',
        '--vcp-ui-theme-accent': 'oklch(0.52 0.15 230)',
        '--vcp-ui-theme-accent-hover': 'oklch(0.44 0.17 230)',
        '--vcp-ui-theme-on-accent': 'oklch(1 0 0)',
    }),
});
const tokenOwners = new WeakMap();
function applySemanticTokens(root, effective) {
    const tokenRoot = root.ownerDocument?.documentElement || root;
    const doc = root.ownerDocument;
    const owners = doc ? (tokenOwners.get(doc) || new Map()) : new Map();
    if (doc && !tokenOwners.has(doc))
        tokenOwners.set(doc, owners);
    const tokens = SEMANTIC_THEME_TOKENS[effective];
    Object.entries(tokens).forEach(([name, value]) => {
        const owner = owners.get(name) || { count: 0, previous: tokenRoot.style.getPropertyValue(name), value };
        owner.count += 1;
        owner.value = value;
        owners.set(name, owner);
        tokenRoot.style.setProperty(name, value);
    });
    const scheme = owners.get('color-scheme') || { count: 0, previous: tokenRoot.style.getPropertyValue('color-scheme'), value: effective };
    scheme.count += 1;
    scheme.value = effective;
    owners.set('color-scheme', scheme);
    tokenRoot.style.setProperty('color-scheme', effective);
    return () => {
        Object.keys(tokens).concat('color-scheme').forEach(name => { const owner = owners.get(name); if (!owner)
            return; owner.count -= 1; if (owner.count > 0)
            return; owners.delete(name); if (owner.previous)
            tokenRoot.style.setProperty(name, owner.previous);
        else
            tokenRoot.style.removeProperty(name); });
        if (owners.size === 0 && doc)
            tokenOwners.delete(doc);
    };
}
/**
 * Presentation-only theme consumer. It never reads body.classList and owns its
 * subscription through the caller-provided UiScope.
 */
export function mountThemePresenter(root, service, context) {
    if (!root)
        throw new TypeError('ThemePresenter requires a root element.');
    let restoreTokens = applySemanticTokens(root, normalizeThemeSnapshot(service.theme.getSnapshot()).value.effective);
    const apply = (snapshot) => {
        const normalized = normalizeThemeSnapshot(snapshot);
        restoreTokens();
        restoreTokens = applySemanticTokens(root, normalized.value.effective);
        root.dataset.themeEffective = normalized.value.effective;
        root.dataset.themeReady = String(normalized.value.ready);
        root.dataset.themeRevision = String(normalized.revision);
        root.dataset.themeSource = normalized.source;
    };
    apply(service.theme.getSnapshot());
    const release = context.scope.subscribe(() => service.theme.subscribe((_value, snapshot) => apply(snapshot), { immediate: false }), 'theme-presenter-subscription');
    const releaseTokens = context.scope.own(() => restoreTokens(), 'theme-presenter-tokens', 'theme-tokens');
    return async () => {
        await release();
        await releaseTokens();
    };
}
