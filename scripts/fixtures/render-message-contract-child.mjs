import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const mode = process.argv[2];
if (mode !== 'main' && mode !== 'fork') throw new Error('mode must be main or fork');
const dom = new JSDOM('<!doctype html><html><head></head><body><div class="chat-messages-container"><div id="feed"></div></div></body></html>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'http://localhost/',
});
const { window } = dom;
for (const [key, value] of Object.entries({
    window,
    document: window.document,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
})) globalThis[key] = value;
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = globalThis.IntersectionObserver;
window.CSS ||= { escape: (value) => String(value) };
window.hljs = { highlightElement: (element) => element.classList.add('hljs'), getLanguage: () => true };
window.renderMathInElement = () => {};
window.mermaid = {
    initialize() {},
    async run({ nodes }) { nodes.forEach((node) => { node.innerHTML = '<svg><text>diagram</text></svg>'; }); },
};
window.flowlockProtocol = { transformForRender: (text) => text };
window.eval(await readFile(new URL('../../vendor/marked.min.js', import.meta.url), 'utf8'));
const markedInstance = new window.marked.Marked({ gfm: true, tables: true, breaks: true });
const feed = window.document.getElementById('feed');
const participant = { id: 'nova', type: 'agent', name: 'Nova', avatarUrl: '', config: {} };
const settings = { userName: '用户', enableUserChatBubbleUi: true, showUserMetaInChatBubbleUi: true };
const message = {
    id: 'golden-message',
    role: 'assistant',
    name: 'Nova',
    timestamp: 1700000000000,
    content: [
        '<think>',
        '推理 **详情**',
        '</think>',
        '# 标题',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '公式：\\(x^2 + y^2 = z^2\\)',
        '',
        '```javascript',
        'const value = 1;',
        'console.log(value);',
        '```',
        '',
        '```mermaid',
        'graph TD',
        'A-->B',
        '```',
        '',
        '[链接](https://example.com)',
        '![图片](https://example.com/image.png)',
        '',
        '[[VCP调用结果信息汇总:',
        '工具名称: FileOperator',
        '执行状态: completed',
        '返回内容: package-name',
        'VCP调用结果结束]]',
    ].join('\n'),
    attachments: [{ id: 'attachment-1', type: 'text/plain', name: 'report.txt', src: 'file:///C:/fixture/report.txt' }],
    state: 'complete',
};
const electronAPI = {
    getEmoticonLibrary: async () => [],
    openImageViewer() {},
    showImageContextMenu() {},
    sendOpenExternalLink() {},
    sovitsStop() {},
};

if (mode === 'main') {
    await import('../../modules/messageRenderer.js');
    window.messageRenderer.initializeMessageRenderer({
        chatMessagesDiv: feed,
        electronAPI,
        markedInstance,
        uiHelper: { scrollToBottom() {}, showToastNotification() {} },
        globalSettingsRef: { get: () => settings, set() {} },
        currentChatHistoryRef: { get: () => [message], set() {} },
        currentSelectedItemRef: { get: () => participant, set() {} },
        currentTopicIdRef: { get: () => 'topic-1', set() {} },
        interruptHandler: { interrupt: async () => ({ success: true }) },
    });
    const row = await window.messageRenderer.renderMessage(message, true, false);
    feed.append(row);
    await row._vcp_process?.({ runHeavy: true });
} else {
    const { createAgentMessagePresentation } = await import('../../modules/ui-system/agent-presentation/index.js');
    const { reconcileAgentTimeline } = await import('../../modules/ui-system/agent-workbench-timeline.js');
    const presentation = createAgentMessagePresentation({
        window,
        document: window.document,
        container: feed,
        markedInstance,
        electronAPI,
        getSessionContext: () => ({
            sessionId: 'session-1', threadId: 'thread-1', participant, messages: [message], settings,
        }),
    });
    reconcileAgentTimeline(feed, [{ kind: 'message', id: message.id, messageId: message.id, value: message }], presentation.timelineCallbacks, new Map());
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}
await new Promise((resolve) => setTimeout(resolve, 20));

function canonicalize(element) {
    if (element.nodeType === window.Node.TEXT_NODE) {
        const text = element.textContent.replace(/\s+/g, ' ').trim();
        return text ? { text } : null;
    }
    if (element.nodeType !== window.Node.ELEMENT_NODE) return null;
    if (element.classList.contains('message-attachment-remove-btn')) return null;
    const ignoredClasses = new Set(['vcp-heavy-pending']);
    const classes = [...element.classList].filter((name) => !ignoredClasses.has(name)).sort();
    const attributes = {};
    for (const name of ['data-message-id', 'data-vcp-block-type', 'href', 'src', 'alt']) {
        if (element.hasAttribute(name)) attributes[name] = element.getAttribute(name).replace('http://localhost/', '/');
    }
    const children = [...element.childNodes].map(canonicalize).filter(Boolean);
    return { tag: element.tagName.toLowerCase(), classes, attributes, children };
}

const canonical = canonicalize(feed.querySelector('.message-item'));
console.log(`CONTRACT_JSON:${JSON.stringify(canonical)}`);
dom.window.close();
