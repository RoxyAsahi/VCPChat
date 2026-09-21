/* Resizer ownership adapter for Workspace Side Pane, wrapping VCPSidebarResizer. */
'use strict';

export function createSidePaneResizerOwner({
    handle,
    paneElement,
    resizerFactory = (typeof window !== 'undefined' ? window.VCPSidebarResizer?.create : null),
    minWidth = 240,
    maxRatio = 0.65,
    minMainContentWidth = 420,
    onWidthChange = null,
    onWidthCommit = null,
    scope = null,
    documentRef = (typeof document !== 'undefined' ? document : null),
    windowRef = (typeof window !== 'undefined' ? window : null)
}) {
    if (!handle || !paneElement) {
        throw new TypeError('SidePaneResizerOwner requires a handle and paneElement');
    }
    if (typeof resizerFactory !== 'function') {
        throw new Error('VCPSidebarResizer factory is not available');
    }

    const doc = documentRef || handle.ownerDocument || globalThis.document;
    const win = windowRef || doc?.defaultView || globalThis.window;

    function getBounds() {
        const totalWidth = win?.innerWidth || 1200;
        const maxFromRatio = Math.round(totalWidth * maxRatio);
        const maxFromRemainder = Math.max(minWidth, totalWidth - minMainContentWidth);
        const max = Math.max(minWidth, Math.min(maxFromRatio, maxFromRemainder));
        return {
            min: minWidth,
            max
        };
    }

    const eventNames = (typeof win?.PointerEvent === 'function')
        ? { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel' }
        : { down: 'mousedown', move: 'mousemove', up: 'mouseup', cancel: 'mouseleave' };

    let isDisposed = false;

    const resizer = resizerFactory({
        handle,
        document: doc,
        eventNames,
        direction: -1, // Right sidebar: dragging left increases width
        step: 16,
        getValue: () => paneElement.getBoundingClientRect().width,
        getBounds,
        applyValue: (width) => {
            if (isDisposed) return;
            paneElement.style.width = `${Math.round(width)}px`;
            onWidthChange?.(Math.round(width));
        },
        onActiveChange: (active) => {
            if (isDisposed || !doc?.body) return;
            doc.body.style.cursor = active ? 'col-resize' : '';
            doc.body.style.userSelect = active ? 'none' : '';
            doc.body.classList.toggle('vcp-sidebar-resizing', active);
            paneElement.style.transition = active ? 'none' : '';
            handle.classList.toggle('active', active);
        },
        onCommit: (width) => {
            if (isDisposed) return;
            const finalWidth = Math.round(width);
            onWidthCommit?.(finalWidth);
        }
    });

    const owner = Object.freeze({
        refresh() {
            if (!isDisposed) resizer?.refresh?.();
        },
        dispose() {
            if (isDisposed) return;
            isDisposed = true;
            resizer?.dispose?.();
        }
    });

    if (scope && typeof scope.own === 'function') {
        scope.own(owner, 'side-pane-resizer-owner');
    }

    return owner;
}

const api = Object.freeze({ createSidePaneResizerOwner });

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSidePaneResizerOwner = api;
}

export default api;
