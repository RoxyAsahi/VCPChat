import type { UiDisposer, UiScope } from '../contracts.js';
import { createPopupSelectController, mountPopupSelectView, type PopupSelectController } from './popup-select.js';
import { mountSemanticIcon } from './semantic-icon.js';

const STYLE_ID = 'vcp-harness-uiux-agent-model-picker';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-agent-model-picker{position:relative;min-width:0;display:inline-flex}.vcp-harness-agent-model-picker-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:0;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary,var(--vcp-color-text,#737780));font-family:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer}.vcp-harness-agent-model-picker-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-agent-model-picker-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3,var(--vcp-color-brand,#1677ff))}.vcp-harness-agent-model-picker-trigger:disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-agent-model-picker-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-agent-model-picker-trigger-icon{flex:none;transition:transform 120ms ease}.vcp-harness-agent-model-picker-trigger[aria-expanded="true"] .vcp-harness-agent-model-picker-trigger-icon{transform:rotate(180deg)}.vcp-harness-agent-model-picker .vcp-harness-popup-select-card{right:auto;left:0;top:calc(100% + 8px);bottom:auto;width:min(240px,calc(100vw - 32px));max-width:min(240px,calc(100vw - 32px));box-sizing:border-box;max-height:min(360px,calc(100vh - 96px));border-radius:12px}.vcp-harness-agent-model-picker-cell{display:flex;align-items:center;gap:8px;width:100%;height:40px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}.vcp-harness-agent-model-picker-cell:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-agent-model-picker-cell-label{flex:1;min-width:0}.vcp-harness-agent-model-picker-cell-value{color:var(--dsw-alias-label-tertiary,#737780);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row{min-height:38px;padding:6px 8px;border-radius:10px}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row-disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row-disabled:hover{background:transparent}`;
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

export interface AgentModelEffortOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export interface AgentModelPickerProps {
    readonly label?: string;
    readonly options: (signal: AbortSignal) => Promise<readonly AgentModelOption[]>;
    readonly onSelect: (option: AgentModelOption) => void | Promise<void>;
    readonly efforts?: readonly AgentModelEffortOption[];
    readonly onEffortSelect?: (option: AgentModelEffortOption) => void | Promise<void>;
    readonly selectedEffort?: string;
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
    setPane(pane: 'root' | 'model' | 'effort'): void;
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
    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'vcp-harness-agent-model-picker-trigger-label';
    triggerLabel.textContent = 'Select model';
    trigger.append(triggerLabel);
    const triggerIcon = document.createElement('span');
    triggerIcon.className = 'vcp-harness-agent-model-picker-trigger-icon';
    mountSemanticIcon(triggerIcon, { name: 'chevron-down', size: 14 }, pickerScope);
    trigger.append(triggerIcon);
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
            triggerLabel.textContent = selected.label;
        },
    }, {
        consume: () => true,
        focusComposer: () => trigger.focus(),
    });
    let pane: 'root' | 'model' | 'effort' = 'root';
    let selectedEffort = props.selectedEffort;
    const view = mountPopupSelectView(root, {
        popup,
        overlayAria: `${props.label ?? 'Model'} picker`,
        searchAria: 'Search models',
        onEscape: () => {
            if (pane === 'root') return false;
            pane = 'root';
            syncPane();
            return true;
        },
    }, pickerScope);
    const paneCell = document.createElement('button');
    paneCell.type = 'button';
    paneCell.className = 'vcp-harness-agent-model-picker-cell';
    paneCell.setAttribute('role', 'menuitem');
    paneCell.innerHTML = '<span class="vcp-harness-agent-model-picker-cell-label">Model</span><span class="vcp-harness-agent-model-picker-cell-value"></span><span aria-hidden="true">›</span>';
    paneCell.addEventListener('click', () => { pane = 'model'; syncPane(); });
    const effortCell = document.createElement('button');
    effortCell.type = 'button';
    effortCell.className = 'vcp-harness-agent-model-picker-cell';
    effortCell.setAttribute('role', 'menuitem');
    effortCell.innerHTML = '<span class="vcp-harness-agent-model-picker-cell-label">Effort</span><span class="vcp-harness-agent-model-picker-cell-value"></span><span aria-hidden="true">›</span>';
    effortCell.addEventListener('click', () => { pane = 'effort'; syncPane(); });
    const effortList = document.createElement('div');
    effortList.className = 'vcp-harness-agent-model-picker-effort-list';
    effortList.setAttribute('role', 'group');
    view.card.prepend(effortCell, effortList);
    const renderEfforts = () => {
        effortList.replaceChildren();
        for (const option of props.efforts ?? []) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'vcp-harness-agent-model-picker-option';
            row.setAttribute('role', 'menuitemradio');
            row.setAttribute('aria-checked', String(option.id === selectedEffort));
            const copy = document.createElement('span');
            copy.className = 'vcp-harness-agent-model-picker-option-copy';
            const label = document.createElement('span');
            label.className = 'vcp-harness-agent-model-picker-option-label';
            label.textContent = option.label;
            copy.append(label);
            if (option.description) {
                const description = document.createElement('span');
                description.className = 'vcp-harness-agent-model-picker-option-description';
                description.textContent = option.description;
                copy.append(description);
            }
            const check = document.createElement('span');
            check.setAttribute('aria-hidden', 'true');
            check.textContent = option.id === selectedEffort ? '✓' : '';
            row.append(copy, check);
            row.addEventListener('click', async () => {
                selectedEffort = option.id;
                await props.onEffortSelect?.(option);
                pane = 'root';
                syncPane();
            });
            effortList.append(row);
        }
    };
    view.card.prepend(paneCell);
    const syncPane = () => {
        const open = popup.getSnapshot().open;
        paneCell.querySelector('.vcp-harness-agent-model-picker-cell-value')!.textContent = triggerLabel.textContent || 'Select model';
        paneCell.hidden = !open || pane !== 'root';
        effortCell.hidden = !open || pane !== 'root' || !(props.efforts?.length);
        effortCell.querySelector('.vcp-harness-agent-model-picker-cell-value')!.textContent = selectedEffort ?? 'Provider default';
        effortList.hidden = !open || pane !== 'effort';
        view.search.hidden = pane !== 'model';
        view.card.querySelector('.vcp-harness-popup-select-viewport')?.toggleAttribute('hidden', pane !== 'model');
        view.card.querySelector('.vcp-harness-popup-select-status')?.toggleAttribute('hidden', pane !== 'model');
        view.card.querySelector('.vcp-harness-popup-select-error')?.toggleAttribute('hidden', pane !== 'model');
        renderEfforts();
    };
    pickerScope.listen(trigger, 'click', () => {
        if (popup.getSnapshot().open) popup.dismiss();
        else popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } });
    });
    const syncTrigger = () => trigger.setAttribute('aria-expanded', String(popup.getSnapshot().open));
    const unsubscribe = popup.subscribe(() => { syncTrigger(); syncPane(); });
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
        open: () => { pane = 'root'; popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } }); },
        // Closing from the trigger/picker surface must return focus to the
        // trigger, matching the Harness menu focus contract.
        close: () => popup.dismiss({ focusComposer: true }),
        refresh: () => {
            if (popup.getSnapshot().open) popup.dismiss();
            pane = 'root'; popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker-refresh' } });
        },
        setSelected: id => {
            selectedId = id;
            const selected = lastOptions.find(option => option.id === id);
            if (selected) triggerLabel.textContent = selected.label;
        },
        setPane: next => { pane = next; syncPane(); },
        dispose: async () => { await dispose(); },
    };
}
