import * as contentProcessor from './agent-renderer-content-utils.js';
import * as emoticonUrlFixer from './agent-renderer-emoticons.js';
import {
    createAgentRendererMarkdownPipeline,
    createAgentRendererScopedHtml,
    createAgentRendererTextTransforms,
} from './agent-renderer-markdown-pipeline.js';
import { createAgentRendererMermaid } from './agent-renderer-mermaid.js';
import { createAgentRendererSpecialBlocks } from './agent-renderer-special-blocks.js';
import { createAgentRendererToolResults } from './agent-renderer-tool-results.js';

const RENDER_PIPELINE_VERSION = '2026-07-26-dollar-guard-v3';
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
const DESKTOP_PUSH_PARTIAL_REGEX = /(?<!`)<<<\[DESKTOP_PUSH\]>>>([\s\S]*)$/s;
const ASSISTANT_HTML_SCOPE_TRIGGER_REGEX = /<\s*(?:style|html|head|body|main|section|article|header|footer|nav|aside|div|span|table|thead|tbody|tfoot|tr|td|th|ul|ol|li|p|h[1-6]|form|button|input|textarea|select|option|label|svg|canvas|iframe|object|embed|video|audio|img|a)\b|style\s*=/i;
const TOOL_RESULT_DANGEROUS_HTML_REGEX = /<\s*\/?\s*(?:style|script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math|canvas|video|audio|source|track|frame|frameset|html|head|body)\b/i;
const HTML_STYLE_TAG_REGEX = /<style\b/i;

function isBacktickWrappedMarker(text, index, marker) {
    return text[index - 1] === '`' || text[index + marker.length] === '`';
}

function findMarkedFieldEnd(text, contentStart, isEscape) {
    const endRegex = isEscape ? /[「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}]/gi : /[「{]末[」}]/g;
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
        markerRegex.lastIndex = findMarkedFieldEnd(
            text, match.index + marker.length, /escape/i.test(marker),
        );
    }
}

function replaceToolRequestBlocks(text, replacer) {
    if (typeof text !== 'string' || !text.includes(TOOL_START_MARKER)) return text;
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
        result += text.slice(cursor, startIndex);
        result += replacer(
            text.slice(startIndex, endIndex),
            text.slice(contentStart, endIndex - TOOL_END_MARKER.length),
            startIndex,
            endIndex,
        );
        cursor = endIndex;
    }
    return result;
}

function createAgentRendererPipeline(options) {
    const escapeHtml = (text) => contentProcessor.escapeHtml(text);
    const mermaid = createAgentRendererMermaid({
        documentRef: options.documentRef,
        getMermaid: () => globalThis.mermaid,
        escapeHtml,
        requestFrame: options.requestFrame,
    });
    const specialBlocks = createAgentRendererSpecialBlocks({
        getMarked: options.getMarked,
        escapeHtml,
        replaceToolRequestBlocks,
        noteRegex: NOTE_REGEX,
        toolCallSummaryRegex: TOOL_CALL_SUMMARY_REGEX,
        conventionalThoughtRegex: CONVENTIONAL_THOUGHT_REGEX,
        thoughtChainRegex: THOUGHT_CHAIN_REGEX,
        roleDividerRegex: ROLE_DIVIDER_REGEX,
    });
    const transformButton = (text) => text.replace(BUTTON_CLICK_REGEX, (match, content) => (
        `<span class="user-clicked-button-bubble">${escapeHtml(content.trim())}</span>`
    ));
    const transformCanvas = (text) => text.replace(CANVAS_PLACEHOLDER_REGEX, () => (
        '<div class="vcp-chat-canvas-placeholder">Canvas协同中<span class="thinking-indicator-dots">...</span></div>'
    ));
    const textTransforms = createAgentRendererTextTransforms({
        window: options.windowRef, escapeHtml, transformButton, transformCanvas,
    });
    const scopedHtml = createAgentRendererScopedHtml({
        document: options.documentRef,
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
    const toolResults = createAgentRendererToolResults({
        getMarked: options.getMarked,
        escapeHtml,
        dangerousHtmlRegex: TOOL_RESULT_DANGEROUS_HTML_REGEX,
    });
    const markdown = createAgentRendererMarkdownPipeline({
        version: RENDER_PIPELINE_VERSION,
        getMarked: options.getMarked,
        getSettings: options.getSettings,
        escapeHtml,
        containsScopedHtml: scopedHtml.containsScopedHtml,
        restoreToolResults: toolResults.restore,
        fixEmoticonUrl: (url) => emoticonUrlFixer.fixEmoticonUrl?.(url) || url,
        processStartEndMarkers: contentProcessor.processStartEndMarkers,
        deIndentMisinterpretedCodeBlocks: contentProcessor.deIndentMisinterpretedCodeBlocks,
        deIndentHtml: scopedHtml.deIndentHtml,
        deIndentToolRequestBlocks: contentProcessor.deIndentToolRequestBlocks,
        applyContentProcessors: contentProcessor.applyContentProcessors,
        transformSpecialBlocks: specialBlocks.transformSpecialBlocks,
        ensureHtmlFenced: scopedHtml.ensureHtmlFenced,
        transformFlowlockBlocks: (text) => options.windowRef.flowlockProtocol?.transformForRender?.(text) || text,
        transformMermaidPlaceholders: (text) => text
            .replace(MERMAID_CODE_REGEX, (match, lang, code) => {
                const temp = options.documentRef.createElement('textarea');
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
    function renderMermaidDiagrams(container) {
        return mermaid.render(container);
    }

    return {
        ...textTransforms,
        clear: () => { markdown.clear(); toolResults.clear(); },
        initialize: (electronAPI) => {
            markdown.initialize();
            return emoticonUrlFixer.initialize(electronAPI);
        },
        parse: (text, renderOptions = {}) => markdown.render(text, renderOptions),
        processAssistantScopedHtmlContent: scopedHtml.process,
        generateUniqueId: scopedHtml.generateUniqueId,
        renderMermaidDiagrams,
        renderSafeToolResultMarkdown: toolResults.renderSafeMarkdown,
        getToolResult: (contentId) => toolResults.get(contentId),
        releaseToolResult: (contentId) => toolResults.release(contentId),
        isDangerousToolResult: (raw) => toolResults.isDangerous(raw),
    };
}

export { createAgentRendererPipeline };
