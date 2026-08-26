import type { UiDisposer, UiScope } from '../contracts.js';

export interface SelectProps { readonly label?: string; readonly portal?: boolean; }

const STYLE_ID = 'vcp-harness-uiux-primitives';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-select{position:relative;display:inline-flex;min-width:218px}.vcp-harness-select>.vcp-harness-select-native{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important}.vcp-harness-select>.vcp-harness-select-trigger{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,var(--vcp-color-border,#c8ccd4));border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--vcp-color-surface,#fff));color:var(--dsw-alias-label-primary,var(--vcp-color-text,#1f2329));font:inherit;font-size:14px;line-height:22px;cursor:pointer}.vcp-harness-select>.vcp-harness-select-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--vcp-color-focus,#4c8dff));outline-offset:2px}.vcp-harness-select>.vcp-harness-menu-list,.vcp-uiux-primitive-menu{z-index:1000;min-width:218px;padding:4px;background:var(--dsw-alias-bg-layer-1,var(--vcp-color-surface,#fff));border:1px solid var(--dsw-alias-border-l2,var(--vcp-color-border,#c8ccd4));border-radius:12px;box-shadow:0 8px 24px rgb(0 0 0/.14)}.vcp-harness-menu-viewport{display:flex;flex-direction:column;min-height:0}.vcp-harness-menu-item-wrap{position:relative}.vcp-uiux-primitive-menu .vcp-harness-menu-item{display:flex;align-items:center;width:100%;min-height:40px;padding:8px 10px;gap:8px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary,var(--vcp-color-text,#1f2329));font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}.vcp-uiux-primitive-menu .vcp-harness-menu-item:hover:not(:disabled),.vcp-uiux-primitive-menu .vcp-harness-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,var(--vcp-color-surface-selected,#eef3ff))}.vcp-uiux-primitive-menu .vcp-harness-menu-item:disabled{opacity:.5;cursor:not-allowed}.vcp-harness-menu-item-check{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary,var(--vcp-color-text,#1f2329))}.vcp-harness-menu-item-check::before{content:'✓';font-size:14px;line-height:16px}.vcp-harness-field-description{margin-top:4px;color:var(--dsw-alias-label-secondary,var(--vcp-color-muted,#68707d));font-size:12px;line-height:18px}.vcp-harness-field-error{margin-top:4px;color:var(--dsw-alias-label-danger,var(--vcp-color-danger,#c62828));font-size:12px;line-height:18px}`;
    (document.head || document.documentElement).append(style);
}

/**
 * Harness-compatible Select shell over an existing native select. The native
 * element remains the business/serialization source; the Light-DOM trigger
 * and menu are disposable presentation nodes.
 */
export function mountSelect(select: HTMLSelectElement, props: SelectProps = {}, scope: UiScope): UiDisposer {
    if (!select || !scope) throw new TypeError('Select requires select and scope.');
    ensureStyles();
    const originalTabIndex = select.getAttribute('tabindex');
    const originalAriaHidden = select.getAttribute('aria-hidden');
    const previousActive = document.activeElement;
    const wrap = document.createElement('span'); wrap.className = 'vcp-harness-select';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'vcp-harness-select-trigger';
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    if (props.label) trigger.setAttribute('aria-label', props.label);
    const menu = document.createElement('div'); menu.className = 'vcp-harness-menu-list vcp-uiux-primitive-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
    const viewport = document.createElement('div'); viewport.className = 'vcp-harness-menu-viewport'; menu.append(viewport);
    select.classList.add('vcp-harness-select-native');
    trigger.setAttribute('aria-controls', `${select.id || 'vcp-select'}-menu`);
    menu.id = `${select.id || 'vcp-select'}-menu`;
    const sync = () => {
        const selected = select.options[select.selectedIndex];
        trigger.textContent = selected?.textContent?.trim() || props.label || '选择';
        Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).forEach((item, index) => {
            const active = index === select.selectedIndex; item.dataset.selected = String(active); item.setAttribute('aria-checked', String(active)); item.tabIndex = active ? 0 : -1; const check = item.querySelector<HTMLElement>('.vcp-harness-menu-item-check'); if (check) check.hidden = !active;
        });
    };
    const close = (restoreFocus = false) => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (menu.parentNode !== wrap) wrap.append(menu); if (restoreFocus && document.contains(trigger)) trigger.focus(); };
    const open = () => { if (select.disabled) return; menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); if (props.portal) document.body.append(menu); const current = menu.querySelector<HTMLElement>('[data-selected="true"]'); (current || menu.querySelector<HTMLElement>('[role="menuitem"]'))?.focus(); };
    const onTrigger = () => trigger.getAttribute('aria-expanded') === 'true' ? close() : open();
    const onChange = () => sync();
    const onSync = () => sync();
    Array.from(select.options).forEach((option, index) => {
        const itemWrap = document.createElement('div'); itemWrap.className = 'vcp-harness-menu-item-wrap';
        const item = document.createElement('button'); item.type = 'button'; item.className = 'vcp-harness-menu-item'; item.setAttribute('role', 'menuitem'); item.textContent = option.textContent?.trim() || ''; item.disabled = option.disabled; const check = document.createElement('span'); check.className = 'vcp-harness-menu-item-check'; check.setAttribute('aria-hidden', 'true'); check.hidden = true; item.append(check); itemWrap.append(item);
        scope.listen(item, 'click', () => { if (!option.disabled) { select.selectedIndex = index; const EventCtor = select.ownerDocument.defaultView?.Event ?? Event; select.dispatchEvent(new EventCtor('change', { bubbles: true })); close(true); } }); viewport.append(itemWrap);
    });
    select.parentNode?.insertBefore(wrap, select); wrap.append(select, trigger, menu); select.tabIndex = -1;
    scope.listen(trigger, 'click', onTrigger); scope.listen(select, 'change', onChange); scope.listen(select, 'vcp-uiux-sync', onSync);
    scope.listen(document, 'pointerdown', event => { if (!wrap.contains(event.target as Node) && !menu.contains(event.target as Node)) close(); }, { capture: true });
    scope.listen(document, 'keydown', event => {
        const key = (event as KeyboardEvent).key;
        if (menu.hidden) return;
        if (key === 'Escape') { event.preventDefault(); close(true); return; }
        const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
        if (!items.length) return;
        const index = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
        const next = key === 'ArrowDown' ? (index + 1) % items.length : key === 'ArrowUp' ? (index - 1 + items.length) % items.length : key === 'Home' ? 0 : key === 'End' ? items.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); items[next].focus(); }
    });
    sync();
    return scope.own(() => { close(false); if (originalTabIndex === null) select.removeAttribute('tabindex'); else select.setAttribute('tabindex', originalTabIndex); if (originalAriaHidden === null) select.removeAttribute('aria-hidden'); else select.setAttribute('aria-hidden', originalAriaHidden); select.classList.remove('vcp-harness-select-native'); wrap.replaceWith(select); if (previousActive && typeof (previousActive as HTMLElement).focus === 'function' && document.contains(previousActive)) (previousActive as HTMLElement).focus(); }, 'harness-select', 'ui-primitive');
}
