import type {
    UiContext,
    UiDisposer,
    UiReadable,
    UiServiceDefinition,
    UiSnapshot,
} from '../contracts.js';

export interface ThemeState {
    readonly ready: boolean;
    readonly effective: 'light' | 'dark';
}

export type ThemeReadable = UiReadable<ThemeState>;

export interface ThemeUiService {
    readonly theme: ThemeReadable;
}

export const themeUiDefinition: UiServiceDefinition<ThemeUiService> = {
    id: 'theme-ui',
    provide: (context: UiContext) => {
        const theme = context.services.theme;
        if (!isThemeReadable(theme)) throw new TypeError('ThemeUiDefinition requires a ThemeReadable service.');
        return Object.freeze({ theme });
    },
};

function isThemeReadable(value: unknown): value is ThemeReadable {
    const candidate = value as Partial<ThemeReadable> | null;
    return Boolean(candidate
        && typeof candidate.get === 'function'
        && typeof candidate.getSnapshot === 'function'
        && typeof candidate.subscribe === 'function');
}

function normalizeThemeSnapshot(snapshot: UiSnapshot<ThemeState>): UiSnapshot<ThemeState> {
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
export function mountThemePresenter(
    root: HTMLElement,
    service: ThemeUiService,
    context: UiContext,
): UiDisposer {
    if (!root) throw new TypeError('ThemePresenter requires a root element.');
    const apply = (snapshot: UiSnapshot<ThemeState>) => {
        const normalized = normalizeThemeSnapshot(snapshot);
        root.dataset.themeEffective = normalized.value.effective;
        root.dataset.themeReady = String(normalized.value.ready);
        root.dataset.themeRevision = String(normalized.revision);
        root.dataset.themeSource = normalized.source;
    };
    apply(service.theme.getSnapshot());
    return context.scope.subscribe(() => service.theme.subscribe(
        (_value, snapshot) => apply(snapshot),
        { immediate: false },
    ), 'theme-presenter-subscription');
}
