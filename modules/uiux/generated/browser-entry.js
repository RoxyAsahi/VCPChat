import { mountThemePresenter } from './providers/theme.js';
import { createSettingsUiService } from './adapters/settings.js';
import { createUiScope } from './runtime/scope.js';
import { createDomRenderer } from './runtime/dom-renderer.js';
import { createUiServiceRegistry } from './runtime/service-registry.js';
import { settingsUiDefinition } from './adapters/settings.js';
import { createRustAssistantUiService, rustAssistantUiDefinition } from './adapters/rust-assistant.js';
import { createForumConfigUiService, forumConfigUiDefinition } from './adapters/forum-config.js';
import { createAssistantRuntimeUiService, assistantRuntimeUiDefinition } from './adapters/assistant-runtime.js';
import { mountField } from './primitives/field.js';
import { mountButton } from './primitives/button.js';
import { mountSelect } from './primitives/select.js';
import { mountInput } from './primitives/input.js';
import { mountMenu } from './primitives/menu.js';
import { mountModal } from './primitives/modal.js';
import { mountTooltip } from './primitives/tooltip.js';
import { mountHoverCard } from './primitives/hover-card.js';
import { mountDisclosureRow } from './primitives/disclosure-row.js';
import { mountStateDot } from './primitives/state-dot.js';
import { mountChoice } from './primitives/choice.js';
import { mountRange } from './primitives/range.js';
import { mountToggle } from './primitives/toggle.js';
import { mountColorPair } from './primitives/color-pair.js';
import { mountPrimitiveLab } from './lab/primitive-lab.js';
const api = {
    mountThemePresenterFromScope(root, theme, legacyScope) {
        const scope = createUiScope(legacyScope);
        return mountThemePresenter(root, { theme }, { scope, services: { theme } });
    },
    createSettingsUiService,
    createDomRenderer,
    createUiServiceRegistryFromScope(legacyScope) {
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
    mountModal,
    mountTooltip,
    mountHoverCard,
    mountDisclosureRow,
    mountStateDot,
    mountChoice,
    mountRange,
    mountToggle,
    mountColorPair,
    mountPrimitiveLabFromScope(root, legacyScope) {
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
