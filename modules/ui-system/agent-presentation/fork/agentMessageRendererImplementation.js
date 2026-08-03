// Agent presentation fork of modules/messageRenderer.js.
// Source receipt: ./FORK_RECEIPT.md. Never import this fork into main chat.

// --- Enhanced Rendering Constants ---
const ENHANCED_RENDER_DEBOUNCE_DELAY = 400; // ms, for general blocks during streaming
const DIARY_RENDER_DEBOUNCE_DELAY = 1000; // ms, potentially longer for diary if complex
const enhancedRenderDebounceTimers = new WeakMap(); // For debouncing prettify calls

// 🟢 大内容截断阈值与缓存
const TOOL_RESULT_TRUNCATE_THRESHOLD = 50000; // 50KB 以上触发截断
const TOOL_RESULT_TRUNCATE_LINES = 80; // 截断后只显示前80行
const toolResultFullContentMap = new Map(); // placeholderId -> { raw: string, fieldKey: string }
let toolResultContentIdCounter = 0;

// 🟢 完整 Markdown → HTML 渲染缓存：只缓存 raw HTML 字符串，不缓存 DOM / 后处理结果 / message 对象。
const RENDER_PIPELINE_VERSION = '2026-07-26-dollar-guard-v3';

import { avatarColorCache, getDominantAvatarColor } from '../../../renderer/colorUtils.js';
import { createMessageSkeleton, formatMessageTimestamp } from '../../../renderer/domBuilder.js';
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

function escapeRawHtmlOutsideCodeFences(markdownText) {
    if (typeof markdownText !== 'string' || !TOOL_RESULT_RAW_HTML_LINE_REGEX.test(markdownText)) {
        return markdownText;
    }

    const lines = markdownText.split('\n');
    let inFence = false;
    let fenceMarker = '';

    return lines.map((line) => {
        const fenceMatch = line.match(FENCE_LINE_REGEX);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (!inFence) {
                inFence = true;
                fenceMarker = marker[0];
            } else if (marker[0] === fenceMarker) {
                inFence = false;
                fenceMarker = '';
            }
            return line;
        }

        if (inFence) {
            return line;
        }

        if (!TOOL_RESULT_RAW_HTML_LINE_REGEX.test(line)) {
            return line;
        }

        return line.replace(/&/g, '\x26amp;').replace(/</g, '\x26lt;').replace(/>/g, '\x26gt;');
    }).join('\n');
}

function fenceCompleteHtmlToolResult(markdownText) {
    if (typeof markdownText !== 'string' || !TOOL_RESULT_COMPLETE_HTML_REGEX.test(markdownText)) {
        return markdownText;
    }

    const lines = markdownText.split('\n');
    const result = [];
    let inFence = false;
    let fenceMarker = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceMatch = line.match(FENCE_LANG_LINE_REGEX);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (!inFence) {
                inFence = true;
                fenceMarker = marker[0];
            } else if (marker[0] === fenceMarker) {
                inFence = false;
                fenceMarker = '';
            }
            result.push(line);
            continue;
        }

        if (inFence || !TOOL_RESULT_COMPLETE_HTML_REGEX.test(line)) {
            result.push(line);
            continue;
        }

        const blockLines = [line];
        let cursor = i + 1;
        while (cursor < lines.length) {
            blockLines.push(lines[cursor]);
            if (/<\s*\/\s*html\s*>/i.test(lines[cursor])) {
                break;
            }
            cursor++;
        }

        result.push('```html');
        result.push(blockLines.join('\n'));
        result.push('```');
        i = cursor;
    }

    return result.join('\n');
}

function sealToolResultMarkdownSource(markdownText) {
    if (typeof markdownText !== 'string') return '';
    const fencedHtml = fenceCompleteHtmlToolResult(markdownText);
    return escapeRawHtmlOutsideCodeFences(fencedHtml);
}

function renderSafeToolResultMarkdown(markdownText) {
    const sealedMarkdown = sealToolResultMarkdownSource(markdownText);

    if (!agentRenderContext.markedInstance) {
        return `<pre class="vcp-tool-result-raw-content">${escapeHtml(sealedMarkdown)}</pre>`;
    }

    try {
        return agentRenderContext.markedInstance.parse(sealedMarkdown, TOOL_RESULT_SAFE_MARKDOWN_OPTIONS);
    } catch (e) {
        return `<pre class="vcp-tool-result-raw-content">${escapeHtml(sealedMarkdown)}</pre>`;
    }
}

/**
 * Generates a unique ID for scoping CSS.
 * @returns {string} A unique ID string (e.g., 'vcp-bubble-1a2b3c4d').
 */
/**
 * Renders Mermaid diagrams found within a given container.
 * Finds placeholders, replaces them with the actual Mermaid code,
 * and then calls the Mermaid API to render them.
 * @param {HTMLElement} container The container element to search within.
 */
async function renderMermaidDiagrams(container) {
    const placeholders = Array.from(container.querySelectorAll('.mermaid-placeholder'));
    if (placeholders.length === 0) return;

    // Prepare elements for rendering
    placeholders.forEach(placeholder => {
        const code = placeholder.dataset.mermaidCode;
        if (code) {
            try {
                // The placeholder div itself will become the mermaid container
                let decodedCode = decodeURIComponent(code);
                // 修复 AI 常用的“智能字符”导致的 Mermaid 语法错误
                decodedCode = decodedCode.replace(/[—–－]/g, '--');

                placeholder.textContent = decodedCode;
                placeholder.classList.remove('mermaid-placeholder');
                placeholder.classList.add('mermaid');
                placeholder.dataset.mermaidSource = decodedCode;
            } catch (e) {
                console.error('Failed to decode mermaid code', e);
                placeholder.textContent = '[Mermaid code decoding error]';
            }
        }
    });

    // Get the list of actual .mermaid elements to render
    const elementsToRender = placeholders.filter(el => el.classList.contains('mermaid'));

    if (elementsToRender.length > 0 && typeof mermaid !== 'undefined') {
        // Initialize mermaid if it hasn't been already
        mermaid.initialize({ startOnLoad: false });

        // 逐个渲染以防止单个图表错误导致所有图表显示错误
        for (const el of elementsToRender) {
            try {
                await mermaid.run({ nodes: [el] });
                enhanceMermaidDiagram(el);
            } catch (error) {
                console.error("Error rendering Mermaid diagram:", error);
                const originalCode = el.dataset.mermaidSource || el.textContent;
                el.innerHTML = `<div class="mermaid-error">Mermaid 渲染错误: ${error.message}</div><pre>${escapeHtml(originalCode)}</pre>`;
            }
        }
    }
}

