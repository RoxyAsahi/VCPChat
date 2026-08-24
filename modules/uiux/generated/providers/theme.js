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
/**
 * Presentation-only theme consumer. It never reads body.classList and owns its
 * subscription through the caller-provided UiScope.
 */
export function mountThemePresenter(root, service, context) {
    if (!root)
        throw new TypeError('ThemePresenter requires a root element.');
    const apply = (snapshot) => {
        const normalized = normalizeThemeSnapshot(snapshot);
        root.dataset.themeEffective = normalized.value.effective;
        root.dataset.themeReady = String(normalized.value.ready);
        root.dataset.themeRevision = String(normalized.revision);
        root.dataset.themeSource = normalized.source;
    };
    apply(service.theme.getSnapshot());
    return context.scope.subscribe(() => service.theme.subscribe((_value, snapshot) => apply(snapshot), { immediate: false }), 'theme-presenter-subscription');
}
