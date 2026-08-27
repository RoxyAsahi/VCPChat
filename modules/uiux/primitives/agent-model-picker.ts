import type { UiDisposer, UiScope } from '../contracts.js';
import { createPopupSelectController, mountPopupSelectView, type PopupSelectController } from './popup-select.js';

const STYLE_ID = 'vcp-harness-uiux-agent-model-picker';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-agent-model-picker{position:relative;min-width:0;display:inline-flex}.vcp-harness-agent-model-picker-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 8px;border:0;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary,var(--vcp-color-text,#737780));font:500 13px/20px inherit;cursor:pointer}.vcp-harness-agent-model-picker-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-agent-model-picker-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3,var(--vcp-color-brand,#1677ff))}.vcp-harness-agent-model-picker-trigger:disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-agent-model-picker .vcp-harness-popup-select-card{right:0;left:auto;bottom:calc(100% + 8px);width:min(240px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));border-radius:12px}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row{min-height:38px;padding:6px 8px;border-radius:10px}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row-disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row-disabled:hover{background:transparent}`;
    (document.head || document.documentElement).append(style);
}

export interface AgentModelOption {
    readonly id: string;
    readonly label: string;
    readonly provider?: string;
    readonly favorite?: boolean;
    readonly active?: boolean;
    readonly disabled?: boolean;
}

export interface AgentModelPickerProps {
    readonly label?: string;
    readonly options: (signal: AbortSignal) => Promise<readonly AgentModelOption[]>;
    readonly onSelect: (option: AgentModelOption) => void | Promise<void>;
    readonly selectedId?: string;
    readonly open?: boolean;
}

export interface AgentModelPickerController {
    readonly root: HTMLSpanElement;
    readonly trigger: HTMLButtonElement;
    readonly popup: PopupSelectController;
    open(): void;
    close(): void;
    refresh(): void;
    setSelected(id: string | undefined): void;
    dispose(): UiDisposer | Promise<void>;
}

/**
 * Candidate-only Agent model picker. It mirrors Harness model-selection
 * interaction while keeping model discovery and persistence injected.
 * `agentModel` remains a separate canonical native input in production.
 */
export function mountAgentModelPicker(host: HTMLElement, props: AgentModelPickerProps, scope: UiScope): AgentModelPickerController {
    if (!host || !props?.options || !props?.onSelect || !scope) throw new TypeError('AgentModelPicker requires host, options, onSelect and scope.');
    ensureStyles();
    const pickerScope = scope.child('harness-agent-model-picker');
    const root = document.createElement('span');
    root.className = 'vcp-harness-agent-model-picker';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'vcp-harness-agent-model-picker-trigger';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', props.label ?? 'Select model');
    root.append(trigger);
    host.append(root);

    let selectedId = props.selectedId;
    let lastOptions: readonly AgentModelOption[] = [];
    const loadOptions = async (signal: AbortSignal) => {
        const options = await props.options(signal);
        lastOptions = options;
        return options.map(option => ({
            id: option.id,
            label: option.label,
            detail: [option.provider, option.favorite ? 'Favorite' : undefined].filter(Boolean).join(' · ') || undefined,
            active: option.active === true || option.id === selectedId,
            disabled: option.disabled === true,
        }));
    };
    const popup = createPopupSelectController({
        options: (_context, signal) => loadOptions(signal),
        onSelect: async option => {
            const selected = lastOptions.find(candidate => candidate.id === option.id);
            if (!selected || selected.disabled) return;
            await props.onSelect(selected);
            selectedId = selected.id;
            trigger.textContent = selected.label;
        },
    }, {
        consume: () => true,
        focusComposer: () => trigger.focus(),
    });
    mountPopupSelectView(root, { popup, overlayAria: `${props.label ?? 'Model'} picker`, searchAria: 'Search models' }, pickerScope);
    pickerScope.listen(trigger, 'click', () => {
        if (popup.getSnapshot().open) popup.dismiss();
        else popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } });
    });
    const syncTrigger = () => trigger.setAttribute('aria-expanded', String(popup.getSnapshot().open));
    const unsubscribe = popup.subscribe(syncTrigger);
    pickerScope.own(unsubscribe, 'agent-model-picker-subscription', 'ui-presentation');
    if (props.open === true) popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } });

    const dispose = pickerScope.own(async () => {
        unsubscribe();
        popup.dispose();
        root.remove();
    }, 'agent-model-picker', 'ui-primitive');
    return {
        root,
        trigger,
        popup,
        open: () => popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } }),
        close: () => popup.dismiss(),
        refresh: () => {
            if (popup.getSnapshot().open) popup.dismiss();
            popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker-refresh' } });
        },
        setSelected: id => {
            selectedId = id;
            const selected = lastOptions.find(option => option.id === id);
            if (selected) trigger.textContent = selected.label;
        },
        dispose: async () => { await dispose(); },
    };
}
