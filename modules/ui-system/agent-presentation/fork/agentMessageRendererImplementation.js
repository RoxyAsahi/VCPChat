// Agent presentation fork of modules/messageRenderer.js.
// Source receipt: ./FORK_RECEIPT.md. Never import this fork into main chat.

// --- Enhanced Rendering Constants ---
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400; // ms, for general blocks during streaming
const DIARY_RENDER_DEBOUNCE_DELAY = 1000; // ms, potentially longer for diary if complex
const enhancedRenderDebounceTimers = new WeakMap(); // For debouncing prettify calls

// 🟢 大内容截断阈值与缓存

// 🟢 完整 Markdown → HTML 渲染缓存：只缓存 raw HTML 字符串，不缓存 DOM / 后处理结果 / message 对象。
const RENDER_PIPELINE_VERSION = '2026-07-26-dollar-guard-v3';

import { avatarColorCache, getDominantAvatarColor } from '../../../renderer/colorUtils.js';
import * as emoticonUrlFixer from '../../../renderer/emoticonUrlFixer.js';
import { createContentPipeline, PIPELINE_MODES } from '../../../renderer/contentPipeline.js';
import * as contentProcessor from '../../../renderer/contentProcessor.js';
import { createAgentImageController } from './agentImageController.js';
import { createAgentVisibilityController } from './agentVisibilityController.js';
import { createAgentAnimationLifecycle } from './agentAnimationLifecycle.js';
import { createAgentRendererSession } from './agent-renderer-session.js';
import { createAgentRendererStream } from './agent-renderer-stream.js';
import { renderAttachments as renderResourceAttachments } from './agent-renderer-resource-dom.js';
import { createAgentMessageDom } from './agent-renderer-message-dom.js';
import { createAgentRendererContent } from './agent-renderer-content.js';
import { createAgentRendererHtmlCache } from './agent-renderer-html-cache.js';
import { createAgentRendererMarkdownStream } from './agent-renderer-markdown-stream.js';
import { createAgentRendererHistory } from './agent-renderer-history.js';
import { createAgentRendererActions } from './agent-renderer-actions.js';
import { protectLatexBlocks, restoreLatexBlocks } from './agent-renderer-latex.js';
import { createAgentRendererAvatarStyle } from './agent-renderer-avatar-style.js';
import { createAgentRendererTextTransforms } from './agent-renderer-text-transforms.js';
import { createAgentRendererScopedHtml } from './agent-renderer-scoped-html.js';
import { createAgentRendererSpecialBlocks } from './agent-renderer-special-blocks.js';
import { createAgentRendererToolResults } from './agent-renderer-tool-results.js';
import { createAgentRendererMessageLifecycle } from './agent-renderer-message-lifecycle.js';
import { createAgentRendererMermaid } from './agent-renderer-mermaid.js';

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
const TOOL_RESULT_RAW_HTML_LINE_REGEX = /<!doctype\b|<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s>/])|<!--|<\?xml\b/i;
const TOOL_RESULT_DANGEROUS_HTML_REGEX = /<\s*\/?\s*(?:style|script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math|canvas|video|audio|source|track|frame|frameset|html|head|body)\b/i;
const TOOL_RESULT_COMPLETE_HTML_REGEX = /<!doctype\s+html\b|<\s*html\b|<\s*head\b|<\s*body\b/i;
const HTML_STYLE_TAG_REGEX = /<style\b/i;
const FENCE_LINE_REGEX = /^\s*(`{3,}|~{3,})/;
const FENCE_LANG_LINE_REGEX = /^\s*(`{3,}|~{3,})(.*)$/;
const TOOL_RESULT_SAFE_MARKDOWN_OPTIONS = Object.freeze({
    mangle: false,
    headerIds: false
});

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

/**
 * Extracts <style> tags from content, scopes the CSS, and injects it into the document head.
 * @param {string} content - The raw message content string.
 * @param {string} scopeId - The unique ID for scoping.
 * @returns {{processedContent: string, styleInjected: boolean}} The content with <style> tags removed, and a flag indicating if styles were injected.
 */
/**
 * Wraps raw HTML documents in markdown code fences if they aren't already.
 * An HTML document is identified by the `<!DOCTYPE html>` declaration.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
/**
 * Wraps raw HTML documents in markdown code fences if they aren't already.
 * 🟢 跳过「始」「末」标记内的 HTML，防止工具调用参数被错误封装
 */
/**
 * Removes leading whitespace from lines that appear to be HTML tags,
 * as long as they are not inside a fenced code block. This prevents
 * the markdown parser from misinterpreting indented HTML as an indented code block.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
/**
 * 根据对话轮次计算消息的深度。
 * @param {string} messageId - 目标消息的ID。
 * @param {Array<Message>} history - 完整的聊天记录数组。
 * @returns {number} - 计算出的深度（0代表最新一轮）。
 */

/**
 * A helper function to preprocess the full message content string before parsing.
 * @param {string} text The raw text content.
 * @returns {string} The processed text.
 */
