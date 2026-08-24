import { mountThemePresenter } from './providers/theme.js';
import { createSettingsUiService } from './adapters/settings.js';
import { createUiScope } from './runtime/scope.js';
import { createUiServiceRegistry } from './runtime/service-registry.js';
import { settingsUiDefinition } from './adapters/settings.js';
import { createRustAssistantUiService, rustAssistantUiDefinition } from './adapters/rust-assistant.js';
import { createForumConfigUiService, forumConfigUiDefinition } from './adapters/forum-config.js';
import { createAssistantRuntimeUiService, assistantRuntimeUiDefinition } from './adapters/assistant-runtime.js';
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

const api = {
    mountThemePresenterFromScope(
        root: HTMLElement,
        theme: ThemeUiService['theme'],
        legacyScope: LegacyScopeLike,
    ): UiDisposer {
        const scope = createUiScope(legacyScope);
        return mountThemePresenter(root, { theme }, { scope, services: { theme } });
    },
    createSettingsUiService,
    createUiServiceRegistryFromScope(legacyScope: LegacyScopeLike) {
        return createUiServiceRegistry(createUiScope(legacyScope));
    },
    settingsUiDefinition,
    createRustAssistantUiService,
    rustAssistantUiDefinition,
    createForumConfigUiService,
    forumConfigUiDefinition,
    createAssistantRuntimeUiService,
    assistantRuntimeUiDefinition,
};

Object.defineProperty(globalThis, 'VCPUIUX', {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
});
globalThis.dispatchEvent?.(new CustomEvent('vcp-uiux-ready'));

export { api as uiuxBrowserApi };