function enhanceMermaidDiagram(mermaidElement) {
    if (!mermaidElement || mermaidElement.dataset.vcpMermaidEnhanced === 'true') return;

    const svg = mermaidElement.querySelector('svg');
    if (!svg) return;

    mermaidElement.dataset.vcpMermaidEnhanced = 'true';

    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid-viewer';
    wrapper.dataset.scale = '1';
    wrapper.dataset.translateX = '0';
    wrapper.dataset.translateY = '0';

    const toolbar = document.createElement('div');
    toolbar.className = 'mermaid-viewer-toolbar';
    toolbar.innerHTML = `
        <button type="button" class="mermaid-viewer-btn" data-mermaid-action="zoom-out" title="缩小">−</button>
        <button type="button" class="mermaid-viewer-btn" data-mermaid-action="reset" title="重置视图">100%</button>
        <button type="button" class="mermaid-viewer-btn" data-mermaid-action="zoom-in" title="放大">＋</button>
        <button type="button" class="mermaid-viewer-btn" data-mermaid-action="fit" title="适应宽度">适应</button>
    `;

    const viewport = document.createElement('div');
    viewport.className = 'mermaid-viewer-viewport';
    viewport.title = '滚轮缩放，按住鼠标左键拖拽平移，双击重置';

    const canvas = document.createElement('div');
    canvas.className = 'mermaid-viewer-canvas';

    svg.removeAttribute('style');
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
    canvas.appendChild(svg);
    viewport.appendChild(canvas);

    mermaidElement.textContent = '';
    wrapper.appendChild(toolbar);
    wrapper.appendChild(viewport);
    mermaidElement.appendChild(wrapper);

    const clampScale = (scale) => Math.min(5, Math.max(0.2, scale));
    const getState = () => ({
        scale: parseFloat(wrapper.dataset.scale) || 1,
        translateX: parseFloat(wrapper.dataset.translateX) || 0,
        translateY: parseFloat(wrapper.dataset.translateY) || 0
    });
    const setState = (nextState) => {
        const scale = clampScale(nextState.scale);
        wrapper.dataset.scale = String(scale);
        wrapper.dataset.translateX = String(nextState.translateX || 0);
        wrapper.dataset.translateY = String(nextState.translateY || 0);
        canvas.style.transform = `translate(${nextState.translateX || 0}px, ${nextState.translateY || 0}px) scale(${scale})`;
        const resetButton = toolbar.querySelector('[data-mermaid-action="reset"]');
        if (resetButton) resetButton.textContent = `${Math.round(scale * 100)}%`;
    };
    const zoomAt = (targetScale, originX = viewport.clientWidth / 2, originY = viewport.clientHeight / 2) => {
        const current = getState();
        const scale = clampScale(targetScale);
        const ratio = scale / current.scale;
        setState({
            scale,
            translateX: originX - (originX - current.translateX) * ratio,
            translateY: originY - (originY - current.translateY) * ratio
        });
    };
    const resetView = () => setState({ scale: 1, translateX: 0, translateY: 0 });
    const fitToWidth = () => {
        const svgWidth = svg.getBBox?.().width || svg.viewBox?.baseVal?.width || svg.getBoundingClientRect().width;
        const availableWidth = Math.max(1, viewport.clientWidth - 32);
        if (!svgWidth) {
            resetView();
            return;
        }
        setState({
            scale: clampScale(Math.min(1.8, availableWidth / svgWidth)),
            translateX: 0,
            translateY: 0
        });
    };

    toolbar.addEventListener('click', (event) => {
        const button = event.target.closest('[data-mermaid-action]');
        if (!button) return;

        event.preventDefault();
        event.stopPropagation();

        const { scale } = getState();
        const action = button.dataset.mermaidAction;
        if (action === 'zoom-in') zoomAt(scale * 1.2);
        else if (action === 'zoom-out') zoomAt(scale / 1.2);
        else if (action === 'reset') resetView();
        else if (action === 'fit') fitToWidth();
    });

    viewport.addEventListener('wheel', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const rect = viewport.getBoundingClientRect();
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        zoomAt(getState().scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    let dragState = null;
    viewport.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;

        const state = getState();
        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: state.translateX,
            originY: state.translateY
        };
        viewport.classList.add('dragging');
        viewport.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });

    viewport.addEventListener('pointermove', (event) => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;

        setState({
            scale: getState().scale,
            translateX: dragState.originX + event.clientX - dragState.startX,
            translateY: dragState.originY + event.clientY - dragState.startY
        });
    });

    const endDrag = (event) => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        dragState = null;
        viewport.classList.remove('dragging');
        viewport.releasePointerCapture?.(event.pointerId);
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('dblclick', (event) => {
        event.preventDefault();
        resetView();
    });

    requestAnimationFrame(fitToWidth);
}

/**
 * Finds special VCP blocks (Tool Requests, Daily Notes) and transforms them
 * directly into styled HTML divs, bypassing the need for markdown code fences.
 * @param {string} text The text content.
 * @param {Map} [codeBlockMap] Map of code block placeholders to their original content.
 * @returns {string} The processed text with special blocks as HTML.
 */
