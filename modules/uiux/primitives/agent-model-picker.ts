import type { UiDisposer, UiScope } from '../contracts.js';
import { createPopupSelectController, mountPopupSelectView, type PopupSelectController } from './popup-select.js';

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
    const pickerScope = scope.child('harness-agent-model-picker');
    const root = document.createElement('span');
    root.className = 'vcp-harness-agent-model-picker';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'vcp-harness-agent-model-picker-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
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
            if (popup.getSnapshot().open) popup.retry();
            else popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker-refresh' } });
        },
        setSelected: id => {
            selectedId = id;
            const selected = lastOptions.find(option => option.id === id);
            if (selected) trigger.textContent = selected.label;
        },
        dispose: async () => { await dispose(); },
    };
}
