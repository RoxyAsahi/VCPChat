// Agent renderer composition root. Source receipt: ./FORK_RECEIPT.md.
// Stateful helpers are instance-owned and wired here; feature behavior belongs
// to the responsibility modules in this directory.
import { getDominantAvatarColor } from './agent-renderer-color.js';
import * as contentProcessor from './agent-renderer-content-utils.js';
import { createAgentImageController } from './agentImageController.js';
import { createAgentVisibilityController } from './agentVisibilityController.js';
import { createAgentAnimationLifecycle } from './agentAnimationLifecycle.js';
import { createAgentRendererSession } from './agent-renderer-session.js';
import { createAgentRendererStream } from './agent-renderer-stream.js';
import { renderAttachments as renderResourceAttachments } from './agent-renderer-resource-dom.js';
import {
    createAgentMessageDom,
    createAgentRendererAvatarStyle,
    createAgentRendererHistory,
} from './agent-renderer-message-dom.js';
import { createAgentRendererContent } from './agent-renderer-content.js';
import { createAgentRendererActions } from './agent-renderer-actions.js';
import { createAgentRendererMessageLifecycle } from './agent-renderer-message-lifecycle.js';
import { createAgentRendererPipeline } from './agent-renderer-pipeline.js';
const colorExtractionPromises = new Map();
async function getDominantAvatarColorCached(url) {
    if (!colorExtractionPromises.has(url)) {
        colorExtractionPromises.set(url, getDominantAvatarColor(url));
    }
    return colorExtractionPromises.get(url);
}
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
const rendererSession = createAgentRendererSession({}, window);
let containerEventDisposers = [];
let streamController = null;
function getStreamController() {
    if (streamController) return streamController;
    streamController = createAgentRendererStream({
        requestFrame(callback) {
            return rendererSession.frame(callback);
        },
        cancelFrame(frameId) {
            rendererSession.cancel(frameId);
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
const rendererPipeline = createAgentRendererPipeline({
    documentRef: document,
    windowRef: window,
    getMarked: () => agentRenderContext.markedInstance,
    getSettings: () => getSettings(),
    requestFrame: (callback) => rendererSession.frame(callback),
});
function parseFullMarkdown(text, options = {}) {
    return rendererPipeline.parse(text, options);
}
const messageDom = createAgentMessageDom({
    documentRef: document,
    windowRef: window,
    getRoot: () => agentRenderContext.chatMessagesDiv,
    cleanupContent: (content) => contentProcessor.cleanupPreviewsInContent(content),
    cleanupAnimation: (content) => animationLifecycle?.cleanup(content),
    unobserveMessage: (item) => visibilityController?.unobserveMessage(item),
    invalidateSession: () => invalidateRenderSession(),
    clearRenderCache: () => rendererPipeline.clear(),
    clearToolResults: () => {},
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
    renderMermaid: (content) => rendererPipeline.renderMermaidDiagrams(content),
    defer: (callback, delay) => rendererSession.timeout(callback, delay),
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
    initializeDependencies: () => rendererPipeline.initialize(agentRenderContext.electronAPI),
    buildDepthMap: (history) => rendererPipeline.buildTurnDepthMap(history),
    observeMessage: (element) => visibilityController?.observeMessage(element),
    isMessageInHotZone: (element) => visibilityController?.isMessageInHotZone(element) === true,
    waitFrame: () => rendererSession.waitFrame(),
    waitIdle: () => rendererSession.waitIdle(),
    delay: (delay) => rendererSession.delay(delay),
    scrollToBottom: () => agentRenderContext.uiHelper.scrollToBottom(),
    onError: (message, error) => console.error(`Failed to render message ${message.id}:`, error),
});
const avatarStyle = createAgentRendererAvatarStyle({
    document,
    getDominantColor: getDominantAvatarColorCached,
});
const rendererActions = createAgentRendererActions({
    getToolResult: (contentId) => rendererPipeline.getToolResult(contentId),
    releaseToolResult: (contentId) => rendererPipeline.releaseToolResult(contentId),
    renderToolResult(container, fullData) {
        container.innerHTML = rendererPipeline.renderSafeToolResultMarkdown(fullData.raw);
        if (rendererPipeline.isDangerousToolResult(fullData.raw)) {
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
    rendererPipeline.initialize(agentRenderContext.electronAPI);
    imageController?.dispose();
    visibilityController?.dispose();
    animationLifecycle?.dispose();
    imageController = createAgentImageController({ document, electronAPI: agentRenderContext.electronAPI });
    // The controller owns observer capability detection and its non-observer fallback.
    const scrollContainer = agentRenderContext.chatMessagesDiv.closest('.chat-messages-container');
    visibilityController = createAgentVisibilityController({
        container: scrollContainer || agentRenderContext.chatMessagesDiv,
        window,
    });
    animationLifecycle = createAgentAnimationLifecycle({ root: agentRenderContext.chatMessagesDiv });
    bindContainerEvent('click', rendererActions.onClick);
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
    const row = [...agentRenderContext.chatMessagesDiv?.querySelectorAll('.message-item[data-message-id]') || []]
        .find((item) => item.dataset.messageId === String(messageId));
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
    pretextBridge: window.pretextBridge,
    requestIdle: (callback, options) => rendererSession.idle(callback, options),
    requestFrame: (callback) => rendererSession.frame(callback),
    getContext: () => agentRenderContext,
    getSettings,
    getParticipant,
    getMessages,
    getStreamController,
    getActiveRenderSessionId,
    isRenderSessionActive,
    observeMessage: (messageItem) => visibilityController?.observeMessage(messageItem),
    generateUniqueId: rendererPipeline.generateUniqueId,
    prepareUserMessageText: rendererPipeline.prepareUserMessageText,
    processAssistantScopedHtmlContent: rendererPipeline.processAssistantScopedHtmlContent,
    calculateDepthByTurns: rendererPipeline.calculateDepthByTurns,
    applyFrontendRegexRules: rendererPipeline.applyFrontendRegexRules,
    renderMarkdownToHtml: rendererPipeline.parse,
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
    rendererSession.frame(() => {
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
