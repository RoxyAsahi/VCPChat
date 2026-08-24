import type { ThemeUiService } from './providers/theme.js';
import type { UiDisposer } from './contracts.js';
interface LegacyScopeLike {
    readonly label: string;
    readonly active: boolean;
    own(disposer: UiDisposer, label?: string, type?: string): UiDisposer;
    listen(target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions, label?: string): UiDisposer;
    subscribe(register: () => UiDisposer | void, label?: string): UiDisposer;
    child(label: string): LegacyScopeLike;
    track<T>(task: Promise<T>, label?: string): Promise<T>;
    dispose(reason?: string): Promise<void>;
    snapshot(): Readonly<Record<string, unknown>>;
}
declare const api: {
    mountThemePresenterFromScope(root: HTMLElement, theme: ThemeUiService["theme"], legacyScope: LegacyScopeLike): UiDisposer;
};
export { api as uiuxBrowserApi };