function preprocessFullContent(text, settings = {}, messageRole = 'assistant', depth = 0) {
    if (!contentPipeline) {
        console.warn('[MessageRenderer] contentPipeline not initialized, falling back to raw text');
        return { text, toolResultMap: null };
    }

    const result = contentPipeline.process(text, {
        mode: PIPELINE_MODES.FULL_RENDER,
        settings,
        messageRole,
        depth
    });

    return { text: result.text, toolResultMap: result.state.toolResultMap || null };
}

function preprocessStreamTailContent(text) {
    if (!contentPipeline) {
        console.warn('[MessageRenderer] contentPipeline not initialized for stream tail, falling back to raw text');
        return text;
    }

    return contentPipeline.process(text, {
        mode: PIPELINE_MODES.STREAM_FAST
    }).text;
}

function renderMarkdownToHtmlUncached(text, options = {}) {
    const markedInstance = agentRenderContext.markedInstance;
    if (!markedInstance) return escapeHtml(text);

    const globalSettings = options.settings || getSettings();
    const {
        messageRole = 'assistant',
        depth = 0
    } = options;

    const { text: processedText, toolResultMap } = preprocessFullContent(text, globalSettings, messageRole, depth);
    const { text: protectedText, map: latexMap } = protectLatexBlocks(processedText);
    let html = markedInstance.parse(protectedText);
    html = restoreLatexBlocks(html, latexMap);
    html = restoreRenderedToolResults(html, toolResultMap);
    return html;
}

const toolResults = createAgentRendererToolResults({
    getMarked: () => agentRenderContext.markedInstance, escapeHtml,
    dangerousHtmlRegex: TOOL_RESULT_DANGEROUS_HTML_REGEX,
});
const renderSafeToolResultMarkdown = toolResults.renderSafeMarkdown;
const restoreRenderedToolResults = toolResults.restore;

const renderHtmlCache = createAgentRendererHtmlCache({
    version: RENDER_PIPELINE_VERSION,
    getSettings,
    containsScopedHtml: containsAssistantHtmlNeedingScope,
    renderUncached: renderMarkdownToHtmlUncached,
});

function renderMarkdownToHtml(text, options = {}) {
    return renderHtmlCache.render(text, options);
}

function parseFullMarkdown(text, options = {}) {
    return renderMarkdownToHtml(text, options);
}

/**
 * 查找流式文本中最后一个尚未闭合的代码围栏。
 * 返回围栏前正文、语言名和原始代码，使流式渲染不再依赖 marked 对残缺围栏的容错行为。
 */
const markdownStreamRenderer = createAgentRendererMarkdownStream({
    getMarked: () => agentRenderContext.markedInstance,
    escapeHtml,
    preprocessTail: preprocessStreamTailContent,
    toolStartMarker: TOOL_START_MARKER,
    isWrappedMarker: isBacktickWrappedMarker,
    findToolEnd: findToolRequestEnd,
});

function parseStreamTailMarkdown(text) {
    return markdownStreamRenderer.parse(text);
}

function prepareFinalTextForRender(messageId, rawText, role = 'assistant', historyOverride = null) {
    let textToRender = (typeof rawText === 'string') ? rawText : (rawText?.text || "[内容格式异常]");
    const history = Array.isArray(historyOverride) ? historyOverride : getMessages();
    const messageInHistory = history.find(m => m.id === messageId);

    if ((messageInHistory?.role || role) === 'user') {
        textToRender = prepareUserMessageText(textToRender);
    }

    const depth = calculateDepthByTurns(messageId, history);
    const currentSelectedItem = getParticipant();
    const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
    const effectiveRole = messageInHistory?.role || role;

    if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes)) {
        textToRender = applyFrontendRegexRules(textToRender, agentConfigForRegex.stripRegexes, effectiveRole, depth);
    }

    return { text: textToRender, depth, role: effectiveRole };
}

/**
 * 🟢 独立渲染单个工具结果块为 HTML
 * 从 transformSpecialBlocks 中提取出来，支持工具结果内部的完整 Markdown 渲染
 * （表格、代码围栏等），同时避免与外部 Markdown 解析器产生冲突。
 * @param {string} fullMatch - 完整的工具结果文本（含 [[VCP调用结果信息汇总: ... VCP调用结果结束]] 标记）
 * @returns {string} 渲染后的 HTML
 */
function fixEmoticonUrlsInMarkdown(text) {
    if (!text || typeof text !== 'string') return text;

    // 1. 修复 Markdown 图片语法: ![alt](url)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        if (emoticonUrlFixer && emoticonUrlFixer.fixEmoticonUrl) {
            const fixedUrl = emoticonUrlFixer.fixEmoticonUrl(url);
            if (fixedUrl !== url) {
                console.debug(`[PreprocessFix] Markdown图片: ${url} → ${fixedUrl}`);
            }
            return `![${alt}](${fixedUrl})`;
        }
        return match;
    });

    // 2. 修复 HTML img 标签: <img src="url" ...>
    text = text.replace(/<img([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, before, url, after) => {
        if (emoticonUrlFixer && emoticonUrlFixer.fixEmoticonUrl) {
            const fixedUrl = emoticonUrlFixer.fixEmoticonUrl(url);
            if (fixedUrl !== url) {
                console.debug(`[PreprocessFix] HTML图片: ${url} → ${fixedUrl}`);
            }
            return `<img${before}src="${fixedUrl}"${after}>`;
        }
        return match;
    });

    return text;
}

