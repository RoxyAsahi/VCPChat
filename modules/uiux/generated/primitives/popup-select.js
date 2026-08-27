import { mountRiskConfirmation } from './risk-confirmation.js';
import { mountSemanticIcon } from './semantic-icon.js';
const STYLE_ID = 'vcp-harness-uiux-popup-select';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-popup-select-card{position:absolute;bottom:calc(100% + 4px);left:0;z-index:100;display:flex;flex-direction:column;padding:4px;min-width:min(220px,100%);max-width:100%;max-height:320px;overflow:hidden;border:1px solid var(--dsw-alias-border-inverted,transparent);border-radius:12px;background:var(--dsw-specific-menu,#fff);box-shadow:var(--dsw-shadow-lv3,0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08));outline:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif}.vcp-harness-popup-select-viewport{display:flex;flex-direction:column;min-height:0;overflow-y:auto}.vcp-harness-popup-select-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:0;border-radius:8px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary,#0f1115);background:transparent;text-align:left}.vcp-harness-popup-select-row-active{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-popup-select-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-popup-select-detail{font-size:12px;color:var(--dsw-alias-label-tertiary,#737780);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-popup-select-check{display:inline-flex;flex:none;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-popup-select-group{display:flex;flex-direction:column}.vcp-harness-popup-select-group-title{padding:5px 8px 3px;color:var(--dsw-alias-label-tertiary,#737780);font-size:12px;line-height:18px;font-weight:500}.vcp-harness-popup-select-option{display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;text-align:left;cursor:pointer}.vcp-harness-popup-select-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-harness-popup-select-option-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:0}.vcp-harness-popup-select-option-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-popup-select-option-detail{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#737780);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-harness-popup-select-option-check{display:inline-flex;flex:none;color:var(--dsw-alias-label-primary,#0f1115)}.vcp-harness-popup-select-option-disabled{color:var(--dsw-alias-label-dimmed,#a0a5ad);cursor:default}.vcp-harness-popup-select-option-disabled:hover{background:transparent}.vcp-harness-popup-select-status{padding:8px 10px;font-size:13px;color:var(--dsw-alias-label-tertiary,#737780)}.vcp-harness-popup-select-search{margin:2px 2px 4px;padding:6px 8px;border:1px solid var(--dsw-alias-border-inverted,transparent);border-radius:8px;background:transparent;font-size:13px;color:var(--dsw-alias-label-primary,#0f1115);outline:none}.vcp-harness-popup-select-error{display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:12px;color:var(--dsw-alias-state-error-primary,#d92d20)}.vcp-harness-popup-select-error-text{flex:1;overflow:hidden;text-overflow:ellipsis}.vcp-harness-popup-select-retry{padding:2px 8px;border:1px solid var(--dsw-alias-border-inverted,transparent);border-radius:6px;background:transparent;font-size:12px;color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer}`;
    // Keep grouped parity geometry aligned with Harness and prevent a
    // horizontal scrollbar from consuming an extra 8px of menu height.
    style.textContent += '.vcp-harness-popup-select-viewport{overflow-x:hidden}.vcp-harness-popup-select-group+.vcp-harness-popup-select-group{margin-top:4px}.vcp-harness-popup-select-option-label{font-size:14px;line-height:20px;font-weight:500}';
    (document.head || document.documentElement).append(style);
}
const POPUP_CLOSED = {
    open: false, command: null, status: 'pending', options: [], search: '', active: 0,
    submitting: false, confirming: null, acknowledged: false, error: null,
};
/**
 * Filter option rows case-insensitively over label and detail (blank search keeps every row).
 * Replicates ui-commands/src/client/popup.ts filterOptions.
 */
export function filterOptions(options, search) {
    const query = search.trim().toLowerCase();
    if (query === '')
        return options;
    return options.filter(option => option.label.toLowerCase().includes(query)
        || (option.detail?.toLowerCase().includes(query) ?? false));
}
/**
 * Headless popupSelect controller replicating ui-commands PopupSelectController:
 * one options load per open, local filtering, single-flight settlement, risk
 * gate before onSelect, late settlements lose write rights through binding
 * identity (dismiss/dispose/reopen swap the binding and abort the fetch).
 */
export function createPopupSelectController(spec, deps) {
    if (!spec?.options || !spec?.onSelect || !deps?.consume || !deps?.focusComposer) {
        throw new TypeError('PopupSelect requires options/onSelect spec and consume/focusComposer deps.');
    }
    const listeners = new Set();
    let snapshot = POPUP_CLOSED;
    let binding = null;
    const emit = () => listeners.forEach(listener => listener());
    const set = (next) => {
        snapshot = { ...snapshot, ...next };
        emit();
    };
    const errorText = (error) => error instanceof Error ? error.message : String(error);
    const runLoad = (current) => {
        spec.options(current.context, current.abort.signal).then(options => {
            if (binding !== current)
                return;
            set({ status: 'ready', options, active: 0, error: null });
        }, (error) => {
            if (binding !== current)
                return;
            this_void_guard(error);
            set({ status: 'failed', options: [], active: 0, error: errorText(error) });
        });
    };
    // The controller never throws from a failed fetch — mirror the source's
    // console.error line verbatim shape without pulling logging config in.
    const this_void_guard = (error) => { void error; };
    const settle = async (current, option) => {
        const s = snapshot;
        if (binding !== current || !s.open || s.submitting)
            return;
        set({ submitting: true, confirming: null, acknowledged: false, error: null });
        try {
            await spec.onSelect(option, current.context);
        }
        catch (error) {
            if (binding !== current)
                return;
            set({ submitting: false, error: errorText(error) });
            return;
        }
        if (binding !== current)
            return;
        deps.consume(current.segment);
        current.abort.abort();
        binding = null;
        snapshot = POPUP_CLOSED;
        emit();
        deps.focusComposer();
    };
    return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        open(command, context, segment) {
            binding?.abort.abort();
            const current = {
                command, context, segment, abort: new AbortController(),
            };
            binding = current;
            snapshot = { ...POPUP_CLOSED, open: true, command };
            emit();
            void spec.options(context, current.abort.signal).then(options => {
                if (binding !== current)
                    return;
                set({ status: 'ready', options, active: 0, error: null });
            }, (error) => {
                if (binding !== current)
                    return;
                set({ status: 'failed', options: [], active: 0, error: errorText(error) });
            });
        },
        retry() {
            const s = snapshot;
            if (binding === null || !s.open || s.status !== 'failed')
                return;
            set({ status: 'pending', error: null });
            runLoad(binding);
        },
        setSearch(search) {
            const s = snapshot;
            if (!s.open || s.submitting || s.confirming !== null || search === s.search)
                return;
            set({ search, active: 0 });
        },
        move(direction) {
            const s = snapshot;
            if (!s.open || s.status !== 'ready' || s.submitting || s.confirming !== null)
                return;
            const rows = filterOptions(s.options, s.search);
            if (rows.length === 0)
                return;
            set({ active: (s.active + direction + rows.length) % rows.length });
        },
        highlight(index) {
            const s = snapshot;
            if (!s.open || s.status !== 'ready' || s.submitting || s.confirming !== null)
                return;
            if (index < 0 || index >= filterOptions(s.options, s.search).length || index === s.active)
                return;
            set({ active: index });
        },
        async select(index) {
            const s = snapshot;
            if (binding === null || !s.open || s.status !== 'ready' || s.submitting || s.confirming !== null)
                return;
            const option = filterOptions(s.options, s.search)[index];
            if (option === undefined)
                return;
            if (option.disabled === true)
                return;
            if (option.confirmation !== undefined) {
                set({ confirming: option, acknowledged: false, error: null });
                return;
            }
            await settle(binding, option);
        },
        acknowledge(acknowledged) {
            const s = snapshot;
            if (!s.open || s.submitting || s.confirming === null || s.acknowledged === acknowledged)
                return;
            set({ acknowledged });
        },
        cancelConfirmation() {
            const s = snapshot;
            if (!s.open || s.submitting || s.confirming === null)
                return;
            set({ confirming: null, acknowledged: false });
        },
        async confirm() {
            const s = snapshot;
            if (binding === null || !s.open || s.submitting || s.confirming === null || !s.acknowledged)
                return;
            await settle(binding, s.confirming);
        },
        dismiss(options) {
            if (binding === null)
                return;
            binding.abort.abort();
            binding = null;
            snapshot = POPUP_CLOSED;
            emit();
            if (options?.focusComposer === true)
                deps.focusComposer();
        },
        dispose() {
            binding?.abort.abort();
            binding = null;
            snapshot = POPUP_CLOSED;
            emit();
        },
    };
}
/**
 * Candidate replication of ui-commands PopupSelectView: an absolutely
 * positioned card (the host is the conversation.input.overlay anchor strip),
 * holding focus in its search input while open. Caller owns placement.
 */
