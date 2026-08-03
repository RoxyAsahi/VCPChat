export function createAgentRendererToolResults({ getMarked, escapeHtml, dangerousHtmlRegex }) {
    const TOOL_RESULT_TRUNCATE_THRESHOLD = 50000;
    const TOOL_RESULT_TRUNCATE_LINES = 80;
    const toolResultFullContentMap = new Map();
    let toolResultContentIdCounter = 0;
    const TOOL_RESULT_RAW_HTML_LINE_REGEX = /<!doctype\b|<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s>/])|<!--|<\?xml\b/i;
    const TOOL_RESULT_COMPLETE_HTML_REGEX = /<!doctype\s+html\b|<\s*html\b|<\s*head\b|<\s*body\b/i;
    const FENCE_LINE_REGEX = /^\s*(`{3,}|~{3,})/;
    const FENCE_LANG_LINE_REGEX = /^\s*(`{3,}|~{3,})(.*)$/;
    const TOOL_RESULT_SAFE_MARKDOWN_OPTIONS = Object.freeze({ mangle: false, headerIds: false });
    const agentRenderContext = { get markedInstance() { return getMarked(); } };
    const TOOL_RESULT_DANGEROUS_HTML_REGEX = dangerousHtmlRegex;
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
    return {
        renderSafeMarkdown: renderSafeToolResultMarkdown,
        restore: restoreRenderedToolResults,
        get: (id) => toolResultFullContentMap.get(id),
        release: (id) => toolResultFullContentMap.delete(id),
        clear() { toolResultFullContentMap.clear(); toolResultContentIdCounter = 0; },
        isDangerous: (text) => TOOL_RESULT_DANGEROUS_HTML_REGEX.test(text),
    };
}
