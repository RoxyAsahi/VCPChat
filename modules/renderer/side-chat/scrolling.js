/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

export function createSideChatScrolling({
    store,
    doc,
    root
}) {
    const disposeCleanups = [];
    let stickToBottom = true;

    let lastScrollTop = 0;

    function pinToBottomIfSticky() {
        if (!store.isDisposed && stickToBottom && root && root.clientHeight > 0) {
            root.scrollTop = root.scrollHeight;
        }
    }

    if (root) {
        const onRootScroll = () => {
            if (root.clientHeight === 0) return;
            // 只有往上滚才算离开底部；内容增长、布局变化引起的滚动事件不改变贴底状态
            if (root.scrollHeight - root.scrollTop - root.clientHeight < 48) stickToBottom = true;
            else if (root.scrollTop < lastScrollTop - 1) stickToBottom = false;
            lastScrollTop = root.scrollTop;
        };
        root.addEventListener('scroll', onRootScroll, { passive: true });
        disposeCleanups.push(() => root.removeEventListener('scroll', onRootScroll));
        const ResizeObserverClass = doc.defaultView?.ResizeObserver || globalThis.ResizeObserver;
        if (ResizeObserverClass) {
            const rootResizeObserver = new ResizeObserverClass(pinToBottomIfSticky);
            rootResizeObserver.observe(root);
            // 也盯着每条消息的高度：流式结束后的整段重排、代码高亮、图片加载都会在最后一次贴底之后
            // 再长高，只看容器尺寸会停在离底部几十像素的地方（ZCode 的 use-stick-to-bottom 同样观察内容尺寸）
            const observeChild = node => { if (node.nodeType === 1) rootResizeObserver.observe(node); };
            root.childNodes.forEach(observeChild);
            const MutationObserverClass = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
            const childObserver = MutationObserverClass ? new MutationObserverClass(records => {
                for (const record of records) {
                    record.addedNodes.forEach(observeChild);
                    record.removedNodes.forEach(node => { if (node.nodeType === 1) rootResizeObserver.unobserve(node); });
                }
            }) : null;
            childObserver?.observe(root, { childList: true });
            disposeCleanups.push(() => {
                childObserver?.disconnect();
                rootResizeObserver.disconnect();
            });
        }
    }

    return Object.freeze({ pinToBottomIfSticky, isSticky: () => stickToBottom, resume() { stickToBottom = true; }, dispose() { disposeCleanups.splice(0).forEach(fn => { try { fn(); } catch {} }); } });
}