export function mountPopupSelectView(host, props, scope) {
    if (!host || !props?.popup || !scope)
        throw new TypeError('PopupSelectView requires a host, popup controller and scope.');
    ensureStyles();
    const popup = props.popup;
    const viewScope = scope.child('harness-popup-select-view');
    const labels = {
        searchPlaceholder: props.searchPlaceholder ?? 'Search…',
        searchAria: props.searchAria ?? 'Filter options',
        retry: props.retryLabel ?? 'Retry',
        loading: props.statusLoading ?? 'Loading options…',
        applying: props.statusApplying ?? 'Applying…',
        empty: props.statusEmpty ?? 'No options',
        overlayAria: props.overlayAria ?? '/{command} options',
        listboxAria: props.listboxAria ?? '/{command} matches',
    };
    const searchEnabled = props.searchEnabled !== false;
    const grouped = props.grouped === true;
    const optionRole = props.optionRole ?? 'option';
    const template = (pattern, command) => pattern.replace('{command}', String(command));
    const card = document.createElement('div');
    card.className = 'vcp-harness-popup-select-card';
    if (grouped)
        card.style.boxSizing = 'content-box';
    card.setAttribute('role', 'menu');
    card.tabIndex = -1;
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'vcp-harness-popup-select-search';
    search.placeholder = labels.searchPlaceholder;
    search.setAttribute('aria-label', labels.searchAria);
    search.hidden = !searchEnabled;
    const error = document.createElement('div');
    error.className = 'vcp-harness-popup-select-error';
    error.setAttribute('role', 'alert');
    const errorTextSpan = document.createElement('span');
    errorTextSpan.className = 'vcp-harness-popup-select-error-text';
    const retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'vcp-harness-popup-select-retry';
    retryButton.textContent = labels.retry;
    error.append(errorTextSpan, retryButton);
    const status = document.createElement('div');
    status.className = 'vcp-harness-popup-select-status';
    const listbox = document.createElement('div');
    if (optionRole === 'option')
        listbox.setAttribute('role', 'listbox');
    listbox.className = 'vcp-harness-popup-select-viewport';
    card.append(search, error, status, listbox);
    card.remove(); // Closed renders null until the first open snapshot lands.
    let lastOpen = false;
    let riskScope = null;
    let rowsScope = null;
    viewScope.listen(card, 'keydown', event => {
        const s = popup.getSnapshot();
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                popup.move(1);
                return;
            case 'ArrowUp':
                event.preventDefault();
                popup.move(-1);
                return;
            case 'Enter':
                event.preventDefault();
                void popup.select(s.active);
                return;
            case 'Escape':
                event.preventDefault();
                if (props.onEscape?.() === true)
                    return;
                popup.dismiss({ focusComposer: true });
                return;
            default: return; // ArrowLeft/Right fall through: native caret movement.
        }
    });
    viewScope.listen(search, 'input', () => popup.setSearch(search.value));
    viewScope.listen(retryButton, 'click', () => popup.retry());
    viewScope.listen(document, 'pointerdown', event => {
        const s = popup.getSnapshot();
        if (!s.open || s.confirming !== null)
            return;
        const target = event.target;
        if (!(target instanceof Node))
            return;
        if (card.contains(target) || props.anchor?.contains(target))
            return;
        popup.dismiss();
    }, { capture: true });
    const renderRows = (s) => {
        const previousRowsScope = rowsScope;
        const nextRowsScope = viewScope.child('harness-popup-select-rows');
        rowsScope = nextRowsScope;
        void previousRowsScope?.dispose('harness-popup-select-rows-rebuilt');
        listbox.replaceChildren();
        if (s.status !== 'ready')
            return;
        if (optionRole === 'option')
            listbox.setAttribute('aria-label', template(labels.listboxAria, s.command ?? ''));
        else
            listbox.removeAttribute('aria-label');
        const rows = filterOptions(s.options, s.search);
        const renderOption = (option, index) => {
            const row = document.createElement(optionRole === 'menuitemradio' ? 'button' : 'div');
            row.dataset.optionId = option.id;
            if (row.tagName.toLowerCase() === 'button')
                row.setAttribute('type', 'button');
            row.setAttribute('role', optionRole);
            row.setAttribute('aria-disabled', String(option.disabled === true));
            if (optionRole === 'menuitemradio')
                row.setAttribute('aria-checked', String(option.active === true));
            else
                row.setAttribute('aria-selected', String(index === s.active));
            row.className = optionRole === 'menuitemradio'
                ? 'vcp-harness-popup-select-option'
                : (index === s.active
                    ? 'vcp-harness-popup-select-row vcp-harness-popup-select-row-active'
                    : 'vcp-harness-popup-select-row');
            if (option.disabled === true)
                row.classList.add(optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-disabled' : 'vcp-harness-popup-select-row-disabled');
            const copy = document.createElement('span');
            copy.className = optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-copy' : 'vcp-harness-popup-select-label';
            const labelNode = document.createElement('span');
            labelNode.className = optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-label' : '';
            labelNode.textContent = option.label;
            copy.append(labelNode);
            if (option.detail !== undefined) {
                const detail = document.createElement('span');
                detail.className = optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-detail' : 'vcp-harness-popup-select-detail';
                detail.textContent = option.detail;
                copy.append(detail);
            }
            row.append(copy);
            if (option.active === true) {
                const check = document.createElement('span');
                check.className = optionRole === 'menuitemradio' ? 'vcp-harness-popup-select-option-check' : 'vcp-harness-popup-select-check';
                check.setAttribute('aria-hidden', 'true');
                mountSemanticIcon(check, { name: 'check', size: 16 }, nextRowsScope.child('harness-popup-select-check'));
                row.append(check);
            }
            nextRowsScope.listen(row, 'click', () => { if (option.disabled !== true)
                void popup.select(index); });
            nextRowsScope.listen(row, 'mouseenter', () => { if (option.disabled !== true)
                popup.highlight(index); });
            return row;
        };
        if (grouped) {
            const groups = new Map();
            rows.forEach((option, index) => {
                const key = option.group ?? '';
                let group = groups.get(key);
                if (!group) {
                    group = document.createElement('section');
                    group.className = 'vcp-harness-popup-select-group';
                    group.setAttribute('role', 'group');
                    if (key) {
                        const title = document.createElement('div');
                        title.className = 'vcp-harness-popup-select-group-title';
                        title.textContent = key;
                        title.id = `vcp-harness-popup-select-group-title-${groups.size}`;
                        group.setAttribute('aria-labelledby', title.id);
                        group.append(title);
                    }
                    groups.set(key, group);
                    listbox.append(group);
                }
                group.append(renderOption(option, index));
            });
        }
        else
            rows.forEach((option, index) => listbox.append(renderOption(option, index)));
        // Focus ownership sits with the search input, so scrolling the virtual
        // highlight into view is explicit here (source useEffect on `active`).
        listbox.querySelector('[aria-selected="true"], [aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest' });
    };
    const sync = () => {
        const s = popup.getSnapshot();
        if (!s.open && lastOpen) {
            card.remove(); // Dismiss renders null; the anchor stays mounted.
            void rowsScope?.dispose('harness-popup-select-rows-closed');
            rowsScope = null;
            listbox.replaceChildren();
        }
        if (!s.open) {
            lastOpen = false;
            return;
        }
        if (!lastOpen) {
            host.append(card);
            lastOpen = true;
        }
        card.setAttribute('aria-label', template(labels.overlayAria, s.command ?? ''));
        if (s.status === 'pending' || s.submitting)
            card.setAttribute('aria-busy', 'true');
        else
            card.removeAttribute('aria-busy');
        search.value = s.search;
        search.hidden = !searchEnabled;
        search.readOnly = s.submitting;
        // The gated shell hides the picker card and shows only the risk modal.
        card.style.display = s.confirming === null ? '' : 'none';
        if (s.error !== null) {
            error.style.display = '';
            errorTextSpan.textContent = s.error;
            retryButton.style.display = s.status === 'failed' ? '' : 'none';
        }
        else {
            error.style.display = 'none';
        }
        status.style.display = '';
        status.textContent = s.submitting ? labels.applying
            : s.status === 'pending' ? labels.loading
                : s.status === 'ready' && filterOptions(s.options, s.search).length === 0 ? labels.empty
                    : '';
        status.style.display = status.textContent === '' ? 'none' : '';
        renderRows(s);
        if (s.confirming === null && searchEnabled)
            search.focus({ preventScroll: true });
    };
    let renderConfirmingId = null;
    let riskController = null;
    const syncRisk = () => {
        const s = popup.getSnapshot();
        const confirmingId = s.confirming?.id ?? null;
        if (confirmingId === renderConfirmingId) {
            riskController?.setAcknowledged(s.acknowledged);
            return;
        }
        renderConfirmingId = confirmingId;
        void riskController?.dispose();
        riskController = null;
        void riskScope?.dispose('popup-risk-swapped');
        riskScope = null;
        if (s.confirming === null)
            return;
        const confirmation = s.confirming.confirmation;
        if (confirmation === undefined)
            return;
        riskScope = scope.child('harness-popup-select-risk');
        riskController = mountRiskConfirmation({
            title: confirmation.title,
            description: confirmation.description,
            acknowledgeLabel: confirmation.acknowledgeLabel,
            cancelLabel: confirmation.cancelLabel,
            confirmLabel: confirmation.confirmLabel,
            acknowledged: s.acknowledged,
            open: true,
            onAcknowledgedChange: value => popup.acknowledge(value),
            onCancel: () => popup.cancelConfirmation(),
            onConfirm: () => { void popup.confirm(); },
        }, riskScope);
    };
    const unsubscribe = popup.subscribe(() => {
        sync();
        syncRisk();
    });
    const dispose = viewScope.own(async () => {
        unsubscribe();
        await riskScope?.dispose('harness-popup-select-risk-unmounted');
        await rowsScope?.dispose('harness-popup-select-rows-unmounted');
        popup.dispose();
        card.remove();
    }, 'harness-popup-select-view', 'ui-primitive');
    sync();
    syncRisk();
    return {
        card, search, sync: () => { sync(); syncRisk(); }, dispose,
    };
}
