const STYLE_ID = 'vcp-harness-uiux-color-pair';
function ensureStyles() { if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
    return; const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = `.vcp-uiux-color-pair{display:inline-flex;align-items:center;gap:6px;height:32px}.vcp-uiux-color-pair input[type=color]{width:32px;height:32px;padding:2px;border:0;border-radius:8px}.vcp-uiux-color-pair input[type=text]{height:32px;padding:0 8px;border:1px solid var(--vcp-color-border,#c8ccd4);border-radius:8px;font-size:14px;line-height:22px}`; (document.head || document.documentElement).append(style); }
export function mountColorPair(color, text, scope) {
    if (!color || color.type !== 'color' || !text || text.type !== 'text' || !scope)
        throw new TypeError('ColorPair requires color and text inputs.');
    ensureStyles();
    const parent = color.parentNode;
    if (!parent || text.parentNode !== parent)
        throw new Error('ColorPair inputs must share a parent.');
    const wrap = document.createElement('span');
    wrap.className = 'vcp-uiux-color-pair';
    parent.insertBefore(wrap, color);
    wrap.append(color, text);
    const valid = (value) => /^#[0-9a-f]{6}$/i.test(value);
    const syncText = () => { text.value = color.value; };
    const onColor = () => syncText();
    const onText = () => { if (valid(text.value))
        color.value = text.value;
    else
        text.value = color.value; };
    scope.listen(color, 'input', onColor);
    scope.listen(color, 'change', onColor);
    scope.listen(text, 'change', onText);
    syncText();
    return scope.own(() => { if (color.parentNode === wrap)
        parent.insertBefore(color, wrap); if (text.parentNode === wrap)
        parent.append(text); wrap.remove(); }, 'harness-color-pair', 'ui-primitive');
}
