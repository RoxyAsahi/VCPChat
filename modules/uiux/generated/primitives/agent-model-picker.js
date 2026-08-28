import { createPopupSelectController, mountPopupSelectView } from './popup-select.js';
import { mountSemanticIcon } from './semantic-icon.js';
const STYLE_ID = 'vcp-harness-uiux-agent-model-picker';
let pickerSequence = 0;
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-agent-model-picker{position:relative;min-width:0;display:inline-flex}.vcp-harness-agent-model-picker-trigger{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:0;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary,var(--vcp-color-text,#737780));font-family:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer}.vcp-harness-agent-model-picker-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-agent-model-picker-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3,var(--vcp-color-brand,#1677ff))}.vcp-harness-agent-model-picker-trigger:disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-agent-model-picker-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-agent-model-picker-trigger-icon{flex:none;transition:transform 120ms ease}.vcp-harness-agent-model-picker-trigger[aria-expanded="true"] .vcp-harness-agent-model-picker-trigger-icon{transform:rotate(180deg)}.vcp-harness-agent-model-picker .vcp-harness-popup-select-card{right:0;left:auto;bottom:calc(100% + 8px);top:auto;width:min(240px,calc(100vw - 32px));max-width:min(240px,calc(100vw - 32px));box-sizing:border-box;max-height:min(360px,calc(100vh - 96px));border-radius:12px}.vcp-harness-agent-model-picker-cell{display:flex;align-items:center;gap:8px;width:100%;height:40px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}.vcp-harness-agent-model-picker-cell:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-agent-model-picker-cell-label{flex:1;min-width:0}.vcp-harness-agent-model-picker-cell-value{color:var(--dsw-alias-label-tertiary,#737780);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row{min-height:38px;padding:6px 8px;border-radius:10px}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row-disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-agent-model-picker .vcp-harness-popup-select-row-disabled:hover{background:transparent}`;
    (document.head || document.documentElement).append(style);
}
/**
 * Candidate-only Agent model picker. It mirrors Harness model-selection
 * interaction while keeping model discovery and persistence injected.
 * `agentModel` remains a separate canonical native input in production.
 */
export function mountAgentModelPicker(host, props, scope) {
    if (!host || !props?.options || !props?.onSelect || !scope)
        throw new TypeError('AgentModelPicker requires host, options, onSelect and scope.');
    ensureStyles();
    const pickerScope = scope.child('harness-agent-model-picker');
    const root = document.createElement('span');
    root.className = 'vcp-harness-agent-model-picker';
    const trigger = props.trigger ?? document.createElement('button');
    const originalTriggerClass = trigger.getAttribute('class');
    const originalTriggerType = trigger.getAttribute('type');
    const originalTriggerAria = {
        haspopup: trigger.getAttribute('aria-haspopup'),
        expanded: trigger.getAttribute('aria-expanded'),
        label: trigger.getAttribute('aria-label'),
        controls: trigger.getAttribute('aria-controls'),
    };
    const originalTriggerMarkup = trigger.innerHTML;
    if (!props.trigger)
        trigger.type = 'button';
    trigger.classList.add('vcp-harness-agent-model-picker-trigger');
    trigger.replaceChildren();
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
    if (!props.trigger)
        root.append(trigger);
    host.append(root);
    let selectedId = props.selectedId;
    let lastOptions = [];
    const loadOptions = async (signal) => {
        const options = await props.options(signal);
        lastOptions = options;
        return options.map(option => ({
            id: option.id,
            label: option.label,
            detail: props.harnessEquivalent === true
                ? undefined
                : [option.provider, option.favorite ? 'Favorite' : undefined].filter(Boolean).join(' · ') || undefined,
            group: option.provider,
            active: option.active === true || option.id === selectedId,
            disabled: option.disabled === true,
        }));
    };
    const popup = createPopupSelectController({
        options: (_context, signal) => loadOptions(signal),
        onSelect: async (option) => {
            const selected = lastOptions.find(candidate => candidate.id === option.id);
            if (!selected || selected.disabled)
                return;
            await props.onSelect(selected);
            selectedId = selected.id;
            triggerLabel.textContent = selected.label;
        },
    }, {
        consume: () => true,
        focusComposer: () => trigger.focus(),
    });
    let pane = 'root';
    let selectedEffort = props.selectedEffort;
    const view = mountPopupSelectView(root, {
        popup,
        anchor: trigger,
        overlayAria: `${props.label ?? 'Model'} picker`,
        searchAria: 'Search models',
        searchEnabled: props.searchEnabled,
        grouped: props.harnessEquivalent === true,
        optionRole: props.harnessEquivalent === true ? 'menuitemradio' : 'option',
        onEscape: () => {
            if (pane === 'root')
                return false;
            pane = 'root';
            syncPane();
            return true;
        },
    }, pickerScope);
    const menuId = `vcp-harness-agent-model-picker-menu-${++pickerSequence}`;
    view.card.id = menuId;
    trigger.setAttribute('aria-controls', menuId);
    const paneCell = document.createElement('button');
    paneCell.type = 'button';
    paneCell.className = 'vcp-harness-agent-model-picker-cell';
    paneCell.setAttribute('role', 'menuitem');
    paneCell.innerHTML = '<span class="vcp-harness-agent-model-picker-cell-label">Model</span><span class="vcp-harness-agent-model-picker-cell-value"></span><span aria-hidden="true">›</span>';
    pickerScope.listen(paneCell, 'click', () => { pane = 'model'; syncPane(); });
    const effortCell = document.createElement('button');
    effortCell.type = 'button';
    effortCell.className = 'vcp-harness-agent-model-picker-cell';
    effortCell.setAttribute('role', 'menuitem');
    effortCell.innerHTML = '<span class="vcp-harness-agent-model-picker-cell-label">Effort</span><span class="vcp-harness-agent-model-picker-cell-value"></span><span aria-hidden="true">›</span>';
    pickerScope.listen(effortCell, 'click', () => { pane = 'effort'; syncPane(); });
    const effortList = document.createElement('div');
    effortList.className = 'vcp-harness-agent-model-picker-effort-list';
    effortList.setAttribute('role', 'group');
    view.card.prepend(effortCell, effortList);
    let effortSelectionGeneration = 0;
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
            pickerScope.listen(row, 'click', async () => {
                const generation = ++effortSelectionGeneration;
                await props.onEffortSelect?.(option);
                if (!pickerScope.active || generation !== effortSelectionGeneration)
                    return;
                selectedEffort = option.id;
                pane = 'root';
                syncPane();
            });
            effortList.append(row);
        }
    };
    view.card.prepend(paneCell);
    const invalidateEffortSelection = () => { effortSelectionGeneration += 1; };
    const placeExternalCard = () => {
        if (!props.trigger || !popup.getSnapshot().open || !view.card.getClientRects().length)
            return;
        const portal = document.body || document.documentElement;
        if (portal && view.card.parentElement !== portal)
            portal.append(view.card);
        const anchorRect = trigger.getBoundingClientRect();
        const cardRect = view.card.getBoundingClientRect();
        const margin = 8;
        const maxLeft = Math.max(margin, window.innerWidth - cardRect.width - margin);
        const left = Math.min(maxLeft, Math.max(margin, anchorRect.right - cardRect.width));
        const above = anchorRect.top - cardRect.height - margin;
        const top = above >= margin ? above : Math.min(window.innerHeight - cardRect.height - margin, anchorRect.bottom + margin);
        view.card.style.position = 'fixed';
        view.card.style.left = `${left}px`;
        view.card.style.right = 'auto';
        view.card.style.top = `${Math.max(margin, top)}px`;
        view.card.style.bottom = 'auto';
    };
    const syncPane = () => {
        const open = popup.getSnapshot().open;
        const setVisibility = (element, visible) => {
            element.hidden = !visible;
            element.style.display = visible ? '' : 'none';
        };
        paneCell.querySelector('.vcp-harness-agent-model-picker-cell-value').textContent = triggerLabel.textContent || 'Select model';
        setVisibility(paneCell, open && pane === 'root');
        setVisibility(effortCell, open && pane === 'root' && Boolean(props.efforts?.length));
        effortCell.querySelector('.vcp-harness-agent-model-picker-cell-value').textContent = selectedEffort ?? 'Provider default';
        setVisibility(effortList, open && pane === 'effort');
        setVisibility(view.search, pane === 'model' && props.searchEnabled !== false);
        const viewport = view.card.querySelector('.vcp-harness-popup-select-viewport');
        const status = view.card.querySelector('.vcp-harness-popup-select-status');
        const error = view.card.querySelector('.vcp-harness-popup-select-error');
        if (viewport)
            setVisibility(viewport, open && pane === 'model');
        if (status) {
            status.hidden = !(open && pane === 'model');
            status.style.display = open && pane === 'model' && status.textContent !== '' ? '' : 'none';
        }
        if (error) {
            error.hidden = !(open && pane === 'model');
            // PopupSelectView owns the error text.  DOM text can outlive a
            // successful retry, so it must never become an independent
            // visibility source here: only the controller snapshot decides
            // whether the in-menu load strip is visible.
            error.style.display = open && pane === 'model' && popup.getSnapshot().error !== null ? '' : 'none';
        }
        renderEfforts();
        placeExternalCard();
    };
    pickerScope.listen(trigger, 'click', event => {
        // Agent Settings already has a legacy listener on this canonical
        // button. Capture-phase interception keeps that behavior available
        // after disposal without proxying through a hidden control.
        event.stopImmediatePropagation();
        if (popup.getSnapshot().open) {
            invalidateEffortSelection();
            popup.dismiss();
        }
        else {
            invalidateEffortSelection();
            pane = 'root';
            popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } });
        }
    }, { capture: true });
    const syncTrigger = () => trigger.setAttribute('aria-expanded', String(popup.getSnapshot().open));
    const unsubscribe = popup.subscribe(() => { syncTrigger(); syncPane(); });
    pickerScope.own(unsubscribe, 'agent-model-picker-subscription', 'ui-presentation');
    pickerScope.listen(window, 'resize', placeExternalCard);
    pickerScope.listen(document, 'scroll', placeExternalCard, { capture: true });
    if (props.open === true)
        popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } });
    pickerScope.own(async () => {
        unsubscribe();
        popup.dispose();
        root.remove();
        trigger.replaceChildren();
        trigger.innerHTML = originalTriggerMarkup;
        if (originalTriggerClass === null)
            trigger.removeAttribute('class');
        else
            trigger.setAttribute('class', originalTriggerClass);
        if (originalTriggerType === null)
            trigger.removeAttribute('type');
        else
            trigger.setAttribute('type', originalTriggerType);
        const restoreAttribute = (name, value) => {
            if (value === null)
                trigger.removeAttribute(name);
            else
                trigger.setAttribute(name, value);
        };
        restoreAttribute('aria-haspopup', originalTriggerAria.haspopup);
        restoreAttribute('aria-expanded', originalTriggerAria.expanded);
        restoreAttribute('aria-label', originalTriggerAria.label);
        restoreAttribute('aria-controls', originalTriggerAria.controls);
    }, 'agent-model-picker', 'ui-primitive');
    return {
        root,
        trigger,
        popup,
        open: () => { invalidateEffortSelection(); pane = 'root'; popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker' } }); },
        // Closing from the trigger/picker surface must return focus to the
        // trigger, matching the Harness menu focus contract.
        close: () => { invalidateEffortSelection(); popup.dismiss({ focusComposer: true }); },
        refresh: () => {
            invalidateEffortSelection();
            if (popup.getSnapshot().open)
                popup.dismiss();
            pane = 'root';
            popup.open('agent-model', {}, { via: 'menu', span: { source: 'agent-model-picker-refresh' } });
        },
        setSelected: id => {
            selectedId = id;
            const selected = lastOptions.find(option => option.id === id);
            if (selected)
                triggerLabel.textContent = selected.label;
        },
        setPane: next => { invalidateEffortSelection(); pane = next; syncPane(); },
        // Dispose the child scope itself so listeners, subscriptions, icon
        // owners and the popup binding all reach quiescence on surface swap.
        dispose: async () => { invalidateEffortSelection(); await pickerScope.dispose('agent-model-picker-disposed'); },
    };
}
