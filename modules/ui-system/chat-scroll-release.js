/**
 * modules/ui-system/chat-scroll-release.js
 * 让「程序化跳转」（对话内查找、轮次导航……）不被聊天区的「粘底跟随」拽回底部。
 *
 * modules/ui-helpers.js 的聊天滚动状态机把「跟随底部」当作用户授予的意图：只有向上滚轮、触摸、拖滚动条
 * 才会关掉它，程序自己 scrollIntoView / scrollTo 走开并不会。长话题里消息用 content-visibility: auto，
 * 滚动途中屏幕外的消息被真正渲染、内容增高，ResizeObserver 看到「仍在跟随」就把滚动位置补回底部，
 * 跳转刚开始就被拽回去（在 94 条的真实话题里，点轮次导航条完全没反应）。
 *
 * ui-helpers.js 在上游边界内不能改，所以这里用它已有的公开入口：给滚动容器派发一次向上滚轮——
 * 和用户自己往上滚完全等价。之后用户滚回底部（向下滚轮 / 拖滚动条）会重新开启跟随。
 */

'use strict';

/** @param {HTMLElement|null} scroller 主聊天的 .chat-messages-container */
export function releaseChatBottomFollow(scroller) {
    const WheelEventCtor = scroller?.ownerDocument?.defaultView?.WheelEvent;
    if (!scroller || typeof WheelEventCtor !== 'function') return false;
    scroller.dispatchEvent(new WheelEventCtor('wheel', { deltaY: -1, deltaMode: 0 }));
    return true;
}