function transformSpecialBlocks(text, codeBlockMap) {
    let processed = text;

    const restoreBlocks = (textStr) => {
        if (!textStr || !codeBlockMap) return textStr;
        let res = textStr;
        for (const [placeholder, block] of codeBlockMap.entries()) {
            if (res.includes(placeholder)) {
                res = res.replace(placeholder, () => block);
            }
        }
        return res;
    };

    // 🟢 架构级修复：VCP Tool Results 不再在此处理
    // 工具结果块在 contentPipeline 中被提取为占位符，贯穿 Markdown 解析后
    // 由 restoreRenderedToolResults() 独立渲染并恢复，彻底避免内部语法干扰

    const createVcpEndMarkerRegex = (isEscape) => {
        return isEscape
            ? /[「{]末[Ee][Ss][Cc][Aa][Pp][Ee][」}]/gi
            : /[「{]末[」}]/g;
    };

    const extractMarkedField = (source, labelRegex) => {
        if (!source || typeof source !== 'string') return null;

        const labelMatch = labelRegex.exec(source);
        if (!labelMatch) return null;

        const startRegex = /[「{]始(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/gi;
        startRegex.lastIndex = labelMatch.index + labelMatch[0].length;
        const startMatch = startRegex.exec(source);
        if (!startMatch) return null;

        // 字段名和起始标记之间只允许空白，避免误吞到后续字段
        if (source.slice(labelMatch.index + labelMatch[0].length, startMatch.index).trim() !== '') {
            return null;
        }

        const startMarker = startMatch[0];
        const isEscape = /escape/i.test(startMarker);
        const contentStart = startMatch.index + startMarker.length;
        const endRegex = createVcpEndMarkerRegex(isEscape);
        endRegex.lastIndex = contentStart;
        const endMatch = endRegex.exec(source);

        if (!endMatch) {
            return source.slice(contentStart).trim();
        }

        return source.slice(contentStart, endMatch.index).trim();
    };

    const renderMarkdownField = (rawText) => {
        const restoredText = restoreBlocks(rawText || '');
        if (agentRenderContext.markedInstance) {
            try {
                return agentRenderContext.markedInstance.parse(restoredText);
            } catch (e) {
                return escapeHtml(restoredText);
            }
        }
        return escapeHtml(restoredText);
    };

    const getDailyNoteAgentInfo = (source) => {
        const maid = extractMarkedField(source, /(?:maid|maidName):\s*/i) || '';
        const valet = extractMarkedField(source, /(?:valet|valetName):\s*/i) || '';

        if (valet) {
            return {
                name: valet,
                type: 'valet',
                gender: 'male',
                label: 'Valet',
                title: "Valet's Diary"
            };
        }

        return {
            name: maid,
            type: 'maid',
            gender: 'female',
            label: 'Maid',
            title: "Maid's Diary"
        };
    };

    const renderDailyNoteCreate = ({ agentName, agentType = 'maid', agentGender = 'female', agentLabel = 'Maid', defaultTitle = "Maid's Diary", date, fileName, folder, diaryContent, diaryTag }) => {
        let html = `<div class="maid-diary-bubble ${agentType}-diary-bubble" data-vcp-block-type="maid-diary" data-agent-gender="${escapeHtml(agentGender)}" data-vcp-preserve-children="true">`;
        html += `<div class="diary-header">`;
        html += `<span class="diary-title">${fileName ? escapeHtml(fileName) : escapeHtml(defaultTitle)}</span>`;
        if (date) {
            html += `<span class="diary-date">${escapeHtml(date)}</span>`;
        }
        html += `</div>`;

        if (agentName || folder) {
            html += `<div class="diary-maid-info">`;
            if (agentName) {
                html += `<span class="diary-maid-label">${escapeHtml(agentLabel)}:</span> `;
                html += `<span class="diary-maid-name">${escapeHtml(agentName)}</span>`;
            }
            if (folder) {
                if (agentName) html += ` <span class="diary-meta-separator">·</span> `;
                html += `<span class="diary-folder-label">Folder:</span> `;
                html += `<span class="diary-folder-name">${escapeHtml(folder)}</span>`;
            }
            html += `</div>`;
        }

        let diaryBody = diaryContent || '[日记内容解析失败]';
        if (diaryTag) {
            diaryBody += `\n\nTag:${diaryTag}`;
        }

        html += `<div class="diary-content">${renderMarkdownField(diaryBody)}</div>`;
        html += `</div>`;

        return `\n\n${html}\n\n`;
    };

    const renderDailyNoteUpdate = ({ agentName, agentType = 'maid', agentGender = 'female', folder, target, replace }) => {
        const hasTarget = target && target.trim();
        const hasReplace = replace && replace.trim();

        let html = `<div class="maid-diary-update-bubble ${agentType}-diary-update-bubble" data-vcp-block-type="maid-diary-update" data-agent-gender="${escapeHtml(agentGender)}" data-vcp-preserve-children="true">`;
        html += `<div class="diary-update-header">`;
        html += `<span class="diary-update-title">DailyNote Update</span>`;
        if (agentName || folder) {
            html += `<span class="diary-update-meta">`;
            if (agentName) html += `<span class="diary-maid-name">${escapeHtml(agentName)}</span>`;
            if (agentName && folder) html += ` <span class="diary-meta-separator">·</span> `;
            if (folder) html += `<span class="diary-folder-name">${escapeHtml(folder)}</span>`;
            html += `</span>`;
        }
        html += `</div>`;

        html += `<div class="diary-update-body">`;
        html += `<div class="diary-update-side diary-update-before">`;
        html += `<div class="diary-update-label">A</div>`;
        html += `<div class="diary-update-content">${hasTarget ? renderMarkdownField(target) : '<em>原文解析失败</em>'}</div>`;
        html += `</div>`;
        html += `<div class="diary-update-arrow" aria-hidden="true">→</div>`;
        html += `<div class="diary-update-side diary-update-after">`;
        html += `<div class="diary-update-label">B</div>`;
        html += `<div class="diary-update-content">${hasReplace ? renderMarkdownField(replace) : '<em>替换内容解析失败</em>'}</div>`;
        html += `</div>`;
        html += `</div>`;
        html += `</div>`;

        return `\n\n${html}\n\n`;
    };

    // Process Tool Call Summaries
    const renderToolCallSummaryBlock = (rawContent) => {
        const content = restoreBlocks(rawContent || '').trim();
        const entries = content
            .split(/[；;。]\s*/u)
            .map(item => item.trim())
            .filter(Boolean);

        const getStatusInfo = (entry) => {
            if (/拒绝|被拒|denied|rejected|refused/i.test(entry)) {
                return { key: 'rejected', label: '拒绝' };
            }
            if (/失败|错误|异常|error|failed/i.test(entry)) {
                return { key: 'failure', label: '失败' };
            }
            if (/超时|timeout/i.test(entry)) {
                return { key: 'timeout', label: '超时' };
            }
            if (/成功|完成|success|succeeded|ok/i.test(entry)) {
                return { key: 'success', label: '成功' };
            }
            if (/取消|中止|cancel/i.test(entry)) {
                return { key: 'cancelled', label: '取消' };
            }
            if (/跳过|skip/i.test(entry)) {
                return { key: 'skipped', label: '跳过' };
            }
            return { key: 'unknown', label: '未知' };
        };

        const renderEntry = (entry) => {
            const statusInfo = getStatusInfo(entry);
            const toolNameMatch = entry.match(/^(.+?)\s*调用/u);
            const toolName = (toolNameMatch?.[1] || entry.replace(/调用.*/u, '') || 'Tool').trim();
            return `<span class="vcp-tool-call-summary-chip status-${statusInfo.key}">` +
                `<span class="vcp-tool-call-summary-tool">${escapeHtml(toolName)}</span>` +
                `<span class="vcp-tool-call-summary-status">${escapeHtml(statusInfo.label)}</span>` +
                `</span>`;
        };

        let html = `<div class="vcp-tool-call-summary-bubble" data-vcp-block-type="tool-call-summary" data-vcp-preserve-children="true">`;
        html += `<div class="vcp-tool-call-summary-header">`;
        html += `<span class="vcp-tool-call-summary-icon">🧾</span>`;
        html += `<span class="vcp-tool-call-summary-title">本轮工具调用摘要</span>`;
        html += `</div>`;

        if (entries.length > 0) {
            html += `<div class="vcp-tool-call-summary-list">${entries.map(renderEntry).join('')}</div>`;
        } else {
            html += `<div class="vcp-tool-call-summary-raw">${escapeHtml(content || '无摘要内容')}</div>`;
        }

        html += `</div>`;
        return `\n\n${html}\n\n`;
    };

    const transformToolCallSummariesInRoleSections = (source) => {
        if (typeof source !== 'string' || !source.includes('[本轮工具调用摘要:]') || !source.includes('<<<[ROLE_DIVIDE_')) {
            return source;
        }

        let result = '';
        let cursor = 0;
        const roleStartRegex = /<<<\[ROLE_DIVIDE_(SYSTEM|ASSISTANT|USER)\]>>>/g;

        while (cursor < source.length) {
            roleStartRegex.lastIndex = cursor;
            const startMatch = roleStartRegex.exec(source);
            if (!startMatch) {
                result += source.slice(cursor);
                break;
            }

            result += source.slice(cursor, startMatch.index);

            const role = startMatch[1];
            const endToken = `<<<[END_ROLE_DIVIDE_${role}]>>>`;
            const sectionContentStart = startMatch.index + startMatch[0].length;
            const endIndex = source.indexOf(endToken, sectionContentStart);

            if (endIndex === -1) {
                result += source.slice(startMatch.index);
                break;
            }

            const sectionContent = source.slice(sectionContentStart, endIndex);
            const transformedSectionContent = sectionContent.replace(TOOL_CALL_SUMMARY_REGEX, (match, rawContent) => {
                return renderToolCallSummaryBlock(rawContent);
            });
            TOOL_CALL_SUMMARY_REGEX.lastIndex = 0;

            result += startMatch[0] + transformedSectionContent + endToken;
            cursor = endIndex + endToken.length;
        }

        return result;
    };

    processed = transformToolCallSummariesInRoleSections(processed);

    // Process Tool Requests
    processed = replaceToolRequestBlocks(processed, (match, content) => {
        const detectedToolName = extractMarkedField(content, /tool_name:\s*/i);
        const detectedCommand = extractMarkedField(content, /command:\s*/i);
        const normalizedToolName = (detectedToolName || '').trim().toLowerCase();
        const normalizedCommand = (detectedCommand || '').trim().toLowerCase();

        // DailyNote 新版 Tool Request:
        // 1) tool_name 为 DailyNote 且 command 为 update 时渲染为 A → B 替换预览；
        // 2) 如果没有 create/update 指令，但同时存在 target 和 replace 字段，也按 update 渲染；
        // 3) tool_name 为 DailyNote 且 command 为 create 时渲染为日记创建；
        // 4) 如果没有 create/update 指令，但存在 content 字段，也按 create 渲染。
        const dailyNoteContent = extractMarkedField(content, /Content:\s*/i);
        const dailyNoteTarget = extractMarkedField(content, /target:\s*/i);
        const dailyNoteReplace = extractMarkedField(content, /replace:\s*/i);
        const isDailyNoteTool = normalizedToolName === 'dailynote';
        const isDailyNoteUpdate = isDailyNoteTool && (normalizedCommand === 'update' || (!normalizedCommand && dailyNoteTarget && dailyNoteReplace));
        const isDailyNoteCreate = isDailyNoteTool && !isDailyNoteUpdate && (normalizedCommand === 'create' || (!normalizedCommand && dailyNoteContent));

        if (isDailyNoteCreate) {
            const dailyNoteAgent = getDailyNoteAgentInfo(content);
            return renderDailyNoteCreate({
                agentName: dailyNoteAgent.name,
                agentType: dailyNoteAgent.type,
                agentGender: dailyNoteAgent.gender,
                agentLabel: dailyNoteAgent.label,
                defaultTitle: dailyNoteAgent.title,
                date: extractMarkedField(content, /Date:\s*/i) || '',
                fileName: extractMarkedField(content, /fileName:\s*/i) || '',
                folder: extractMarkedField(content, /folder:\s*/i) || '',
                diaryContent: dailyNoteContent || '[日记内容解析失败]',
                diaryTag: extractMarkedField(content, /Tag:\s*/i) || ''
            });
        } else if (isDailyNoteUpdate) {
            const dailyNoteAgent = getDailyNoteAgentInfo(content);
            return renderDailyNoteUpdate({
                agentName: dailyNoteAgent.name,
                agentType: dailyNoteAgent.type,
                agentGender: dailyNoteAgent.gender,
                folder: extractMarkedField(content, /folder:\s*/i) || '',
                target: dailyNoteTarget || '',
                replace: dailyNoteReplace || ''
            });
        } else {
            // --- It's a regular tool call, render it normally ---
            const xmlToolNameMatch = content.match(/<tool_name>([\s\S]*?)<\/tool_name>/i);

            let toolName = 'Processing...';
            let extractedName = (xmlToolNameMatch?.[1] || detectedToolName || '').trim();
            if (extractedName) {
                extractedName = extractedName.replace(/[「{](?:始|末)(?:[Ee][Ss][Cc][Aa][Pp][Ee])?[」}]/gi, '').replace(/,$/, '').trim();
            }
            if (extractedName) {
                toolName = extractedName;
            }

            const escapedFullContent = escapeHtml(restoreBlocks(content));
            return `\n\n<div class="vcp-tool-use-bubble" data-vcp-block-type="tool-use" data-vcp-preserve-children="true">` +
                `<div class="vcp-tool-summary">` +
                `<span class="vcp-tool-label">VCP-ToolUse:</span> ` +
                `<span class="vcp-tool-name-highlight">${escapeHtml(toolName)}</span>` +
                `</div>` +
                `<div class="vcp-tool-details"><pre>${escapedFullContent}</pre></div>` +
                `</div>\n\n`;
        }
    });

    // Process Daily Notes
    processed = processed.replace(NOTE_REGEX, (match, rawContent) => {
        const content = rawContent.trim();
        const maidRegex = /Maid:\s*([^\n\r]*)/;
        const dateRegex = /Date:\s*([^\n\r]*)/;
        const contentRegex = /Content:\s*([\s\S]*)/;

        const maidMatch = content.match(maidRegex);
        const dateMatch = content.match(dateRegex);
        const contentMatch = content.match(contentRegex);

        const maid = maidMatch ? maidMatch[1].trim() : '';
        const date = dateMatch ? dateMatch[1].trim() : '';
        // The rest of the text after "Content:", or the full text if "Content:" is not found
        const diaryContent = contentMatch ? contentMatch[1].trim() : content;

        let html = `<div class="maid-diary-bubble" data-vcp-block-type="maid-diary" data-vcp-preserve-children="true">`;
        html += `<div class="diary-header">`;
        html += `<span class="diary-title">Maid's Diary</span>`;
        if (date) {
            html += `<span class="diary-date">${escapeHtml(date)}</span>`;
        }
        html += `</div>`;

        if (maid) {
            html += `<div class="diary-maid-info">`;
            html += `<span class="diary-maid-label">Maid:</span> `;
            html += `<span class="diary-maid-name">${escapeHtml(maid)}</span>`;
            html += `</div>`;
        }

        let processedDiaryContent;
        if (agentRenderContext.markedInstance) {
            try {
                processedDiaryContent = agentRenderContext.markedInstance.parse(restoreBlocks(diaryContent));
            } catch (e) {
                processedDiaryContent = escapeHtml(restoreBlocks(diaryContent));
            }
        } else {
            processedDiaryContent = escapeHtml(restoreBlocks(diaryContent));
        }
        html += `<div class="diary-content">${processedDiaryContent}</div>`;
        html += `</div>`;

        return `\n\n${html}\n\n`;
    });

    // Process VCP Thought Chains
    const renderThoughtChain = (theme, rawContent) => {
        const displayTheme = theme ? theme.trim() : "元思考链";
        const content = rawContent.trim();
        const escapedContent = escapeHtml(restoreBlocks(content));

        let html = `<div class="vcp-thought-chain-bubble collapsible" data-vcp-block-type="thought-chain" data-vcp-preserve-children="true">`;
        html += `<div class="vcp-thought-chain-header">`;
        html += `<span class="vcp-thought-chain-icon">🧠</span>`;
        html += `<span class="vcp-thought-chain-label">${escapeHtml(displayTheme)}</span>`;
        html += `<span class="vcp-result-toggle-icon"></span>`;
        html += `</div>`;

        html += `<div class="vcp-thought-chain-collapsible-content">`;

        let processedContent;
        if (agentRenderContext.markedInstance) {
            try {
                processedContent = agentRenderContext.markedInstance.parse(restoreBlocks(content));
            } catch (e) {
                processedContent = `<pre>${escapedContent}</pre>`;
            }
        } else {
            processedContent = `<pre>${escapedContent}</pre>`;
        }

        html += `<div class="vcp-thought-chain-body">${processedContent}</div>`;
        html += `</div>`; // End of vcp-thought-chain-collapsible-content
        html += `</div>`; // End of vcp-thought-chain-bubble

        return `\n\n${html}\n\n`;
    };

    processed = processed.replace(THOUGHT_CHAIN_REGEX, (match, theme, rawContent) => {
        return renderThoughtChain(theme, rawContent);
    });

    // Process Conventional Thought Chains (<think>...</think>)
    processed = processed.replace(CONVENTIONAL_THOUGHT_REGEX, (match, rawContent) => {
        return renderThoughtChain("思维链", rawContent);
    });

    // Desktop Push blocks 已在 preprocessFullContent 中于代码块保护之后统一处理
    // 这里不再重复处理，避免与代码块内的语法冲突

    // Process Role Dividers
    processed = processed.replace(ROLE_DIVIDER_REGEX, (match, isEnd, role) => {
        const isEndMarker = !!isEnd;
        const roleLower = role.toLowerCase();

        let label = '';
        if (roleLower === 'system') label = 'System';
        else if (roleLower === 'assistant') label = 'Assistant';
        else if (roleLower === 'user') label = 'User';

        const actionText = isEndMarker ? '末' : '始';

        return `\n\n<div class="vcp-role-divider role-${roleLower} type-${isEndMarker ? 'end' : 'start'}" data-vcp-block-type="role-divider" data-vcp-preserve-children="true"><span class="divider-text">${label} 分界之${actionText}</span></div>\n\n`;
    });

    return processed;
}

/**
 * Transforms user's "clicked button" indicators into styled bubbles.
 * @param {string} text The text content.
 * @returns {string} The processed text.
 */
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
function renderToolResultBlock(fullMatch) {
    const startMarker = '[[VCP调用结果信息汇总:';
    const endMarker = 'VCP调用结果结束]]';
    const markdownFieldKeys = new Set(['返回内容', '内容', 'Result', '返回结果', 'output']);
    const knownFieldKeys = new Set(['工具名称', '执行状态', '命令', '参数', '返回内容', '内容', 'Result', '返回结果', 'output', '可访问URL', 'url', 'image']);
    let content = fullMatch;
    if (content.startsWith(startMarker)) {
        content = content.slice(startMarker.length);
    }
    if (content.endsWith(endMarker)) {
        content = content.slice(0, -endMarker.length);
    }
    content = content.trim();

    const lines = content.split('\n');
    let toolName = 'Unknown Tool';
    let status = 'Unknown Status';
    const details = [];
    let otherContent = [];
    let currentKey = null;
    let currentValue = [];

    lines.forEach(line => {
        const kvMatch = line.match(/^-\s*([^:]+):\s*(.*)/);
        const matchedKey = kvMatch?.[1]?.trim();
        const isKnownField = matchedKey && knownFieldKeys.has(matchedKey);
        const shouldStartNewField = isKnownField && !markdownFieldKeys.has(currentKey);

        if (shouldStartNewField) {
            if (currentKey) {
                const val = currentValue.join('\n').trim();
                if (currentKey === '工具名称') toolName = val;
                else if (currentKey === '执行状态') status = val;
                else details.push({ key: currentKey, value: val });
            }
            currentKey = matchedKey;
            currentValue = [kvMatch[2].trim()];
        } else if (currentKey) {
            currentValue.push(line);
        } else if (line.trim() !== '') {
            otherContent.push(line);
        }
    });

    if (currentKey) {
        const val = currentValue.join('\n').trim();
        if (currentKey === '工具名称') toolName = val;
        else if (currentKey === '执行状态') status = val;
        else details.push({ key: currentKey, value: val });
    }

    let html = `<div class="vcp-tool-result-bubble collapsible" data-vcp-block-type="tool-result" data-vcp-preserve-children="true">`;
    html += `<div class="vcp-tool-result-header">`;
    html += `<span class="vcp-tool-result-label">VCP-ToolResult</span>`;
    html += `<span class="vcp-tool-result-name">${escapeHtml(toolName)}</span>`;
    html += `<span class="vcp-tool-result-status">${escapeHtml(status)}</span>`;
    html += `<span class="vcp-result-toggle-icon"></span>`;
    html += `</div>`;

    html += `<div class="vcp-tool-result-collapsible-content">`;
    html += `<div class="vcp-tool-result-details">`;

    details.forEach(({ key, value }) => {
        const isMarkdownField = markdownFieldKeys.has(key);
        const isImageUrl = typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value) && /\.(jpeg|jpg|png|gif|webp)([?&#]|$)/i.test(value);
        let processedValue;

        if (isImageUrl && (key === '可访问URL' || key === '返回内容' || key === 'url' || key === 'image')) {
            processedValue = `<a href="${value}" target="_blank" rel="noopener noreferrer" title="点击预览"><img src="${value}" class="vcp-tool-result-image" alt="Generated Image"></a>`;
        } else if (isMarkdownField) {
            // 🟢 架构级修复：工具结果内容使用独立的 Markdown 渲染
            // 由于工具结果块已经从外部文本中完全隔离，这里可以安全地使用 Markdown 解析器
            // 支持表格、代码围栏、列表等完整 Markdown 语法，不再需要 escapeHtml + <pre> 的妥协方案

            // 🟢 性能优化：大内容二级截断
            const isLargeContent = value.length > TOOL_RESULT_TRUNCATE_THRESHOLD;
            let valueToRender = value;
            let truncationNotice = '';

            if (isLargeContent) {
                // 截断到前 N 行
                const allLines = value.split('\n');
                const truncatedLines = allLines.slice(0, TOOL_RESULT_TRUNCATE_LINES);
                valueToRender = truncatedLines.join('\n');

                // 存储完整内容供懒加载
                const contentId = toolResultContentIdCounter++;
                toolResultFullContentMap.set(contentId, { raw: value, fieldKey: key });

                const remainingLines = allLines.length - TOOL_RESULT_TRUNCATE_LINES;
                const sizeKB = Math.round(value.length / 1024);
                truncationNotice = `<div class="vcp-tool-result-truncated-notice" data-content-id="${contentId}">` +
                    `<span>📄 内容已截断（共 ${allLines.length} 行 / ${sizeKB}KB），当前显示前 ${TOOL_RESULT_TRUNCATE_LINES} 行</span>` +
                    `<span style="font-weight:600;">点击展开全部</span>` +
                    `</div>`;
            }

            const renderedMarkdown = renderSafeToolResultMarkdown(valueToRender);
            const sealClass = TOOL_RESULT_DANGEROUS_HTML_REGEX.test(valueToRender)
                ? ' vcp-tool-result-markdown-content--sealed-html'
                : '';
            processedValue = `<div class="vcp-tool-result-markdown-content${sealClass}">${renderedMarkdown}</div>${truncationNotice}`;
        } else {
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            processedValue = escapeHtml(value);
            processedValue = processedValue.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

            if (key === '返回内容') {
                processedValue = processedValue.replace(/###(.*?)###/g, '<strong>$1</strong>');
            }
        }

        const itemClass = (isMarkdownField && !isImageUrl)
            ? 'vcp-tool-result-item vcp-tool-result-item-markdown'
            : 'vcp-tool-result-item';
        html += `<div class="${itemClass}">`;
        html += `<span class="vcp-tool-result-item-key">${escapeHtml(key)}:</span> `;
        const valueTag = (isMarkdownField && !isImageUrl) ? 'div' : 'span';
        html += `<${valueTag} class="vcp-tool-result-item-value">${processedValue}</${valueTag}>`;
        html += `</div>`;
    });
    html += `</div>`;

    if (otherContent.length > 0) {
        const footerText = otherContent.join('\n');
        const processedFooter = `<pre class="vcp-tool-result-raw-content">${escapeHtml(footerText)}</pre>`;
        html += `<div class="vcp-tool-result-footer">${processedFooter}</div>`;
    }

    html += `</div>`;
    html += `</div>`;

    return html;
}

/**
 * 🟢 在 Markdown 解析后恢复工具结果占位符为渲染好的 HTML
 * @param {string} html - marked.parse() 输出的 HTML
 * @param {Map|null} toolResultMap - 占位符到原始工具结果文本的映射
 * @returns {string} 恢复后的 HTML
 */
function restoreRenderedToolResults(html, toolResultMap) {
    if (!toolResultMap || toolResultMap.size === 0 || typeof html !== 'string') return html;

    // P1-5：工具结果占位符使用 HTML 注释格式，单遍匹配即可恢复。
    // 同时兼容 marked 将注释占位符包裹成 <p><!--VCP_TOOL_RESULT_n--></p> 的情况。
    return html.replace(/<p>\s*(<!--VCP_TOOL_RESULT_(\d+)-->)\s*<\/p>|<!--VCP_TOOL_RESULT_(\d+)-->/g, (match, wrappedPlaceholder, wrappedId, bareId) => {
        const placeholder = wrappedPlaceholder || `<!--VCP_TOOL_RESULT_${bareId}-->`;
        const rawMatch = toolResultMap.get(placeholder);
        if (!rawMatch) return match;
        return `\n\n${renderToolResultBlock(rawMatch)}\n\n`;
    });
}

/**
 * 🟢 在 Markdown 文本中修复表情包URL
 * 处理 ![alt](url) 和 <img src="url"> 两种形式
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
    clearToolResults: () => {
        toolResultFullContentMap.clear();
        toolResultContentIdCounter = 0;
    },
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
    getToolResult: (contentId) => toolResultFullContentMap.get(contentId),
    releaseToolResult: (contentId) => toolResultFullContentMap.delete(contentId),
    renderToolResult(container, fullData) {
        container.innerHTML = renderSafeToolResultMarkdown(fullData.raw);
        if (TOOL_RESULT_DANGEROUS_HTML_REGEX.test(fullData.raw)) {
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

function renderMessage(message, isInitialLoad = false, appendToDom = true, renderSessionId = getActiveRenderSessionId(), renderContext = {}) {
    // console.debug('[MessageRenderer renderMessage] Received message:', JSON.parse(JSON.stringify(message)));
    const { chatMessagesDiv, electronAPI, markedInstance, uiHelper } = agentRenderContext;
    const globalSettings = getSettings();
    const currentSelectedItem = getParticipant();
    const currentChatHistory = getMessages();

    // Prevent re-rendering if the message already exists in the DOM, unless it's a thinking message being replaced.
    const existingMessageDom = chatMessagesDiv.querySelector(`.message-item[data-message-id="${message.id}"]`);
    if (existingMessageDom && !existingMessageDom.classList.contains('thinking')) {
        // console.log(`[MessageRenderer] Message ${message.id} already in DOM. Skipping render.`);
        // return existingMessageDom;
    }

    if (!chatMessagesDiv || !electronAPI || !markedInstance) {
        console.error("MessageRenderer: Missing critical references for rendering.");
        return null;
    }

    if (!message.id) {
        message.id = `msg_${message.timestamp}_${Math.random().toString(36).substring(2, 9)}`;
    }

    const { messageItem, contentDiv, avatarImg, senderNameDiv } = createMessageSkeleton(message, globalSettings, currentSelectedItem);
    messageItem.dataset.vcpInitialLoad = isInitialLoad ? 'true' : 'false';

    // --- NEW: Scoped CSS Implementation ---
    let scopeId = null;
    if (message.role === 'assistant') {
        scopeId = generateUniqueId();
        messageItem.id = scopeId; // Assign the unique ID to the message container
    }
    // --- END Scoped CSS Implementation ---


    // 先添加到DOM
    if (appendToDom) {
        chatMessagesDiv.appendChild(messageItem);
        // 观察新消息的可见性
        visibilityController?.observeMessage(messageItem);
    }

    const isActiveStreamRequest = message.role === 'assistant'
        && (message.state === 'streaming' || message.isStreaming === true || getStreamController().has(message.id));
    const messageTextIsEmpty = message.content === null
        || message.content === undefined
        || (typeof message.content === 'string' && message.content.trim() === '');

    if (message.isThinking || (isActiveStreamRequest && messageTextIsEmpty)) {
        contentDiv.innerHTML = `<span class="thinking-indicator">${message.content || '思考中'}<span class="thinking-indicator-dots">...</span></span>`;
        messageItem.classList.add(message.isThinking ? 'thinking' : 'streaming');
    } else {
        // 切回仍在后台运行且已经产生内容的会话时，恢复可中止的流式状态。
        if (isActiveStreamRequest) {
            messageItem.classList.add('streaming');
        }
        let textToRender = "";
        if (typeof message.content === 'string') {
            textToRender = message.content;
        } else if (message.content && typeof message.content.text === 'string') {
            // This case handles objects like { text: "..." }, common for group messages before history saving
            textToRender = message.content.text;
        } else if (message.content === null || message.content === undefined) {
            textToRender = ""; // Handle null or undefined content gracefully
            console.warn('[MessageRenderer] message.content is null or undefined for message ID:', message.id);
        } else {
            // Fallback for other unexpected object structures, log and use a placeholder
            console.warn('[MessageRenderer] Unexpected message.content type. Message ID:', message.id, 'Content:', JSON.stringify(message.content));
            textToRender = "[消息内容格式异常]";
        }

        if (message.role === 'user') {
            textToRender = prepareUserMessageText(textToRender);
        } else if (message.role === 'assistant') {
            textToRender = processAssistantScopedHtmlContent(textToRender, scopeId, messageItem);
        }

        // --- 按“对话轮次”计算深度 ---
        // 历史批量渲染时优先使用预计算 depthMap，避免每条消息重复扫描完整 history。
        // 如果是实时新消息，它此时可能还不在 history 数组里，则保留原有临时追加兜底逻辑。
        const precomputedDepth = renderContext.depthMap?.get?.(message.id);
        const depth = precomputedDepth !== undefined
            ? precomputedDepth
            : calculateDepthByTurns(
                message.id,
                currentChatHistory.some(m => m.id === message.id)
                    ? [...currentChatHistory]
                    : [...currentChatHistory, message]
            );
        // --- 深度计算结束 ---

        // --- 应用前端正则规则 ---
        // 核心修复：将正则规则应用移出 preprocessFullContent，以避免在流式传输的块上执行
        // 这样可以确保正则表达式在完整的消息内容上运行
        const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
        if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes)) {
            textToRender = applyFrontendRegexRules(textToRender, agentConfigForRegex.stripRegexes, message.role, depth);
        }
        // --- 正则规则应用结束 ---

        let rawHtml = renderMarkdownToHtml(textToRender, {
            settings: globalSettings,
            messageRole: message.role,
            depth
        });

        // 修复：清理 Markdown 解析器可能生成的损坏的 SVG viewBox 属性
        // 错误 "Unexpected end of attribute" 表明 viewBox 的值不完整, 例如 "0 "
        rawHtml = rawHtml.replace(/viewBox="0 "/g, 'viewBox="0 0 24 24"');

        // Synchronously set the base HTML content
        const finalHtml = rawHtml;
        contentDiv.innerHTML = finalHtml;

        // [Pretext集成] 延后填充文本高度缓存，避免阻塞首屏与批量历史渲染
        scheduleMessagePretextEstimate(message.id, textToRender, chatMessagesDiv);

        // Define the post-processing logic as a function.
        // This allows us to control WHEN it gets executed.
        const runPostRenderProcessing = async (postOptions = {}) => {
            if (!isRenderSessionActive(renderSessionId) || !messageItem.isConnected || !contentDiv.isConnected) {
                return;
            }

            return renderPostProcessedHtml(contentDiv, finalHtml, {
                messageId: message.id,
                message,
                settings: globalSettings,
                renderSessionId,
                runHeavy: postOptions.runHeavy !== false,
                includeAttachments: true
            });
        };

        messageItem._vcp_activateHeavy = () => {
            if (messageItem.dataset.vcpHeavyActivated === 'true') return;
            return runPostRenderProcessing({ runHeavy: true });
        };

        // If we are appending directly to the DOM, schedule the processing immediately.
        if (appendToDom) {
            // We still use requestAnimationFrame to ensure the element is painted before we process it.
            requestAnimationFrame(() => {
                if (!isRenderSessionActive(renderSessionId) || !messageItem.isConnected) return;
                runPostRenderProcessing();
            });
        } else {
            // If not, attach the processing function to the element itself.
            // The caller (e.g., a batch renderer) will be responsible for executing it
            // AFTER the element has been attached to the DOM.
            messageItem._vcp_process = (postOptions = {}) => {
                if (!isRenderSessionActive(renderSessionId) || !messageItem.isConnected) return;
                return runPostRenderProcessing(postOptions);
            };
            messageItem._vcp_renderSessionId = renderSessionId;
        }
    }

    avatarStyle.apply({
        message, messageItem, avatarImg, senderNameDiv,
        settings: globalSettings, participant: currentSelectedItem,
    });


    // Attachments and content processing are now deferred within a requestAnimationFrame
    // to prevent race conditions during history loading. See the block above.

    if (isInitialLoad && message.isThinking && !isActiveStreamRequest) {
        // Durable Projection does not keep stale thinking placeholders.
        messageItem.remove();
        return null;
    }

    // Highlighting is now part of processRenderedContent

    if (appendToDom) {
        agentRenderContext.uiHelper.scrollToBottom();
    }
    return messageItem;
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
async function renderFullMessage(messageId, fullContent, agentName, agentId) {
    console.debug(`[MessageRenderer renderFullMessage] Rendering full message for ID: ${messageId}`);
    const { chatMessagesDiv } = agentRenderContext;
    const currentChatHistoryArray = getMessages();
    const currentSelectedItem = getParticipant();
    const projectedMessage = currentChatHistoryArray.find(msg => msg.id === messageId) || {
        id: messageId,
        role: 'assistant',
        timestamp: Date.now(),
    };

    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) {
        return;
    }

    messageItem.classList.remove('thinking', 'streaming');

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) {
        console.error(`[renderFullMessage] Could not find .md-content div for message ID ${messageId}.`);
        return;
    }

    // Update timestamp display if it was missing
    const nameTimeBlock = messageItem.querySelector('.name-time-block');
    if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
        const timestampDiv = document.createElement('div');
        timestampDiv.classList.add('message-timestamp');
        timestampDiv.textContent = formatMessageTimestamp(projectedMessage.timestamp || Date.now());
        nameTimeBlock.appendChild(timestampDiv);
    }

    // --- Update DOM ---
    const globalSettings = getSettings();
    // --- 应用前端正则规则 (修复流式处理问题) ---
    const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
    const messageFromHistoryForRegex = currentChatHistoryArray.find(msg => msg.id === messageId);
    const messageRoleForRender = messageFromHistoryForRegex?.role || 'assistant';
    let depth = 0;
    if (messageFromHistoryForRegex) {
        depth = calculateDepthByTurns(messageId, currentChatHistoryArray);
        if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes)) {
            fullContent = applyFrontendRegexRules(fullContent, agentConfigForRegex.stripRegexes, messageRoleForRender, depth);
        }
    }
    // --- 正则规则应用结束 ---
    if (messageRoleForRender === 'assistant') {
        let scopedMessageId = messageItem.id;
        if (!scopedMessageId) {
            scopedMessageId = generateUniqueId();
            messageItem.id = scopedMessageId;
        }
        fullContent = processAssistantScopedHtmlContent(fullContent, scopedMessageId, messageItem);
    }

    const rawHtml = renderMarkdownToHtml(fullContent, {
        settings: globalSettings,
        messageRole: messageRoleForRender,
        depth
    });

    await renderPostProcessedHtml(contentDiv, rawHtml, {
        messageId,
        message: messageFromHistoryForRegex ? { ...messageFromHistoryForRegex, content: fullContent } : null,
        settings: globalSettings,
        renderSessionId: null,
        runHeavy: true,
        includeAttachments: !!messageFromHistoryForRegex
    });

    agentRenderContext.uiHelper.scrollToBottom();
}

function scheduleMessagePretextEstimate(messageId, text, container) {
    if (!window.pretextBridge || !window.pretextBridge.isReady() || !messageId || !text) return;

    const run = () => {
        try {
            const containerWidth = container ? container.clientWidth : 800;
            window.pretextBridge.estimateHeight(messageId, text, 'body', containerWidth);
        } catch (e) {
            // Pretext 失败不影响正常渲染
        }
    };

    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 300 });
    } else {
        setTimeout(run, 0);
    }
}

function updateMessageContent(messageId, newContent) {
    const { chatMessagesDiv } = agentRenderContext;
    const messageItem = chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
    if (!messageItem) return;

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

    const globalSettings = getSettings(messageId);
    let textToRender = (typeof newContent === 'string') ? newContent : (newContent?.text || "[内容格式异常]");

    // --- 深度计算 (用于历史消息渲染) ---
    const currentChatHistoryForUpdate = getMessages();
    const messageInHistory = currentChatHistoryForUpdate.find(m => m.id === messageId);

    if (messageInHistory && messageInHistory.role === 'user') {
        textToRender = prepareUserMessageText(textToRender);
    }

    // --- 按“对话轮次”计算深度 ---
    const depthForUpdate = calculateDepthByTurns(messageId, currentChatHistoryForUpdate);
    // --- 深度计算结束 ---
    // --- 应用前端正则规则 (修复流式处理问题) ---
    const currentSelectedItem = getParticipant();
    const agentConfigForRegex = currentSelectedItem?.config || currentSelectedItem;
    if (agentConfigForRegex?.stripRegexes && Array.isArray(agentConfigForRegex.stripRegexes) && messageInHistory) {
        textToRender = applyFrontendRegexRules(textToRender, agentConfigForRegex.stripRegexes, messageInHistory.role, depthForUpdate);
    }
    // --- 正则规则应用结束 ---
    if ((messageInHistory?.role || 'assistant') === 'assistant') {
        let scopedMessageId = messageItem.id;
        if (!scopedMessageId) {
            scopedMessageId = generateUniqueId();
            messageItem.id = scopedMessageId;
        }
        textToRender = processAssistantScopedHtmlContent(textToRender, scopedMessageId, messageItem);
    }

    const rawHtml = renderMarkdownToHtml(textToRender, {
        settings: globalSettings,
        messageRole: messageInHistory?.role || 'assistant',
        depth: depthForUpdate
    });

    // --- Post-Render Processing (aligned with renderMessage logic) ---

    renderPostProcessedHtml(contentDiv, rawHtml, {
        messageId,
        message: messageInHistory ? { ...messageInHistory, content: newContent } : null,
        settings: globalSettings,
        renderSessionId: null,
        runHeavy: true,
        includeAttachments: !!messageInHistory
    });
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
