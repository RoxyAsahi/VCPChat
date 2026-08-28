import { mountThemePresenter } from './providers/theme.js';
import { createSettingsUiService } from './adapters/settings.js';
import { createUiScope } from './runtime/scope.js';
import { createDomRenderer } from './runtime/dom-renderer.js';
import { createUiServiceRegistry } from './runtime/service-registry.js';
import { settingsUiDefinition } from './adapters/settings.js';
import { createRustAssistantUiService, rustAssistantUiDefinition } from './adapters/rust-assistant.js';
import { createForumConfigUiService, forumConfigUiDefinition } from './adapters/forum-config.js';
import { createAssistantRuntimeUiService, assistantRuntimeUiDefinition } from './adapters/assistant-runtime.js';
import type { ThemeUiService } from './providers/theme.js';
import type { UiDisposer } from './contracts.js';
import { mountField } from './primitives/field.js';
import { mountButton } from './primitives/button.js';
import { mountSelect } from './primitives/select.js';
import { mountInput } from './primitives/input.js';
import { mountMenu } from './primitives/menu.js';
import { mountAgentPresetSeat } from './primitives/agent-preset-seat.js';
import { mountAgentPresetRow } from './primitives/agent-preset-row.js';
import { mountLanguageRow } from './primitives/language-row.js';
import { mountAgentModelPicker } from './primitives/agent-model-picker.js';
import { mountModal } from './primitives/modal.js';
import { mountTooltip } from './primitives/tooltip.js';
import { mountHoverCard } from './primitives/hover-card.js';
import { mountDisclosureRow, mountDisclosureRowController } from './primitives/disclosure-row.js';
import { mountStateDot } from './primitives/state-dot.js';
import { mountToast } from './primitives/toast.js';
import { mountRiskConfirmation } from './primitives/risk-confirmation.js';
import { mountSemanticIcon } from './primitives/semantic-icon.js';
import { mountChoice } from './primitives/choice.js';
import { mountRange } from './primitives/range.js';
import { mountToggle } from './primitives/toggle.js';
import { mountColorPair } from './primitives/color-pair.js';
import { createPopupSelectController, mountPopupSelectView } from './primitives/popup-select.js';
import { mountDirectoryBrowser } from './primitives/directory-browser.js';
import { mountPrimitiveLab } from './lab/primitive-lab.js';
import { mountOnboardingSurface } from './primitives/onboarding-surface.js';
import { mountDiffBlock } from './primitives/diff-block.js';

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
    createDomRenderer,
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
    mountField,
    mountButton,
    mountSelect,
    mountInput,
    mountMenu,
    mountAgentPresetSeat,
    mountAgentPresetRow,
    mountLanguageRow,
    mountAgentModelPicker,
    mountModal,
    mountTooltip,
    mountHoverCard,
    mountDisclosureRow,
    mountDisclosureRowController,
    mountStateDot,
    mountToast,
    mountRiskConfirmation,
    mountSemanticIcon,
    mountChoice,
    mountRange,
    mountToggle,
    mountColorPair,
    // Candidate-only command popup primitives. They are exposed solely so the
    // component Lab and Electron evidence can mount them; no VCP Composer or
    // command business path consumes this API.
    createPopupSelectController,
    mountPopupSelectView,
    // Candidate-only browser. Capabilities are caller-injected; this API does
    // not connect to VCP's directory IPC or Workspace persistence.
    mountDirectoryBrowser,
    mountOnboardingSurface,
    mountDiffBlock,
    mountPrimitiveLabFromScope(root: HTMLElement, legacyScope: LegacyScopeLike): UiDisposer {
        return mountPrimitiveLab(root, createUiScope(legacyScope));
    },
};

Object.defineProperty(globalThis, 'VCPUIUX', {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
});
globalThis.dispatchEvent?.(new CustomEvent('vcp-uiux-ready'));

export { api as uiuxBrowserApi };
