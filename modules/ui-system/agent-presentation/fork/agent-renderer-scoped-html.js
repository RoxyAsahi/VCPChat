export function createAgentRendererScopedHtml({
    document, scopeCss, styleRegex, htmlTriggerRegex, htmlStyleTagRegex, htmlFenceCheckRegex,
    toolResultRegex, replaceToolRequestBlocks, desktopPushRegex, desktopPushPartialRegex, codeFenceRegex,
}) {
    function generateUniqueId() {
        return `vcp-bubble-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 9)}`;
    }
    function containsScopedHtml(text) {
        return typeof text === 'string' && htmlTriggerRegex.test(text);
    }
    function containsStyle(text) {
        return typeof text === 'string' && htmlStyleTagRegex.test(text);
    }
    function injectStyles(content, scopeId) {
        let css = '';
        const processedContent = content.replace(styleRegex, (_match, value) => {
            css += `${value.trim()}\n`;
            return '';
        });
        if (css) {
            try {
                const style = document.createElement('style');
                style.type = 'text/css';
                style.dataset.vcpScopeId = scopeId;
                style.textContent = scopeCss(css, scopeId);
                document.head.append(style);
            } catch (error) {
                console.error(`[ScopedCSS] Failed to scope or inject CSS for ID: ${scopeId}`, error);
            }
        }
        return processedContent;
    }
    function process(content, scopeId, messageItem = null) {
        if (!scopeId || !containsScopedHtml(content)) return content;
        if (messageItem) {
            messageItem.dataset.vcpHtmlScopeCandidate = 'true';
            if (!containsStyle(content)) messageItem.dataset.vcpInlineHtmlScoped = 'true';
        }
        const blocks = [];
        const protect = (match) => {
            const placeholder = `__VCP_STYLE_PROTECT_${blocks.length}__`;
            blocks.push(match);
            return placeholder;
        };
        toolResultRegex.lastIndex = 0;
        let protectedText = content.replace(toolResultRegex, protect);
        toolResultRegex.lastIndex = 0;
        protectedText = replaceToolRequestBlocks(protectedText, protect);
        protectedText = protectedText.replace(desktopPushRegex, protect);
        protectedText = protectedText.replace(desktopPushPartialRegex, protect);
        protectedText = protectedText.replace(codeFenceRegex, protect);
        let restored = injectStyles(protectedText, scopeId);
        blocks.forEach((block, index) => {
            restored = restored.split(`__VCP_STYLE_PROTECT_${index}__`).join(block);
        });
        return restored;
    }
    function ensureHtmlFenced(text) {
        const startTag = '<!doctype html>';
        const endTag = '</html>';
        if (htmlFenceCheckRegex.test(text) || !text.toLowerCase().includes(startTag)) return text;
        const protectedRanges = [];
        replaceToolRequestBlocks(text, (match, _content, start, end) => {
            protectedRanges.push({ start, end });
            return match;
        });
        const isProtected = (index) => protectedRanges.some((range) => index >= range.start && index < range.end);
        let result = '';
        let cursor = 0;
        while (true) {
            const start = text.toLowerCase().indexOf(startTag, cursor);
            result += text.substring(cursor, start === -1 ? text.length : start);
            if (start === -1) break;
            const end = text.toLowerCase().indexOf(endTag, start + startTag.length);
            if (end === -1) {
                result += text.substring(start);
                break;
            }
            const block = text.substring(start, end + endTag.length);
            result += isProtected(start) || (result.match(/```/g) || []).length % 2 !== 0
                ? block : `\n\`\`\`html\n${block}\n\`\`\`\n`;
            cursor = end + endTag.length;
        }
        return result;
    }
    function deIndentHtml(text) {
        let inFence = false;
        return text.split('\n').map((line) => {
            if (line.trim().startsWith('```')) {
                inFence = !inFence;
                return line;
            }
            if (!inFence && !line.includes('<img') && /^\s+<(!|[a-zA-Z])/.test(line)) return line.trimStart();
            return line;
        }).join('\n');
    }
    return { generateUniqueId, containsScopedHtml, process, ensureHtmlFenced, deIndentHtml };
}
