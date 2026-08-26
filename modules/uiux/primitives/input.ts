import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-input';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-uiux-input-wrap{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid var(--vcp-color-border,#c8ccd4);border-radius:8px;background:var(--vcp-color-surface,#fff)}.vcp-uiux-input-wrap:focus-within{border-color:var(--vcp-color-brand,#1677ff)}.vcp-uiux-input-wrap>input{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:14px;line-height:22px;color:var(--vcp-color-text,#1f2329)}`;
    (document.head || document.documentElement).append(style);
}

export interface InputProps { readonly placeholder?: string; }

/** Harness Input contract: native input remains the authoritative control. */
export function mountInput(input: HTMLInputElement, props: InputProps = {}, scope: UiScope): UiDisposer {
    if (!input || !scope) throw new TypeError('Input requires input and scope.');
    ensureStyles();
    const parent = input.parentNode;
    if (!parent) throw new Error('Input requires a connected parent.');
    const wrap = document.createElement('span');
    wrap.className = 'vcp-uiux-input-wrap';
    if (props.placeholder !== undefined) input.placeholder = props.placeholder;
    parent.insertBefore(wrap, input);
    wrap.append(input);
    return scope.own(() => { if (input.parentNode === wrap) parent.insertBefore(input, wrap); wrap.remove(); }, 'harness-input', 'ui-primitive');
}