/**
 * @typedef {Object} Message
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 * @property {number} timestamp
 * @property {string} [id]
 * @property {boolean} [isThinking]
 * @property {Array<{type: string, src: string, name: string}>} [attachments]
 * @property {string} [finishReason]
 * @property {boolean} [isGroupMessage] // New: Indicates if it's a group message
 * @property {string} [agentId] // New: ID of the speaking agent in a group
 * @property {string} [name] // New: Name of the speaking agent in a group (can override default role name)
 * @property {string} [avatarUrl] // New: Specific avatar for this message (e.g. group member)
 * @property {string} [avatarColor] // New: Specific avatar color for this message
 */


/**
 * @typedef {Object} CurrentSelectedItem
 * @property {string|null} id - Can be agentId or groupId
 * @property {'agent'|'group'|null} type
 * @property {string|null} name
 * @property {string|null} avatarUrl
 * @property {object|null} config - Full config of the selected item
 */


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
        // ... other uiHelper functions ...
    },
    summarizeTopicFromMessages: async () => "",
    handleCreateBranch: () => { },
    // activeStreamingMessageId: null, // ID of the message currently being streamed - REMOVED
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

let contentPipeline = null;

let activeRenderSessionId = 0;
const messageDom = createAgentMessageDom({
    documentRef: document,
    windowRef: window,
    getRoot: () => agentRenderContext.chatMessagesDiv,
    cleanupContent: (content) => contentProcessor.cleanupPreviewsInContent(content),
    cleanupAnimation: (content) => animationLifecycle?.cleanup(content),
    unobserveMessage: (item) => visibilityController?.unobserveMessage(item),
    invalidateSession: () => invalidateRenderSession(),
    clearRenderCache: () => renderHtmlCache.clear(),
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

    contentPipeline = createContentPipeline({
        escapeHtml,
        processStartEndMarkers: contentProcessor.processStartEndMarkers,
        fixEmoticonUrlsInMarkdown,
        deIndentMisinterpretedCodeBlocks: contentProcessor.deIndentMisinterpretedCodeBlocks,
        deIndentHtml,
        deIndentToolRequestBlocks: contentProcessor.deIndentToolRequestBlocks,
        applyContentProcessors: contentProcessor.applyContentProcessors,
        transformSpecialBlocks,
        ensureHtmlFenced,
        transformFlowlockBlocks: (text) => {
            if (!window.flowlockProtocol || typeof window.flowlockProtocol.transformForRender !== 'function') {
                return text;
            }
            return window.flowlockProtocol.transformForRender(text);
        },
        transformMermaidPlaceholders: (text) => {
            let transformed = text.replace(MERMAID_CODE_REGEX, (match, lang, code) => {
                const tempEl = document.createElement('textarea');
                tempEl.innerHTML = code;
                const encodedCode = encodeURIComponent(tempEl.value.trim());
                return `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodedCode}"></div>`;
            });

            transformed = transformed.replace(MERMAID_FENCE_REGEX, (match, lang, code) => {
                const encodedCode = encodeURIComponent(code.trim());
                return `<div class="mermaid-placeholder" data-vcp-block-type="mermaid" data-vcp-preserve-children="true" data-mermaid-code="${encodedCode}"></div>`;
            });

            return transformed;
        },
        getToolResultRegex: () => TOOL_RESULT_REGEX,
        getToolRequestRegex: () => TOOL_REGEX,
        replaceToolRequestBlocks,
        getCodeFenceRegex: () => CODE_FENCE_REGEX,
        getDesktopPushRegex: () => DESKTOP_PUSH_REGEX,
        getDesktopPushPartialRegex: () => DESKTOP_PUSH_PARTIAL_REGEX,
    });

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



/**
 * Renders a full, non-streamed message, replacing a 'thinking' placeholder.
 * @param {string} messageId - The ID of the message to update.
 * @param {string} fullContent - The full HTML or text content of the message.
 * @param {string} agentName - The name of the agent sending the message.
 * @param {string} agentId - The ID of the agent sending the message.
 */
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

// Expose methods to renderer.js
/**
 * Renders a complete chat history with progressive loading for better UX.
 * First shows the latest 5 messages, then loads older messages in batches of 10.
 * @param {Array<Message>} history The chat history to render.
 * @param {Object} options Rendering options
 * @param {number} options.initialBatch - Number of latest messages to show first (default: 5)
 * @param {number} options.batchSize - Size of subsequent batches (default: 10)
 * @param {number} options.batchDelay - Delay between batches in ms (default: 100)
 */
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
