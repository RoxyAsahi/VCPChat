// Agent presentation fork of modules/messageRenderer.js.
// Source receipt: ./FORK_RECEIPT.md. Never import this fork into main chat.
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400;
const DIARY_RENDER_DEBOUNCE_DELAY = 1000;
const enhancedRenderDebounceTimers = new WeakMap();
const RENDER_PIPELINE_VERSION = '2026-07-26-dollar-guard-v3';
import { avatarColorCache, getDominantAvatarColor } from '../../../renderer/colorUtils.js';
import * as emoticonUrlFixer from '../../../renderer/emoticonUrlFixer.js';
import * as contentProcessor from '../../../renderer/contentProcessor.js';
import { createAgentImageController } from './agentImageController.js';
import { createAgentVisibilityController } from './agentVisibilityController.js';
import { createAgentAnimationLifecycle } from './agentAnimationLifecycle.js';
import { createAgentRendererSession } from './agent-renderer-session.js';
import { createAgentRendererStream } from './agent-renderer-stream.js';
import { renderAttachments as renderResourceAttachments } from './agent-renderer-resource-dom.js';
import { createAgentMessageDom } from './agent-renderer-message-dom.js';
import { createAgentRendererContent } from './agent-renderer-content.js';
import { createAgentRendererHistory } from './agent-renderer-history.js';
import { createAgentRendererActions } from './agent-renderer-actions.js';
import { createAgentRendererAvatarStyle } from './agent-renderer-avatar-style.js';
import { createAgentRendererTextTransforms } from './agent-renderer-text-transforms.js';
import { createAgentRendererScopedHtml } from './agent-renderer-scoped-html.js';
import { createAgentRendererSpecialBlocks } from './agent-renderer-special-blocks.js';
import { createAgentRendererToolResults } from './agent-renderer-tool-results.js';
import { createAgentRendererMessageLifecycle } from './agent-renderer-message-lifecycle.js';
import { createAgentRendererMermaid } from './agent-renderer-mermaid.js';
import { createAgentRendererMarkdownPipeline } from './agent-renderer-markdown-pipeline.js';
const colorExtractionPromises = new Map();
async function getDominantAvatarColorCached(url) {
    if (!colorExtractionPromises.has(url)) {
        colorExtractionPromises.set(url, getDominantAvatarColor(url));
    }
    return colorExtractionPromises.get(url);
}
// --- Pre-compiled Regular Expressions for Performance ---
const TOOL_REGEX = /(?<!`)<<<\[TOOL_REQUEST\]>>>(.*?)<<<\[END_TOOL_REQUEST\]>>>(?!`)/gs;
const TOOL_START_MARKER = '<<<[TOOL_REQUEST]>>>';
const TOOL_END_MARKER = '<<<[END_TOOL_REQUEST]>>>';
const NOTE_REGEX = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/gs;
const TOOL_RESULT_REGEX = /\[\[VCP调用结果信息汇总:(.*?)VCP调用结果结束\]\]/gs;
const TOOL_CALL_SUMMARY_REGEX = /\[本轮工具调用摘要:\]([\s\S]*?)\[本轮工具调用摘要结束\]/g;
const BUTTON_CLICK_REGEX = /\[\[点击按钮:(.*?)\]\]/gs;
const CANVAS_PLACEHOLDER_REGEX = /\{\{VCPChatCanvas\}\}/g;
const STYLE_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const HTML_FENCE_CHECK_REGEX = /```\w*\n<!DOCTYPE html>/i;
const MERMAID_CODE_REGEX = /<code.*?>\s*(flowchart|graph|mermaid)\s+([\s\S]*?)<\/code>/gi;
const MERMAID_FENCE_REGEX = /```(mermaid|flowchart|graph)[^\S\n]*\n([\s\S]*?)```/g;
const CODE_FENCE_REGEX = /```[^\n]*([\s\S]*?)```/g;
const THOUGHT_CHAIN_REGEX = /^[ \t]*\[--- VCP元思考链(?::\s*"([^"]*)")?\s*---\][ \t]*\r?\n([\s\S]*?)^[ \t]*\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$)/gm;
const CONVENTIONAL_THOUGHT_REGEX = /^[ \t]*<think(?:ing)?>[ \t]*\r?\n([\s\S]*?)^[ \t]*<\/think(?:ing)?>[ \t]*(?:\r?\n|$)/gim;
const ROLE_DIVIDER_REGEX = /<<<\[(END_)?ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g;
const DESKTOP_PUSH_REGEX = /(?<!`)<<<\[DESKTOP_PUSH\]>>>([\s\S]*?)<<<\[DESKTOP_PUSH_END\]>>>(?!`)/gs;
const DESKTOP_PUSH_PARTIAL_REGEX = /(?<!`)<<<\[DESKTOP_PUSH\]>>>([\s\S]*)$/s; // 流式传输中未闭合的情况
function isBacktickWrappedMarker(text, index, marker) {
    return text[index - 1] === '`' || text[index + marker.length] === '`';
}
function findMarkedFieldEnd(text, contentStart, isEscape) {
    const endRegex = isEscape
        ? /[「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}]/gi
        : /[「{]末[」}]/g;
    endRegex.lastIndex = contentStart;
    const endMatch = endRegex.exec(text);
    return endMatch ? endMatch.index + endMatch[0].length : text.length;
}
function findToolRequestEnd(text, contentStart) {
    const markerRegex = /<<<\[END_TOOL_REQUEST\]>>>|[「{]始(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/gi;
    markerRegex.lastIndex = contentStart;
    while (true) {
        const match = markerRegex.exec(text);
        if (!match) return -1;
        const marker = match[0];
        if (marker === TOOL_END_MARKER) {
            if (isBacktickWrappedMarker(text, match.index, marker)) {
                markerRegex.lastIndex = match.index + marker.length;
                continue;
            }
            return match.index + marker.length;
        }
        const isEscape = /escape/i.test(marker);
        markerRegex.lastIndex = findMarkedFieldEnd(text, match.index + marker.length, isEscape);
    }
}
function replaceToolRequestBlocks(text, replacer) {
    if (typeof text !== 'string' || !text.includes(TOOL_START_MARKER)) {
        return text;
    }
    let result = '';
    let cursor = 0;
    while (cursor < text.length) {
        const startIndex = text.indexOf(TOOL_START_MARKER, cursor);
        if (startIndex === -1) {
            result += text.slice(cursor);
            break;
        }
        if (isBacktickWrappedMarker(text, startIndex, TOOL_START_MARKER)) {
            result += text.slice(cursor, startIndex + TOOL_START_MARKER.length);
            cursor = startIndex + TOOL_START_MARKER.length;
            continue;
        }
        const contentStart = startIndex + TOOL_START_MARKER.length;
        const endIndex = findToolRequestEnd(text, contentStart);
        if (endIndex === -1) {
            result += text.slice(cursor);
            break;
        }
        const fullMatch = text.slice(startIndex, endIndex);
        const content = text.slice(contentStart, endIndex - TOOL_END_MARKER.length);
        result += text.slice(cursor, startIndex);
        result += replacer(fullMatch, content, startIndex, endIndex);
        cursor = endIndex;
    }
    return result;
}
// --- Enhanced Rendering Styles (from UserScript) ---
function injectEnhancedStyles() {
    // The stylesheet is imported through style.css in the legacy cascade layer.
    // Keeping it there lets the next-UI system override only its own message surface.
}
// --- Core Logic ---
/**
 * A helper function to escape HTML special characters.
 * @param {string} text The text to escape.
 * @returns {string} The escaped text.
 */
function escapeHtml(text) {
    return contentProcessor.escapeHtml(text);
}
const ASSISTANT_HTML_SCOPE_TRIGGER_REGEX = /<\s*(?:style|html|head|body|main|section|article|header|footer|nav|aside|div|span|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|p|h[1-6]|form|button|input|textarea|select|option|label|svg|canvas|iframe|object|embed|video|audio|img|a)\b|style\s*=/i;
const TOOL_RESULT_DANGEROUS_HTML_REGEX = /<\s*\/?\s*(?:style|script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math|canvas|video|audio|source|track|frame|frameset|html|head|body)\b/i;
const HTML_STYLE_TAG_REGEX = /<style\b/i;
const mermaidRenderer = createAgentRendererMermaid({
    documentRef: document,
    windowRef: window,
    getMermaid: () => globalThis.mermaid,
    escapeHtml,
});
function renderMermaidDiagrams(container) {
    return mermaidRenderer.render(container);
}
/**
 * Finds special VCP blocks (Tool Requests, Daily Notes) and transforms them
 * directly into styled HTML divs, bypassing the need for markdown code fences.
 * @param {string} text The text content.
 * @param {Map} [codeBlockMap] Map of code block placeholders to their original content.
 * @returns {string} The processed text with special blocks as HTML.
 */
const specialBlocks = createAgentRendererSpecialBlocks({
    getMarked: () => agentRenderContext.markedInstance,
    escapeHtml,
    replaceToolRequestBlocks,
    noteRegex: NOTE_REGEX,
    toolCallSummaryRegex: TOOL_CALL_SUMMARY_REGEX,
    conventionalThoughtRegex: CONVENTIONAL_THOUGHT_REGEX,
    thoughtChainRegex: THOUGHT_CHAIN_REGEX,
    roleDividerRegex: ROLE_DIVIDER_REGEX,
});
const transformSpecialBlocks = specialBlocks.transformSpecialBlocks;
function transformUserButtonClick(text) {
    return text.replace(BUTTON_CLICK_REGEX, (match, content) => {
        const escapedContent = escapeHtml(content.trim());
        return `<span class="user-clicked-button-bubble">${escapedContent}</span>`;
    });
}
function transformVCPChatCanvas(text) {
    return text.replace(CANVAS_PLACEHOLDER_REGEX, () => {
        // Use a div for better block-level layout and margin behavior
        return `<div class="vcp-chat-canvas-placeholder">Canvas协同中<span class="thinking-indicator-dots">...</span></div>`;
    });
}
const textTransforms = createAgentRendererTextTransforms({
    window, escapeHtml, transformButton: transformUserButtonClick, transformCanvas: transformVCPChatCanvas,
});
const {
    applyFrontendRegexRules, buildTurnDepthMap, calculateDepthByTurns, prepareUserMessageText,
} = textTransforms;
const scopedHtml = createAgentRendererScopedHtml({
    document,
    scopeCss: contentProcessor.scopeCss,
    styleRegex: STYLE_REGEX,
    htmlTriggerRegex: ASSISTANT_HTML_SCOPE_TRIGGER_REGEX,
    htmlStyleTagRegex: HTML_STYLE_TAG_REGEX,
    htmlFenceCheckRegex: HTML_FENCE_CHECK_REGEX,
    toolResultRegex: TOOL_RESULT_REGEX,
    replaceToolRequestBlocks,
    desktopPushRegex: DESKTOP_PUSH_REGEX,
    desktopPushPartialRegex: DESKTOP_PUSH_PARTIAL_REGEX,
    codeFenceRegex: CODE_FENCE_REGEX,
});
const generateUniqueId = scopedHtml.generateUniqueId;
const containsAssistantHtmlNeedingScope = scopedHtml.containsScopedHtml;
const processAssistantScopedHtmlContent = scopedHtml.process;
const ensureHtmlFenced = scopedHtml.ensureHtmlFenced;
const deIndentHtml = scopedHtml.deIndentHtml;
function extractSpeakableTextFromContentElement(contentElement) {
    if (!contentElement) return '';
    const contentClone = contentElement.cloneNode(true);
    contentClone.querySelectorAll(
        '.vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble, .vcp-flowlock-bubble, .maid-diary-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, style, script'
    ).forEach(el => el.remove());
    return (contentClone.innerText || '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
const toolResults = createAgentRendererToolResults({
    getMarked: () => agentRenderContext.markedInstance, escapeHtml,
    dangerousHtmlRegex: TOOL_RESULT_DANGEROUS_HTML_REGEX,
});
const renderSafeToolResultMarkdown = toolResults.renderSafeMarkdown;
const markdownPipeline = createAgentRendererMarkdownPipeline({
    version: RENDER_PIPELINE_VERSION,
    getMarked: () => agentRenderContext.markedInstance,
    getSettings,
    escapeHtml,
    containsScopedHtml: containsAssistantHtmlNeedingScope,
    restoreToolResults: toolResults.restore,
    fixEmoticonUrl: (url) => emoticonUrlFixer.fixEmoticonUrl?.(url) || url,
    processStartEndMarkers: contentProcessor.processStartEndMarkers,
    deIndentMisinterpretedCodeBlocks: contentProcessor.deIndentMisinterpretedCodeBlocks,
    deIndentHtml,
    deIndentToolRequestBlocks: contentProcessor.deIndentToolRequestBlocks,
    applyContentProcessors: contentProcessor.applyContentProcessors,
    transformSpecialBlocks,
    ensureHtmlFenced,
    transformFlowlockBlocks: (text) => window.flowlockProtocol?.transformForRender?.(text) || text,
    transformMermaidPlaceholders: (text) => text
        .replace(MERMAID_CODE_REGEX, (match, lang, code) => {
            const temp = document.createElement('textarea');
            temp.innerHTML = code;
            return `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodeURIComponent(temp.value.trim())}"></div>`;
        })
        .replace(MERMAID_FENCE_REGEX, (match, lang, code) => `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodeURIComponent(code.trim())}"></div>`),
    getToolResultRegex: () => TOOL_RESULT_REGEX,
    getToolRequestRegex: () => TOOL_REGEX,
    replaceToolRequestBlocks,
    getCodeFenceRegex: () => CODE_FENCE_REGEX,
    getDesktopPushRegex: () => DESKTOP_PUSH_REGEX,
    getDesktopPushPartialRegex: () => DESKTOP_PUSH_PARTIAL_REGEX,
});
function renderMarkdownToHtml(text, options = {}) { return markdownPipeline.render(text, options); }
function parseFullMarkdown(text, options = {}) { return markdownPipeline.render(text, options); }
let agentRenderContext = {
    getSessionContext: () => ({ sessionId: null, threadId: null, participant: {}, messages: [], settings: {} }),
    actions: {},
    chatMessagesDiv: null,
    electronAPI: null,
    markedInstance: null,
    uiHelper: {
        scrollToBottom: () => { },
        openModal: () => { },
        autoResizeTextarea: () => { },
    },
    summarizeTopicFromMessages: async () => "",
    handleCreateBranch: () => { },
};
let imageController = null;
let visibilityController = null;
let animationLifecycle = null;
const rendererSession = createAgentRendererSession();
let containerEventDisposers = [];
let streamController = null;
function getStreamController() {
    if (streamController) return streamController;
    streamController = createAgentRendererStream({
        requestFrame(callback) {
            return window.requestAnimationFrame?.(callback) ?? setTimeout(callback, 0);
        },
        cancelFrame(frameId) {
            if (window.cancelAnimationFrame) window.cancelAnimationFrame(frameId);
            else clearTimeout(frameId);
        },
        onFlush(messageId, content) {
            updateMessageContent(messageId, content);
        },
    });
    return streamController;
}
function getSessionContext(subject = null) {
    return rendererSession.context(subject);
}
function getMessages(subject = null) {
    return rendererSession.messages(subject);
}
function getParticipant(subject = null) {
    return rendererSession.participant(subject);
}
function getSettings(subject = null) {
    return rendererSession.settings(subject);
}
function bindContainerEvent(type, handler, options) {
    const dispose = rendererSession.bind(type, handler, options);
    containerEventDisposers.push(dispose);
    return dispose;
}
function disposeContainerEvents() {
    for (const dispose of containerEventDisposers.splice(0)) dispose();
}
let activeRenderSessionId = 0;
const messageDom = createAgentMessageDom({
    documentRef: document,
    windowRef: window,
    getRoot: () => agentRenderContext.chatMessagesDiv,
    cleanupContent: (content) => contentProcessor.cleanupPreviewsInContent(content),
    cleanupAnimation: (content) => animationLifecycle?.cleanup(content),
    unobserveMessage: (item) => visibilityController?.unobserveMessage(item),
    invalidateSession: () => invalidateRenderSession(),
    clearRenderCache: () => markdownPipeline.clear(),
    clearToolResults: () => toolResults.clear(),
    clearStream: () => getStreamController().clear(),
});
const rendererContent = createAgentRendererContent({
    getSettings: () => getSettings(),
    getActiveRenderSessionId: () => getActiveRenderSessionId(),
    isRenderSessionActive: (sessionId) => isRenderSessionActive(sessionId),
    cleanupPreviews: (content) => contentProcessor.cleanupPreviewsInContent(content),
    cleanupAnimation: (content) => animationLifecycle?.cleanup(content),
    setImageContent: (content, html, messageId) => imageController?.setContent(content, html, messageId),
    renderAttachments: (message, content) => renderAttachments(message, content),
    processRenderedContent: (content, settings) => contentProcessor.processRenderedContent(content, settings),
    renderMermaid: (content) => renderMermaidDiagrams(content),
    highlight: (content) => contentProcessor.highlightAllPatternsInMessage(content),
    processAnimation: (content) => animationLifecycle?.process(content),
});
const rendererHistory = createAgentRendererHistory({
    document,
    root: () => agentRenderContext.chatMessagesDiv,
    renderMessage: (...args) => renderMessage(...args),
    activeSessionId: () => getActiveRenderSessionId(),
    invalidateSession: () => invalidateRenderSession(),
    isSessionActive: (sessionId) => isRenderSessionActive(sessionId),
    initializeDependencies: () => emoticonUrlFixer.initialize(agentRenderContext.electronAPI),
    buildDepthMap: (history) => buildTurnDepthMap(history),
    observeMessage: (element) => visibilityController?.observeMessage(element),
    isMessageInHotZone: (element) => visibilityController?.isMessageInHotZone(element) === true,
    requestFrame: (callback) => requestAnimationFrame(callback),
    requestIdle: (callback) => {
        if ('requestIdleCallback' in window) requestIdleCallback(callback, { timeout: 1000 });
        else requestAnimationFrame(callback);
    },
    scrollToBottom: () => agentRenderContext.uiHelper.scrollToBottom(),
    onError: (message, error) => console.error(`Failed to render message ${message.id}:`, error),
});
const avatarStyle = createAgentRendererAvatarStyle({
    document,
    getDominantColor: getDominantAvatarColorCached,
});
const rendererActions = createAgentRendererActions({
    getToolResult: (contentId) => toolResults.get(contentId),
    releaseToolResult: (contentId) => toolResults.release(contentId),
    renderToolResult(container, fullData) {
        container.innerHTML = renderSafeToolResultMarkdown(fullData.raw);
        if (toolResults.isDangerous(fullData.raw)) {
            container.classList.add('vcp-tool-result-markdown-content--sealed-html');
        }
    },
    stopSpeech: () => agentRenderContext.electronAPI.sovitsStop(),
});
function invalidateRenderSession() {
    activeRenderSessionId += 1;
    return activeRenderSessionId;
}
function getActiveRenderSessionId() {
    return activeRenderSessionId;
}
function isRenderSessionActive(sessionId) {
    return sessionId === activeRenderSessionId;
}
function cleanupScopedStylesForMessage(messageItem, messageId = null) {
    return messageDom.cleanupScopedStyles(messageItem, messageId);
}
function cleanupMessageDomResources(messageItem, messageId = null) {
    return messageDom.cleanupResources(messageItem, messageId);
}
function removeMessageById(messageId) {
    return messageDom.remove(messageId);
}
function clearChat() {
    return messageDom.clear();
}
function initializeAgentMessageRenderer(refs) {
    disposeContainerEvents();
    Object.assign(agentRenderContext, refs);
    rendererSession.update(refs);
    markdownPipeline.initialize();
    imageController?.dispose();
    visibilityController?.dispose();
    animationLifecycle?.dispose();
    imageController = createAgentImageController({ document, electronAPI: agentRenderContext.electronAPI });
    // Start the emoticon fixer initialization, but don't wait for it here.
    // The await will happen inside renderMessage to ensure it's ready before rendering.
    emoticonUrlFixer.initialize(agentRenderContext.electronAPI);
    // 初始化可见性优化器
    // 🟢 关键修复：IntersectionObserver 的 root 必须是产生滚动条的那个父容器
    const scrollContainer = agentRenderContext.chatMessagesDiv.closest('.chat-messages-container');
    if (typeof globalThis.Element !== 'undefined' && typeof globalThis.IntersectionObserver !== 'undefined') {
        visibilityController = createAgentVisibilityController({
            container: scrollContainer || agentRenderContext.chatMessagesDiv,
            window,
        });
    }
    animationLifecycle = createAgentAnimationLifecycle({ root: agentRenderContext.chatMessagesDiv });
    bindContainerEvent('click', rendererActions.onClick);
    injectEnhancedStyles();
    console.log("[MessageRenderer] Initialized. Current selected item type on init:", getParticipant()?.type);
}
async function renderAttachments(message, contentDiv) {
    return renderResourceAttachments({
        documentRef: document,
        windowRef: window,
        electronAPI: agentRenderContext.electronAPI,
        message,
        contentDiv,
    });
}
async function renderPostProcessedHtml(contentDiv, rawHtml, options = {}) {
    return rendererContent.renderPostProcessedHtml(contentDiv, rawHtml, options);
}
function startStreamingMessage(message, messageItem = null) {
    getStreamController().start(message);
    return messageItem;
}
function appendStreamChunk(messageId, chunkData, context) {
    getStreamController().append(messageId, chunkData, context);
}
/**
 * 从完整的消息内容中提取桌面推送块，一次性推送到桌面画布
 * 仅作为兜底机制：当流式推送不可用时（如桌面窗口在流式过程中不存在），
 * 在finalize时补充推送。如果流式推送已经成功处理过，这里不会重复推送。
 */
function extractAndPushDesktopBlocks(content) {
    // Desktop push is a VChat capability action, not a presentation side effect.
    agentRenderContext.actions?.desktopPush?.(content);
}
async function finalizeStreamedMessage(messageId, finishReason, context, finalPayload = null) {
    const { current, finalContent } = getStreamController().finalize(messageId, finalPayload);
    updateMessageContent(messageId, finalContent);
    const row = agentRenderContext.chatMessagesDiv?.querySelector(`.message-item[data-message-id="${escapeCssAttributeValue(messageId)}"]`);
    row?.classList.remove('thinking', 'streaming');
    if (row) row.dataset.finishReason = finishReason || 'completed';
    extractAndPushDesktopBlocks(finalContent);
    return {
        ...(current.message || {}),
        id: messageId,
        content: finalContent,
        state: finishReason === 'cancelled' ? 'interrupted' : 'complete',
        finishReason,
        context,
    };
}
const messageLifecycle = createAgentRendererMessageLifecycle({
    documentRef: document,
    windowRef: window,
    getContext: () => agentRenderContext,
    getSettings,
    getParticipant,
    getMessages,
    getStreamController,
    getActiveRenderSessionId,
    isRenderSessionActive,
    observeMessage: (messageItem) => visibilityController?.observeMessage(messageItem),
    generateUniqueId,
    prepareUserMessageText,
    processAssistantScopedHtmlContent,
    calculateDepthByTurns,
    applyFrontendRegexRules,
    renderMarkdownToHtml,
    renderPostProcessedHtml,
    applyAvatar: (payload) => avatarStyle.apply(payload),
});
function renderMessage(message, isInitialLoad = false, appendToDom = true, renderSessionId = getActiveRenderSessionId(), renderContext = {}) {
    return messageLifecycle.renderMessage(message, isInitialLoad, appendToDom, renderSessionId, renderContext);
}
function renderFullMessage(messageId, fullContent, agentName, agentId) {
    return messageLifecycle.renderFullMessage(messageId, fullContent, agentName, agentId);
}
function updateMessageContent(messageId, newContent) {
    return messageLifecycle.updateMessageContent(messageId, newContent);
}
async function renderHistory(history, options = {}) {
    return rendererHistory.render(history, options);
}
async function renderMessageBatch(messages, scrollToBottom = false, renderSessionId = getActiveRenderSessionId(), renderContext = {}) {
    return rendererHistory.renderBatch(messages, scrollToBottom, renderSessionId, renderContext);
}
async function renderHistoryLegacy(history, renderSessionId = getActiveRenderSessionId(), renderContext = {}) {
    return rendererHistory.renderLegacy(history, renderSessionId, renderContext);
}
function refreshLayoutDependentState() {
    const chatMessagesDiv = agentRenderContext.chatMessagesDiv;
    if (!chatMessagesDiv) return;
    chatMessagesDiv.querySelectorAll('.message-item').forEach((messageItem) => {
        delete messageItem.dataset.vcpMeasuredHeight;
        messageItem.style.containIntrinsicSize = 'auto 100px';
    });
    requestAnimationFrame(() => {
        if (!chatMessagesDiv.isConnected) return;
        visibilityController?.recheckVisibility();
    });
}
function disposeAgentMessageRenderer() {
    disposeContainerEvents();
    rendererActions.dispose();
    streamController?.dispose();
    streamController = null;
    for (const row of agentRenderContext.chatMessagesDiv?.querySelectorAll('.message-item') || []) {
        cleanupMessageDomResources(row, row.dataset?.messageId || null);
    }
    visibilityController?.dispose();
    imageController?.dispose();
    animationLifecycle?.dispose();
    visibilityController = null;
    imageController = null;
    animationLifecycle = null;
    rendererSession.dispose();
    agentRenderContext = {
        getSessionContext: () => ({ sessionId: null, threadId: null, participant: {}, messages: [], settings: {} }),
        actions: {},
        chatMessagesDiv: null,
        electronAPI: null,
        markedInstance: null,
        uiHelper: {},
    };
}
export {
    appendStreamChunk,
    clearChat,
    disposeAgentMessageRenderer,
    finalizeStreamedMessage,
    initializeAgentMessageRenderer,
    parseFullMarkdown,
    refreshLayoutDependentState,
    removeMessageById,
    renderFullMessage,
    renderHistory,
    renderHistoryLegacy,
    renderMessage,
    renderMessageBatch,
    startStreamingMessage,
    updateMessageContent,
};
